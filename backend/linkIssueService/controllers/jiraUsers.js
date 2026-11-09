const {
  ErrorResponse,
  asyncHandler,
  audit,
  requestWithRetry,
  CORRELATION_HEADER,
  PROJECT_ID_HEADER,
  createLogger
} = require('@srckube/service-core');
const JiraUserMapping = require('../models/JiraUserMapping');
const { assignableUsers, getUser } = require('../utils/jiraClient');
const { loadCredentials } = require('./jiraConnection');

const logger = createLogger('linkIssueService:jiraUsers');
const USER_SERVICE = process.env.userService;

function actor(req) {
  return req.kauth?.grant?.access_token?.content?.sub;
}

// Loads the project's Jira credentials, or produces the error a caller should
// return. Every route here needs them, and "no Jira connection" is a distinct
// answer from "Jira rejected us".
async function credentialsOr400(projectId) {
  const creds = await loadCredentials(projectId);
  if (!creds) {
    throw new ErrorResponse(
      'This project has no Jira connection yet. Configure it first at ' +
        'PUT /api/v1/linkIssue/jira/connection.',
      409
    );
  }
  return creds;
}

// @desc    The Jira accounts mapped for this project
// @route   GET /api/v1/linkIssue/jira/users
exports.listMappings = asyncHandler(async (req, res) => {
  const projectId = req.projectScope.projectId;
  const mappings = await JiraUserMapping.find({ projectId }).sort({ jiraDisplayName: 1 });
  res.status(200).json({
    success: true,
    count: mappings.length,
    data: mappings.map((m) => m.toPublic())
  });
});

// @desc    Jira accounts that can be assigned work on this project's Jira projects
// @route   GET /api/v1/linkIssue/jira/users/candidates
//
// Sourced from /user/assignable/search rather than /user/search, deliberately:
// a Jira site contains accounts that exist but cannot hold an issue in a given
// project, and offering those would produce a mapping that only fails at
// assignment time.
exports.candidates = asyncHandler(async (req, res, next) => {
  const projectId = req.projectScope.projectId;
  let creds;
  try {
    creds = await credentialsOr400(projectId);
  } catch (err) {
    return next(err);
  }

  const seen = new Map();
  const failures = [];
  for (const projectKey of creds.projectKeys) {
    // eslint-disable-next-line no-await-in-loop
    const result = await assignableUsers({ ...creds, projectKey });
    if (!result.ok) {
      failures.push({ projectKey, status: result.status });
      continue;
    }
    // A person assignable on several of the project's Jira projects appears
    // once; accountId is the identity, so it is the dedupe key.
    result.users.forEach((u) => {
      if (!seen.has(u.accountId)) seen.set(u.accountId, u);
    });
  }

  if (seen.size === 0 && failures.length > 0) {
    return next(
      new ErrorResponse(
        `Could not read assignable users from Jira for ${failures.map((f) => f.projectKey).join(', ')}. ` +
          'Re-validate the connection: the token may have been revoked or its project access changed.',
        502
      )
    );
  }

  const mapped = await JiraUserMapping.find({ projectId }).select('jiraAccountId keycloakSub');
  const claimed = new Map(mapped.map((m) => [m.jiraAccountId, m.keycloakSub]));

  res.status(200).json({
    success: true,
    count: seen.size,
    data: [...seen.values()].map((u) => ({
      ...u,
      // So a picker can show who is already taken rather than letting someone
      // choose an account that will be refused by the uniqueness rule.
      mappedTo: claimed.get(u.accountId) || null
    })),
    // Partial failures are reported rather than swallowed: a candidate list
    // missing one Jira project looks complete otherwise.
    unreadableProjectKeys: failures.map((f) => f.projectKey)
  });
});

