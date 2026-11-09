const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

// WP-114 — Multi-tenancy isolation suite for moduleService
// (release-blocking, per WP-021's precedent).
//
// moduleService had NO tests at all before this file; jest and axios were
// added to its package.json to mirror folderService's setup.
//
// WHAT THIS SERVICE'S EXPOSURE ACTUALLY WAS, stated plainly because it is
// unusual: nothing in the product reads moduleService. The module taxonomy is
// compiled into frontend/src/workbench/modules.ts (ModuleId = 1|2|3|4|5|6 with
// hardcoded slugs, labels, icons and routing) and hardcoded again in
// linkIssueService/controllers/linkIssue.js. The two rows this service holds
// are vestigial 2023 duplicates of that taxonomy.
//
// So the hole was not a read leak but a WRITE one: every route was
// keycloak.protect() only, so any authenticated user could rename or delete
// the global `testcaserepo` row for everybody, cross-tenant. Section 1 proves
// a write cannot reach another project's module; section 2 proves the
// membership gate; section 3 covers the stamping rule.

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

describe('moduleService tenant isolation (WP-114, release-blocking)', () => {
  let token;
  let sub;
  let client;
  let userServiceClient;
  const projectAId = 1;
  let projectBId;
  let projectBMongoId;
  let orgBId;
  let moduleInB;
  const createdInA = [];

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
      name: `WP-114 isolation org ${runId}`,
      key: `wp114-iso-org-${runId}`
    });
    expect(orgResp.status).toBe(201);
    orgBId = orgResp.data.data._id;
    trackOrganization(orgBId);

    const projResp = await userServiceClient.post('/api/v1/projects', {
      name: `WP-114 isolation project B ${runId}`,
      key: `wp114-iso-proj-b-${runId}`,
      organizationId: orgBId
    });
    expect(projResp.status).toBe(201);
    projectBId = projResp.data.data.id;
    trackProject(projectBId);
    projectBMongoId = projResp.data.data._id;

    const createResp = await postWithCacheRetry(
      client,
      '/api/v1/modules',
      { moduleName: `WP-114 module in B ${runId}` },
      withScope(projectBId)
    );
    expect(createResp.status).toBe(201);
    expect(createResp.data.data.projectId).toBe(projectBId);
    moduleInB = createResp.data.data._id;
  }, 30000);

  afterAll(async () => {
    for (const id of createdInA) {
      await client.delete(`/api/v1/modules/${id}`, withScope(projectAId));
    }
  });

  describe('1. Query-level isolation (member of both A and B)', () => {
    it("GET list scoped to A does not include B's module", async () => {
      const resp = await client.get('/api/v1/modules', withScope(projectAId));
      expect(resp.status).toBe(200);
      expect(resp.data.data.some((m) => m._id === moduleInB)).toBe(false);
    });

    it("GET list scoped to B DOES include B's module (positive control)", async () => {
      const resp = await client.get('/api/v1/modules', withScope(projectBId));
      expect(resp.status).toBe(200);
      expect(resp.data.data.some((m) => m._id === moduleInB)).toBe(true);
    });

    it("GET single, scoped to A, does not return B's module", async () => {
      const resp = await client.get(`/api/v1/modules/${moduleInB}`, withScope(projectAId));
      expect(resp.status).toBe(200);
      expect(resp.data.data).toBeFalsy();
    });

    // THE actual hole: a cross-tenant WRITE. Before WP-114 this renamed the
    // row for everybody.
    it("PUT, scoped to A, cannot rename B's module", async () => {
      const resp = await client.put(
        `/api/v1/modules/${moduleInB}`,
        { moduleName: 'renamed by project A' },
        withScope(projectAId)
      );
      expect(resp.data.data).toBeFalsy();

      const verify = await client.get(`/api/v1/modules/${moduleInB}`, withScope(projectBId));
      expect(verify.data.data.moduleName).toBe(`WP-114 module in B ${runId}`);
    });

    it("DELETE, scoped to A, cannot delete B's module", async () => {
      const resp = await client.delete(`/api/v1/modules/${moduleInB}`, withScope(projectAId));
      expect(resp.status).toBe(200);

      const verify = await client.get(`/api/v1/modules/${moduleInB}`, withScope(projectBId));
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
      const resp = await client.get('/api/v1/modules', withScope(projectBId));
      expect(resp.status).toBe(403);
    });

    it('a write claiming scope B is rejected with 403', async () => {
      const resp = await client.post('/api/v1/modules', { moduleName: 'nope' }, withScope(projectBId));
      expect(resp.status).toBe(403);
    });

    it('a delete claiming scope B is rejected with 403', async () => {
      const resp = await client.delete(`/api/v1/modules/${moduleInB}`, withScope(projectBId));
      expect(resp.status).toBe(403);
    });

    it('missing X-Project-Id is rejected with 403', async () => {
      const resp = await client.get('/api/v1/modules');
      expect(resp.status).toBe(403);
    });

    it('an unknown projectId is rejected with 403', async () => {
      const resp = await client.get('/api/v1/modules', withScope(99999999));
      expect(resp.status).toBe(403);
    });

    it('a non-integer projectId is rejected with 403', async () => {
      const resp = await client.get('/api/v1/modules', withScope('not-a-number'));
      expect(resp.status).toBe(403);
    });

    it(`GET /${DUMMY_ID} with valid scope A behaves cleanly for a nonexistent id`, async () => {
      const resp = await client.get(`/api/v1/modules/${DUMMY_ID}`, withScope(projectAId));
      expect(resp.status).toBe(200);
      expect(resp.data.data).toBeFalsy();
    });
  });

  describe('3. projectId comes from the verified header, never the body', () => {
    it('ignores a forged projectId in the create payload', async () => {
      const resp = await postWithCacheRetry(
        client,
        '/api/v1/modules',
        { moduleName: `WP-114 forged-scope module ${runId}`, projectId: 99999999 },
        withScope(projectAId)
      );
      expect(resp.status).toBe(201);
      expect(resp.data.data.projectId).toBe(projectAId);
      createdInA.push(resp.data.data._id);
    });

    it('an update cannot move a module into another project', async () => {
      const created = await postWithCacheRetry(
        client,
        '/api/v1/modules',
        { moduleName: `WP-114 move-attempt module ${runId}` },
        withScope(projectAId)
      );
      expect(created.status).toBe(201);
      createdInA.push(created.data.data._id);

      const resp = await client.put(
        `/api/v1/modules/${created.data.data._id}`,
        { projectId: 99999999, moduleName: 'still mine' },
        withScope(projectAId)
      );
      expect(resp.status).toBe(200);
      expect(resp.data.data.projectId).toBe(projectAId);
      expect(resp.data.data.moduleName).toBe('still mine');
    });
  });
});

// Suite teardown (WP-110 follow-up) — its own top-level afterAll, which Jest
// runs last. See shared/test-utils/fixtureCleanup.js.
afterAll(() => {
  purgeTrackedFixtures();
});
