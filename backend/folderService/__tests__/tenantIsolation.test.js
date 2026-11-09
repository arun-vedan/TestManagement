const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

// WP-113 — Multi-tenancy isolation suite for folderService
// (release-blocking, per WP-021's precedent).
//
// Same two-axis design as the sibling suites: query-level filtering while a
// member of BOTH projects, then membership-level authorization after leaving
// project B.
//
// WHAT WAS DIFFERENT ABOUT THIS SERVICE. folderService already had a
// `required` projectId on its model, so it LOOKED scoped. No controller ever
// referenced it: `Folder.create(req.body)` took it straight from the client
// and no read filtered on it. A required-but-unenforced tenant field is worse
// than a missing one, because the schema implies a guarantee the code never
// made — so section 1 includes an explicit test that the stamp comes from the
// verified header and a body value cannot override it.
//
// Section 3 covers the folder TREE, which is this service's own wrinkle:
// parentFolder is a plain Number, so without a guard a folder could be grafted
// onto a parent in another tenant, leaving a child in a tree whose parent its
// owner cannot see.

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';
const USER_SERVICE_URL = process.env.TEST_USER_SERVICE_URL || 'http://localhost:8000';
const DUMMY_ID = '000000000000000000000000';
const runId = Date.now();

function decodeJwtPayload(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

async function postWithCacheRetry(client, url, body, headers, { retries = 8, delayMs = 400 } = {}) {
  let resp;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    resp = await client.post(url, body, headers);
    if (resp.status !== 403) return resp;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return resp;
}

describe('folderService tenant isolation (WP-113, release-blocking)', () => {
  let token;
  let sub;
  let client;
  let userServiceClient;
  const projectAId = 1;
  let projectBId;
  let projectBMongoId;
  let orgBId;
  let folderInB;      // _id
  let folderInBNumId; // numeric id, for updatebyparam and parent checks

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

    const orgResp = await userServiceClient.post('/api/v1/organizations', {
      name: `WP-113 isolation org ${runId}`,
      key: `wp113-iso-org-${runId}`
    });
    expect(orgResp.status).toBe(201);
    orgBId = orgResp.data.data._id;
    trackOrganization(orgBId);

    const projResp = await userServiceClient.post('/api/v1/projects', {
      name: `WP-113 isolation project B ${runId}`,
      key: `wp113-iso-proj-b-${runId}`,
      organizationId: orgBId
    });
    expect(projResp.status).toBe(201);
    projectBId = projResp.data.data.id;
    trackProject(projectBId);
    projectBMongoId = projResp.data.data._id;

    const createResp = await postWithCacheRetry(
      client,
      '/api/v1/folders',
      { folderName: `WP-113 folder in B ${runId}`, parentFolder: 0, moduleId: 1 },
      withScope(projectBId)
    );
    expect(createResp.status).toBe(201);
    expect(createResp.data.data.projectId).toBe(projectBId);
    folderInB = createResp.data.data._id;
    folderInBNumId = createResp.data.data.id;
  }, 30000);

  describe('1. Query-level isolation (member of both A and B)', () => {
    it('create stamps the VERIFIED project and ignores a body projectId', async () => {
      // The specific hole WP-113 closes: projectId was taken from req.body.
      const resp = await postWithCacheRetry(
        client,
        '/api/v1/folders',
        {
          folderName: `WP-113 forged-scope folder ${runId}`,
          parentFolder: 0,
          moduleId: 1,
          projectId: projectBId // forged — must be ignored
        },
        withScope(projectAId)
      );
      expect(resp.status).toBe(201);
      expect(resp.data.data.projectId).toBe(projectAId);

      await client.delete(`/api/v1/folders/${resp.data.data._id}`, withScope(projectAId));
    });

    it("GET list scoped to A does not include B's folder", async () => {
      const resp = await client.get('/api/v1/folders', withScope(projectAId));
      expect(resp.status).toBe(200);
      expect(resp.data.data.some((f) => f._id === folderInB)).toBe(false);
    });

    it("GET list scoped to B DOES include B's folder (positive control)", async () => {
      const resp = await client.get('/api/v1/folders', withScope(projectBId));
      expect(resp.status).toBe(200);
      expect(resp.data.data.some((f) => f._id === folderInB)).toBe(true);
    });

    it("every row of a scoped list carries the caller's own projectId", async () => {
      const resp = await client.get('/api/v1/folders', withScope(projectAId));
      expect(resp.data.data.length).toBeGreaterThan(0);
      resp.data.data.forEach((f) => expect(f.projectId).toBe(projectAId));
    });

    it("GET single, scoped to A, does not return B's folder", async () => {
      const resp = await client.get(`/api/v1/folders/${folderInB}`, withScope(projectAId));
      expect(resp.status).toBe(200);
      expect(resp.data.data).toBeFalsy();
    });

    it("PUT, scoped to A, cannot rename B's folder", async () => {
      const resp = await client.put(
        `/api/v1/folders/${folderInB}`,
        { folderName: 'renamed by project A' },
        withScope(projectAId)
      );
      expect(resp.data.data).toBeFalsy();

      const verify = await client.get(`/api/v1/folders/${folderInB}`, withScope(projectBId));
      expect(verify.data.data.folderName).toBe(`WP-113 folder in B ${runId}`);
    });

    it("updatebyparam, scoped to A, cannot touch B's folder by numeric id", async () => {
      const resp = await client.put(
        `/api/v1/folders/updatebyparam/${folderInBNumId}`,
        { folderName: 'renamed by param from project A' },
        withScope(projectAId)
      );
      expect(resp.data.data).toBeFalsy();

      const verify = await client.get(`/api/v1/folders/${folderInB}`, withScope(projectBId));
      expect(verify.data.data.folderName).toBe(`WP-113 folder in B ${runId}`);
    });

    it("an update cannot move a folder into another project", async () => {
      // projectId is stripped from the update payload entirely.
      const resp = await client.put(
        `/api/v1/folders/${folderInB}`,
        { projectId: projectAId },
        withScope(projectBId)
      );
      expect(resp.status).toBe(200);
      expect(resp.data.data.projectId).toBe(projectBId);
    });

    it("DELETE, scoped to A, cannot delete B's folder", async () => {
      const resp = await client.delete(`/api/v1/folders/${folderInB}`, withScope(projectAId));
      expect(resp.status).toBe(200);

      const verify = await client.get(`/api/v1/folders/${folderInB}`, withScope(projectBId));
      expect(verify.data.data).toBeTruthy();
    });
  });

  describe('2. Membership-level authorization (identity is NOT a member of B)', () => {
    beforeAll(async () => {
      const resp = await userServiceClient.delete(`/api/v1/projects/${projectBMongoId}/members/${sub}`);
      expect([200, 204]).toContain(resp.status);
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }, 20000);

    it('claiming scope B outright is rejected with 403', async () => {
      const resp = await client.get('/api/v1/folders', withScope(projectBId));
      expect(resp.status).toBe(403);
    });

    it('a write claiming scope B is rejected with 403', async () => {
      const resp = await client.post(
        '/api/v1/folders',
        { folderName: 'nope', parentFolder: 0, moduleId: 1 },
        withScope(projectBId)
      );
      expect(resp.status).toBe(403);
    });

    it('a delete claiming scope B is rejected with 403', async () => {
      const resp = await client.delete(`/api/v1/folders/${folderInB}`, withScope(projectBId));
      expect(resp.status).toBe(403);
    });

    it('missing X-Project-Id is rejected with 403', async () => {
      const resp = await client.get('/api/v1/folders');
      expect(resp.status).toBe(403);
    });

    it('an unknown projectId is rejected with 403', async () => {
      const resp = await client.get('/api/v1/folders', withScope(99999999));
      expect(resp.status).toBe(403);
    });

    it('a non-integer projectId is rejected with 403', async () => {
      const resp = await client.get('/api/v1/folders', withScope('not-a-number'));
      expect(resp.status).toBe(403);
    });

    it(`GET /${DUMMY_ID} with valid scope A behaves cleanly for a nonexistent id`, async () => {
      const resp = await client.get(`/api/v1/folders/${DUMMY_ID}`, withScope(projectAId));
      expect(resp.status).toBe(200);
      expect(resp.data.data).toBeFalsy();
    });
  });

  describe('3. The folder tree cannot span projects', () => {
    // parentFolder is a plain Number, so without a guard a folder could be
    // grafted onto a parent in another tenant. Nothing fails at write time --
    // the child just lands in a tree whose parent its owner cannot see.
    it('rejects a parentFolder that belongs to another project', async () => {
      const resp = await client.post(
        '/api/v1/folders',
        { folderName: `WP-113 cross-tenant child ${runId}`, parentFolder: folderInBNumId, moduleId: 1 },
        withScope(projectAId)
      );
      expect(resp.status).toBe(400);
      expect(String(resp.data.error)).toMatch(/does not exist in this project/i);
    });

    it('rejects a parentFolder that exists nowhere', async () => {
      const resp = await client.post(
        '/api/v1/folders',
        { folderName: `WP-113 orphan child ${runId}`, parentFolder: 99999999, moduleId: 1 },
        withScope(projectAId)
      );
      expect(resp.status).toBe(400);
    });

    it('accepts parentFolder 0 (root) and a parent in the same project', async () => {
      const root = await client.post(
        '/api/v1/folders',
        { folderName: `WP-113 root ${runId}`, parentFolder: 0, moduleId: 1 },
        withScope(projectAId)
      );
      expect(root.status).toBe(201);

      const child = await client.post(
        '/api/v1/folders',
        { folderName: `WP-113 child ${runId}`, parentFolder: root.data.data.id, moduleId: 1 },
        withScope(projectAId)
      );
      expect(child.status).toBe(201);
      expect(child.data.data.parentFolder).toBe(root.data.data.id);

      await client.delete(`/api/v1/folders/${child.data.data._id}`, withScope(projectAId));
      await client.delete(`/api/v1/folders/${root.data.data._id}`, withScope(projectAId));
    });
  });
});

// Suite teardown (WP-110 follow-up) — its own top-level afterAll, which Jest
// runs last. See shared/test-utils/fixtureCleanup.js.
afterAll(() => {
  purgeTrackedFixtures();
});