// @desc    Proposed mappings, matched on email where Jira exposes it
// @route   GET /api/v1/linkIssue/jira/users/suggest
//
// A convenience, never a source of truth. Atlassian hides `emailAddress`
// whenever the account's privacy setting says so -- the default on many sites
// -- so this can legitimately return nothing, and that is reported as a
// reason rather than an empty success. Mappings are still a human decision;
// this only saves the typing when the emails happen to line up.
exports.suggest = asyncHandler(async (req, res, next) => {
  const projectId = req.projectScope.projectId;
  let creds;
  try {
    creds = await credentialsOr400(projectId);
  } catch (err) {
    return next(err);
  }

  // The project's own people, from the directory endpoint userService exposes.
  let members = [];
  try {
    const resp = await requestWithRetry({
      method: 'get',
      url: `http://${USER_SERVICE}/api/v1/users/directory`,
      headers: {
        Authorization: req.headers.authorization,
        [CORRELATION_HEADER]: req.correlationId,
        [PROJECT_ID_HEADER]: String(projectId)
      }
    });
    members = resp.data.data || [];
  } catch (err) {
    logger.warn('could not read the project directory for suggestions', { error: err.message });
    return next(
      new ErrorResponse('Could not read this project\'s members to match against Jira right now.', 503)
    );
  }

  const jira = new Map();
  for (const projectKey of creds.projectKeys) {
    // eslint-disable-next-line no-await-in-loop
    const result = await assignableUsers({ ...creds, projectKey });
    if (result.ok) result.users.forEach((u) => jira.set(u.accountId, u));
  }

  const byEmail = new Map();
  let jiraWithEmail = 0;
  jira.forEach((u) => {
    if (u.emailAddress) {
      jiraWithEmail += 1;
      byEmail.set(u.emailAddress.toLowerCase(), u);
    }
  });

  const existing = await JiraUserMapping.find({ projectId }).select('keycloakSub');
  const alreadyMapped = new Set(existing.map((m) => m.keycloakSub));

  const suggestions = [];
  const unmatched = [];
  members.forEach((m) => {
    if (alreadyMapped.has(m.id)) return;
    const match = m.email ? byEmail.get(String(m.email).toLowerCase()) : null;
    if (match) {
      suggestions.push({
        keycloakSub: m.id,
        username: m.username,
        email: m.email,
        jiraAccountId: match.accountId,
        jiraDisplayName: match.displayName
      });
    } else {
      unmatched.push({ keycloakSub: m.id, username: m.username, email: m.email || null });
    }
  });

  res.status(200).json({
    success: true,
    count: suggestions.length,
    data: suggestions,
    unmatched,
    // Explains an empty result instead of leaving it to be interpreted as
    // "nobody matches".
    emailMatchingAvailable: jiraWithEmail > 0,
    note:
      jiraWithEmail === 0
        ? 'Jira is not exposing email addresses for these accounts (an Atlassian privacy setting), so no ' +
          'suggestions could be made. Map people from the candidate list instead.'
        : null
  });
});

// @desc    Map one Keycloak identity to one Jira account
// @route   PUT /api/v1/linkIssue/jira/users
exports.setMapping = asyncHandler(async (req, res, next) => {
  const projectId = req.projectScope.projectId;
  const { keycloakSub, jiraAccountId } = req.body || {};
  if (!keycloakSub || !jiraAccountId) {
    return next(new ErrorResponse('keycloakSub and jiraAccountId are both required', 400));
  }

  let creds;
  try {
    creds = await credentialsOr400(projectId);
  } catch (err) {
    return next(err);
  }

  // Confirm the account exists on THIS site before storing it. A typo'd
  // accountId otherwise saves cleanly and surfaces much later as an
  // assignment that silently does nothing.
  const found = await getUser({ ...creds, accountId: jiraAccountId });
  if (!found.ok) {
    return next(
      new ErrorResponse(
        found.status === 404
          ? `No Jira account '${jiraAccountId}' exists on ${creds.baseUrl}. Pick one from ` +
            'GET /api/v1/linkIssue/jira/users/candidates — Jira identifies people by accountId, not by email.'
          : `Jira could not confirm account '${jiraAccountId}'${found.status ? ` (HTTP ${found.status})` : ''}.`,
        found.status === 404 ? 400 : 502
      )
    );
  }

  // The uniqueness rules exist so WP-144's reverse lookup is unambiguous, so
  // a collision is reported in those terms rather than as a duplicate-key
  // error from Mongo.
  const claimedBy = await JiraUserMapping.findOne({ projectId, jiraAccountId });
  if (claimedBy && claimedBy.keycloakSub !== keycloakSub) {
    return next(
      new ErrorResponse(
        `Jira account ${found.user.displayName} is already mapped to another user on this project. ` +
          'One Jira account maps to one person, so that a Jira issue\'s assignee resolves to exactly one of yours.',
        409
      )
    );
  }

  const existing = await JiraUserMapping.findOne({ projectId, keycloakSub });
  const mapping = await JiraUserMapping.findOneAndUpdate(
    { projectId, keycloakSub },
    {
      $set: {
        jiraAccountId,
        jiraDisplayName: found.user.displayName,
        jiraEmailAddress: found.user.emailAddress,
        updatedBy: actor(req)
      },
      $setOnInsert: { createdBy: actor(req) }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true }
  );

  await audit(req, {
    entityType: 'jira_user_mapping',
    entityId: keycloakSub,
    action: existing ? 'update' : 'create',
    ...(existing ? { before: { jiraAccountId: existing.jiraAccountId } } : {}),
    after: { jiraAccountId, jiraDisplayName: found.user.displayName }
  });

  res.status(existing ? 200 : 201).json({ success: true, data: mapping.toPublic() });
});

