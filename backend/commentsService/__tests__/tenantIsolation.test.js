const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

// WP-115 — Multi-tenancy isolation suite for commentsService
// (release-blocking, per WP-021's precedent).
//
// Same two-axis design as the sibling suites.
//
// THIS SERVICE'S OWN WRINKLE, and it is the one worth reading about.
// commentsService does not use @srckube/service-core's advancedResults; it
// keeps a local copy, because line 3 sets `req.query['status'] = 1` to enforce
// soft-delete filtering — a documented deliberate deviation that must not be
// consolidated away (LAUNCH_PLAN.md operational warnings).
//
// That local copy had DIVERGED: service-core's version gained the
// `if (req.projectScope) reqQuery.projectId = ...` block in WP-021, and this
// one never did. So mounting requireProjectScope() on the list route would
// have authorized the caller and then returned EVERY TENANT'S comments —
// scoped-looking and silently leaking, which is worse than being plainly
// unscoped. Section 1's list assertions are what catch that: they would pass
// against a route that merely gates and fail against one that does not filter.
//
// Keeping the deviation does not mean keeping the drift. The tenant filter was
// ported in; the status filter stayed local.

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

describe('commentsService tenant isolation (WP-115, release-blocking)', () => {
  let token;
  let sub;
  let client;
  let userServiceClient;
  const projectAId = 1;
  let projectBId;
  let projectBMongoId;
  let orgBId;
  let commentInB;
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
      name: `WP-115 isolation org ${runId}`,
      key: `wp115-iso-org-${runId}`
    });
    expect(orgResp.status).toBe(201);
    orgBId = orgResp.data.data._id;
    trackOrganization(orgBId);

    const projResp = await userServiceClient.post('/api/v1/projects', {
      name: `WP-115 isolation project B ${runId}`,
      key: `wp115-iso-proj-b-${runId}`,
      organizationId: orgBId
    });
    expect(projResp.status).toBe(201);
    projectBId = projResp.data.data.id;
    trackProject(projectBId);
    projectBMongoId = projResp.data.data._id;

    const createResp = await postWithCacheRetry(
      client,
      '/api/v1/comments',
      { comments: `WP-115 secret comment in B ${runId}`, moduleId: 2, typeId: `WP115-REQ-${runId}` },
      withScope(projectBId)
    );
    expect(createResp.status).toBe(201);
    expect(createResp.data.data.projectId).toBe(projectBId);
    commentInB = createResp.data.data._id;
  }, 30000);

  afterAll(async () => {
    for (const id of createdInA) {
      await client.put(`/api/v1/comments/deleteCommentById?id=${id}`, {}, withScope(projectAId));
    }
  });

  describe('1. Query-level isolation (member of both A and B)', () => {
    // These two are the ones that catch the diverged local advancedResults:
    // a route that merely gates without filtering would pass the 403 tests in
    // section 2 and fail here.
    it("GET list scoped to A does not include B's comment", async () => {
      const resp = await client.get('/api/v1/comments', withScope(projectAId));
      expect(resp.status).toBe(200);
      expect(resp.data.data.some((c) => c._id === commentInB)).toBe(false);
    });

    it("GET list scoped to B DOES include B's comment (positive control)", async () => {
      const resp = await client.get('/api/v1/comments', withScope(projectBId));
      expect(resp.status).toBe(200);
      expect(resp.data.data.some((c) => c._id === commentInB)).toBe(true);
    });

    it("every row of a scoped list carries the caller's own projectId", async () => {
      const resp = await client.get('/api/v1/comments', withScope(projectBId));
      expect(resp.data.data.length).toBeGreaterThan(0);
      resp.data.data.forEach((c) => expect(c.projectId).toBe(projectBId));
    });

    it('the soft-delete deviation still holds: only status 1 rows are listed', async () => {
      // The local advancedResults forces status = 1. Keeping the tenant filter
      // must not have displaced it.
      const resp = await client.get('/api/v1/comments', withScope(projectBId));
      expect(resp.status).toBe(200);
      resp.data.data.forEach((c) => expect(c.status).toBe(1));
    });

    it("GET single, scoped to A, does not return B's comment", async () => {
      const resp = await client.get(`/api/v1/comments/${commentInB}`, withScope(projectAId));
      expect(resp.status).toBe(200);
      expect(resp.data.data).toBeFalsy();
    });

    it("update, scoped to A, cannot edit B's comment", async () => {
      const resp = await client.put(
        `/api/v1/comments/updateCommentsByParam?id=${commentInB}`,
        { comments: 'edited by project A' },
        withScope(projectAId)
      );
      expect(resp.data.data).toBeFalsy();

      const verify = await client.get(`/api/v1/comments/${commentInB}`, withScope(projectBId));
      expect(verify.data.data.comments).toBe(`WP-115 secret comment in B ${runId}`);
    });

    it("soft delete, scoped to A, cannot delete B's comment", async () => {
      const resp = await client.put(
        `/api/v1/comments/deleteCommentById?id=${commentInB}`,
        {},
        withScope(projectAId)
      );
      expect(resp.status).toBe(200); // idempotent-by-shape

      const verify = await client.get(`/api/v1/comments/${commentInB}`, withScope(projectBId));
      expect(verify.data.data).toBeTruthy();
      expect(verify.data.data.status).toBe(1);
    });
  });

  describe('2. Membership-level authorization (identity is NOT a member of B)', () => {
    beforeAll(async () => {
      const resp = await userServiceClient.delete(`/api/v1/projects/${projectBMongoId}/members/${sub}`);
      expect([200, 204]).toContain(resp.status);
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }, 20000);

    it('claiming scope B outright is rejected with 403', async () => {
      const resp = await client.get('/api/v1/comments', withScope(projectBId));
      expect(resp.status).toBe(403);
    });

    it('a write claiming scope B is rejected with 403', async () => {
      const resp = await client.post(
        '/api/v1/comments',
        { comments: 'nope', moduleId: 2, typeId: 'nope' },
        withScope(projectBId)
      );
      expect(resp.status).toBe(403);
    });

    it('a soft delete claiming scope B is rejected with 403', async () => {
      const resp = await client.put(
        `/api/v1/comments/deleteCommentById?id=${commentInB}`,
        {},
        withScope(projectBId)
      );
      expect(resp.status).toBe(403);
    });

    it('missing X-Project-Id is rejected with 403', async () => {
      const resp = await client.get('/api/v1/comments');
      expect(resp.status).toBe(403);
    });

    it('an unknown projectId is rejected with 403', async () => {
      const resp = await client.get('/api/v1/comments', withScope(99999999));
      expect(resp.status).toBe(403);
    });

    it('a non-integer projectId is rejected with 403', async () => {
      const resp = await client.get('/api/v1/comments', withScope('not-a-number'));
      expect(resp.status).toBe(403);
    });

    it(`GET /${DUMMY_ID} with valid scope A behaves cleanly for a nonexistent id`, async () => {
      const resp = await client.get(`/api/v1/comments/${DUMMY_ID}`, withScope(projectAId));
      expect(resp.status).toBe(200);
      expect(resp.data.data).toBeFalsy();
    });
  });

  describe('3. projectId comes from the verified header, never the body', () => {
    it('ignores a forged projectId in the create payload', async () => {
      const resp = await postWithCacheRetry(
        client,
        '/api/v1/comments',
        {
          comments: `WP-115 forged-scope comment ${runId}`,
          moduleId: 2,
          typeId: `WP115-FORGE-${runId}`,
          projectId: 99999999
        },
        withScope(projectAId)
      );
      expect(resp.status).toBe(201);
      expect(resp.data.data.projectId).toBe(projectAId);
      createdInA.push(resp.data.data._id);
    });

    it('an update cannot move a comment into another project', async () => {
      const created = await postWithCacheRetry(
        client,
        '/api/v1/comments',
        { comments: `WP-115 move-attempt ${runId}`, moduleId: 2, typeId: `WP115-MOVE-${runId}` },
        withScope(projectAId)
      );
      expect(created.status).toBe(201);
      createdInA.push(created.data.data._id);

      const resp = await client.put(
        `/api/v1/comments/updateCommentsByParam?id=${created.data.data._id}`,
        { projectId: 99999999, comments: 'still mine' },
        withScope(projectAId)
      );
      expect(resp.status).toBe(200);
      expect(resp.data.data.projectId).toBe(projectAId);
      expect(resp.data.data.comments).toBe('still mine');
    });
  });
});

// Suite teardown (WP-110 follow-up) — its own top-level afterAll, which Jest
// runs last. See shared/test-utils/fixtureCleanup.js.
afterAll(() => {
  purgeTrackedFixtures();
});
