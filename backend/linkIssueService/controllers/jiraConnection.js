const {
  ErrorResponse,
  asyncHandler,
  audit,
  encryptSecret,
  decryptSecret,
  isCredentialEncryptionConfigured
} = require('@srckube/service-core');
const JiraConnection = require('../models/JiraConnection');
const { validateConnection, normalizeBaseUrl } = require('../utils/jiraClient');

// WP-142 — Jira connection settings, and a validate action that calls Jira
// and reports what it found rather than saving blind.

function actor(req) {
  return req.kauth?.grant?.access_token?.content?.sub;
}

// The context that binds a sealed token to its project (WP-140). Changing the
// shape of this string makes every stored token undecryptable, so it is
// defined once.
function credentialContext(projectId) {
  return `jira:project:${projectId}`;
}

// @desc    Current Jira connection for this project, without the token
// @route   GET /api/v1/linkIssue/jira/connection
exports.getConnection = asyncHandler(async (req, res) => {
  const projectId = req.projectScope.projectId;
  // +apiTokenSealed because toPublic() derives apiTokenConfigured from it.
  // Without this the settings screen reports "no token stored" on a project
  // that has one -- select:false means absent, not empty. The value itself is
  // never returned; toPublic() excludes it.
  const connection = await JiraConnection.findOne({ projectId }).select('+apiTokenSealed');
  if (!connection) {
    // Not a 404: "this project has no Jira connection" is a normal state a
    // settings screen renders, not a missing resource.
    return res.status(200).json({ success: true, data: { projectId, configured: false } });
  }
  res.status(200).json({ success: true, data: { configured: true, ...connection.toPublic() } });
});

// Pulls the credentials a validate/save call should use: the supplied ones,
// falling back to the stored token when the caller is re-validating or
// changing another field and did not re-type it.
//
// That fallback is the difference between a settings form that works and one
// that demands the token on every edit -- and since the token is never
// returned to the client, a UI could not re-send it even if it wanted to.
async function resolveCredentials(projectId, body) {
  const supplied = {
    baseUrl: body.baseUrl,
    accountEmail: body.accountEmail,
    apiToken: body.apiToken,
    projectKeys: body.projectKeys
  };

  const needsStored = !supplied.apiToken || !supplied.baseUrl || !supplied.accountEmail || !supplied.projectKeys;
  if (!needsStored) return { ...supplied, usedStoredToken: false };

  const stored = await JiraConnection.findOne({ projectId }).select('+apiTokenSealed');
  if (!stored) return { ...supplied, usedStoredToken: false };

  let storedToken = null;
  if (!supplied.apiToken && stored.apiTokenSealed) {
    try {
      storedToken = decryptSecret(stored.apiTokenSealed, credentialContext(projectId));
    } catch (err) {
      // A token sealed under a key that is no longer in the ring, or against a
      // different project. Reported rather than silently treated as "no
      // token", which would surface as "token is required" and send the user
      // hunting for a token they already saved.
      const problem = new ErrorResponse(
        'The stored Jira token could not be decrypted. It may have been sealed with a credential key that is no ' +
          'longer configured (see CREDENTIAL_KEYS). Re-enter the API token to replace it.',
        409
      );
      problem.undecryptable = true;
      throw problem;
    }
  }

  return {
    baseUrl: supplied.baseUrl || stored.baseUrl,
    accountEmail: supplied.accountEmail || stored.accountEmail,
    apiToken: supplied.apiToken || storedToken,
    projectKeys: supplied.projectKeys || stored.projectKeys,
    usedStoredToken: !supplied.apiToken && Boolean(storedToken)
  };
}

function normalizeKeys(raw) {
  if (raw === undefined || raw === null) return undefined;
  const list = Array.isArray(raw)
    ? raw
    : String(raw)
        .split(',')
        .map((s) => s.trim());
  // Jira project keys are upper-case by convention and the API is
  // case-sensitive on them, so a lower-case key would 404 and read as
  // "invisible project".
  return [...new Set(list.filter(Boolean).map((k) => String(k).trim().toUpperCase()))];
}

// @desc    Validate a Jira connection WITHOUT saving anything
// @route   POST /api/v1/linkIssue/jira/connection/validate
exports.validate = asyncHandler(async (req, res, next) => {
  const projectId = req.projectScope.projectId;
  const body = req.body || {};
  let creds;
  try {
    creds = await resolveCredentials(projectId, { ...body, projectKeys: normalizeKeys(body.projectKeys) });
  } catch (err) {
    return next(err);
  }

  const result = await validateConnection(creds);
  // 200 whether or not it validated: the request itself succeeded, and the
  // verdict is the payload. A non-2xx here would make a UI treat "your token
  // is wrong" as a transport failure.
  res.status(200).json({
    success: true,
    data: {
      valid: result.valid,
      reason: result.reason,
      message: result.message,
      account: result.account || null,
      projects: result.projects || [],
      unreachableKeys: result.unreachableKeys || [],
      usedStoredToken: creds.usedStoredToken
    }
  });
});

