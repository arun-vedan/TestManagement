const ErrorResponse = require('../utils/errorResponse');
const { requestWithRetry } = require('../httpClient');
const { HEADER_NAME: CORRELATION_HEADER } = require('../correlationId');
const { createLogger } = require('../logger');

const logger = createLogger('service-core:projectScope');

// WP-021 — Tenant scoping middleware.
//
// CONVENTION (pick-one, documented): the caller supplies the numeric
// project id via the request HEADER `X-Project-Id` (read case-insensitively
// as `x-project-id`, matching how every other framework/Node HTTP stack
// lower-cases incoming header names) — NOT a query string or body field.
// Chosen over query/body for two reasons:
//   1. A header applies uniformly across every verb (GET list, GET single,
//      POST create, PUT update, DELETE) without needing a different
//      extraction rule per route or polluting the write payload's JSON body
//      with a piece of request-authorization metadata that isn't part of
//      the resource itself.
//   2. It matches the precedent already set by this same library's
//      correlation-id header (`x-correlation-id`, see correlationId.js) —
//      one consistent place (headers) for cross-cutting request metadata,
//      separate from both the resource payload (body) and resource
//      filters/pagination (query).
const PROJECT_ID_HEADER = 'x-project-id';

// ---------------------------------------------------------------------------
// WP-110 architecture (c) — how membership is resolved, and what changed.
//
// BEFORE: this middleware answered "is the caller a member of project X" by
// GETting userService's unfiltered `GET /api/v1/projects` and caching the
// entire response ONCE, GLOBALLY, shared across every caller. That had two
// consequences the WP-110 brief called the keystone problem:
//
//   1. The list endpoint could not be scoped to the caller's organization —
//      filtering it per caller would have made the one shared cache wrong for
//      everyone else. So the tenant-enumeration hole was load-bearing: every
//      authenticated user could read every project's id, name and full
//      members[] array, and that was documented as an accepted trade because
//      this middleware depended on it.
//   2. Every service held every project's membership list in memory to answer
//      a question about one caller and one project.
//
// AFTER: this middleware asks userService a scoped question —
// `GET /api/v1/projects/scope/:projectId` — which answers only for the
// CALLING user and returns only { projectId, role, status, organizationId }.
// No members[] array, no other project, nothing about projects the caller
// cannot access (403, never 404, for both "not a member" and "no such
// project", so existence is never disclosed). `GET /api/v1/projects` is
// consequently free to be organization-scoped without breaking anything here.
//
// The three fields are exactly what is consumed downstream — established by
// survey rather than assumption: middleware/authorize.js needs the caller's
// own role and the project status (archived ⇒ read-only), audit.js needs
// organizationId, and no controller in any service reads the project document
// at all.
// ---------------------------------------------------------------------------

// CACHING. The old cache was a single unkeyed entry, which is precisely why it
// could not hold a per-caller answer. This one is keyed by
// (caller subject, projectId), so a cached answer is only ever served to the
// caller it was computed for — the leak is structurally impossible rather than
// merely avoided by convention.
//
// Both positive and negative answers are cached, deliberately. Caching only
// positives would mean every denied request re-hits userService, which hands
// any authenticated stranger a cheap amplification vector against the identity
// service by spamming project ids they do not belong to.
//
// The cost is the staleness window that already exists and is already
// documented: a membership change takes up to PROJECT_SCOPE_CACHE_TTL_MS
// (default 30s) to take effect. See LAUNCH_PLAN.md's operational warnings —
// this lag previously produced one false "authorize() isn't wired" conclusion
// during WP-022. The isolation suites shrink the window via the env var rather
// than sleeping 30s per assertion.
const DEFAULT_CACHE_TTL_MS = 30 * 1000;

function resolveCacheTtlMs() {
  const raw = process.env.PROJECT_SCOPE_CACHE_TTL_MS;
  if (raw !== undefined && raw !== '') {
    const parsed = parseInt(raw, 10);
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return DEFAULT_CACHE_TTL_MS;
}

// Map<"sub::projectId", { expiresAt, scope|null }>. scope === null is a cached
// denial.
let scopeCache = new Map();

function cacheKey(userSub, projectId) {
  return `${userSub}::${projectId}`;
}

// Test-only escape hatch so unit tests don't leak cache state across cases.
function _resetProjectCacheForTests() {
  scopeCache = new Map();
}

function getIdentityServiceBaseUrl() {
  // Same convention as WP-010's ISTATUS_SERVICE (defectService ->
  // istatusservice): an env var named after the target service, holding
  // `container:port` for the Docker network (see backend/docker-compose.yml),
  // reached by container name, never `localhost` (WP-012b regression class
  // — localhost inside a container is the container itself).
  const target = process.env.userService;
  return target ? `http://${target}` : null;
}

// Resolves the caller's scope on one project.
//
// Returns the scope object on success, or null when userService answered with
// a definite "no access" (403). Throws only for an indeterminate outcome —
// unreachable, 5xx, malformed body — which the caller turns into a fail-closed
// 503. Keeping "denied" and "could not tell" apart is the whole point: the old
// implementation could not confuse them because it never asked a question that
// could be answered "no", and collapsing them now would either turn an outage
// into a silent mass-denial or turn a denial into a 503.
async function fetchScope(projectId, userSub, forwardHeaders) {
  const key = cacheKey(userSub, projectId);
  const now = Date.now();
  const hit = scopeCache.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.scope;
  }

  const base = getIdentityServiceBaseUrl();
  if (!base) {
    throw new Error(
      "userService env var not configured; can't reach the identity service to verify project membership"
    );
  }

  let resp;
  try {
    resp = await requestWithRetry(
      {
        method: 'get',
        url: `${base}/api/v1/projects/scope/${projectId}`,
        headers: forwardHeaders
      },
      { retries: 1, timeout: 3000 }
    );
  } catch (err) {
    const status = err.response && err.response.status;
    if (status === 403 || status === 400) {
      // A definite answer: this caller has no access to this project (or the
      // id was not usable). Cache the denial — see the CACHING note above.
      scopeCache.set(key, { scope: null, expiresAt: now + resolveCacheTtlMs() });
      return null;
    }
    throw err;
  }

  const scope = resp.data && resp.data.data;
  if (!scope || typeof scope.projectId !== 'number' || typeof scope.role !== 'string') {
    throw new Error('Unexpected response shape from identity service GET /api/v1/projects/scope/:projectId');
  }

  scopeCache.set(key, { scope, expiresAt: now + resolveCacheTtlMs() });
  return scope;
}

