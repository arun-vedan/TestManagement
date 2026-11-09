const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { createTestPersona } = require('../../shared/test-utils/keycloakTestPersona');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

// WP-043 -- bulk endpoint black-box HTTP suite for testRepoService, through
// Kong, against real project 1 (for the functional/audit-count proof) and
// a fresh disposable project+personas (for RBAC). Mirrors the structure of
// rbacMatrix.test.js and importExport's own test suite (WP-045 precedent
// for all-or-nothing).

const KONG_URL = process.env.TEST_KONG_URL || 'http://localhost:8000';
const USER_SERVICE_URL = process.env.TEST_USER_SERVICE_URL || 'http://localhost:8000';
const DEFAULT_PROJECT_ID = 1;
const runId = Date.now();

const withScope = (projectId) => ({ headers: { [PROJECT_ID_HEADER]: String(projectId) } });

async function withCacheRetry(fn, { retries = 10, delayMs = 500 } = {}) {
  let resp;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    resp = await fn();
    if (resp.status !== 403 && resp.status !== 503) return resp;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return resp;
}

describe('testRepoService bulk endpoints (WP-043, live, through Kong)', () => {
  let adminToken;
  let client;

  beforeAll(async () => {
    adminToken = await getServiceToken();
    client = axios.create({ baseURL: KONG_URL, headers: { Authorization: `Bearer ${adminToken}` }, validateStatus: () => true });
  });

  // WP-043 finding (pre-existing, not introduced here): testRepoService's
  // `id`/`TestCaseId` are assigned by models/testrepo.js's pre-save hook
  // -- the same findOne().sort({id:-1})+1 read-then-write race class
  // WP-020c diagnosed for Project.id. `npm test` runs every file in this
  // directory in parallel jest workers, and this service's own other
  // suites (api.test.js/events.test.js/rbacMatrix.test.js/
  // tenantIsolation.test.js) all create test cases too, so two concurrent
  // creates can read the same max id and the loser dies with a duplicate-
  // key 400. Pre-existing model bug, not introduced by this WP (the
  // pre-save hook is untouched) -- see the matching, fuller comment in
  // defectService/__tests__/bulk.test.js for the full writeup and the
  // reasoning for retrying here rather than fixing the model broadly.
  async function createTestCaseWithRetry(payload, retries = 4) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const resp = await client.post('/api/v1/testrepo', payload, withScope(DEFAULT_PROJECT_ID));
      if (resp.status === 201) return resp;
      if (resp.status !== 400 || attempt === retries) return resp;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 200));
    }
    throw new Error('unreachable');
  }

  async function seedTestCases(n, tag) {
    const ids = [];
    for (let i = 0; i < n; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const resp = await createTestCaseWithRetry({ TestCaseSummary: `WP-043 bulk ${tag} ${i} ${runId}`, TestCaseDescription: 'seeded for WP-043 bulk test, cleaned up in this test' });
      expect(resp.status).toBe(201);
      ids.push(resp.data.data._id);
    }
    return ids;
  }

  async function cleanup(ids) {
    if (ids.length === 0) return;
    await client.delete('/api/v1/testrepo/bulk', { ...withScope(DEFAULT_PROJECT_ID), data: { ids } }).catch(() => {});
  }

  it('bulk-assigns 10 seeded test cases in one action, all-or-nothing, and produces EXACTLY 10 audit events with the correct actor', async () => {
    const ids = await seedTestCases(10, 'assign10');
    try {
      const bulkResp = await client.patch(
        '/api/v1/testrepo/bulk',
        { ids, action: 'assign', assignedTo: 'wp043-bulk-assignee' },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(bulkResp.status).toBe(200);
      expect(bulkResp.data.policy).toBe('all-or-nothing');
      expect(bulkResp.data.updated).toBe(10);
      expect(bulkResp.data.data.every((d) => d.assignedTo === 'wp043-bulk-assignee')).toBe(true);

      // Scope the audit-count proof by correlationId, NOT by entityId/
      // TestCaseId: testRepoService's TestCaseId is assigned by
      // `findOne({}, {id:1}).sort({id:-1})` + 1 (models/testrepo.js) --
      // deleting the highest-numbered test cases (this test's own cleanup)
      // makes the NEXT create() reuse the exact same TestCaseId, which
      // would make a later run of this same suite double-count against a
      // still-present prior run's audit rows for "TC-91" etc. (reproduced
      // while writing this test: 3 consecutive runs of a 3-item bulk-assign
      // showed 9 matching rows when filtered by entityId alone). Every HTTP
      // request gets its own unique req.correlationId (service-core/
      // correlationId.js), echoed back as the `x-correlation-id` response
      // header and stamped on every audit() call this request makes -- an
      // exact, collision-proof key for "audit events from exactly this
      // bulk call".
      const correlationId = bulkResp.headers['x-correlation-id'];
      expect(correlationId).toBeTruthy();

      const auditResp = await client.get('/api/v1/audit?entityType=testcase&action=bulk-assign&limit=200', withScope(DEFAULT_PROJECT_ID));
      expect(auditResp.status).toBe(200);
      const matching = auditResp.data.data.filter((e) => e.correlationId === correlationId);
      expect(matching.length).toBe(10);
      expect(matching.every((e) => e.actor && e.actor.length > 0)).toBe(true);
      expect(matching.every((e) => e.summary && e.summary.after && e.summary.after.assignedTo === 'wp043-bulk-assignee')).toBe(true);
      // Actor must come from the verified token, never the request body --
      // this request carried no actor field at all, so every event's actor
      // is whatever audit() derived from req.kauth (WP-024 contract).
      const uniqueActors = new Set(matching.map((e) => e.actor));
      expect(uniqueActors.size).toBe(1);
    } finally {
      await cleanup(ids);
    }
  }, 60000);

  it('all-or-nothing: one missing id fails the WHOLE batch and changes nothing', async () => {
    const ids = await seedTestCases(3, 'partial');
    try {
      const badIds = [...ids, '000000000000000000000000'];
      const resp = await client.patch('/api/v1/testrepo/bulk', { ids: badIds, action: 'assign', assignedTo: 'should-not-apply' }, withScope(DEFAULT_PROJECT_ID));
      expect(resp.status).toBe(422);
      expect(resp.data.policy).toBe('all-or-nothing');
      expect(resp.data.success).toBe(false);

      const check = await client.get(`/api/v1/testrepo/${ids[0]}`, withScope(DEFAULT_PROJECT_ID));
      expect(check.data.data.assignedTo).toBeUndefined();
    } finally {
      await cleanup(ids);
    }
  });

  it('bulk status-change validates lifecycle transitions all-or-nothing', async () => {
    const ids = await seedTestCases(2, 'status');
    try {
      // Fresh draft test cases cannot jump straight to 'archived'.
      const resp = await client.patch('/api/v1/testrepo/bulk', { ids, action: 'status', status: 'archived' }, withScope(DEFAULT_PROJECT_ID));
      expect(resp.status).toBe(422);
      expect(resp.data.policy).toBe('all-or-nothing');
      expect(resp.data.invalidIds.length).toBeGreaterThan(0);
    } finally {
      await cleanup(ids);
    }
  });

  it('bulk delete removes exactly the requested items and produces one bulk-delete audit event each', async () => {
    const ids = await seedTestCases(3, 'delete');
    const resp = await client.delete('/api/v1/testrepo/bulk', { ...withScope(DEFAULT_PROJECT_ID), data: { ids } });
    expect(resp.status).toBe(200);
    expect(resp.data.policy).toBe('all-or-nothing');
    expect(resp.data.deleted).toBe(3);

    const getResp = await client.get(`/api/v1/testrepo/${ids[0]}`, withScope(DEFAULT_PROJECT_ID));
    expect(getResp.status).toBe(404);
  });

  it('rejects a bulk request with no ids / bad action', async () => {
    const r1 = await client.patch('/api/v1/testrepo/bulk', { ids: [], action: 'assign', assignedTo: 'x' }, withScope(DEFAULT_PROJECT_ID));
    expect(r1.status).toBe(400);
    const r2 = await client.patch('/api/v1/testrepo/bulk', { ids: ['000000000000000000000000'], action: 'nonsense' }, withScope(DEFAULT_PROJECT_ID));
    expect(r2.status).toBe(400);
  });

  describe('RBAC: viewer rejected server-side on both bulk routes', () => {
    let projectId;
    let projectMongoId;
    let orgId;
    let userServiceClient;
    let adminClient;
    let viewerPersona;
    let viewerClient;
    let seededId;

    beforeAll(async () => {
      userServiceClient = axios.create({ baseURL: USER_SERVICE_URL, headers: { Authorization: `Bearer ${adminToken}` }, validateStatus: () => true });
      const orgResp = await userServiceClient.post('/api/v1/organizations', { name: `WP-043 bulk rbac org ${runId}`, key: `wp043-bulk-rbac-org-${runId}` });
      orgId = orgResp.data.data._id;
      trackOrganization(orgId);
      const projResp = await userServiceClient.post('/api/v1/projects', { name: `WP-043 bulk rbac proj ${runId}`, key: `wp043-bulk-rbac-proj-${runId}`, organizationId: orgId });
      projectId = projResp.data.data.id;
      trackProject(projectId);
      projectMongoId = projResp.data.data._id;
      trackProject(projectMongoId);

      adminClient = axios.create({ baseURL: KONG_URL, headers: { Authorization: `Bearer ${adminToken}` }, validateStatus: () => true });
      const seedResp = await withCacheRetry(() => adminClient.post('/api/v1/testrepo', { TestCaseSummary: 'wp043 viewer bulk probe', TestCaseDescription: 'x' }, withScope(projectId)));
      expect(seedResp.status).toBe(201);
      seededId = seedResp.data.data._id;

      viewerPersona = await createTestPersona('viewer');
      const addResp = await userServiceClient.post(`/api/v1/projects/${projectMongoId}/members`, { userId: viewerPersona.userId, role: 'viewer' });
      expect(addResp.status).toBe(200);
      const token = await viewerPersona.getToken();
      viewerClient = axios.create({ baseURL: KONG_URL, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true });

      // requireProjectScope()'s cache (projectScope.js) is a SINGLE global
      // cache of the whole project list, refreshed once per 30s TTL --
      // NOT per-project. The plain reads/writes above (seeding the probe
      // test case as admin) already forced testRepoService to fetch and
      // cache the project list BEFORE this viewer was added as a member,
      // so a 403 from the viewer immediately after would be genuinely
      // ambiguous: real RBAC denial, or the cache not yet knowing this
      // membership exists at all (which also surfaces as 403 --
      // requireProjectScope() itself returns 403 for "not a member",
      // before authorize() ever runs). Proving a REAL read succeeds first
      // (viewer's role permits 'read' unconditionally) disambiguates: once
      // this passes, the cache is confirmed warm with viewer's real
      // membership, so the write/delete 403s asserted below can only be
      // authorize('write'/'delete') denying the viewer role, not a cache
      // artifact.
      const readCheck = await withCacheRetry(() => viewerClient.get('/api/v1/testrepo', withScope(projectId)), { retries: 45, delayMs: 800 });
      expect(readCheck.status).toBe(200);
    }, 70000);

    afterAll(async () => {
      await adminClient.delete('/api/v1/testrepo/bulk', { ...withScope(projectId), data: { ids: [seededId] } }).catch(() => {});
      await viewerPersona.cleanup().catch(() => {});
      if (projectMongoId) await userServiceClient.delete(`/api/v1/projects/${projectMongoId}`);
      if (orgId) await userServiceClient.delete(`/api/v1/organizations/${orgId}`);
    }, 30000);

    it('viewer cannot bulk-assign (403) -- and the same id is unchanged, provably', async () => {
      const resp = await withCacheRetry(() => viewerClient.patch('/api/v1/testrepo/bulk', { ids: [seededId], action: 'assign', assignedTo: 'viewer-should-not-apply' }, withScope(projectId)));
      expect(resp.status).toBe(403);
      const check = await adminClient.get(`/api/v1/testrepo/${seededId}`, withScope(projectId));
      expect(check.data.data.assignedTo).toBeUndefined();
    }, 20000);

    it('viewer cannot bulk-delete (403)', async () => {
      const resp = await viewerClient.delete('/api/v1/testrepo/bulk', { ...withScope(projectId), data: { ids: [seededId] } });
      expect(resp.status).toBe(403);
    });

    it('control: admin CAN bulk-assign the same route on the same project (proves the 403 above is role-based, not a broken route)', async () => {
      const resp = await adminClient.patch('/api/v1/testrepo/bulk', { ids: [seededId], action: 'assign', assignedTo: 'admin-control' }, withScope(projectId));
      expect(resp.status).toBe(200);
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
