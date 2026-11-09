const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { createTestPersona } = require('../../shared/test-utils/keycloakTestPersona');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

// Security-gap fix (2026-09) — release-blocking permission-matrix suite
// (HTTP level) for releaseService, modeled directly on
// testRepoService/__tests__/rbacMatrix.test.js (WP-022). Before this fix,
// every route in backend/releaseService/routes/{releases,environments}.js
// mounted keycloak.protect() + requireProjectScope() but never
// authorize(action) — a viewer could create/update/delete releases and
// environments. This suite proves the real ROUTES of the live
// releaseService container are now actually wired to authorize(), end to
// end, with REAL distinct persona identities holding each of the four
// roles — not mocked requests, and not a grep for the word "authorize".
//
// permissions.test.js / authorize.test.js (backend/shared/service-core/
// __tests__/) already prove the shared matrix and middleware exhaustively
// at the unit level; this suite's job is the wiring, on this service's own
// routes, through Kong, in the real container.

const KONG_URL = process.env.TEST_KONG_URL || 'http://localhost:8000';
const USER_SERVICE_URL = process.env.TEST_USER_SERVICE_URL || 'http://localhost:8000';
const runId = Date.now();

const withScope = (projectId) => ({ headers: { [PROJECT_ID_HEADER]: String(projectId) } });

// requireProjectScope()'s in-process project-list cache is global to the
// container (see projectScope.js) -- same cache-population race
// tenantIsolation.test.js documents and retries around.
async function withCacheRetry(fn, { retries = 8, delayMs = 400 } = {}) {
  let resp;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    resp = await fn();
    if (resp.status !== 403) return resp;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return resp;
}

