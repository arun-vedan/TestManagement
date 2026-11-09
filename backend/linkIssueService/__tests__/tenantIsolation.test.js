const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

// WP-111 — Multi-tenancy isolation suite for linkIssueService
// (release-blocking, per WP-021's precedent).
//
// Follows the six existing suites' design, which exists because only ONE real
// Keycloak identity is available in this environment: isolation is proven
// along two independent axes rather than by logging in as two people --
//   1. query-level filtering, while a member of BOTH projects, and
//   2. membership-level authorization, after leaving project B.
//
// Project A = the seeded Default Project (id=1). Project B = a fresh
// Organization+Project this suite creates and tears down.
//
// WHY THIS SERVICE'S SUITE HAS AN EXTRA SECTION. linkIssueService is not just
// another CRUD service: it owns the traceability graph, and it also has two
// aggregate endpoints (coverage/untested-requirements and
// coverage/orphan-testcases) that fan out to requirementService and
// testRepoService. Before WP-111 those two forwarded a hardcoded
// X-Project-Id: '1' (the DEFAULT_PROJECT_ID shim, audited and deliberately
// kept by WP-104 because this service genuinely had no scope to forward). An
// aggregate that silently reports on project 1 regardless of who asks is a
// worse leak than a single document, so section 3 covers it specifically.

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';
const USER_SERVICE_URL = process.env.TEST_USER_SERVICE_URL || 'http://localhost:8000';
const DUMMY_ID = '000000000000000000000000';
const runId = Date.now();

