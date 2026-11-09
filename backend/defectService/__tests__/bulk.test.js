const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { createTestPersona } = require('../../shared/test-utils/keycloakTestPersona');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

// WP-043 -- bulk endpoint black-box HTTP suite for defectService. See
// testRepoService/__tests__/bulk.test.js for the fuller comment on the
// pattern this follows; not repeated here.

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

describe('defectService bulk endpoints (WP-043, live, through Kong)', () => {
  let adminToken;
  let client;

  beforeAll(async () => {
    adminToken = await getServiceToken();
    client = axios.create({ baseURL: KONG_URL, headers: { Authorization: `Bearer ${adminToken}` }, validateStatus: () => true });
  });

  // WP-043 finding (pre-existing, not introduced here): defectService's
  // `id`/`defectId` are assigned by models/defects.js's pre-save hook --
  // `findOne({}, {id:1}).sort({id:-1}).limit(1)` then `+1` against a
  // `unique` index -- the SAME read-then-write race class WP-020c
  // diagnosed for Project.id. `npm test` runs every file in this
  // directory in parallel jest workers (no --runInBand,
  // scripts/run-api-tests.sh), and api.test.js/tenantIsolation.test.js/
  // events.test.js all create defects too, so two concurrent creates
  // (this file's and another's) can read the same max id and the loser
  // dies with `E11000 duplicate key error ... index: id_1` -> surfaced as
  // this route's generic 400 (reproduced live: `dup key: { id: 92 }`,
  // `dup key: { id: 108 }` across repeat runs). This is a real,
  // pre-existing model bug, NOT something WP-043 introduced (the pre-save
  // hook is untouched) -- fixing it broadly (e.g. an atomic counter)
  // would touch every create path across every consumer of that pattern
  // in this service, which is out of this WP's scope. Retrying THIS
  // suite's own seed calls on exactly that failure mode is a narrow,
  // honest mitigation for the concurrency this suite itself adds, not a
  // silent "assert broken behavior as expected" (GR-6) -- see
  // EXECUTION_LOG.md's WP-043 report for the full disclosure.
  async function createDefectWithRetry(payload, retries = 4) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const resp = await client.post('/api/v1/defects', payload, withScope(DEFAULT_PROJECT_ID));
      if (resp.status === 201) return resp;
      if (resp.status !== 400 || attempt === retries) return resp;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 200));
    }
    throw new Error('unreachable');
  }

  async function seedDefects(n, tag) {
    const ids = [];
    for (let i = 0; i < n; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const resp = await createDefectWithRetry({ summary: `WP-043 bulk ${tag} ${i} ${runId}`, Severity: 'High', Status: 'New' });
      expect(resp.status).toBe(201);
      ids.push(resp.data.data._id);
    }
    return ids;
  }

  async function cleanup(ids) {
    if (ids.length === 0) return;
    await client.delete('/api/v1/defects/bulk', { ...withScope(DEFAULT_PROJECT_ID), data: { ids } }).catch(() => {});
  }

  it('bulk-assigns defects, all-or-nothing, with one audit event per item', async () => {
    const ids = await seedDefects(4, 'assign');
    try {
      const resp = await client.patch('/api/v1/defects/bulk', { ids, action: 'assign', assignedTo: 'wp043-defect-assignee' }, withScope(DEFAULT_PROJECT_ID));
      expect(resp.status).toBe(200);
      expect(resp.data.policy).toBe('all-or-nothing');
      expect(resp.data.updated).toBe(4);
      expect(resp.data.data.every((d) => d.assignedTo === 'wp043-defect-assignee')).toBe(true);

      // See testRepoService/__tests__/bulk.test.js's matching comment:
      // defectId is assigned by the same findOne().sort({id:-1})+1 pattern
      // and can be reused after a delete, so the audit-count proof is
      // scoped by the unique-per-request x-correlation-id header, not by
      // entityId.
      const correlationId = resp.headers['x-correlation-id'];
      expect(correlationId).toBeTruthy();
      const auditResp = await client.get('/api/v1/audit?entityType=defect&action=bulk-assign&limit=200', withScope(DEFAULT_PROJECT_ID));
      const matching = auditResp.data.data.filter((e) => e.correlationId === correlationId);
      expect(matching.length).toBe(4);
    } finally {
      await cleanup(ids);
    }
  }, 30000);

  it('all-or-nothing: a missing id fails the whole batch', async () => {
    const ids = await seedDefects(2, 'partial');
    try {
      const resp = await client.patch('/api/v1/defects/bulk', { ids: [...ids, '000000000000000000000000'], action: 'assign', assignedTo: 'nope' }, withScope(DEFAULT_PROJECT_ID));
      expect(resp.status).toBe(422);
      expect(resp.data.policy).toBe('all-or-nothing');

      const check = await client.get(`/api/v1/defects/${ids[0]}`, withScope(DEFAULT_PROJECT_ID));
      expect(check.data.data.assignedTo).toBeUndefined();
    } finally {
      await cleanup(ids);
    }
  });

  it('bulk delete removes exactly the requested defects', async () => {
    const ids = await seedDefects(2, 'delete');
    const resp = await client.delete('/api/v1/defects/bulk', { ...withScope(DEFAULT_PROJECT_ID), data: { ids } });
    expect(resp.status).toBe(200);
    expect(resp.data.deleted).toBe(2);
    const getResp = await client.get(`/api/v1/defects/${ids[0]}`, withScope(DEFAULT_PROJECT_ID));
    expect(getResp.status).toBe(404);
  });

  it('bulk status-change is deliberately unsupported for defects (400, explicit reason)', async () => {
    const ids = await seedDefects(1, 'status');
    try {
      const resp = await client.patch('/api/v1/defects/bulk', { ids, action: 'status', status: 'Open' }, withScope(DEFAULT_PROJECT_ID));
      expect(resp.status).toBe(400);
      expect(resp.data.error).toMatch(/not supported for defects/);
    } finally {
      await cleanup(ids);
    }
  });

  describe('RBAC: viewer rejected server-side', () => {
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
      const orgResp = await userServiceClient.post('/api/v1/organizations', { name: `WP-043 defect bulk rbac org ${runId}`, key: `wp043-defect-bulk-rbac-org-${runId}` });
      orgId = orgResp.data.data._id;
      trackOrganization(orgId);
      const projResp = await userServiceClient.post('/api/v1/projects', { name: `WP-043 defect bulk rbac proj ${runId}`, key: `wp043-defect-bulk-rbac-proj-${runId}`, organizationId: orgId });
      projectId = projResp.data.data.id;
      trackProject(projectId);
      projectMongoId = projResp.data.data._id;
      trackProject(projectMongoId);

      adminClient = axios.create({ baseURL: KONG_URL, headers: { Authorization: `Bearer ${adminToken}` }, validateStatus: () => true });
      const seedResp = await withCacheRetry(() => adminClient.post('/api/v1/defects', { summary: 'wp043 viewer defect bulk probe', Severity: 'High', Status: 'New' }, withScope(projectId)));
      expect(seedResp.status).toBe(201);
      seededId = seedResp.data.data._id;

      viewerPersona = await createTestPersona('viewer');
      const addResp = await userServiceClient.post(`/api/v1/projects/${projectMongoId}/members`, { userId: viewerPersona.userId, role: 'viewer' });
      expect(addResp.status).toBe(200);
      const token = await viewerPersona.getToken();
      viewerClient = axios.create({ baseURL: KONG_URL, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true });

      // See testRepoService/__tests__/bulk.test.js's matching comment:
      // requireProjectScope()'s cache is a single GLOBAL cache of the
      // whole project list (30s TTL), not per-project -- prove a real read
      // succeeds first so the write/delete 403s below are unambiguously
      // authorize() denying the viewer role, not the cache not yet
      // knowing about this membership.
      const readCheck = await withCacheRetry(() => viewerClient.get('/api/v1/defects', withScope(projectId)), { retries: 45, delayMs: 800 });
      expect(readCheck.status).toBe(200);
    }, 70000);

    afterAll(async () => {
      await adminClient.delete('/api/v1/defects/bulk', { ...withScope(projectId), data: { ids: [seededId] } }).catch(() => {});
      await viewerPersona.cleanup().catch(() => {});
      if (projectMongoId) await userServiceClient.delete(`/api/v1/projects/${projectMongoId}`);
      if (orgId) await userServiceClient.delete(`/api/v1/organizations/${orgId}`);
    }, 30000);

    it('viewer cannot bulk-assign defects (403)', async () => {
      const resp = await withCacheRetry(() => viewerClient.patch('/api/v1/defects/bulk', { ids: [seededId], action: 'assign', assignedTo: 'x' }, withScope(projectId)));
      expect(resp.status).toBe(403);
    }, 20000);

    it('viewer cannot bulk-delete defects (403)', async () => {
      const resp = await viewerClient.delete('/api/v1/defects/bulk', { ...withScope(projectId), data: { ids: [seededId] } });
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
