const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { createTestPersona } = require('../../shared/test-utils/keycloakTestPersona');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

// WP-043 -- SavedView black-box HTTP suite, through Kong, against real
// project/persona data (same pattern as testRepoService/__tests__/
// rbacMatrix.test.js). Proves: the four seeded system defaults appear per
// entityType with no read-then-write id race (upsert-based, see
// controllers/savedView.js), personal CRUD, persistence across a FRESH
// token (a new client.getToken() call -- i.e. a new "session"), ownership
// isolation between two different personas, and that a viewer can read but
// not write/delete.
//
// FIXTURE HYGIENE (a real bug found and fixed, not the initial design):
// the outer describe originally created its OWN disposable org/project for
// every run, same as the RBAC sub-describe below. That leaked: system
// (seeded default) SavedView documents are, by this WP's own design,
// permanently un-deletable through the API (only ever seeded, see
// controllers/savedView.js), and userService's project DELETE is a
// soft-delete/archive (WP-022 precedent), not a hard delete -- so every
// run of this file's outer describe against a throwaway project left 4
// permanently-orphaned SavedView documents behind (defect x2 + testexecution
// x1 + requirement x1) in srckube-fields with no cleanup path at all.
// Reproduced live: repeated runs during this WP's own development left 7
// distinct orphaned projectIds (28 documents) before this fix -- see
// EXECUTION_LOG.md's WP-043 report for the disclosure and count. Fixed by
// running the outer describe's CRUD/seeding tests against the real,
// permanent Default Project (id=1, `DEFAULT_PROJECT_ID` below) instead of
// a disposable one -- project 1 already carries its own correctly-seeded
// four defaults (verified independently, see the report), so "seeds them
// idempotently" is proven just as validly by asserting two consecutive
// GETs agree, with no new project needed. Only the RBAC sub-describe still
// creates (and archives) a disposable project, because it genuinely needs
// an isolated, freshly-added viewer membership -- and it only ever queries
// entityType 'testcase' (no seeded defaults exist for that type), so it
// contributes zero new orphaned system-view documents.

const KONG_URL = process.env.TEST_KONG_URL || 'http://localhost:8000';
const USER_SERVICE_URL = process.env.TEST_USER_SERVICE_URL || 'http://localhost:8000';
const DEFAULT_PROJECT_ID = 1;
const runId = Date.now();

const withScope = (projectId) => ({ headers: { [PROJECT_ID_HEADER]: String(projectId) } });

// requireProjectScope()'s in-process membership cache is per-container and
// takes up to ~30s to warm for a brand-new project -- same retry helper as
// rbacMatrix.test.js/tenantIsolation.test.js, not a bug when seen here.
async function withCacheRetry(fn, { retries = 10, delayMs = 500 } = {}) {
  let resp;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    resp = await fn();
    if (resp.status !== 403 && resp.status !== 503) return resp;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return resp;
}

