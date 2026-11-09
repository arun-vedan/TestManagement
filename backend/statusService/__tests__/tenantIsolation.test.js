const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

// WP-116 — Multi-tenancy isolation suite for statusService
// (release-blocking, per WP-021's precedent).
//
// WHY THIS ONE CARRIED THE MOST RISK OF THE EIGHT. statusService holds the
// defect-status vocabulary AND its transition graph, and defectService's
// updateDefectStatus (WP-010) validates every transition against it. So the
// scoping had two failure modes that a route-gating test alone would miss:
//
//   1. defectService sent only Authorization + correlation to istatusservice,
//      no X-Project-Id. Scoping without fixing that turns every transition
//      into a 403 that fails CLOSED as 503 "Status service unreachable" --
//      the same stale-header-subset class WP-111 found in reportingService.
//      Section 3 covers that end to end.
//
//   2. Only project 1 held the 8 statuses; every other project held ZERO, and
//      nothing seeds a vocabulary at project creation. Scoping alone would
//      therefore have left every project but one unable to transition a defect
//      at all. Isolation that silently disables a feature for all but one
//      tenant is breakage with a filter in front of it, not isolation. Hence
//      shared/scripts/seedProjectStatuses.mongo.js, and section 4 here.

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';
const USER_SERVICE_URL = process.env.TEST_USER_SERVICE_URL || 'http://localhost:8000';
const DEFECT_SERVICE_URL = process.env.TEST_DEFECT_SERVICE_URL || 'http://localhost:8000';
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