// @desc    Remove a mapping
// @route   DELETE /api/v1/linkIssue/jira/users/:keycloakSub
exports.deleteMapping = asyncHandler(async (req, res, next) => {
  const projectId = req.projectScope.projectId;
  const { keycloakSub } = req.params;
  const existing = await JiraUserMapping.findOne({ projectId, keycloakSub });
  if (!existing) {
    return next(new ErrorResponse('No Jira mapping exists for that user on this project', 404));
  }
  await JiraUserMapping.deleteOne({ _id: existing._id });

  await audit(req, {
    entityType: 'jira_user_mapping',
    entityId: keycloakSub,
    action: 'delete',
    before: { jiraAccountId: existing.jiraAccountId, jiraDisplayName: existing.jiraDisplayName }
  });

  res.status(200).json({ success: true, data: {} });
});

// ---------------------------------------------------------------------------
// The resolvers WP-144 and WP-145 use. Exported rather than duplicated so the
// degradation rule lives in one place.
// ---------------------------------------------------------------------------

// Keycloak sub -> Jira accountId.
//
// NEVER THROWS FOR AN UNMAPPED USER, which is the acceptance: "an unmapped
// user degrades to unassigned with a visible warning, never an error."
// Returning an error here would make a whole defect-to-Jira operation fail
// because one person had not been mapped yet, which on a team of ten means the
// feature is unusable until all ten are done. Instead the caller gets
// `accountId: null` plus a warning it is expected to surface.
exports.resolveJiraAccount = async function resolveJiraAccount(projectId, keycloakSub) {
  if (!keycloakSub) {
    return { accountId: null, mapped: false, warning: 'No assignee to resolve.' };
  }
  const mapping = await JiraUserMapping.findOne({ projectId, keycloakSub });
  if (!mapping) {
    return {
      accountId: null,
      mapped: false,
      warning:
        'This person has no Jira account mapped on this project, so the issue will be left unassigned. ' +
        'A project admin can map them under the project\'s Jira settings.'
    };
  }
  return {
    accountId: mapping.jiraAccountId,
    mapped: true,
    displayName: mapping.jiraDisplayName || null,
    warning: null
  };
};

// Jira accountId -> Keycloak sub, for rendering a linked issue's Jira assignee
// as somebody this product knows. Unambiguous by construction: the
// (projectId, jiraAccountId) unique index guarantees at most one.
exports.resolveLocalUser = async function resolveLocalUser(projectId, jiraAccountId) {
  if (!jiraAccountId) return { keycloakSub: null, mapped: false };
  const mapping = await JiraUserMapping.findOne({ projectId, jiraAccountId });
  if (!mapping) return { keycloakSub: null, mapped: false };
  return { keycloakSub: mapping.keycloakSub, mapped: true };
};