function decodeJwtPayload(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

// requireProjectScope() caches its membership answer per (caller, project) for
// PROJECT_SCOPE_CACHE_TTL_MS (WP-110 architecture (c); 2000ms in backend/.env
// for tests). A project this suite just created can momentarily be unknown to
// a request whose lookup landed a moment earlier, so retry rather than flake.
async function postWithCacheRetry(axiosClient, url, body, headers, { retries = 8, delayMs = 400 } = {}) {
  let resp;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    resp = await axiosClient.post(url, body, headers);
    if (resp.status !== 403) return resp;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return resp;
}

describe('linkIssueService tenant isolation (WP-111, release-blocking)', () => {
  let token;
  let sub;
  let client;
  let userServiceClient;
  const projectAId = 1;
  let projectBId;
  let projectBMongoId;
  let orgBId;
  let foreignLinkId; // _id of a LinkIssue created under project B

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

    // --- Project B (this identity is auto-enrolled as creator/admin) ---
    const orgResp = await userServiceClient.post('/api/v1/organizations', {
      name: `WP-111 isolation org ${runId}`,
      key: `wp111-iso-org-${runId}`
    });
    expect(orgResp.status).toBe(201);
    orgBId = orgResp.data.data._id;
    trackOrganization(orgBId);

    const projResp = await userServiceClient.post('/api/v1/projects', {
      name: `WP-111 isolation project B ${runId}`,
      key: `wp111-iso-proj-b-${runId}`,
      organizationId: orgBId
    });
    expect(projResp.status).toBe(201);
    projectBId = projResp.data.data.id;
    trackProject(projectBId);
    projectBMongoId = projResp.data.data._id;
    expect(projectBId).not.toBe(projectAId);

    // --- Seed one "foreign" link under project B, while still a member ---
    const createResp = await postWithCacheRetry(
      client,
      '/api/v1/linkIssue',
      {
        sourceId: `WP111-REQ-${runId}`,
        destinationId: `WP111-TC-${runId}`,
        srcModule: 2,
        destinationModule: 1,
        linkType: 'tests'
      },
      withScope(projectBId)
    );
    expect(createResp.status).toBe(201);
    // The scope is stamped server-side from the verified header, never taken
    // from the body -- this assertion is what proves that.
    expect(createResp.data.data.projectId).toBe(projectBId);
    foreignLinkId = createResp.data.data._id;
  }, 30000);

  describe('1. Query-level isolation (member of both A and B)', () => {
    it("GET list scoped to A does not include B's link", async () => {
      const resp = await client.get('/api/v1/linkIssue', withScope(projectAId));
      expect(resp.status).toBe(200);
      expect(resp.data.data.some((l) => l._id === foreignLinkId)).toBe(false);
    });

    it("GET list scoped to B DOES include B's link (positive control)", async () => {
      const resp = await client.get('/api/v1/linkIssue', withScope(projectBId));
      expect(resp.status).toBe(200);
      expect(resp.data.data.some((l) => l._id === foreignLinkId)).toBe(true);
    });

    it("every row of a scoped list carries the caller's own projectId", async () => {
      const resp = await client.get('/api/v1/linkIssue', withScope(projectAId));
      expect(resp.status).toBe(200);
      expect(resp.data.data.length).toBeGreaterThan(0);
      resp.data.data.forEach((l) => expect(l.projectId).toBe(projectAId));
    });

    it("GET single, scoped to A, does not return B's link", async () => {
      const resp = await client.get(`/api/v1/linkIssue/${foreignLinkId}`, withScope(projectAId));
      // A scoped lookup finds nothing; the route answers 200 with data:null
      // rather than leaking the document.
      expect(resp.status).toBe(200);
      expect(resp.data.data).toBeFalsy();
    });

    it("GET single, scoped to B, DOES return B's link (positive control)", async () => {
      const resp = await client.get(`/api/v1/linkIssue/${foreignLinkId}`, withScope(projectBId));
      expect(resp.status).toBe(200);
      expect(resp.data.data._id).toBe(foreignLinkId);
    });

    it("PUT, scoped to A, cannot modify B's link", async () => {
      const resp = await client.put(
        `/api/v1/linkIssue/${foreignLinkId}`,
        { linkType: 'blocks' },
        withScope(projectAId)
      );
      expect(resp.data.data).toBeFalsy();

      // Prove it really is unchanged, read back through B's own scope.
      const verify = await client.get(`/api/v1/linkIssue/${foreignLinkId}`, withScope(projectBId));
      expect(verify.status).toBe(200);
      expect(verify.data.data.linkType).toBe('tests');
    });

    it("DELETE, scoped to A, cannot delete B's link", async () => {
      const resp = await client.delete(`/api/v1/linkIssue/${foreignLinkId}`, withScope(projectAId));
      expect(resp.status).toBe(200); // the route is idempotent-by-shape

      const verify = await client.get(`/api/v1/linkIssue/${foreignLinkId}`, withScope(projectBId));
      expect(verify.status).toBe(200);
      expect(verify.data.data).toBeTruthy();
      expect(verify.data.data._id).toBe(foreignLinkId);
    });

    it("completedelete, scoped to A, cannot delete B's link pair", async () => {
      const resp = await client.delete(
        `/api/v1/linkIssue/completedelete?srcId=WP111-REQ-${runId}&destId=WP111-TC-${runId}`,
        withScope(projectAId)
      );
      expect(resp.status).toBe(200);

      const verify = await client.get(`/api/v1/linkIssue/${foreignLinkId}`, withScope(projectBId));
      expect(verify.data.data).toBeTruthy();
    });

    // updateLink scoped its FILTER to the caller's project but passed the body
    // through untouched, so a projectId in the body re-homed the document.
    // Only reachable by a member of the source project, but it lets a link be
    // planted into another tenant's traceability graph.
    it('PUT cannot move a link to another project by sending projectId in the body', async () => {
      const resp = await client.put(
        `/api/v1/linkIssue/${foreignLinkId}`,
        { projectId: projectAId, linkType: 'tests' },
        withScope(projectBId)
      );
      expect(resp.status).toBe(200);
      expect(resp.data.data.projectId).toBe(projectBId);

      const inA = await client.get(`/api/v1/linkIssue/${foreignLinkId}`, withScope(projectAId));
      expect(inA.data.data).toBeFalsy();
      const inB = await client.get(`/api/v1/linkIssue/${foreignLinkId}`, withScope(projectBId));
      expect(inB.data.data._id).toBe(foreignLinkId);
    });

    // WP-111's per-project uniqueness, proven in the database and not only in
    // the model: a stale global index outlived the schema change (dropped by
    // shared/scripts/dropStaleLinkIssueUniqueIndex.mongo.js, found in WP-141).
    it("the same link pair in A as B's is A's own link, not a duplicate-key error", async () => {
      const resp = await client.post(
        '/api/v1/linkIssue',
        {
          sourceId: `WP111-REQ-${runId}`,
          destinationId: `WP111-TC-${runId}`,
          srcModule: 2,
          destinationModule: 1,
          linkType: 'tests'
        },
        withScope(projectAId)
      );
      expect(resp.status).toBe(201);
      expect(resp.data.data.projectId).toBe(projectAId);
      await client.delete(`/api/v1/linkIssue/${resp.data.data._id}`, withScope(projectAId));
    });

    // WP-141 — an external link is tenant data like any other link.
    it('an external (Jira) link created in B is invisible from A, and the same key in A is a separate link', async () => {
      const sourceId = `WP141-BUG-${runId}`;
      const external = { provider: 'jira', key: 'ACME-141' };
      const inB = await postWithCacheRetry(
        client,
        '/api/v1/linkIssue',
        { sourceId, srcModule: 5, destinationModule: 100, external, linkType: 'relates-to' },
        withScope(projectBId)
      );
      expect(inB.status).toBe(201);
      expect(inB.data.data.projectId).toBe(projectBId);

      const listA = await client.get(`/api/v1/linkIssue?sourceId=${sourceId}`, withScope(projectAId));
      expect(listA.status).toBe(200);
      expect(listA.data.data).toHaveLength(0);
      const listB = await client.get(`/api/v1/linkIssue?sourceId=${sourceId}`, withScope(projectBId));
      expect(listB.data.data.map((l) => l._id)).toEqual([inB.data.data._id]);

      // Same source id and same Jira key in A: its own row, no collision.
      const inA = await client.post(
        '/api/v1/linkIssue',
        { sourceId, srcModule: 5, destinationModule: 100, external, linkType: 'relates-to' },
        withScope(projectAId)
      );
      expect(inA.status).toBe(201);
      expect(inA.data.data.projectId).toBe(projectAId);
      await client.delete(`/api/v1/linkIssue/${inA.data.data._id}`, withScope(projectAId));
    });
  });

  describe('2. Membership-level authorization (identity is NOT a member of B)', () => {
    beforeAll(async () => {
      // Leave project B. requireProjectScope() must now refuse scope B
      // outright rather than merely filtering it.
      const resp = await userServiceClient.delete(`/api/v1/projects/${projectBMongoId}/members/${sub}`);
      expect([200, 204]).toContain(resp.status);
      // Outlast the (caller, project) scope cache.
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }, 20000);

    it('claiming scope B outright is rejected with 403, not 404', async () => {
      const resp = await client.get('/api/v1/linkIssue', withScope(projectBId));
      expect(resp.status).toBe(403);
    });

    it('a write attempt claiming scope B is rejected with 403', async () => {
      const resp = await client.post(
        '/api/v1/linkIssue',
        { sourceId: 'x', destinationId: 'y', srcModule: 2, destinationModule: 1 },
        withScope(projectBId)
      );
      expect(resp.status).toBe(403);
    });

    it('a delete claiming scope B is rejected with 403', async () => {
      const resp = await client.delete(`/api/v1/linkIssue/${foreignLinkId}`, withScope(projectBId));
      expect(resp.status).toBe(403);
    });

    it('missing X-Project-Id header is rejected with 403', async () => {
      const resp = await client.get('/api/v1/linkIssue');
      expect(resp.status).toBe(403);
    });

    it('an unknown projectId is rejected with 403', async () => {
      const resp = await client.get('/api/v1/linkIssue', withScope(99999999));
      expect(resp.status).toBe(403);
    });

    it('a non-integer projectId is rejected with 403', async () => {
      const resp = await client.get('/api/v1/linkIssue', withScope('not-a-number'));
      expect(resp.status).toBe(403);
    });

    it(`GET /${DUMMY_ID} with valid scope A still behaves cleanly for a nonexistent id`, async () => {
      const resp = await client.get(`/api/v1/linkIssue/${DUMMY_ID}`, withScope(projectAId));
      expect(resp.status).toBe(200);
      expect(resp.data.data).toBeFalsy();
    });
  });

  describe('3. The coverage aggregates are scoped too (the DEFAULT_PROJECT_ID shim is gone)', () => {
    // Before WP-111 both of these forwarded a hardcoded X-Project-Id: '1',
    // so they reported on the Default Project no matter who asked. An
    // aggregate that quietly answers about another tenant is a worse leak
    // than a single document, because nothing in the response says which
    // project it describes.
    it('untested-requirements is reachable with scope A and reports a bounded set', async () => {
      const resp = await client.get('/api/v1/linkIssue/coverage/untested-requirements', withScope(projectAId));
      expect(resp.status).toBe(200);
      expect(Array.isArray(resp.data.data)).toBe(true);
    });

    it('orphan-testcases is reachable with scope A and reports a bounded set', async () => {
      const resp = await client.get('/api/v1/linkIssue/coverage/orphan-testcases', withScope(projectAId));
      expect(resp.status).toBe(200);
      expect(Array.isArray(resp.data.data)).toBe(true);
    });

    it('untested-requirements requires a scope header at all (no silent default to project 1)', async () => {
      const resp = await client.get('/api/v1/linkIssue/coverage/untested-requirements');
      expect(resp.status).toBe(403);
    });

    it('orphan-testcases requires a scope header at all', async () => {
      const resp = await client.get('/api/v1/linkIssue/coverage/orphan-testcases');
      expect(resp.status).toBe(403);
    });

    it('both aggregates refuse a project this identity is not a member of', async () => {
      const a = await client.get('/api/v1/linkIssue/coverage/untested-requirements', withScope(projectBId));
      const b = await client.get('/api/v1/linkIssue/coverage/orphan-testcases', withScope(projectBId));
      expect(a.status).toBe(403);
      expect(b.status).toBe(403);
    });
  });
});

// Suite teardown (WP-110 follow-up) — its own top-level afterAll, which Jest
// runs last. DELETE /api/v1/projects only ARCHIVES, so API teardown alone left
// orphaned projects behind; see shared/test-utils/fixtureCleanup.js.
afterAll(() => {
  purgeTrackedFixtures();
});
