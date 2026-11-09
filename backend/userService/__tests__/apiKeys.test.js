const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { createTestPersona } = require('../../shared/test-utils/keycloakTestPersona');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

// WP-032 — Machine-to-machine auth (API keys / service accounts).
//
// Black-box, real-HTTP-through-Kong (GR-6), matching the pattern
// established by rbacMembers.test.js/organizationsAndProjects.test.js: a
// fresh token minted per suite run (per this session's ground rules on
// Kong sweeps), real fixtures created/torn down via the live API, never
// asserting broken behavior as correct.
//
// Acceptance criteria under test (see EXECUTION_LOG.md's WP-032 entry for
// the full narrative + manual-curl proof this suite formalizes):
//   1. hashedSecret only persisted; plaintext returned once at creation,
//      never again (list/verify never echo it back).
//   2. createdBy derived from the token, never the body.
//   3. Positive scope enforcement: a results:write key works on its own
//      route and is REJECTED (403) on a route requiring a different scope.
//   4. Project binding: a key for project X is REJECTED (403) on project Y
//      even with a correctly-formed X-Project-Id: Y header.
//   5. Revocation is immediate (no 30s membership-cache-style staleness).
//   6. Key management (create/list/revoke) is gated to project admins.
const KONG_URL = process.env.TEST_KONG_URL || 'http://localhost:8000';
const runId = Date.now();

