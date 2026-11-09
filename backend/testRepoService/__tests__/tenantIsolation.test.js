const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

// WP-021 — Multi-tenancy isolation suite (release-blocking, spec §43).
//
// Proves a user who is a member of one project cannot read or write another
// project's testRepoService data through any route, and that requests with
// no/foreign/unknown projectId are rejected. Black-box HTTP against the
// live container (GR-6).
//
// Only ONE real Keycloak identity is available to this test harness (the
// client_credentials service account from getServiceToken.js — see
// backend/shared/test-utils/getServiceToken.js's own comment on why it's
// not part of @srckube/service-core). So "user A" and "an attacker" are
// necessarily the same real token throughout; what's actually varied
// between requests is the CLAIMED scope (X-Project-Id) and, separately,
// this identity's real membership of the two projects. Two independent
// things are proven, each targeting a different layer of
// requireProjectScope():
//
//   1. Query-level isolation (identity is a member of BOTH projects):
//      a document that really belongs to project B is invisible/
//      unwritable through every route when the request is scoped to
//      project A, and vice versa. This is the advancedResults()/
//      controller-level {projectId} filter working, independent of
//      membership.
//   2. Membership-level authorization (identity is a member of ONLY
//      project A): the SAME identity is refused (403) when it tries to
//      claim scope B outright, and refused for an unknown/missing
//      projectId. This is requireProjectScope() itself working.
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
// not per-request. When this suite's file and a sibling __tests__ file run
// as concurrent Jest workers against the same container, a project this
// suite just created can momentarily be invisible to a request if the
// cache was populated (by either file) a moment before this suite's create
// call landed. Retry a handful of times, well within the local/test TTL
// (2000ms, backend/.env), rather than flake on that race.
async function postWithCacheRetry(axiosClient, url, body, headers, { retries = 8, delayMs = 400 } = {}) {
  let resp;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    resp = await axiosClient.post(url, body, headers);
    if (resp.status !== 403) return resp;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return resp;
}

