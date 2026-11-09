const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');

// Black-box HTTP tests against the running service. Container: userservice.
//
// userService was the "risky" WP-012 service (TD-03, legacy JWT). Migrating
// it onto @srckube/service-core was WP-012's job. WP-022 retired the legacy
// JWT system entirely (routes/auth.js, controllers/auth.js,
// middleware/auth.js, utils/sendEmail.js, and the password/role/
// resetPassword* fields on models/User.js) after confirming no live
// consumer exists (frontend/, srckube-kong/kong.yml, every other backend
// service -- see EXECUTION_LOG.md's WP-022 entry). /api/v1/auth/* now 404s
// like any other unmounted path; see the coverage below.
//
// WP-012b fixed a real regression WP-012 introduced: deleting userService's
// local keycloak-config.js collapsed two different uses of the Keycloak
// base URL onto one env var, KeyCloak_URI:
//   1. Issuer validation (inbound, @srckube/service-core's initKeycloak())
//      — string-matched against incoming tokens' `iss` claim, which this
//      stack mints as http://localhost:8080. Must equal the other 13
//      services' value.
//   2. Outbound admin/token API calls (controllers/users.js,
//      getKeycloakUser/getKeycloakUsers) made from inside the container,
//      where `localhost` means the container itself, not Keycloak. Must be
//      the Docker-network hostname, http://keycloak:8080.
// One var can't be both — before the fix, every real Keycloak token was
// rejected with a 403 issuer mismatch on every /api/v1/users route. The fix
// (backend/docker-compose.yml + controllers/users.js) splits this into
// KeyCloak_URI (issuer only) and KeyCloak_Admin_URI (outbound admin calls,
// falls back to KeyCloak_URI if unset).
//
// WP-012b also wired JWT_SECRET/JWT_EXPIRE/JWT_COOKIE_EXPIRE into
// docker-compose (previously absent entirely, since config/config.env is
// excluded from the Docker build by .dockerignore's **/*.env), so the
// legacy JWT register/login path now actually works instead of 500ing.
//
// The legacy generic User CRUD (GET/POST /api/v1/users, GET/PUT/DELETE
// /api/v1/users/:id, models/User.js) is RETIRED. Kong never routed it, so it
// was unreachable in production, and these tests only passed by bypassing the
// gateway -- tested API that nothing could ship. No consumer existed in
// frontend/, Kong, or any service (checked before removal). Like /api/v1/auth
// below, it now 404s, and that is what is asserted. The identity endpoints
// (/kcUser, /kcUsers, /directory) are unaffected: Kong routes /kcUser (a prefix
// that also covers /kcUsers) and /directory, and the frontend depends on them.

// WP-101 — THIS SUITE DELIBERATELY BYPASSES KONG, and must keep doing so.
//
// Every other black-box suite in this repo now defaults to Kong
// (http://localhost:8000). This one does not, because it asserts on the
// SERVICE'S OWN auth layer: keycloak.protect() rejecting a request carrying no
// token, and the correlation-id middleware's behaviour on such a request.
// Through the gateway those are unobservable — Kong's jwt plugin answers 401
// before the request ever reaches the service, so the service's 403 and its
// x-correlation-id response header never happen. Pointing this file at Kong
// does not make it stricter, it makes it test Kong instead of the service.
//
// Hence the dedicated *_DIRECT_URL names: a blanket TEST_BASE_URL=<kong> in a
// CI job or a shell must not silently capture this file and turn its
// assertions into assertions about the gateway.
//
// CONSEQUENCE FOR DROPPING THE PUBLISHED HOST PORTS (WP-101's second bullet):
// this file and userService/__tests__/api.test.js are the only two that still
// need to address a service directly. When the host ports go, they must run
// INSIDE the compose network (where `http://<service>:3000` resolves) rather
// than be rewritten — rewriting them would delete the coverage, not move it.
const BASE_URL = process.env.TEST_USERSERVICE_DIRECT_URL || 'http://localhost:3001';
const KONG_URL = process.env.TEST_KONG_URL || 'http://localhost:8000';
const DUMMY_ID = '000000000000000000000000';

const client = axios.create({
  baseURL: BASE_URL,
  validateStatus: () => true
});