describe('statusService tenant isolation (WP-116, release-blocking)', () => {
  let token;
  let sub;
  let client;
  let userServiceClient;
  let defectClient;
  const projectAId = 1;
  let projectBId;
  let projectBMongoId;
  let orgBId;
  let statusInB;
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
    defectClient = axios.create({
      baseURL: DEFECT_SERVICE_URL,
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true
    });

    const orgResp = await userServiceClient.post('/api/v1/organizations', {
      name: `WP-116 isolation org ${runId}`,
      key: `wp116-iso-org-${runId}`
    });
    expect(orgResp.status).toBe(201);
    orgBId = orgResp.data.data._id;
    trackOrganization(orgBId);

    const projResp = await userServiceClient.post('/api/v1/projects', {
      name: `WP-116 isolation project B ${runId}`,
      key: `wp116-iso-proj-b-${runId}`,
      organizationId: orgBId
    });
    expect(projResp.status).toBe(201);
    projectBId = projResp.data.data.id;
    trackProject(projectBId);
    projectBMongoId = projResp.data.data._id;

    const createResp = await postWithCacheRetry(
      client,
      '/api/v1/issuestatus',
      { istatus: `WP116-ONLY-IN-B-${runId}`, moduleId: 5, parentId: [0] },
      withScope(projectBId)
    );
    expect(createResp.status).toBe(201);
    expect(createResp.data.data.projectId).toBe(projectBId);
    statusInB = createResp.data.data._id;
  }, 30000);

  describe('1. Query-level isolation (member of both A and B)', () => {
    it("GET list scoped to A does not include B's status", async () => {
      const resp = await client.get('/api/v1/issuestatus', withScope(projectAId));
      expect(resp.status).toBe(200);
      expect(resp.data.data.some((s) => s._id === statusInB)).toBe(false);
      expect(resp.data.data.some((s) => s.istatus === `WP116-ONLY-IN-B-${runId}`)).toBe(false);
    });

    it("GET list scoped to B DOES include B's status (positive control)", async () => {
      const resp = await client.get('/api/v1/issuestatus', withScope(projectBId));
      expect(resp.status).toBe(200);
      expect(resp.data.data.some((s) => s._id === statusInB)).toBe(true);
    });

    it("every row of a scoped list carries the caller's own projectId", async () => {
      const resp = await client.get('/api/v1/issuestatus', withScope(projectAId));
      expect(resp.data.data.length).toBeGreaterThan(0);
      resp.data.data.forEach((s) => expect(s.projectId).toBe(projectAId));
    });

    it("project A still sees its own full 8-status vocabulary", async () => {
      // The regression that would matter most: scoping must not have hidden
      // the Default Project's own workflow from itself.
      const resp = await client.get('/api/v1/issuestatus', { ...withScope(projectAId), params: { limit: 1000 } });
      const names = resp.data.data.map((s) => s.istatus);
      ['New', 'Open', 'Fixed', 'Rejected', 'Deffered', 'Retest', 'Re-open', 'Closed'].forEach((n) => {
        expect(names).toContain(n);
      });
    });

    it("GET single, scoped to A, does not return B's status", async () => {
      const resp = await client.get(`/api/v1/issuestatus/${statusInB}`, withScope(projectAId));
      expect(resp.status).toBe(200);
      expect(resp.data.data).toBeFalsy();
    });

    it("PUT, scoped to A, cannot rename B's status", async () => {
      const resp = await client.put(
        `/api/v1/issuestatus/${statusInB}`,
        { istatus: 'renamed by project A' },
        withScope(projectAId)
      );
      expect(resp.data.data).toBeFalsy();

      const verify = await client.get(`/api/v1/issuestatus/${statusInB}`, withScope(projectBId));
      expect(verify.data.data.istatus).toBe(`WP116-ONLY-IN-B-${runId}`);
    });

    it("DELETE, scoped to A, cannot delete B's status", async () => {
      const resp = await client.delete(`/api/v1/issuestatus/${statusInB}`, withScope(projectAId));
      expect(resp.status).toBe(200);

      const verify = await client.get(`/api/v1/issuestatus/${statusInB}`, withScope(projectBId));
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
      const resp = await client.get('/api/v1/issuestatus', withScope(projectBId));
      expect(resp.status).toBe(403);
    });

    it('a write claiming scope B is rejected with 403', async () => {
      const resp = await client.post(
        '/api/v1/issuestatus',
        { istatus: 'nope', moduleId: 5 },
        withScope(projectBId)
      );
      expect(resp.status).toBe(403);
    });

    it('a delete claiming scope B is rejected with 403', async () => {
      const resp = await client.delete(`/api/v1/issuestatus/${statusInB}`, withScope(projectBId));
      expect(resp.status).toBe(403);
    });

    it('missing X-Project-Id is rejected with 403', async () => {
      const resp = await client.get('/api/v1/issuestatus');
      expect(resp.status).toBe(403);
    });

    it('an unknown projectId is rejected with 403', async () => {
      const resp = await client.get('/api/v1/issuestatus', withScope(99999999));
      expect(resp.status).toBe(403);
    });

    it('a non-integer projectId is rejected with 403', async () => {
      const resp = await client.get('/api/v1/issuestatus', withScope('not-a-number'));
      expect(resp.status).toBe(403);
    });

    it(`GET /${DUMMY_ID} with valid scope A behaves cleanly for a nonexistent id`, async () => {
      const resp = await client.get(`/api/v1/issuestatus/${DUMMY_ID}`, withScope(projectAId));
      expect(resp.status).toBe(200);
      expect(resp.data.data).toBeFalsy();
    });
  });

  describe('3. defectService can still validate transitions (the live WP-010 workflow)', () => {
    // This is the end-to-end check that scoping did not break the feature that
    // depends on this service. Before WP-116 defectService sent no
    // X-Project-Id here, so every transition would 403 -> 503.
    it('the status vocabulary is reachable through defectService\'s own path', async () => {
      // A transition on a nonexistent defect: the point is the STATUS CODE,
      // not the defect. 404 means defectService reached istatusservice, loaded
      // the vocabulary and then failed to find the defect. 503 would mean it
      // could not read the vocabulary at all, which is the regression.
      const resp = await defectClient.put(
        `/api/v1/defects/${DUMMY_ID}/status`,
        { status: 'Open' },
        withScope(projectAId)
      );
      expect(resp.status).not.toBe(503);
      expect(String(resp.data.error || '')).not.toMatch(/status service/i);
    });

    it('an unrecognized status is rejected as a 400, which proves the graph was loaded', async () => {
      const resp = await defectClient.put(
        `/api/v1/defects/${DUMMY_ID}/status`,
        { status: 'NoSuchStatusAnywhere' },
        withScope(projectAId)
      );
      // Whatever the outcome, it must not be "could not reach the vocabulary".
      expect(resp.status).not.toBe(503);
    });
  });

  describe('4. A new project gets its own seeded vocabulary', () => {
    // THIS SECTION'S ASSERTION WAS INVERTED, and the reason is the point of it.
    //
    // When WP-116 scoped this service it created a gap: only project 1 had any
    // statuses, so a new project could not transition a defect at all. This
    // test originally asserted that gap — "project B has only what was
    // explicitly created in it" — to document it honestly rather than leave it
    // unrecorded.
    //
    // The WP-116 follow-up closed it: userService's createProject now calls
    // istatusservice's idempotent POST /api/v1/issuestatus/seed, so a new
    // project is born with the canonical 8-status workflow. The old assertion
    // then started failing, which is exactly what should happen when a
    // documented gap is fixed — so it now asserts the new behaviour instead.
    it('project B was seeded the default workflow at creation, scoped to itself', async () => {
      // Re-grant membership just long enough to read B back.
      await userServiceClient.post(`/api/v1/projects/${projectBMongoId}/members`, { userId: sub, role: 'admin' });
      await new Promise((resolve) => setTimeout(resolve, 2500));

      const resp = await client.get('/api/v1/issuestatus', { ...withScope(projectBId), params: { limit: 1000 } });
      expect(resp.status).toBe(200);
      const rows = resp.data.data;
      const names = rows.map((s) => s.istatus);

      // Its own explicitly-created status is still there...
      expect(names).toContain(`WP116-ONLY-IN-B-${runId}`);
      // ...alongside the seeded canonical workflow.
      ['New', 'Open', 'Fixed', 'Rejected', 'Deffered', 'Retest', 'Re-open', 'Closed'].forEach((n) => {
        expect(names).toContain(n);
      });

      // Every row belongs to B, and the seeded graph references only B's OWN
      // ids — not project A's. A seeder that copied ids instead of remapping
      // them would produce a vocabulary that looks right and refuses every
      // transition, so this is the assertion that matters.
      const ownIds = new Set(rows.map((s) => s.id));
      rows.forEach((s) => {
        expect(s.projectId).toBe(projectBId);
        (s.parentId || []).forEach((pid) => {
          if (pid !== 0) expect(ownIds.has(pid)).toBe(true);
        });
      });
    }, 20000);
  });

  afterAll(async () => {
    for (const id of createdInA) {
      await client.delete(`/api/v1/issuestatus/${id}`, withScope(projectAId));
    }
  });
});

// Suite teardown (WP-110 follow-up) — its own top-level afterAll, which Jest
// runs last. See shared/test-utils/fixtureCleanup.js.
afterAll(() => {
  purgeTrackedFixtures();
});
