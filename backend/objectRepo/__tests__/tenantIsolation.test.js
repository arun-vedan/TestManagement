const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

// WP-118 — Multi-tenancy isolation suite for objectRepo
// (release-blocking, per WP-021's precedent).
//
// Same two-axis design as the seven sibling suites: query-level filtering
// while a member of BOTH projects, then membership-level authorization after
// leaving project B.
//
// NOTE ON DATA: this service's collection was EMPTY when WP-118 ran, so there
// was no backfill to write — verified rather than assumed. Everything this
// suite asserts on is created by the suite itself.

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

describe('objectRepo tenant isolation (WP-118, release-blocking)', () => {
  let token;
  let sub;
  let client;
  let userServiceClient;
  const projectAId = 1;
  let projectBId;
  let projectBMongoId;
  let orgBId;
  let docInB;
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
      name: 'WP-118 isolation org ' + runId,
      key: 'wp118-iso-org-' + runId
    });
    expect(orgResp.status).toBe(201);
    orgBId = orgResp.data.data._id;
    trackOrganization(orgBId);

    const projResp = await userServiceClient.post('/api/v1/projects', {
      name: 'WP-118 isolation project B ' + runId,
      key: 'wp118-iso-proj-b-' + runId,
      organizationId: orgBId
    });
    expect(projResp.status).toBe(201);
    projectBId = projResp.data.data.id;
    trackProject(projectBId);
    projectBMongoId = projResp.data.data._id;

    const createResp = await postWithCacheRetry(
      client,
      '/api/v1/objectrepo',
      { objectId: 'WP118-OBJ-' + runId, objectName: 'secret of B', parentId: 0 },
      withScope(projectBId)
    );
    expect(createResp.status).toBe(201);
    expect(createResp.data.data.projectId).toBe(projectBId);
    docInB = createResp.data.data._id;
  }, 30000);

  afterAll(async () => {
    for (const id of createdInA) {
      await client.delete('/api/v1/objectrepo/' + id, withScope(projectAId));
    }
  });

  describe('1. Query-level isolation (member of both A and B)', () => {
    it("GET list scoped to A does not include B's document", async () => {
      const resp = await client.get('/api/v1/objectrepo', withScope(projectAId));
      expect(resp.status).toBe(200);
      expect(resp.data.data.some((d) => d._id === docInB)).toBe(false);
    });

    it("GET list scoped to B DOES include B's document (positive control)", async () => {
      const resp = await client.get('/api/v1/objectrepo', withScope(projectBId));
      expect(resp.status).toBe(200);
      expect(resp.data.data.some((d) => d._id === docInB)).toBe(true);
    });

    it("every row of a scoped list carries the caller's own projectId", async () => {
      const resp = await client.get('/api/v1/objectrepo', withScope(projectBId));
      expect(resp.data.data.length).toBeGreaterThan(0);
      resp.data.data.forEach((d) => expect(d.projectId).toBe(projectBId));
    });

    it("GET single, scoped to A, does not return B's document", async () => {
      const resp = await client.get('/api/v1/objectrepo/' + docInB, withScope(projectAId));
      expect(resp.status).toBe(200);
      expect(resp.data.data).toBeFalsy();
    });

    it("PUT, scoped to A, cannot modify B's document", async () => {
      const resp = await client.put('/api/v1/objectrepo/' + docInB, { objectName: 'overwritten by project A' }, withScope(projectAId));
      expect(resp.data.data).toBeFalsy();

      const verify = await client.get('/api/v1/objectrepo/' + docInB, withScope(projectBId));
      expect(verify.data.data).toBeTruthy();
      expect(verify.data.data.objectName).toBe('secret of B');
    });

    it("DELETE, scoped to A, cannot delete B's document", async () => {
      const resp = await client.delete('/api/v1/objectrepo/' + docInB, withScope(projectAId));
      expect(resp.status).toBe(200);

      const verify = await client.get('/api/v1/objectrepo/' + docInB, withScope(projectBId));
      expect(verify.data.data).toBeTruthy();
    });
  });

  describe('2. Membership-level authorization (identity is NOT a member of B)', () => {
    beforeAll(async () => {
      const resp = await userServiceClient.delete(
        '/api/v1/projects/' + projectBMongoId + '/members/' + sub
      );
      expect([200, 204]).toContain(resp.status);
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }, 20000);

    it('claiming scope B outright is rejected with 403', async () => {
      const resp = await client.get('/api/v1/objectrepo', withScope(projectBId));
      expect(resp.status).toBe(403);
    });

    it('a write claiming scope B is rejected with 403', async () => {
      const resp = await client.post('/api/v1/objectrepo', { objectId: 'WP118-OBJ-' + runId, objectName: 'secret of B', parentId: 0 }, withScope(projectBId));
      expect(resp.status).toBe(403);
    });

    it('a delete claiming scope B is rejected with 403', async () => {
      const resp = await client.delete('/api/v1/objectrepo/' + docInB, withScope(projectBId));
      expect(resp.status).toBe(403);
    });

    it('missing X-Project-Id is rejected with 403', async () => {
      const resp = await client.get('/api/v1/objectrepo');
      expect(resp.status).toBe(403);
    });

    it('an unknown projectId is rejected with 403', async () => {
      const resp = await client.get('/api/v1/objectrepo', withScope(99999999));
      expect(resp.status).toBe(403);
    });

    it('a non-integer projectId is rejected with 403', async () => {
      const resp = await client.get('/api/v1/objectrepo', withScope('not-a-number'));
      expect(resp.status).toBe(403);
    });

    it('GET /' + DUMMY_ID + ' with valid scope A behaves cleanly', async () => {
      const resp = await client.get('/api/v1/objectrepo/' + DUMMY_ID, withScope(projectAId));
      expect(resp.status).toBe(200);
      expect(resp.data.data).toBeFalsy();
    });
  });

  describe('3. projectId comes from the verified header, never the body', () => {
    it('ignores a forged projectId in the create payload', async () => {
      const resp = await postWithCacheRetry(
        client,
        '/api/v1/objectrepo',
        Object.assign({}, { objectId: 'WP118-A-' + runId, objectName: 'object A', parentId: 0 }, { projectId: 99999999 }),
        withScope(projectAId)
      );
      expect(resp.status).toBe(201);
      expect(resp.data.data.projectId).toBe(projectAId);
      createdInA.push(resp.data.data._id);
    });
  });
});

// Suite teardown (WP-110 follow-up) — its own top-level afterAll, which Jest
// runs last. See shared/test-utils/fixtureCleanup.js.
afterAll(() => {
  purgeTrackedFixtures();
});
