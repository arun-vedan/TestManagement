const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { createTestPersona } = require('../../shared/test-utils/keycloakTestPersona');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

// WP-022 — release-blocking permission-matrix suite (HTTP level).
//
// permissions.test.js and authorize.test.js (backend/shared/service-core/
// __tests__/) already prove the matrix and the authorize() middleware
// exhaustively at the unit level. This suite's job is different: prove the
// real ROUTES of a live service are actually wired to authorize() as
// intended, end to end, with REAL distinct persona identities holding each
// of the four roles -- not mocked requests. testRepoService is used as the
// representative target: requirementService and defectService mount
// authorize() identically (same import, same per-route placement
// immediately after requireProjectScope() -- see each service's
// routes/*.js and the WP-022 EXECUTION_LOG.md entry), so proving the
// wiring once here, against the one shared middleware, generalizes; this
// suite does not re-run the same proof three times.
//
// Real personas (backend/shared/test-utils/keycloakTestPersona.js, WP-022):
// creates four disposable Keycloak users, gets a REAL bearer token for
// each via the password grant, adds each as a member of one fresh project
// with a different role, and issues requests through Kong AS that persona.
// This is a materially stronger proof than authorize.test.js's mocked
// req/res -- it also proves keycloak.protect() -> requireProjectScope() ->
// authorize() compose correctly on the real route, in the real container.

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

describe('RBAC permission matrix (WP-022, release-blocking, HTTP level)', () => {
  let adminToken;
  let userServiceClient;
  let projectId; // numeric, for X-Project-Id
  let projectMongoId;
  let orgId;
  const personas = {}; // role -> { persona, client }
  const createdEntities = []; // _id[] to clean up

  beforeAll(async () => {
    adminToken = await getServiceToken();
    userServiceClient = axios.create({
      baseURL: USER_SERVICE_URL,
      headers: { Authorization: `Bearer ${adminToken}` },
      validateStatus: () => true
    });

    const orgResp = await userServiceClient.post('/api/v1/organizations', {
      name: `WP-022 rbac matrix org ${runId}`,
      key: `wp022-rbac-org-${runId}`
    });
    expect(orgResp.status).toBe(201);
    orgId = orgResp.data.data._id;
    trackOrganization(orgId);

    const projResp = await userServiceClient.post('/api/v1/projects', {
      name: `WP-022 rbac matrix project ${runId}`,
      key: `wp022-rbac-proj-${runId}`,
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
    for (const id of createdEntities) {
      await cleanupClient.delete(`/api/v1/testrepo/${id}`, withScope(projectId)).catch(() => {});
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

  describe('read: every role can list and view (viewer = read-only everywhere, but still reads everywhere)', () => {
    it.each(['admin', 'manager', 'contributor', 'viewer'])('%s can GET the list', async (role) => {
      const resp = await withCacheRetry(() => personas[role].client.get('/api/v1/testrepo', withScope(projectId)));
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);
    });
  });

  describe('write (create): admin/manager/contributor allowed, viewer denied', () => {
    it.each([
      ['admin', true],
      ['manager', true],
      ['contributor', true],
      ['viewer', false]
    ])('%s create -> allowed=%s', async (role, allowed) => {
      const resp = await personas[role].client.post(
        '/api/v1/testrepo',
        { TestCaseSummary: `WP-022 matrix ${role} ${Date.now()}`, TestCaseDescription: 'rbac matrix suite' },
        withScope(projectId)
      );
      if (allowed) {
        expect(resp.status).toBe(201);
        createdEntities.push(resp.data.data._id);
      } else {
        expect(resp.status).toBe(403);
      }
    });
  });

  describe('delete: admin/manager allowed, contributor/viewer denied', () => {
    let deletableId;

    beforeAll(async () => {
      const createResp = await personas.admin.client.post(
        '/api/v1/testrepo',
        { TestCaseSummary: `WP-022 matrix delete-target ${Date.now()}`, TestCaseDescription: 'rbac matrix suite' },
        withScope(projectId)
      );
      expect(createResp.status).toBe(201);
      deletableId = createResp.data.data._id;
    });

    it('viewer cannot delete (403) -- proves viewer changes nothing', async () => {
      const resp = await personas.viewer.client.delete(`/api/v1/testrepo/${deletableId}`, withScope(projectId));
      expect(resp.status).toBe(403);
    });

    it('contributor cannot delete (403)', async () => {
      const resp = await personas.contributor.client.delete(`/api/v1/testrepo/${deletableId}`, withScope(projectId));
      expect(resp.status).toBe(403);
    });

    it('manager can delete (200)', async () => {
      const resp = await personas.manager.client.delete(`/api/v1/testrepo/${deletableId}`, withScope(projectId));
      expect(resp.status).toBe(200);
    });
  });

  describe('viewer end-to-end: can browse everything, changes nothing (WP-022 acceptance criterion, verbatim)', () => {
    let seededId;

    beforeAll(async () => {
      const createResp = await personas.admin.client.post(
        '/api/v1/testrepo',
        { TestCaseSummary: `WP-022 viewer-probe seed ${Date.now()}`, TestCaseDescription: 'rbac matrix suite' },
        withScope(projectId)
      );
      expect(createResp.status).toBe(201);
      seededId = createResp.data.data._id;
      createdEntities.push(seededId);
    });

    it('viewer can list', async () => {
      const resp = await personas.viewer.client.get('/api/v1/testrepo', withScope(projectId));
      expect(resp.status).toBe(200);
    });

    it('viewer can GET the single seeded entity', async () => {
      const resp = await personas.viewer.client.get(`/api/v1/testrepo/${seededId}`, withScope(projectId));
      expect(resp.status).toBe(200);
      expect(resp.data.data._id).toBe(seededId);
    });

    it('viewer cannot PUT (update) it', async () => {
      const resp = await personas.viewer.client.put(
        `/api/v1/testrepo/${seededId}`,
        { TestCaseSummary: 'viewer should never be able to write this' },
        withScope(projectId)
      );
      expect(resp.status).toBe(403);
    });

    it('viewer cannot DELETE it', async () => {
      const resp = await personas.viewer.client.delete(`/api/v1/testrepo/${seededId}`, withScope(projectId));
      expect(resp.status).toBe(403);
    });

    it('viewer cannot create a new one', async () => {
      const resp = await personas.viewer.client.post(
        '/api/v1/testrepo',
        { TestCaseSummary: 'viewer should never be able to create this', TestCaseDescription: 'x' },
        withScope(projectId)
      );
      expect(resp.status).toBe(403);
    });

    it('the seeded entity was never modified by any of the above (still readable, unchanged)', async () => {
      const resp = await personas.admin.client.get(`/api/v1/testrepo/${seededId}`, withScope(projectId));
      expect(resp.status).toBe(200);
      expect(resp.data.data.TestCaseSummary).toMatch(/^WP-022 viewer-probe seed /);
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
