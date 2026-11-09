// WP-141 — an external-issue link type.
//
// The link vocabulary was a closed set of internal modules (1 test case,
// 2 requirement, 3 test plan, 4 test run, 5 defect, 6 release). A Jira issue
// is none of them, and has no record on our side for a reverse link to point
// back to, so an external link is:
//
//   - ONE row, internal entity -> external issue. Internal links are made
//     bidirectional by the client writing a mirrored pair (linkissue.tsx);
//     there is nothing to mirror into here, and a row whose SOURCE is external
//     is refused.
//   - destinationModule EXTERNAL_MODULE (100), deliberately far from the
//     internal range so the next real module (7) never collides with it.
//     Every report that reads links (reportingService coverage/traceability/
//     releaseLens) matches explicit internal module pairs or counts unknown
//     modules as "other", so a 100 is ignored there until WP-144 surfaces it.
//   - destinationId derived server-side as `<provider>:<KEY>`, never taken from
//     the client. The unique index is {projectId, sourceId, destinationId}, and
//     a bare Jira key can be textually identical to one of our own ids (a Jira
//     project keyed TC has an issue TC-1; so do we). The namespace keeps
//     "Bug-7 -> our TC-1" and "Bug-7 -> Jira TC-1" distinct rows instead of a
//     duplicate-key error about a link the user cannot see.
//   - `external.status` / `external.fetchedAt` are a cache of the provider's
//     own data, written only by the server (WP-144). A client-supplied status
//     would be indistinguishable from a real one, so it is dropped.

const EXTERNAL_MODULE = 100;
const EXTERNAL_PROVIDERS = ['jira'];

// Jira project keys: a letter, then letters/digits/underscore, 2-10 chars in
// total by default; issue numbers start at 1.
const JIRA_KEY = /^[A-Z][A-Z0-9_]{1,9}-[1-9][0-9]{0,9}$/;
const SUMMARY_MAX = 500;

// Fields that say WHAT a link connects. They are fixed at creation; an update
// may only change what the link says about itself (its type, its summary).
const IDENTITY_FIELDS = ['projectId', 'sourceId', 'destinationId', 'srcModule', 'destinationModule', 'external'];

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function asModule(value) {
  if (value === undefined || value === null || value === '') return value;
  const n = Number(value);
  return Number.isInteger(n) ? n : value;
}

function normalizeExternal(body) {
  const external = body.external;
  if (!external || typeof external !== 'object') {
    throw badRequest(`An external link (destinationModule ${EXTERNAL_MODULE}) needs an "external" object with provider and key.`);
  }

  const provider = typeof external.provider === 'string' ? external.provider.trim().toLowerCase() : '';
  if (!EXTERNAL_PROVIDERS.includes(provider)) {
    throw badRequest(`Unsupported external provider '${String(external.provider)}'. Supported: ${EXTERNAL_PROVIDERS.join(', ')}.`);
  }

  if (typeof external.key !== 'string') {
    throw badRequest('external.key must be an issue key such as ACME-123.');
  }
  const key = external.key.trim().toUpperCase();
  if (!JIRA_KEY.test(key)) {
    throw badRequest(`'${external.key.trim().slice(0, 60)}' is not a Jira issue key. Expected the form ACME-123.`);
  }

  return { provider, key };
}

function normalizeSummary(summary) {
  if (typeof summary !== 'string') return undefined;
  const trimmed = summary.trim();
  return trimmed ? trimmed.slice(0, SUMMARY_MAX) : undefined;
}

// Returns a sanitised copy of a create body. Throws an error carrying
// statusCode 400 on invalid input.
function normalizeCreate(body) {
  const out = { ...body };
  out.srcModule = asModule(out.srcModule);
  out.destinationModule = asModule(out.destinationModule);

  if (out.srcModule === EXTERNAL_MODULE) {
    throw badRequest('An external issue cannot be the source of a link. Link from the test case, requirement or defect instead.');
  }

  if (out.destinationModule !== EXTERNAL_MODULE) {
    delete out.external;
    return out;
  }

  if (typeof out.sourceId !== 'string' || !out.sourceId.trim()) {
    throw badRequest('sourceId is required: the test case, requirement or defect this issue is linked from.');
  }

  const external = normalizeExternal(out);
  out.external = external;
  out.destinationId = `${external.provider}:${external.key}`;
  const summary = normalizeSummary(out.summary);
  if (summary === undefined) {
    delete out.summary;
  } else {
    out.summary = summary;
  }
  return out;
}

// Returns a copy of an update body with every identity field removed.
function normalizeUpdate(body) {
  const out = { ...body };
  IDENTITY_FIELDS.forEach((field) => delete out[field]);
  return out;
}

module.exports = {
  EXTERNAL_MODULE,
  EXTERNAL_PROVIDERS,
  normalizeCreate,
  normalizeUpdate
};