function decodeJwtPayload(token) {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

describe('WP-032: API keys (machine-to-machine auth)', () => {
  let adminToken;
  let adminSub;
  let adminClient; // Authorization: Bearer, no X-Project-Id (set per-call)
  let projectXId; // numeric id, project 1 (pre-existing, admin is a member)
  let projectYMongoId;
  let projectYId; // numeric id of a freshly-created second project
  let orgId;
  const createdKeyIds = []; // cleanup safety net

  beforeAll(async () => {
    adminToken = await getServiceToken();
    adminSub = decodeJwtPayload(adminToken).sub;
    adminClient = axios.create({
      baseURL: KONG_URL,
      headers: { Authorization: `Bearer ${adminToken}` },
      validateStatus: () => true
    });

    const projectsResp = await adminClient.get('/api/v1/projects');
    expect(projectsResp.status).toBe(200);
    const projectX = projectsResp.data.data.find((p) => p.id === 1);
    if (!projectX) {
      throw new Error('Expected project id=1 to exist (CURRENT VERIFIED STATE precondition)');
    }
    projectXId = projectX.id;

    // A second, real project for the project-binding negative test --
    // needs a genuinely different numeric projectId, not just an unknown
    // one, to prove the key is rejected FOR A REAL PROJECT it isn't bound
    // to, not merely for an invalid id.
    const orgResp = await adminClient.post('/api/v1/organizations', {
      name: `WP-032 org ${runId}`,
      key: `wp032-org-${runId}`
    });
    expect(orgResp.status).toBe(201);
    orgId = orgResp.data.data._id;
    trackOrganization(orgId);

    const projYResp = await adminClient.post('/api/v1/projects', {
      name: `WP-032 project Y ${runId}`,
      key: `wp032-proj-y-${runId}`,
      organizationId: orgId
    });
    expect(projYResp.status).toBe(201);
    projectYMongoId = projYResp.data.data._id;
    trackProject(projectYMongoId);
    projectYId = projYResp.data.data.id;
    trackProject(projectYId);
    expect(projectYId).not.toBe(projectXId);
  }, 30000);

  afterAll(async () => {
    for (const keyId of createdKeyIds) {
      await adminClient.delete(`/api/v1/apikeys/${keyId}`, { headers: { 'X-Project-Id': String(projectXId) } }).catch(() => {});
    }
    if (projectYMongoId) {
      await adminClient.delete(`/api/v1/projects/${projectYMongoId}`).catch(() => {});
    }
    if (orgId) {
      await adminClient.delete(`/api/v1/organizations/${orgId}`).catch(() => {});
    }
  }, 30000);

  describe('creation: hashing, createdBy, project binding all come from trusted sources', () => {
    it('createdBy is derived from the token, ignoring a forged value in the body', async () => {
      const resp = await adminClient.post(
        '/api/v1/apikeys',
        { scopes: ['results:write'], name: `wp032-forged-createdby-${runId}`, createdBy: 'FORGED-ATTACKER-SUB' },
        { headers: { 'X-Project-Id': String(projectXId) } }
      );
      expect(resp.status).toBe(201);
      createdKeyIds.push(resp.data.data.keyId);
      expect(resp.data.data.createdBy).toBe(adminSub);
      expect(resp.data.data.createdBy).not.toBe('FORGED-ATTACKER-SUB');
    });

    it('projectId is derived from the X-Project-Id header, ignoring a different value in the body', async () => {
      const resp = await adminClient.post(
        '/api/v1/apikeys',
        { scopes: ['results:write'], name: `wp032-forged-project-${runId}`, projectId: projectYId },
        { headers: { 'X-Project-Id': String(projectXId) } }
      );
      expect(resp.status).toBe(201);
      createdKeyIds.push(resp.data.data.keyId);
      expect(resp.data.data.projectId).toBe(projectXId);
      expect(resp.data.data.projectId).not.toBe(projectYId);
    });

    it('the plaintext secret is returned exactly once, at creation, and never again', async () => {
      const createResp = await adminClient.post(
        '/api/v1/apikeys',
        { scopes: ['results:write'], name: `wp032-secret-once-${runId}` },
        { headers: { 'X-Project-Id': String(projectXId) } }
      );
      expect(createResp.status).toBe(201);
      createdKeyIds.push(createResp.data.data.keyId);
      expect(typeof createResp.data.data.secret).toBe('string');
      expect(createResp.data.data.secret.length).toBeGreaterThanOrEqual(32);
      expect(createResp.data.data.hashedSecret).toBeUndefined();

      const listResp = await adminClient.get('/api/v1/apikeys', { headers: { 'X-Project-Id': String(projectXId) } });
      expect(listResp.status).toBe(200);
      const found = listResp.data.data.find((k) => k.keyId === createResp.data.data.keyId);
      expect(found).toBeDefined();
      expect(found.secret).toBeUndefined();
      expect(found.hashedSecret).toBeUndefined();
    });

    it('rejects a create request with no scopes', async () => {
      const resp = await adminClient.post(
        '/api/v1/apikeys',
        { name: `wp032-no-scopes-${runId}` },
        { headers: { 'X-Project-Id': String(projectXId) } }
      );
      expect(resp.status).toBe(400);
    });

    it('rejects a create request with an unknown scope', async () => {
      const resp = await adminClient.post(
        '/api/v1/apikeys',
        { scopes: ['not-a-real-scope'], name: `wp032-bad-scope-${runId}` },
        { headers: { 'X-Project-Id': String(projectXId) } }
      );
      expect(resp.status).toBe(400);
    });
  });

  describe('scope + project-binding matrix (positive AND negative cases, real HTTP through Kong)', () => {
    let keyId;
    let secret;

    beforeAll(async () => {
      const resp = await adminClient.post(
        '/api/v1/apikeys',
        { scopes: ['results:write'], name: `wp032-matrix-${runId}` },
        { headers: { 'X-Project-Id': String(projectXId) } }
      );
      expect(resp.status).toBe(201);
      keyId = resp.data.data.keyId;
      secret = resp.data.data.secret;
      createdKeyIds.push(keyId);
    });

    it('POSITIVE: a results:write-scoped key succeeds on the route requiring results:write, on ITS OWN project, with NO bearer token at all', async () => {
      const resp = await axios.get(`${KONG_URL}/api/v1/apikeys/demo/results`, {
        headers: { 'X-Api-Key': `${keyId}.${secret}`, 'X-Project-Id': String(projectXId) },
        validateStatus: () => true
      });
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);
      expect(resp.data.via).toBe('apiKey');
      expect(resp.data.projectId).toBe(projectXId);
    });

    it('NEGATIVE (scope): the SAME key is rejected on a route requiring a scope it does not have', async () => {
      const resp = await axios.get(`${KONG_URL}/api/v1/apikeys/demo/admin`, {
        headers: { 'X-Api-Key': `${keyId}.${secret}`, 'X-Project-Id': String(projectXId) },
        validateStatus: () => true
      });
      expect(resp.status).toBe(403);
      expect(resp.data.success).toBe(false);
    });

    it('NEGATIVE (project binding): the SAME key is rejected on a DIFFERENT real project, even with a well-formed, correctly-numbered X-Project-Id header', async () => {
      const resp = await axios.get(`${KONG_URL}/api/v1/apikeys/demo/results`, {
        headers: { 'X-Api-Key': `${keyId}.${secret}`, 'X-Project-Id': String(projectYId) },
        validateStatus: () => true
      });
      expect(resp.status).toBe(403);
      expect(resp.data.error).toMatch(/not authorized for this project/i);
    });

    it('NEGATIVE: a well-formed but wrong secret is rejected', async () => {
      const resp = await axios.get(`${KONG_URL}/api/v1/apikeys/demo/results`, {
        headers: { 'X-Api-Key': `${keyId}.0000000000000000000000000000000000000000000000000000000000000000`, 'X-Project-Id': String(projectXId) },
        validateStatus: () => true
      });
      expect(resp.status).toBe(401);
    });

    it('NEGATIVE: a malformed X-Api-Key header (no ".") is rejected', async () => {
      const resp = await axios.get(`${KONG_URL}/api/v1/apikeys/demo/results`, {
        headers: { 'X-Api-Key': 'not-a-well-formed-key', 'X-Project-Id': String(projectXId) },
        validateStatus: () => true
      });
      expect(resp.status).toBe(401);
    });

    it('a valid Keycloak bearer (no X-Api-Key at all) still works unchanged on the same route', async () => {
      const resp = await axios.get(`${KONG_URL}/api/v1/apikeys/demo/results`, {
        headers: { Authorization: `Bearer ${adminToken}`, 'X-Project-Id': String(projectXId) },
        validateStatus: () => true
      });
      expect(resp.status).toBe(200);
      expect(resp.data.via).toBe('keycloak');
    });
  });

  describe('revocation is immediate, not eventually-consistent', () => {
    it('a key that worked a moment ago is rejected on the VERY NEXT request after revocation (no 30s wait)', async () => {
      const createResp = await adminClient.post(
        '/api/v1/apikeys',
        { scopes: ['results:write'], name: `wp032-revoke-${runId}` },
        { headers: { 'X-Project-Id': String(projectXId) } }
      );
      expect(createResp.status).toBe(201);
      const { keyId, secret } = createResp.data.data;
      createdKeyIds.push(keyId);

      const beforeRevoke = await axios.get(`${KONG_URL}/api/v1/apikeys/demo/results`, {
        headers: { 'X-Api-Key': `${keyId}.${secret}`, 'X-Project-Id': String(projectXId) },
        validateStatus: () => true
      });
      expect(beforeRevoke.status).toBe(200);

      const revokeResp = await adminClient.delete(`/api/v1/apikeys/${keyId}`, {
        headers: { 'X-Project-Id': String(projectXId) }
      });
      expect(revokeResp.status).toBe(200);
      expect(revokeResp.data.data.revoked).toBe(true);

      // No sleep, no retry loop -- if revocation had WP-021-style cache
      // latency this would still return 200 and the assertion below would
      // correctly fail, not be silently skipped.
      const afterRevoke = await axios.get(`${KONG_URL}/api/v1/apikeys/demo/results`, {
        headers: { 'X-Api-Key': `${keyId}.${secret}`, 'X-Project-Id': String(projectXId) },
        validateStatus: () => true
      });
      expect(afterRevoke.status).toBe(401);
      expect(afterRevoke.data.error).toMatch(/invalid or revoked/i);
    }, 20000);
  });

  describe('management endpoints are admin-only', () => {
    let persona;

    beforeAll(async () => {
      persona = await createTestPersona('wp032-contributor');
      const addResp = await adminClient.post(
        `/api/v1/projects/${(await adminClient.get('/api/v1/projects')).data.data.find((p) => p.id === projectXId)._id}/members`,
        { userId: persona.sub, role: 'contributor' }
      );
      expect(addResp.status).toBe(200);
    }, 30000);

    afterAll(async () => {
      if (persona) await persona.cleanup();
    }, 15000);

    it('a contributor (non-admin) cannot create an API key on a project they belong to', async () => {
      const token = await persona.getToken();
      const client = axios.create({ baseURL: KONG_URL, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true });
      const resp = await client.post(
        '/api/v1/apikeys',
        { scopes: ['results:write'], name: `wp032-contributor-should-fail-${runId}` },
        { headers: { 'X-Project-Id': String(projectXId) } }
      );
      expect(resp.status).toBe(403);
    });

    it('a contributor (non-admin) cannot list API keys either', async () => {
      const token = await persona.getToken();
      const client = axios.create({ baseURL: KONG_URL, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true });
      const resp = await client.get('/api/v1/apikeys', { headers: { 'X-Project-Id': String(projectXId) } });
      expect(resp.status).toBe(403);
    });
  });

  describe('unauthenticated requests are still rejected (the Kong anonymous-fallback route does NOT mean "no auth")', () => {
    it('GET /api/v1/apikeys/demo/results with no credentials at all is rejected', async () => {
      const resp = await axios.get(`${KONG_URL}/api/v1/apikeys/demo/results`, {
        headers: { 'X-Project-Id': String(projectXId) },
        validateStatus: () => true
      });
      expect([401, 403]).toContain(resp.status);
    });

    it('the strict-jwt management route (/api/v1/apikeys) still rejects AT KONG with no bearer at all', async () => {
      const resp = await axios.get(`${KONG_URL}/api/v1/apikeys`, {
        headers: { 'X-Project-Id': String(projectXId) },
        validateStatus: () => true
      });
      expect(resp.status).toBe(401);
      expect(resp.headers['x-kong-upstream-latency']).toBeUndefined();
    });
  });
});

// Suite teardown (WP-110 follow-up) — declared as its own top-level afterAll
// ON PURPOSE, not inside the suite's existing one.
//
// Jest runs afterAll hooks outermost-last, so this fires AFTER the suite's own
// cleanup has finished. Order matters: an earlier attempt called this first,
// which hard-deleted the fixture project before the suite's own teardown tried
// to touch it -- that teardown then logged a warning after the test run had
// ended, and Jest failed the whole suite with "Cannot log after tests are
// done" even though every test passed.
//
// Why this is needed at all: DELETE /api/v1/projects only ARCHIVES (the
// deliberate WP-022 project-deletion-orphaning decision), while
// DELETE /api/v1/organizations hard-deletes. API-only teardown therefore left
// the project behind with its organization gone -- which is where this
// environment's 701 orphaned projects came from. See
// shared/test-utils/fixtureCleanup.js.
afterAll(() => {
  purgeTrackedFixtures();
});