describe('testRepoService tenant isolation (WP-021, release-blocking)', () => {
  let token;
  let sub;
  let client; // authed client for testRepoService, no default X-Project-Id
  let userServiceClient; // authed client for userService (org/project admin)
  let projectAId; // numeric id, always 1 (Default Project)
  let projectBId; // numeric id, freshly created
  let projectBMongoId;
  let orgBId;
  let foreignEntityId; // _id of a TestCase created under project B

  const withScope = (projectId) => ({ headers: { [PROJECT_ID_HEADER]: String(projectId) } });

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
      name: `WP-021 isolation org ${runId}`,
      key: `wp021-iso-org-${runId}`
    });
    expect(orgResp.status).toBe(201);
    orgBId = orgResp.data.data._id;
    trackOrganization(orgBId);

    const projResp = await userServiceClient.post('/api/v1/projects', {
      name: `WP-021 isolation project B ${runId}`,
      key: `wp021-iso-proj-b-${runId}`,
      organizationId: orgBId
    });
    expect(projResp.status).toBe(201);
    projectBId = projResp.data.data.id;
    trackProject(projectBId);
    projectBMongoId = projResp.data.data._id;
    trackProject(projectBMongoId);
    expect(projectBId).not.toBe(projectAId);

    // --- Seed one "foreign" TestCase under project B, while still a member ---
    const createResp = await postWithCacheRetry(
      client,
      '/api/v1/testrepo',
      {
        TestCaseSummary: `WP-021 foreign test case ${runId}`,
        TestCaseDescription: 'Belongs to project B; project A must never see or touch it'
      },
      withScope(projectBId)
    );
    expect(createResp.status).toBe(201);
    expect(createResp.data.data.projectId).toBe(projectBId);
    foreignEntityId = createResp.data.data._id;
    // NOTE: membership in B is intentionally left in place here -- section 1
    // below needs it (to independently verify B's document via scope=B
    // after each cross-tenant attack attempt through scope=A). It's revoked
    // in section 2's own beforeAll, after section 1 has run.
  }, 20000);

  afterAll(async () => {
    // Best-effort cleanup: re-grant B membership so we can delete the
    // fixture data and the project/org, then leave A's membership as-is
    // (harmless / matches the seeded default-admin shape).
    if (projectBMongoId) {
      await userServiceClient.post(`/api/v1/projects/${projectBMongoId}/members`, { userId: sub, role: 'admin' });
    }
    if (foreignEntityId) {
      await client.delete(`/api/v1/testrepo/${foreignEntityId}`, withScope(projectBId));
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
      const resp = await client.get('/api/v1/testrepo', withScope(projectAId));
      expect(resp.status).toBe(200);
      expect(resp.data.data.some((tc) => tc._id === foreignEntityId)).toBe(false);
    });

    it('GET list scoped to B DOES include B\'s document (positive control)', async () => {
      const resp = await client.get('/api/v1/testrepo', withScope(projectBId));
      expect(resp.status).toBe(200);
      expect(resp.data.data.some((tc) => tc._id === foreignEntityId)).toBe(true);
    });

    it('GET single, scoped to A, 404s on B\'s document (not found, not leaked)', async () => {
      const resp = await client.get(`/api/v1/testrepo/${foreignEntityId}`, withScope(projectAId));
      expect(resp.status).toBe(404);
      expect(resp.data.success).toBe(false);
    });

    it('PUT, scoped to A, cannot modify B\'s document', async () => {
      const resp = await client.put(
        `/api/v1/testrepo/${foreignEntityId}`,
        { TestCaseSummary: 'HIJACKED from project A' },
        withScope(projectAId)
      );
      expect(resp.status).toBe(404);

      // and it is genuinely unchanged, verified back through B's own scope
      const verify = await client.get(`/api/v1/testrepo/${foreignEntityId}`, withScope(projectBId));
      expect(verify.data.data.TestCaseSummary).toBe(`WP-021 foreign test case ${runId}`);
    });

    it('DELETE, scoped to A, cannot delete B\'s document', async () => {
      const resp = await client.delete(`/api/v1/testrepo/${foreignEntityId}`, withScope(projectAId));
      expect(resp.status).toBe(404);

      const verify = await client.get(`/api/v1/testrepo/${foreignEntityId}`, withScope(projectBId));
      expect(verify.status).toBe(200); // still there
    });

    it('wildcardsearch, scoped to A, does not surface B\'s document', async () => {
      const resp = await client.get('/api/v1/testrepo/wildcardsearch', {
        params: { search: `foreign test case ${runId}` },
        ...withScope(projectAId)
      });
      expect(resp.status).toBe(200);
      expect(resp.data.data.some((tc) => tc._id === foreignEntityId)).toBe(false);
    });

    it('updateTestCaseByParam, scoped to A, cannot touch B\'s TestCaseId', async () => {
      const getB = await client.get(`/api/v1/testrepo/${foreignEntityId}`, withScope(projectBId));
      const tcid = getB.data.data.TestCaseId;

      const resp = await client.put(
        `/api/v1/testrepo/updateTestCaseByParam?tcid=${tcid}`,
        { TestCaseSummary: 'HIJACKED via byParam' },
        withScope(projectAId)
      );
      expect(resp.status).toBe(404);
    });
  });

  describe('2. Membership-level authorization (identity is NOT a member of B)', () => {
    beforeAll(async () => {
      // Revoke membership of project B now, after section 1's tests (which
      // relied on being a member of both A and B) have already run.
      const removeResp = await userServiceClient.delete(`/api/v1/projects/${projectBMongoId}/members/${sub}`);
      expect(removeResp.status).toBe(200);

      // requireProjectScope() caches the project list briefly (in-process,
      // PROJECT_SCOPE_CACHE_TTL_MS -- see projectScope.js). The local/test
      // env sets this to 2000ms (backend/.env) specifically so this suite
      // doesn't need to sleep the 30s production default to observe the
      // revocation above take effect against testRepoService.
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }, 20000);

    it('claiming scope B outright is rejected with 403, not 404 (this identity is genuinely not a member)', async () => {
      const resp = await client.get('/api/v1/testrepo', withScope(projectBId));
      expect(resp.status).toBe(403);
      expect(resp.data.success).toBe(false);
    });

    it('a write attempt claiming scope B is rejected with 403', async () => {
      const resp = await client.post(
        '/api/v1/testrepo',
        { TestCaseSummary: 'should never be created', TestCaseDescription: 'x' },
        withScope(projectBId)
      );
      expect(resp.status).toBe(403);
    });

    it('missing X-Project-Id header is rejected with 403', async () => {
      const resp = await client.get('/api/v1/testrepo');
      expect(resp.status).toBe(403);
    });

    it('an unknown projectId is rejected with 403', async () => {
      const resp = await client.get('/api/v1/testrepo', withScope(999999));
      expect(resp.status).toBe(403);
    });

    it('a non-integer projectId is rejected with 403', async () => {
      const resp = await client.get('/api/v1/testrepo', { headers: { [PROJECT_ID_HEADER]: 'not-a-number' } });
      expect(resp.status).toBe(403);
    });

    it(`GET /${DUMMY_ID} with valid scope A still 404s cleanly for a nonexistent id`, async () => {
      const resp = await client.get(`/api/v1/testrepo/${DUMMY_ID}`, withScope(projectAId));
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