// requireProjectScope() — opt-in per route/service (NOT applied globally in
// applyStandardSecurity(), per the WP-021 dispatch brief: a service-core
// change is picked up by all 14 services on rebuild, and most of them have
// no concept of projectId at all — see EXECUTION_LOG.md's WP-021 survey).
// Mount it after keycloak.protect() (it needs req.kauth) and, for list
// routes, before advancedResults() (it sets req.projectScope, which
// advancedResults reads to add the tenant filter — see
// middleware/advancedResults.js).
//
// Behavior:
//   - No `x-project-id` header, or a non-integer value            -> 403
//   - Header present but no project with that numeric id exists   -> 403
//     (WP-021 acceptance: "foreign/missing projectId -> 403" — an unknown
//     project id is treated the same as a foreign one, not a 404, so this
//     middleware never confirms/denies whether a given id exists to an
//     unauthenticated-for-it caller beyond "you don't have access to it")
//   - Header present, project exists, caller is not a member      -> 403
//   - Identity service (userService) unreachable/errors            -> 503,
//     FAIL CLOSED. Same call as WP-010's istatusservice-unavailable
//     decision (backend/defectService/controllers/defects.js
//     updateDefectStatus) and for the same reason, only more so: this is a
//     tenant-isolation boundary, not a workflow-validation one. Failing
//     open here would let ANY authenticated user read/write ANY project's
//     data for the duration of an identity-service outage -- a worse
//     failure mode than a temporary 503. requestWithRetry already absorbs
//     transient network blips/5xxs with backoff before this gives up.
//   - Success: sets req.projectScope = { projectId, role, status, project }
//     and calls next(). Every controller in a migrated service MUST use
//     req.projectScope.projectId in its Mongo filter — see
//     testRepoService/requirementService/defectService controllers.
//
//     `project` is a MINIMAL object ({ id, status, organizationId }), not the
//     full document this middleware used to attach. It exists so audit.js's
//     `req.projectScope.project.organizationId` read keeps working unchanged;
//     `role` is now a first-class field because authorize.js can no longer
//     re-derive it from a members[] array that is deliberately no longer sent.
function requireProjectScope() {
  return async function projectScopeMiddleware(req, res, next) {
    // WP-032: an API-key-authenticated request already had its project
    // binding fully verified (key.projectId === X-Project-Id header,
    // checked exactly, not just cached) by requireAuth() in
    // middleware/apiKeyAuth.js, which also pre-set req.projectScope. Re-running
    // this middleware's membership lookup would be wrong here (an API key is
    // never a member of Project.members[]) and is unnecessary -- short-circuit
    // as already-satisfied.
    if (req.apiKeyAuth) {
      return next();
    }

    const raw = req.headers[PROJECT_ID_HEADER];
    if (!raw) {
      return next(new ErrorResponse(`Missing required ${PROJECT_ID_HEADER} header`, 403));
    }

    const projectId = Number(raw);
    if (!Number.isInteger(projectId)) {
      return next(new ErrorResponse(`Invalid ${PROJECT_ID_HEADER} header: must be an integer`, 403));
    }

    const grant = req.kauth && req.kauth.grant && req.kauth.grant.access_token && req.kauth.grant.access_token.content;
    const userSub = grant && grant.sub;
    if (!userSub) {
      // requireProjectScope() must run after keycloak.protect(); a missing
      // token subject here means it's wired in wrong upstream, not a
      // legitimate anonymous case (keycloak.protect() would already have
      // rejected an unauthenticated request).
      return next(new ErrorResponse('Authenticated user identity not found on request', 401));
    }

    const forwardHeaders = {};
    if (req.headers.authorization) {
      forwardHeaders.authorization = req.headers.authorization;
    }
    if (req.correlationId) {
      forwardHeaders[CORRELATION_HEADER] = req.correlationId;
    }

    let scope;
    try {
      scope = await fetchScope(projectId, userSub, forwardHeaders);
    } catch (err) {
      logger.error('identity service unavailable; failing closed on project scope check', {
        correlationId: req.correlationId,
        projectId,
        error: err.message
      });
      return next(
        new ErrorResponse('Unable to verify project membership: identity service unavailable', 503)
      );
    }

    if (!scope) {
      // Deliberately the same message shape for "not a member" and "no such
      // project" — see the Behavior note above on not disclosing existence.
      return next(new ErrorResponse(`User is not a member of project '${projectId}'`, 403));
    }

    req.projectScope = {
      projectId,
      role: scope.role,
      status: scope.status,
      project: {
        id: scope.projectId,
        status: scope.status,
        organizationId: scope.organizationId
      }
    };
    next();
  };
}

module.exports = { requireProjectScope, PROJECT_ID_HEADER, _resetProjectCacheForTests };