describe('releaseService RBAC permission matrix (security-gap fix, release-blocking, HTTP level)', () => {
  let adminToken;
  let userServiceClient;
  let projectId; // numeric, for X-Project-Id
  let projectMongoId;
  let orgId;
  const personas = {}; // role -> { persona, client }
  const createdReleaseIds = []; // _id[] to clean up

  beforeAll(async () => {
    adminToken = await getServiceToken();
    userServiceClient = axios.create({
      baseURL: USER_SERVICE_URL,
      headers: { Authorization: `Bearer ${adminToken}` },
      validateStatus: () => true
    });

    const orgResp = await userServiceClient.post('/api/v1/organizations', {
      name: `release-rbac matrix org ${runId}`,
      key: `rel-rbac-org-${runId}`
    });
    expect(orgResp.status).toBe(201);
    orgId = orgResp.data.data._id;
    trackOrganization(orgId);

    const projResp = await userServiceClient.post('/api/v1/projects', {
      name: `release-rbac matrix project ${runId}`,
      key: `rel-rbac-proj-${runId}`,
      organizationId: orgId
    });
    expect(projResp.status).toBe(201);
    projectId = projResp.data.data.id;
    trackProject(projectId);
    projectMongoId = projResp.data.data._id;
    trackProject(projectMongoId);

    // Create one real persona per role and add each to the project with
    // that exact role. The service account (already project admin as
    // creator) does the adding.
    for (const role of ['admin', 'manager', 'contributor', 'viewer']) {
      const persona = await createTestPersona(role);
      const addResp = await userServiceClient.post(`/api/v1/projects/${projectMongoId}/members`, {
        userId: persona.userId,
        role
      });
      expect(addResp.status).toBe(200);
      const token = await persona.getToken();
      personas[role] = {
        persona,
        client: axios.create({
          baseURL: KONG_URL,
          headers: { Authorization: `Bearer ${token}` },
          validateStatus: () => true
        })
      };
    }
  }, 60000);

  afterAll(async () => {
    // Clean up entities directly via the service-account (project admin
    // creator) through Kong.
    const cleanupClient = axios.create({ baseURL: KONG_URL, headers: { Authorization: `Bearer ${adminToken}` }, validateStatus: () => true });
    for (const id of createdReleaseIds) {
      await cleanupClient.delete(`/api/v1/releases/${id}`, withScope(projectId)).catch(() => {});
    }
    for (const role of Object.keys(personas)) {
      await personas[role].persona.cleanup().catch(() => {});
    }
    if (projectMongoId) {
      await userServiceClient.delete(`/api/v1/projects/${projectMongoId}`);
    }
    if (orgId) {
      await userServiceClient.delete(`/api/v1/organizations/${orgId}`);
    }
  }, 30000);

  describe('read: every role can list and view releases (viewer = read-only everywhere, but still reads everywhere)', () => {
    it.each(['admin', 'manager', 'contributor', 'viewer'])('%s can GET /api/v1/releases', async (role) => {
      const resp = await withCacheRetry(() => personas[role].client.get('/api/v1/releases', withScope(projectId)));
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);
    });
  });

  describe('write (create release): admin/manager/contributor allowed, viewer denied', () => {
    it.each([
      ['admin', true],
      ['manager', true],
      ['contributor', true],
      ['viewer', false]
    ])('%s create -> allowed=%s', async (role, allowed) => {
      const resp = await personas[role].client.post(
        '/api/v1/releases',
        { name: `rbac matrix release ${role} ${Date.now()}` },
        withScope(projectId)
      );
      if (allowed) {
        expect(resp.status).toBe(201);
        createdReleaseIds.push(resp.data.data._id);
      } else {
        expect(resp.status).toBe(403);
      }
    });
  });

  describe('write (update release): admin/manager/contributor allowed, viewer denied', () => {
    let releaseId;

    beforeAll(async () => {
      const createResp = await personas.admin.client.post(
        '/api/v1/releases',
        { name: `rbac matrix update-target ${Date.now()}` },
        withScope(projectId)
      );
      expect(createResp.status).toBe(201);
      releaseId = createResp.data.data._id;
      createdReleaseIds.push(releaseId);
    });

    it.each([
      ['admin', true],
      ['manager', true],
      ['contributor', true],
      ['viewer', false]
    ])('%s update -> allowed=%s', async (role, allowed) => {
      const resp = await personas[role].client.put(
        `/api/v1/releases/${releaseId}`,
        { notes: `touched by ${role}` },
        withScope(projectId)
      );
      expect(resp.status).toBe(allowed ? 200 : 403);
    });
  });

  describe('delete: admin/manager allowed, contributor/viewer denied', () => {
    let deletableId;

    beforeAll(async () => {
      const createResp = await personas.admin.client.post(
        '/api/v1/releases',
        { name: `rbac matrix delete-target ${Date.now()}` },
        withScope(projectId)
      );
      expect(createResp.status).toBe(201);
      deletableId = createResp.data.data._id;
    });

    it('viewer cannot delete (403) -- proves viewer changes nothing', async () => {
      const resp = await personas.viewer.client.delete(`/api/v1/releases/${deletableId}`, withScope(projectId));
      expect(resp.status).toBe(403);
    });

    it('contributor cannot delete (403)', async () => {
      const resp = await personas.contributor.client.delete(`/api/v1/releases/${deletableId}`, withScope(projectId));
      expect(resp.status).toBe(403);
    });

    it('manager can delete (200)', async () => {
      const resp = await personas.manager.client.delete(`/api/v1/releases/${deletableId}`, withScope(projectId));
      expect(resp.status).toBe(200);
    });
  });

  describe('gate-status: gated \'read\' -- every role (including viewer) can evaluate it', () => {
    let releaseId;

    beforeAll(async () => {
      // No qualityGates configured -- gate-status evaluates an empty rule
      // list (trivially "green") without needing any downstream service,
      // which keeps this a pure RBAC-wiring probe rather than also
      // depending on testPlanExecutionService/defectService/istatusService
      // being reachable.
      const createResp = await personas.admin.client.post(
        '/api/v1/releases',
        { name: `rbac matrix gate-status target ${Date.now()}` },
        withScope(projectId)
      );
      expect(createResp.status).toBe(201);
      releaseId = createResp.data.data._id;
      createdReleaseIds.push(releaseId);
    });

    it.each(['admin', 'manager', 'contributor', 'viewer'])('%s can GET gate-status', async (role) => {
      const resp = await personas[role].client.get(`/api/v1/releases/${releaseId}/gate-status`, withScope(projectId));
      expect(resp.status).toBe(200);
      expect(resp.data.data.overall).toBe('green');
    });
  });

  describe('link/unlink test plan: gated \'write\' (mutates the release) -- admin/manager/contributor allowed, viewer denied', () => {
    let releaseId;
    const fakePlanId = '66f2e8911e414a16d1f204b3';

    beforeAll(async () => {
      const createResp = await personas.admin.client.post(
        '/api/v1/releases',
        { name: `rbac matrix plans target ${Date.now()}` },
        withScope(projectId)
      );
      expect(createResp.status).toBe(201);
      releaseId = createResp.data.data._id;
      createdReleaseIds.push(releaseId);
    });

    it('viewer cannot link a test plan (403)', async () => {
      const resp = await personas.viewer.client.post(
        `/api/v1/releases/${releaseId}/plans`,
        { testPlanId: fakePlanId },
        withScope(projectId)
      );
      expect(resp.status).toBe(403);
    });

    it('contributor can link a test plan (200)', async () => {
      const resp = await personas.contributor.client.post(
        `/api/v1/releases/${releaseId}/plans`,
        { testPlanId: fakePlanId },
        withScope(projectId)
      );
      expect(resp.status).toBe(200);
      expect(resp.data.data.linkedTestPlanIds).toContain(fakePlanId);
    });

    it('viewer cannot unlink a test plan (403)', async () => {
      const resp = await personas.viewer.client.delete(
        `/api/v1/releases/${releaseId}/plans/${fakePlanId}`,
        withScope(projectId)
      );
      expect(resp.status).toBe(403);
    });

    it('contributor can unlink a test plan (200)', async () => {
      const resp = await personas.contributor.client.delete(
        `/api/v1/releases/${releaseId}/plans/${fakePlanId}`,
        withScope(projectId)
      );
      expect(resp.status).toBe(200);
      expect(resp.data.data.linkedTestPlanIds).not.toContain(fakePlanId);
    });
  });

  describe('environments: same authorize() wiring as releases (routes/environments.js)', () => {
    it('viewer can GET /api/v1/environments (200)', async () => {
      const resp = await withCacheRetry(() => personas.viewer.client.get('/api/v1/environments', withScope(projectId)));
      expect(resp.status).toBe(200);
    });

    it('viewer cannot POST /api/v1/environments (403)', async () => {
      const resp = await personas.viewer.client.post(
        '/api/v1/environments',
        { name: `rbac matrix env ${Date.now()}` },
        withScope(projectId)
      );
      expect(resp.status).toBe(403);
    });

    it('contributor can POST /api/v1/environments (201) but not DELETE it (403); manager can', async () => {
      const createResp = await personas.contributor.client.post(
        '/api/v1/environments',
        { name: `rbac matrix env ${Date.now()}` },
        withScope(projectId)
      );
      expect(createResp.status).toBe(201);
      const envId = createResp.data.data._id;

      const contributorDelete = await personas.contributor.client.delete(`/api/v1/environments/${envId}`, withScope(projectId));
      expect(contributorDelete.status).toBe(403);

      const managerDelete = await personas.manager.client.delete(`/api/v1/environments/${envId}`, withScope(projectId));
      expect(managerDelete.status).toBe(200);
    });
  });

  describe('viewer end-to-end: can browse everything, changes nothing (verbatim RBAC acceptance criterion)', () => {
    let seededId;

    beforeAll(async () => {
      const createResp = await personas.admin.client.post(
        '/api/v1/releases',
        { name: `rbac matrix viewer-probe seed ${Date.now()}` },
        withScope(projectId)
      );
      expect(createResp.status).toBe(201);
      seededId = createResp.data.data._id;
      createdReleaseIds.push(seededId);
    });

    it('viewer can list', async () => {
      const resp = await personas.viewer.client.get('/api/v1/releases', withScope(projectId));
      expect(resp.status).toBe(200);
    });

    it('viewer can GET the single seeded release', async () => {
      const resp = await personas.viewer.client.get(`/api/v1/releases/${seededId}`, withScope(projectId));
      expect(resp.status).toBe(200);
      expect(resp.data.data._id).toBe(seededId);
    });

    it('viewer cannot PUT (update) it', async () => {
      const resp = await personas.viewer.client.put(
        `/api/v1/releases/${seededId}`,
        { notes: 'viewer should never be able to write this' },
        withScope(projectId)
      );
      expect(resp.status).toBe(403);
    });

    it('viewer cannot DELETE it', async () => {
      const resp = await personas.viewer.client.delete(`/api/v1/releases/${seededId}`, withScope(projectId));
      expect(resp.status).toBe(403);
    });

    it('viewer cannot create a new one', async () => {
      const resp = await personas.viewer.client.post(
        '/api/v1/releases',
        { name: 'viewer should never be able to create this' },
        withScope(projectId)
      );
      expect(resp.status).toBe(403);
    });

    it('the seeded release was never modified by any of the above (still readable, unchanged)', async () => {
      const resp = await personas.admin.client.get(`/api/v1/releases/${seededId}`, withScope(projectId));
      expect(resp.status).toBe(200);
      expect(resp.data.data.name).toMatch(/^rbac matrix viewer-probe seed /);
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
