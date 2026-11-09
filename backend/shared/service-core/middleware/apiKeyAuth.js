const ErrorResponse = require('../utils/errorResponse');
const { requestWithRetry } = require('../httpClient');
const { HEADER_NAME: CORRELATION_HEADER } = require('../correlationId');
const { createLogger } = require('../logger');
const { initKeycloak } = require('../keycloak');
const { PROJECT_ID_HEADER } = require('./projectScope');

const logger = createLogger('service-core:apiKeyAuth');

// WP-032 — Machine-to-machine auth (API keys / service accounts).
//
// requireAuth(requiredScope) replaces keycloak.protect() as the FIRST
// auth-checking middleware on a route. It accepts EITHER credential type:
//
//   - `X-Api-Key: <keyId>.<secret>` header present -> validated against
//     userService's internal verify endpoint (see
//     backend/userService/controllers/apikeys.js verifyApiKey). On success
//     this middleware does the FULL job that requireProjectScope()+
//     authorize() would otherwise do for a human caller: it checks the
//     key's scopes include `requiredScope` (positive allow-list, not a
//     denylist -- SECURITY REQUIREMENT #3) and that the key's bound
//     projectId matches the request's X-Project-Id header EXACTLY
//     (SECURITY REQUIREMENT #4 -- a key for project X must be rejected on
//     project Y even with a correct-looking header). It then sets
//     req.apiKeyAuth and a pre-satisfied req.projectScope so that
//     requireProjectScope()/authorize(), still mounted downstream on the
//     route unchanged, short-circuit as already-satisfied instead of
//     re-running their human-membership-array logic (which an API key,
//     not being a project member, could never satisfy). See the
//     `if (req.apiKeyAuth)` early-return added to both of those files.
//
//   - No `X-Api-Key` header -> delegates to the exact same
//     keycloak.protect() every route used before this WP. Zero behavior
//     change for every existing bearer-token caller.
//
// Deliberately NOT cached (SECURITY REQUIREMENT #5): every API-key request
// does a live lookup against userService's DB. WP-021's
// requireProjectScope() 30s cache is a documented, accepted staleness
// window for human membership; a revoked API key is a materially
// different, higher-stakes property (this WP's whole premise is CI
// systems calling in unattended) and a live lookup is cheap (single
// indexed Mongo query, no join) — so revocation takes effect on the very
// next request, not up to 30s later. This is a deliberate different
// tradeoff from projectScope.js's cache, not an oversight; see
// EXECUTION_LOG.md's WP-032 entry for the measured revoke-then-call proof.
function getIdentityServiceBaseUrl() {
  const target = process.env.userService;
  return target ? `http://${target}` : null;
}

async function verifyApiKey(keyId, secret, forwardHeaders) {
  const base = getIdentityServiceBaseUrl();
  if (!base) {
    throw new Error(
      "userService env var not configured; can't reach the identity service to verify the API key"
    );
  }
  const resp = await requestWithRetry(
    {
      method: 'post',
      url: `${base}/api/v1/apikeys/verify`,
      headers: forwardHeaders,
      data: { keyId, secret }
    },
    { retries: 1, timeout: 3000 }
  );
  return resp.data;
}

function requireAuth(requiredScope) {
  const keycloak = initKeycloak();
  const protectMiddleware = keycloak.protect();

  return async function requireAuthMiddleware(req, res, next) {
    const apiKeyHeader = req.headers['x-api-key'];

    if (!apiKeyHeader) {
      // No API key presented -- exactly the pre-WP-032 behavior.
      return protectMiddleware(req, res, next);
    }

    const raw = String(apiKeyHeader);
    const sepIndex = raw.indexOf('.');
    if (sepIndex <= 0 || sepIndex === raw.length - 1) {
      return next(new ErrorResponse('Malformed X-Api-Key header; expected "<keyId>.<secret>"', 401));
    }
    const keyId = raw.slice(0, sepIndex);
    const secret = raw.slice(sepIndex + 1);

    const forwardHeaders = {};
    if (req.correlationId) {
      forwardHeaders[CORRELATION_HEADER] = req.correlationId;
    }

    let result;
    try {
      result = await verifyApiKey(keyId, secret, forwardHeaders);
    } catch (err) {
      logger.error('identity service unavailable; failing closed on API key verification', {
        correlationId: req.correlationId,
        error: err.message
      });
      return next(new ErrorResponse('Unable to verify API key: identity service unavailable', 503));
    }

    if (!result || result.valid !== true) {
      return next(new ErrorResponse('Invalid or revoked API key', 401));
    }

    const scopes = Array.isArray(result.scopes) ? result.scopes : [];

    // SECURITY REQUIREMENT #3 -- positive enumeration. requiredScope is the
    // exact scope this ROUTE demands; a key must have it explicitly listed.
    // There is no wildcard/superset scope in this WP's design, so "can do
    // X and nothing else" falls straight out of this one check.
    if (requiredScope && !scopes.includes(requiredScope)) {
      return next(
        new ErrorResponse(`API key does not have the required scope '${requiredScope}'`, 403)
      );
    }

    // SECURITY REQUIREMENT #4 -- project binding. The route's project
    // context (X-Project-Id header, same convention requireProjectScope()
    // uses) MUST match the key's own bound projectId. Required present AND
    // matching -- fail closed on a missing header too, rather than
    // silently defaulting to the key's own project, so the contract is
    // unambiguous and independently testable.
    const rawProjectId = req.headers[PROJECT_ID_HEADER];
    if (!rawProjectId) {
      return next(new ErrorResponse(`Missing required ${PROJECT_ID_HEADER} header`, 403));
    }
    const requestedProjectId = Number(rawProjectId);
    if (!Number.isInteger(requestedProjectId) || requestedProjectId !== result.projectId) {
      return next(new ErrorResponse('API key is not authorized for this project', 403));
    }

    req.apiKeyAuth = { keyId: result.keyId, projectId: result.projectId, scopes };
    // Pre-satisfy requireProjectScope()'s output shape so downstream
    // middleware/controllers that read req.projectScope.projectId keep
    // working unchanged for API-key-authenticated requests too.
    req.projectScope = { projectId: result.projectId, project: null };
    return next();
  };
}

module.exports = { requireAuth };