describe('SavedView API (WP-043, live, through Kong)', () => {
  let adminToken;
  let userServiceClient;
  const projectId = DEFAULT_PROJECT_ID; // see header comment: real project, not disposable -- no orphan risk
  let adminClient;
  const createdViewIds = [];

  beforeAll(async () => {
    adminToken = await getServiceToken();
    userServiceClient = axios.create({
      baseURL: USER_SERVICE_URL,
      headers: { Authorization: `Bearer ${adminToken}` },
      validateStatus: () => true
    });
    adminClient = axios.create({ baseURL: KONG_URL, headers: { Authorization: `Bearer ${adminToken}` }, validateStatus: () => true });
  }, 60000);

  afterAll(async () => {
    // Only personal views need cleanup here -- system (seeded default)
    // views on project 1 are permanent by design and were never created
    // fresh by this describe (they pre-exist / are idempotently upserted).
    for (const id of createdViewIds) {
      await adminClient.delete(`/api/v1/savedviews/${id}`, withScope(projectId)).catch(() => {});
    }
  }, 30000);

  it('seeds the four named default views, exactly once per entityType, idempotently', async () => {
    const defectResp1 = await withCacheRetry(() => adminClient.get('/api/v1/savedviews?entityType=defect', withScope(projectId)));
    expect(defectResp1.status).toBe(200);
    const names1 = defectResp1.data.data.map((v) => v.name).sort();
    expect(names1).toEqual(['Critical defects', 'Unassigned']);
    expect(defectResp1.data.data.every((v) => v.isSystem === true && v.ownerId === null)).toBe(true);

    // Calling again must not duplicate them (upsert, not create).
    const defectResp2 = await adminClient.get('/api/v1/savedviews?entityType=defect', withScope(projectId));
    expect(defectResp2.data.count).toBe(2);

    const testexecResp = await adminClient.get('/api/v1/savedviews?entityType=testexecution', withScope(projectId));
    expect(testexecResp.data.data.map((v) => v.name)).toEqual(['My failed tests']);

    const reqResp = await adminClient.get('/api/v1/savedviews?entityType=requirement', withScope(projectId));
    expect(reqResp.data.data.map((v) => v.name)).toEqual(['Untested requirements']);
  }, 30000);

  it('creates a personal view, updates it, and persistence survives a fresh token (new session)', async () => {
    const createResp = await adminClient.post(
      '/api/v1/savedviews',
      { entityType: 'testcase', name: `WP-043 my view ${runId}`, filterModel: { items: [{ field: 'status', operator: 'equals', value: 'draft' }] }, queryParams: { status: 'draft' } },
      withScope(projectId)
    );
    expect(createResp.status).toBe(201);
    const id = createResp.data.data._id;
    createdViewIds.push(id);
    expect(createResp.data.data.ownerId).toBeTruthy();
    expect(createResp.data.data.isSystem).toBe(false);

    // A genuinely fresh token, not the cached one above -- simulates
    // re-fetching in a brand-new session.
    const freshToken = await getServiceToken();
    const freshClient = axios.create({ baseURL: KONG_URL, headers: { Authorization: `Bearer ${freshToken}` }, validateStatus: () => true });
    const listResp = await freshClient.get('/api/v1/savedviews?entityType=testcase', withScope(projectId));
    expect(listResp.status).toBe(200);
    const found = listResp.data.data.find((v) => v._id === id);
    expect(found).toBeTruthy();
    expect(found.queryParams).toEqual({ status: 'draft' });

    const updateResp = await freshClient.put(`/api/v1/savedviews/${id}`, { name: `WP-043 my view renamed ${runId}` }, withScope(projectId));
    expect(updateResp.status).toBe(200);
    expect(updateResp.data.data.name).toBe(`WP-043 my view renamed ${runId}`);
  }, 30000);

  it('rejects a duplicate name for the same (project, entityType, owner)', async () => {
    const name = `WP-043 dup view ${runId}`;
    const r1 = await adminClient.post('/api/v1/savedviews', { entityType: 'testcase', name }, withScope(projectId));
    expect(r1.status).toBe(201);
    createdViewIds.push(r1.data.data._id);
    const r2 = await adminClient.post('/api/v1/savedviews', { entityType: 'testcase', name }, withScope(projectId));
    expect(r2.status).toBe(409);
  });

  it('system (seeded default) views cannot be edited or deleted through the API', async () => {
    const listResp = await adminClient.get('/api/v1/savedviews?entityType=defect', withScope(projectId));
    const systemView = listResp.data.data.find((v) => v.isSystem);
    expect(systemView).toBeTruthy();

    const updResp = await adminClient.put(`/api/v1/savedviews/${systemView._id}`, { name: 'hijacked' }, withScope(projectId));
    expect(updResp.status).toBe(403);

    const delResp = await adminClient.delete(`/api/v1/savedviews/${systemView._id}`, withScope(projectId));
    expect(delResp.status).toBe(403);
  });

  describe('RBAC: viewer can read (own + system), cannot write/delete -- rejected server-side', () => {
    // Deliberately a SEPARATE, brand-new project, not the outer describe's
    // `projectId` -- requireProjectScope()'s per-project membership cache
    // (fieldsservice's own container-local copy) was already warmed by the
    // CRUD tests above calling adminClient against that project BEFORE
    // this viewer persona would be added to it, so a member added
    // afterward would not be visible to fieldsservice until the cache's
    // ~30s TTL naturally expires (reproduced while writing this test: the
    // read below failed with a persistent 403 for the first ~5s of
    // retries against the reused project). A fresh project sidesteps that
    // entirely -- same fix bulk.test.js's RBAC describes already use.
    let rbacProjectId;
    let rbacProjectMongoId;
    let rbacOrgId;
    let viewerPersona;
    let viewerClient;

    beforeAll(async () => {
      const orgResp = await userServiceClient.post('/api/v1/organizations', { name: `WP-043 savedview rbac org ${runId}`, key: `wp043-sv-rbac-org-${runId}` });
      rbacOrgId = orgResp.data.data._id;
      trackOrganization(rbacOrgId);
      const projResp = await userServiceClient.post('/api/v1/projects', { name: `WP-043 savedview rbac proj ${runId}`, key: `wp043-sv-rbac-proj-${runId}`, organizationId: rbacOrgId });
      rbacProjectId = projResp.data.data.id;
      trackProject(rbacProjectId);
      rbacProjectMongoId = projResp.data.data._id;
      trackProject(rbacProjectMongoId);

      viewerPersona = await createTestPersona('viewer');
      const addResp = await userServiceClient.post(`/api/v1/projects/${rbacProjectMongoId}/members`, {
        userId: viewerPersona.userId,
        role: 'viewer'
      });
      expect(addResp.status).toBe(200);
      const token = await viewerPersona.getToken();
      viewerClient = axios.create({ baseURL: KONG_URL, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true });
    }, 30000);

    afterAll(async () => {
      await viewerPersona.cleanup().catch(() => {});
      if (rbacProjectMongoId) await userServiceClient.delete(`/api/v1/projects/${rbacProjectMongoId}`);
      if (rbacOrgId) await userServiceClient.delete(`/api/v1/organizations/${rbacOrgId}`);
    }, 15000);

    it('viewer can list saved views', async () => {
      // requireProjectScope()'s in-process cache (projectScope.js) is a
      // SINGLE global cache of the whole project list, not per-project --
      // refreshed once per 30s TTL regardless of which project a request
      // asks about. The CRUD tests above already made fieldsservice fetch
      // and cache that list before this viewer was added as a member, so
      // the default ~5s retry budget isn't enough here; wait out the full
      // TTL (see GR: "membership is cached 30s ... do not misread as an
      // authorization bug").
      const resp = await withCacheRetry(
        () => viewerClient.get('/api/v1/savedviews?entityType=testcase', withScope(rbacProjectId)),
        { retries: 45, delayMs: 800 }
      );
      expect(resp.status).toBe(200);
    }, 45000);

    it('viewer cannot create a saved view (403, server-side, not just hidden in the UI)', async () => {
      const resp = await viewerClient.post('/api/v1/savedviews', { entityType: 'testcase', name: 'viewer should not be able to save this' }, withScope(rbacProjectId));
      expect(resp.status).toBe(403);
    });

    it('viewer cannot delete a saved view (403)', async () => {
      const resp = await viewerClient.delete(`/api/v1/savedviews/000000000000000000000000`, withScope(rbacProjectId));
      expect(resp.status).toBe(403);
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