function decodeJwtPayload(token) {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

describe('userService API (live)', () => {
  describe('the identity endpoints require authentication (keycloak.protect(), not Kong)', () => {
    const protectedRoutes = [
      ['get', '/api/v1/users/kcUser?id=x'],
      ['get', '/api/v1/users/kcUsers?id=x'],
      ['get', '/api/v1/users/directory']
    ];

    it.each(protectedRoutes)('%s %s rejects a request with no token', async (method, path) => {
      const resp = await client.request({ method, url: path });
      expect(resp.status).not.toBeLessThan(400);
      expect(resp.status).not.toBe(404);
    });
  });

  describe('the legacy generic /api/v1/users CRUD is gone (never Kong-routed)', () => {
    const removedRoutes = [
      ['get', '/api/v1/users'],
      ['post', '/api/v1/users'],
      ['get', `/api/v1/users/${DUMMY_ID}`],
      ['put', `/api/v1/users/${DUMMY_ID}`],
      ['delete', `/api/v1/users/${DUMMY_ID}`]
    ];

    it.each(removedRoutes)('%s %s 404s -- the route no longer exists, not "rejected"', async (method, path) => {
      const resp = await client.request({ method, url: path });
      expect(resp.status).toBe(404);
    });
  });

  describe('legacy /api/v1/auth routes are gone (WP-022, TD-03)', () => {
    const removedRoutes = [
      ['get', '/api/v1/auth/me'],
      ['put', '/api/v1/auth/updatedetails'],
      ['put', '/api/v1/auth/updatepassword'],
      ['post', '/api/v1/auth/login'],
      ['post', '/api/v1/auth/register'],
      ['get', '/api/v1/auth/logout'],
      ['post', '/api/v1/auth/forgotpassword'],
      ['put', '/api/v1/auth/resetpassword/sometoken']
    ];

    it.each(removedRoutes)('%s %s 404s -- the route no longer exists, not "rejected"', async (method, path) => {
      const resp = await client.request({ method, url: path });
      expect(resp.status).toBe(404);
    });
  });

  describe('the service accepts a real Keycloak token directly (WP-012b regression check)', () => {
    let authedClient;
    let ownUserId;

    beforeAll(async () => {
      const token = await getServiceToken();
      ownUserId = decodeJwtPayload(token).sub;
      authedClient = axios.create({
        baseURL: BASE_URL,
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true
      });
    });

    it('GET /api/v1/users/kcUser for the caller itself, straight to the container, returns 200', async () => {
      // Before WP-012b: 403 "Access denied" (KeyCloak_URI issuer mismatch,
      // see file header) on every route of this service. Resolving yourself
      // is always permitted (utils/identityVisibility.js), so a 200 here
      // proves the service's own issuer validation accepts a real token.
      // Used to be GET /api/v1/users, retired with the legacy CRUD.
      const resp = await authedClient.get('/api/v1/users/kcUser', { params: { id: ownUserId } });
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);
      expect(resp.data.data.id).toBe(ownUserId);
    });
  });

  describe('GET /api/v1/users/kcUser through Kong (Keycloak admin API proxy, WP-012b)', () => {
    // This route IS Kong-routed (srckube-kong/kong.yml, service
    // "userService") and is a real frontend dependency
    // (frontend/src/api/apiCalls.tsx: getCreatedBy). Exercised through Kong,
    // not the container directly, to catch exactly the issuer-mismatch
    // class of bug WP-012 introduced (keycloak-connect's serverUrl check
    // only fires on the real inbound request path).
    const kongClient = axios.create({ baseURL: KONG_URL, validateStatus: () => true });
    let serviceToken;
    let ownUserId;

    beforeAll(async () => {
      serviceToken = await getServiceToken();
      // The service-account client (node-microservice) is itself a Keycloak
      // user, so its own token's `sub` claim is a real, always-present user
      // id — no dependency on a specific human account existing in the
      // realm, and no hardcoded UUID to go stale.
      ownUserId = decodeJwtPayload(serviceToken).sub;
    });

    it('rejects a request with no token', async () => {
      const resp = await kongClient.get('/api/v1/users/kcUser', { params: { id: ownUserId } });
      expect(resp.status).not.toBeLessThan(400);
      expect(resp.status).not.toBe(404);
      expect(resp.status).not.toBe(500);
    });

    it('a valid service token looking up a real Keycloak user id returns that user (not 403, not 500)', async () => {
      const resp = await kongClient.get('/api/v1/users/kcUser', {
        params: { id: ownUserId },
        headers: { Authorization: `Bearer ${serviceToken}` }
      });
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);
      expect(resp.data.data.id).toBe(ownUserId);
    });

    it('a valid service token looking up an unknown Keycloak user id returns 404, not 500', async () => {
      const resp = await kongClient.get('/api/v1/users/kcUser', {
        params: { id: '00000000-0000-0000-0000-000000000000' },
        headers: { Authorization: `Bearer ${serviceToken}` }
      });
      // Before WP-012b's error-handling fix in controllers/users.js, the
      // axios rejection from Keycloak's own 404 fell through to the shared
      // errorHandler's `statusCode || 500` default, so an unknown user was
      // indistinguishable from a real outage.
      expect(resp.status).toBe(404);
      expect(resp.data.success).toBe(false);
    });
  });
});
