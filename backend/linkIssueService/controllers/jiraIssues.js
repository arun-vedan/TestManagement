const { ErrorResponse, asyncHandler, createLogger } = require('@srckube/service-core');
const LinkIssue = require('../models/linkIssue');
const { getIssues, searchIssues } = require('../utils/jiraClient');
const { loadCredentials } = require('./jiraConnection');
const { resolveLocalUser } = require('./jiraUsers');

const logger = createLogger('linkIssueService:jiraIssues');
const EXTERNAL_MODULE = 100;

// WP-144 — rendering a linked Jira issue's live summary, status and assignee.
//
// THE ACCEPTANCE IS ABOUT THE FAILURE CASE: "a linked issue renders current
// status; Jira unreachable shows the cached value labelled stale, never a
// broken row." So the cache is not an optimisation bolted on afterwards, it is
// the feature. Everything below is arranged around the row still rendering when
// Jira is down.
//
// Reuses the materialised-cache convention from
// reportingService/controllers/reports.js rather than inventing a second one:
// a `fetchedAt` per row acting as `computedAt`, a `staleMs` window, and on
// failure the cached value served with `stale: true` and a `staleReason` saying
// WHY. That service's own comment makes the argument this follows -- it would
// rather present a labelled-stale number than no number.
//
// WHERE THE CACHE LIVES. On the link's own `external` subdocument, which WP-141
// deliberately left room for (`status`, `fetchedAt`, with a note that WP-144
// fills them). Not a separate cache collection: the cache has exactly the same
// lifetime and tenancy as the link, so giving it its own collection would mean
// a second thing to scope, index and purge, and a way for the two to disagree.

function resolveStaleMs() {
  const raw = process.env.JIRA_ISSUE_STALE_MS;
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  // Same default as REPORT_STALE_MS. A Jira status does not change often
  // enough to justify a tighter window, and a tighter one mostly buys extra
  // calls against a rate limit.
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 5 * 60 * 1000;
}

function isFresh(external, staleMs) {
  if (!external || !external.fetchedAt) return false;
  return Date.now() - new Date(external.fetchedAt).getTime() < staleMs;
}

// The shape a row renders from. Always returns something renderable, which is
// the whole point: a caller never has to handle "no data" as a special case.
function toRow(link, { stale, staleReason }) {
  const e = link.external || {};
  return {
    linkId: link._id,
    sourceId: link.sourceId,
    srcModule: link.srcModule,
    provider: e.provider || null,
    key: e.key || null,
    summary: e.summary || null,
    status: e.status || null,
    statusCategory: e.statusCategory || null,
    issueType: e.issueType || null,
    assigneeAccountId: e.assigneeAccountId || null,
    assigneeDisplayName: e.assigneeDisplayName || null,
    // Distinct from `stale`: Jira ANSWERED and does not have this key
    // (deleted, moved, or no longer visible to the configured account). A row
    // can say "no longer in Jira" instead of showing blanks, and that is a
    // different user action from "try again later".
    missing: Boolean(e.missing),
    fetchedAt: e.fetchedAt || null,
    stale: Boolean(stale),
    staleReason: stale ? staleReason : null,
    // True when nothing has ever been cached for this key AND Jira is
    // unreachable -- the one case with genuinely nothing to show. Named so a
    // UI renders "unavailable" rather than an empty row that looks like a bug.
    neverFetched: !e.fetchedAt
  };
}

