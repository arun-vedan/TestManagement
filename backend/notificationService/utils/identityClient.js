const axios = require('axios');
const { createLogger } = require('@srckube/service-core');

const logger = createLogger('notificationService:identityClient');

// WP-031 — resolves "who is a project manager on project X", for the
// status-changed(to: 'review') -> notify project managers rule
// (consumers/notificationConsumer.js). This is a background consumer, not a
// request handler, so there is no caller token to forward (unlike
// service-core's requireProjectScope(), which forwards the INCOMING
// request's Authorization header to userService) -- a service-account token
// has to be minted here instead.
//
// Same client_credentials grant, same client_id ('node-microservice'), same
// KeyCloak_Secret env var as userService's own outbound Keycloak Admin API
// calls (backend/userService/controllers/users.js's getKeycloakUser) -- not
// a new credential, the existing service-account identity every service in
// this stack already has via KeyCloak_Secret.
//
// WP-012b: an outbound call FROM INSIDE a container must reach Keycloak via
// KeyCloak_Admin_URI (the Docker-network hostname, http://keycloak:8080) --
// KeyCloak_URI (http://localhost:8080) is unreachable from inside a
// container (localhost there is the container itself).
//
// BUT -- verified empirically (see EXECUTION_LOG.md's WP-031 report) -- the
// token this mints is then USED AGAINST ANOTHER srckube SERVICE
// (userService's own keycloak.protect(), not Keycloak's admin API, unlike
// every other KeyCloak_Admin_URI caller in this codebase, e.g.
// userService/controllers/users.js). keycloak-connect derives a token's
// expected issuer from the URL it verifies it against (KeyCloak_URI on
// EVERY service, http://localhost:8080/realms/srckube), and Keycloak itself
// stamps a minted token's `iss` claim from the Host header of the request
// that minted it -- so a token requested via `http://keycloak:8080` carries
// iss: http://keycloak:8080/realms/srckube, which mismatches what
// userService's keycloak.protect() checks incoming tokens against and gets
// rejected 403, the exact WP-012b issuer-mismatch failure mode in a new
// context. Fixed by overriding the outbound request's Host header to the
// same value KeyCloak_URI's host:port has -- reachability still goes over
// the real Docker-network hostname (the TCP connection), only the Host
// header (which Keycloak reads to compute `iss`) is overridden, so the
// resulting token's issuer matches what every consuming service expects.
function keycloakTokenHostHeader() {
  const uri = process.env.KeyCloak_URI;
  if (!uri) {
    return null;
  }
  try {
    return new URL(uri).host;
  } catch (err) {
    return null;
  }
}

function keycloakTokenBaseUrl() {
  return process.env.KeyCloak_Admin_URI || process.env.KeyCloak_URI;
}

function userServiceBaseUrl() {
  // Same env-var-named-after-target-service, reach-by-container-name
  // convention as every other cross-service caller in this codebase (e.g.
  // defectService's istatusService, requirementService/testRepoService/
  // defectService's userService for requireProjectScope()).
  const target = process.env.userService;
  return target ? `http://${target}` : null;
}

// Cached in-process, refreshed a little before real expiry -- mirrors
// service-core's projectScope.js caching a short-lived cross-service
// resource rather than re-fetching on every call, just for a token instead
// of a project list.
let cachedToken = null; // { token, expiresAt }

async function getServiceAccountToken() {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now) {
    return cachedToken.token;
  }

  const base = keycloakTokenBaseUrl();
  if (!base) {
    throw new Error(
      'Neither KeyCloak_Admin_URI nor KeyCloak_URI is configured; cannot mint a service-account token'
    );
  }

  const body = new URLSearchParams({
    client_id: process.env.KeyCloak_clientId || 'node-microservice',
    grant_type: 'client_credentials',
    client_secret: process.env.KeyCloak_Secret
  });

  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const hostHeader = keycloakTokenHostHeader();
  if (hostHeader) {
    // See keycloakTokenHostHeader()'s comment above -- overrides only the
    // Host header Keycloak reads to stamp `iss`, not where the request
    // actually connects to (still the real KeyCloak_Admin_URI host).
    headers.Host = hostHeader;
  }

  const resp = await axios.post(
    `${base}/realms/${process.env.KeyCloak_Realm || 'srckube'}/protocol/openid-connect/token`,
    body,
    { headers, timeout: 5000 }
  );

  const token = resp.data.access_token;
  // expires_in is seconds; refresh 5s early so a call issued right at the
  // boundary never races an expired token.
  const ttlMs = Math.max((resp.data.expires_in || 60) * 1000 - 5000, 5000);
  cachedToken = { token, expiresAt: now + ttlMs };
  return token;
}

// Resolves the userIds of every project member with role === 'manager' on
// the given NUMERIC projectId (the id every event payload in this codebase
// carries -- see eventStreams.js's STATUS_CHANGED producers). Deliberately
// goes through GET /api/v1/projects (the unfiltered list) and finds by
// numeric `id` client-side, the exact same shape service-core's
// requireProjectScope()/fetchProjects() uses -- NOT
// GET /api/v1/projects/:id, which keys off the Mongo `_id`, not this
// numeric id, and would need a second lookup to translate one into the
// other for no benefit.
async function resolveProjectManagers(projectId, correlationId) {
  const base = userServiceBaseUrl();
  if (!base) {
    logger.warn('userService env var not configured; cannot resolve project managers', {
      projectId,
      correlationId
    });
    return [];
  }

  const token = await getServiceAccountToken();
  const resp = await axios.get(`${base}/api/v1/projects`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'x-correlation-id': correlationId || ''
    },
    timeout: 5000
  });

  const projects = (resp.data && resp.data.data) || [];
  const project = projects.find((p) => p.id === projectId);
  if (!project || !Array.isArray(project.members)) {
    return [];
  }

  return project.members.filter((m) => m.role === 'manager').map((m) => m.userId);
}

// Test-only escape hatch, same pattern as service-core's
// _resetEventsForTests/_resetProjectCacheForTests -- lets a test observe
// "cold cache" behavior without a real 5s-early-expiry wait.
function _resetIdentityClientForTests() {
  cachedToken = null;
}

module.exports = { getServiceAccountToken, resolveProjectManagers, _resetIdentityClientForTests };