// @desc    Save the Jira connection for this project
// @route   PUT /api/v1/linkIssue/jira/connection
//
// VALIDATES BEFORE PERSISTING, which is the WP's acceptance: "a wrong token, a
// wrong base URL, and a project key the account cannot see each produce a
// distinct actionable error BEFORE anything is saved." Saving first and
// validating after would leave a project configured with credentials that
// cannot work, and the next person to look would reasonably believe the
// integration was set up.
exports.saveConnection = asyncHandler(async (req, res, next) => {
  const projectId = req.projectScope.projectId;

  if (!isCredentialEncryptionConfigured()) {
    // Refused rather than stored in the clear. There is deliberately no
    // plaintext fallback: that is how a plaintext admin credential ends up in
    // the one deployment where someone forgot an env var.
    return next(
      new ErrorResponse(
        'Credential encryption is not configured on this server, so a Jira token cannot be stored. ' +
          'Set CREDENTIAL_KEYS and CREDENTIAL_ACTIVE_KEY_ID (see backend/.env.example).',
        503
      )
    );
  }

  const body = req.body || {};
  let creds;
  try {
    creds = await resolveCredentials(projectId, { ...body, projectKeys: normalizeKeys(body.projectKeys) });
  } catch (err) {
    return next(err);
  }

  const result = await validateConnection(creds);
  if (!result.valid) {
    // The reason code travels with the message so a UI can highlight the
    // offending field rather than showing a banner.
    const problem = new ErrorResponse(result.message, 400);
    problem.reason = result.reason;
    problem.unreachableKeys = result.unreachableKeys || [];
    return next(problem);
  }

  const baseUrl = normalizeBaseUrl(creds.baseUrl);
  const update = {
    projectId,
    baseUrl,
    accountEmail: String(creds.accountEmail).toLowerCase().trim(),
    projectKeys: result.projects.map((p) => p.key),
    lastValidatedAt: new Date(),
    lastValidatedBy: actor(req),
    validatedAccountId: result.account.accountId,
    validatedAccountName: result.account.displayName,
    updatedBy: actor(req)
  };

  // Only re-seal when a new token was supplied. Re-sealing the stored one on
  // every unrelated edit would churn the ciphertext for nothing.
  if (!creds.usedStoredToken) {
    update.apiTokenSealed = encryptSecret(creds.apiToken, credentialContext(projectId));
  }

  const existing = await JiraConnection.findOne({ projectId });
  const connection = await JiraConnection.findOneAndUpdate(
    { projectId },
    { $set: update, $setOnInsert: { createdBy: actor(req) } },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
      runValidators: true,
      // See the note in getConnection: toPublic() needs this to report
      // apiTokenConfigured truthfully on the save response.
      select: '+apiTokenSealed'
    }
  );

  await audit(req, {
    entityType: 'jira_connection',
    entityId: String(projectId),
    action: existing ? 'update' : 'create',
    // The token is never audited, in either direction. `before`/`after` carry
    // what changed, and a credential is not something an audit trail should
    // make readable.
    ...(existing
      ? { before: { baseUrl: existing.baseUrl, accountEmail: existing.accountEmail, projectKeys: existing.projectKeys } }
      : {}),
    after: {
      baseUrl: update.baseUrl,
      accountEmail: update.accountEmail,
      projectKeys: update.projectKeys,
      tokenReplaced: !creds.usedStoredToken
    }
  });

  res.status(existing ? 200 : 201).json({
    success: true,
    data: connection.toPublic(),
    validation: { message: result.message, account: result.account, projects: result.projects }
  });
});

// @desc    Remove the Jira connection for this project
// @route   DELETE /api/v1/linkIssue/jira/connection
exports.deleteConnection = asyncHandler(async (req, res, next) => {
  const projectId = req.projectScope.projectId;
  const existing = await JiraConnection.findOne({ projectId });
  if (!existing) {
    return next(new ErrorResponse('This project has no Jira connection', 404));
  }
  await JiraConnection.deleteOne({ projectId });

  await audit(req, {
    entityType: 'jira_connection',
    entityId: String(projectId),
    action: 'delete',
    before: { baseUrl: existing.baseUrl, accountEmail: existing.accountEmail, projectKeys: existing.projectKeys }
  });

  res.status(200).json({ success: true, data: {} });
});

// Exported for WP-143/WP-144, which need the live credentials to call Jira on
// a project's behalf. Kept here so exactly one place decrypts a token, and so
// the context string has a single definition.
exports.loadCredentials = async function loadCredentials(projectId) {
  const connection = await JiraConnection.findOne({ projectId }).select('+apiTokenSealed');
  if (!connection) return null;
  return {
    baseUrl: connection.baseUrl,
    accountEmail: connection.accountEmail,
    apiToken: decryptSecret(connection.apiTokenSealed, credentialContext(projectId)),
    projectKeys: connection.projectKeys
  };
};

exports.credentialContext = credentialContext;