// Hydrates a set of links in place. Exported because WP-161/WP-164 and the
// traceability report all need the same "render these keys, tolerate Jira
// being down" behaviour, and a second implementation would drift.
async function hydrateLinks(projectId, links, { force = false } = {}) {
  const staleMs = resolveStaleMs();
  const external = links.filter((l) => l.destinationModule === EXTERNAL_MODULE && l.external && l.external.key);
  if (external.length === 0) return { rows: [], stale: false, staleReason: null };

  const needsFetch = force ? external : external.filter((l) => !isFresh(l.external, staleMs));
  if (needsFetch.length === 0) {
    return { rows: external.map((l) => toRow(l, { stale: false })), stale: false, staleReason: null };
  }

  const creds = await loadCredentials(projectId);
  if (!creds) {
    // No Jira connection configured. Not an error: links created before
    // WP-142 existed are legitimate, and the key is still worth showing.
    const reason = 'This project has no Jira connection configured, so live issue data cannot be fetched.';
    return {
      rows: external.map((l) => toRow(l, { stale: true, staleReason: reason })),
      stale: true,
      staleReason: reason
    };
  }

  // ONE call for every stale key, not one per link. A requirement with eight
  // linked issues would otherwise cost eight round trips on every page view.
  const result = await getIssues({
    ...creds,
    issueKeys: needsFetch.map((l) => l.external.key)
  });

  if (!result.ok) {
    // THE ACCEPTANCE CASE. Serve what is cached, labelled, rather than
    // failing the request -- a 502 here would take out the whole links panel
    // because one external row could not refresh.
    const reason = `Jira could not be reached${result.status ? ` (HTTP ${result.status})` : ''}; showing the last known values.`;
    logger.warn('jira hydration failed; serving cached values', { projectId, status: result.status });
    return {
      rows: external.map((l) => toRow(l, { stale: !isFresh(l.external, staleMs), staleReason: reason })),
      stale: true,
      staleReason: reason
    };
  }

  const byKey = new Map(result.issues.map((i) => [i.key, i]));
  const now = new Date();
  const writes = [];
  needsFetch.forEach((link) => {
    const fresh = byKey.get(link.external.key);
    if (fresh) {
      Object.assign(link.external, {
        summary: fresh.summary,
        status: fresh.status,
        statusCategory: fresh.statusCategory,
        issueType: fresh.issueType,
        assigneeAccountId: fresh.assigneeAccountId,
        assigneeDisplayName: fresh.assigneeDisplayName,
        missing: false,
        fetchedAt: now
      });
    } else {
      // Jira answered and does not have it. The previously cached summary is
      // KEPT deliberately -- a user seeing "ACME-12: Login fails (no longer in
      // Jira)" can act on it, where a blank row tells them nothing.
      link.external.missing = true;
      link.external.fetchedAt = now;
    }
    writes.push({
      updateOne: {
        filter: { _id: link._id, projectId },
        update: { $set: { external: link.external } }
      }
    });
  });

  if (writes.length) {
    // Scoped by projectId in every filter as well as by _id -- defence in
    // depth, so a write can never land on another tenant's link even if an id
    // were somehow wrong.
    await LinkIssue.bulkWrite(writes, { ordered: false });
  }

  return { rows: external.map((l) => toRow(l, { stale: false })), stale: false, staleReason: null };
}

// @desc    External (Jira) links for this project, with live display fields
// @route   GET /api/v1/linkIssue/jira/issues
// @query   sourceId? — narrow to one defect/requirement/test case
//          refresh=true — ignore the cache window
exports.listIssues = asyncHandler(async (req, res) => {
  const projectId = req.projectScope.projectId;
  const filter = { projectId, destinationModule: EXTERNAL_MODULE };
  if (req.query.sourceId) filter.sourceId = String(req.query.sourceId);

  const links = await LinkIssue.find(filter);
  const { rows, stale, staleReason } = await hydrateLinks(projectId, links, {
    force: String(req.query.refresh) === 'true'
  });

  // Resolve each Jira assignee back to a local user where WP-143 has a
  // mapping, so the UI can show a colleague rather than a Jira display name
  // that may differ from the one this product uses.
  await Promise.all(
    rows.map(async (row) => {
      if (!row.assigneeAccountId) return;
      const local = await resolveLocalUser(projectId, row.assigneeAccountId);
      row.assigneeKeycloakSub = local.keycloakSub;
      row.assigneeMapped = local.mapped;
    })
  );

  res.status(200).json({
    success: true,
    count: rows.length,
    stale,
    staleReason,
    data: rows
  });
});

// @desc    Search Jira for an issue to link
// @route   GET /api/v1/linkIssue/jira/issues/search?q=...
//
// "Search or paste an issue key" -- this is the search half. Pasting a key
// still goes through the ordinary WP-141 link-creation path, which validates
// the key's SHAPE without requiring Jira to be reachable; an unknown key then
// surfaces as `missing: true` on first hydration rather than blocking the
// link. That split is deliberate: creating a link must not depend on an
// external system being up.
exports.searchIssues = asyncHandler(async (req, res, next) => {
  const projectId = req.projectScope.projectId;
  const text = req.query.q;
  if (!text || !String(text).trim()) {
    return next(new ErrorResponse('A search term is required: pass ?q=<text>', 400));
  }

  const creds = await loadCredentials(projectId);
  if (!creds) {
    return next(
      new ErrorResponse(
        'This project has no Jira connection configured. Set one up at ' +
          'PUT /api/v1/linkIssue/jira/connection before searching.',
        409
      )
    );
  }

  const result = await searchIssues({
    ...creds,
    projectKeys: creds.projectKeys,
    text: String(text),
    maxResults: Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50)
  });

  if (!result.ok) {
    return next(
      new ErrorResponse(
        `Jira search failed${result.status ? ` (HTTP ${result.status})` : ''}. ` +
          'Re-validate the connection if this persists.',
        502
      )
    );
  }

  // Which results are already linked, so the UI does not offer a duplicate.
  const keys = result.issues.map((i) => i.key);
  const existing = await LinkIssue.find({
    projectId,
    destinationModule: EXTERNAL_MODULE,
    'external.key': { $in: keys }
  }).select('external.key sourceId');
  const linked = new Map(existing.map((l) => [l.external.key, l.sourceId]));

  res.status(200).json({
    success: true,
    count: result.issues.length,
    data: result.issues.map((i) => ({ ...i, alreadyLinkedTo: linked.get(i.key) || null }))
  });
});

exports.hydrateLinks = hydrateLinks;
exports.resolveStaleMs = resolveStaleMs;
exports.EXTERNAL_MODULE = EXTERNAL_MODULE;
