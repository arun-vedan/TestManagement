const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

// Wave A-1 -- Multi-tenancy isolation suite for fieldsService's `/field`
// routes (the hole this route shipped with -- WP-012's service-core
// migration moved this service onto the shared library but never adopted
// WP-021's requireProjectScope()/authorize() chain, unlike this same
// service's savedView.js sibling from WP-043). Mirrors
// backend/requirementService/__tests__/tenantIsolation.test.js's design:
// only one real Keycloak identity is available to this harness, so
// isolation is proven along two independent axes -- query-level filtering
// (member of both projects) and membership-level authorization (member of
// only one).
//
// Project A = the seeded Default Project (id=1, WP-020 backfill).
// Project B = a fresh Organization+Project created by this suite.

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';
const USER_SERVICE_URL = process.env.TEST_USER_SERVICE_URL || 'http://localhost:8000';
const DUMMY_ID = '000000000000000000000000';
const runId = Date.now();

function decodeJwtPayload(token) {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

// requireProjectScope()'s in-process project-list cache (see
// projectScope.js, PROJECT_SCOPE_CACHE_TTL_MS) is global to the container,
// not per-request -- retry a handful of times, well within the local/test
// TTL, rather than flake on that race (same helper as the other
// WP-021-migrated services' isolation suites).
async function postWithCacheRetry(axiosClient, url, body, headers, { retries = 8, delayMs = 400 } = {}) {
  let resp;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    resp = await axiosClient.post(url, body, headers);
    if (resp.status !== 403) return resp;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return resp;
}

describe('fieldsService tenant isolation (Wave A-1, release-blocking)', () => {
  let token;
  let sub;
  let client; // authed client for fieldsService, no default X-Project-Id
  let userServiceClient; // authed client for userService (org/project admin)
  let projectAId; // numeric id, always 1 (Default Project)
  let projectBId; // numeric id, freshly created
  let projectBMongoId;
  let orgBId;
  let foreignEntityId; // _id of a Field created under project B

  const withScope = (projectId) => ({ headers: { [PROJECT_ID_HEADER]: String(projectId) } });

  const newField = (overrides = {}) => ({
    fieldName: `wp021_isolation_field_${runId}`,
    displayName: 'WP-021 isolation field',
    fieldType: 'Text',
    moduleId: 1,
    isDisplayed: true,
    isDefault: false,
    isEnabled: true,
    isMandatory: false,
    ...overrides
  });

  beforeAll(async () => {
    token = await getServiceToken();
    sub = decodeJwtPayload(token).sub;

    client = axios.create({
      baseURL: BASE_URL,
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true
    });
    userServiceClient = axios.create({
      baseURL: USER_SERVICE_URL,
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true
    });

    // --- Ensure this identity is a member of Project A (Default, id=1) ---
    const listResp = await userServiceClient.get('/api/v1/projects');
    expect(listResp.status).toBe(200);
    const projectA = listResp.data.data.find((p) => p.id === 1);
    expect(projectA).toBeDefined(); // WP-020 backfill precondition
    projectAId = projectA.id;
    const addToA = await userServiceClient.post(`/api/v1/projects/${projectA._id}/members`, {
      userId: sub,
      role: 'admin'
    });
    expect(addToA.status).toBe(200);

    // --- Create Project B (this identity is auto-added as admin creator) ---
    const orgResp = await userServiceClient.post('/api/v1/organizations', {
      name: `WP-021 isolation org (fields) ${runId}`,
      key: `wp021-iso-org-fields-${runId}`
    });
    expect(orgResp.status).toBe(201);
    orgBId = orgResp.data.data._id;
    trackOrganization(orgBId);

    const projResp = await userServiceClient.post('/api/v1/projects', {
      name: `WP-021 isolation project B (fields) ${runId}`,
      key: `wp021-iso-proj-b-fields-${runId}`,
      organizationId: orgBId
    });
    expect(projResp.status).toBe(201);
    projectBId = projResp.data.data.id;
    trackProject(projectBId);
    projectBMongoId = projResp.data.data._id;
    trackProject(projectBMongoId);
    expect(projectBId).not.toBe(projectAId);

    // --- Seed one "foreign" Field under project B, while still a member ---
    const createResp = await postWithCacheRetry(
      client,
      '/api/v1/fields',
      newField(),
      withScope(projectBId)
    );
    expect(createResp.status).toBe(201);
    expect(createResp.data.data.projectId).toBe(projectBId);
    foreignEntityId = createResp.data.data._id;
    // NOTE: membership in B is intentionally left in place here -- section 1
    // below needs it. It's revoked in section 2's own beforeAll, after
    // section 1 has run.
  }, 20000);

  afterAll(async () => {
    if (projectBMongoId) {
      await userServiceClient.post(`/api/v1/projects/${projectBMongoId}/members`, { userId: sub, role: 'admin' });
    }
    if (foreignEntityId) {
      // Section 2 revoked this identity's membership in B, then waited out
      // the cache TTL for the revocation to take effect. Re-adding
      // membership just above does not itself wait out that same cache --
      // a request landing immediately after can still see the stale
      // "not a member" cache entry and 403, which would silently leak this
      // document (reproduced once while developing this suite: an
      // un-retried delete here left an orphaned Field behind with a
      // projectId matching a since-deleted project). Retry through the
      // cache window rather than risk that.
      let delResp;
      for (let attempt = 0; attempt <= 8; attempt += 1) {
        delResp = await client.delete(`/api/v1/fields/${foreignEntityId}`, withScope(projectBId));
        if (delResp.status !== 403) break;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
    if (projectBMongoId) {
      await userServiceClient.delete(`/api/v1/projects/${projectBMongoId}`);
    }
    if (orgBId) {
      await userServiceClient.delete(`/api/v1/organizations/${orgBId}`);
    }
  });

  describe('1. Query-level isolation (member of both A and B)', () => {
    it('GET list scoped to A does not include B\'s document', async () => {
      const resp = await client.get('/api/v1/fields', withScope(projectAId));
      expect(resp.status).toBe(200);
      expect(resp.data.data.some((f) => f._id === foreignEntityId)).toBe(false);
    });

    it('GET list scoped to B DOES include B\'s document (positive control)', async () => {
      const resp = await client.get('/api/v1/fields', withScope(projectBId));
      expect(resp.status).toBe(200);
      expect(resp.data.data.some((f) => f._id === foreignEntityId)).toBe(true);
    });

    // THE VULNERABILITY (Wave A-1): before the fix, getField() resolved by
    // bare Mongo _id with no project check at all, so this returned 200
    // with B's full document while scoped to A. Must 404, not leak
    // existence.
    it('GET single, scoped to A, 404s on B\'s document (not found, not leaked)', async () => {
      const resp = await client.get(`/api/v1/fields/${foreignEntityId}`, withScope(projectAId));
      expect(resp.status).toBe(404);
      expect(resp.data.success).toBe(false);
    });

    // THE VULNERABILITY: before the fix, updateField() used
    // findByIdAndUpdate(req.params.id, ...) with no project check, so any
    // authenticated user in any project could rewrite another project's
    // field definitions.
    it('PUT, scoped to A, cannot modify B\'s document', async () => {
      const resp = await client.put(
        `/api/v1/fields/${foreignEntityId}`,
        { displayName: 'HIJACKED from project A' },
        withScope(projectAId)
      );
      expect(resp.status).toBe(404);

      const verify = await client.get(`/api/v1/fields/${foreignEntityId}`, withScope(projectBId));
      expect(verify.data.data.displayName).toBe('WP-021 isolation field');
    });

    // THE VULNERABILITY: before the fix, deleteField() used
    // findByIdAndDelete(req.params.id) with no project check, so any
    // authenticated user in any project could delete another project's
    // field definitions.
    it('DELETE, scoped to A, cannot delete B\'s document', async () => {
      const resp = await client.delete(`/api/v1/fields/${foreignEntityId}`, withScope(projectAId));
      expect(resp.status).toBe(404);

      const verify = await client.get(`/api/v1/fields/${foreignEntityId}`, withScope(projectBId));
      expect(verify.status).toBe(200); // still there
    });

    it('createField ignores a client-supplied foreign projectId and stamps the requesting project instead', async () => {
      const resp = await client.post(
        '/api/v1/fields',
        newField({ fieldName: `wp021_spoof_attempt_${runId}`, projectId: projectBId }),
        withScope(projectAId)
      );
      expect(resp.status).toBe(201);
      expect(resp.data.data.projectId).toBe(projectAId); // NOT the spoofed projectBId
      // cleanup: this one really does belong to A
      await client.delete(`/api/v1/fields/${resp.data.data._id}`, withScope(projectAId));
    });
  });

  describe('2. Membership-level authorization (identity is NOT a member of B)', () => {
    beforeAll(async () => {
      const removeResp = await userServiceClient.delete(`/api/v1/projects/${projectBMongoId}/members/${sub}`);
      expect(removeResp.status).toBe(200);

      // requireProjectScope()'s in-process cache (PROJECT_SCOPE_CACHE_TTL_MS,
      // backend/.env in local/test) is 2000ms.
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }, 20000);

    it('claiming scope B outright is rejected with 403, not 404 (this identity is genuinely not a member)', async () => {
      const resp = await client.get('/api/v1/fields', withScope(projectBId));
      expect(resp.status).toBe(403);
      expect(resp.data.success).toBe(false);
    });

    it('a write attempt claiming scope B is rejected with 403', async () => {
      const resp = await client.post('/api/v1/fields', newField({ fieldName: 'should_never_be_created' }), withScope(projectBId));
      expect(resp.status).toBe(403);
    });

    it('missing X-Project-Id header is rejected with 403', async () => {
      const resp = await client.get('/api/v1/fields');
      expect(resp.status).toBe(403);
    });

    it('an unknown projectId is rejected with 403', async () => {
      const resp = await client.get('/api/v1/fields', withScope(999999));
      expect(resp.status).toBe(403);
    });

    it('a non-integer projectId is rejected with 403', async () => {
      const resp = await client.get('/api/v1/fields', { headers: { [PROJECT_ID_HEADER]: 'not-a-number' } });
      expect(resp.status).toBe(403);
    });

    it(`GET /${DUMMY_ID} with valid scope A still 404s cleanly for a nonexistent id`, async () => {
      const resp = await client.get(`/api/v1/fields/${DUMMY_ID}`, withScope(projectAId));
      expect(resp.status).toBe(404);
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
