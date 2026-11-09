const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { createTestPersona } = require('../../shared/test-utils/keycloakTestPersona');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

// WP-040 — black-box HTTP suite for reportingService, same shape as every
// other service's __tests__/api.test.js (GR-6: functional assertions
// against the live container via Kong, never documenting broken behavior
// as expected).
//
// Ground-truth numbers (hand-verified against `docker exec mongodb
// mongosh`, NOT the MongoDB MCP connection -- see this file's sibling
// handVerifiedFigures.test.js for the full derivation of each) live in
// that separate file; this one covers auth, project scoping, and RBAC.

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';
const USER_SERVICE_URL = process.env.TEST_USER_SERVICE_URL || 'http://localhost:8000';
const DEFAULT_PROJECT_ID = 1;
const PROJECT_SCOPE_HEADERS = { [PROJECT_ID_HEADER]: String(DEFAULT_PROJECT_ID) };

const REPORT_ENDPOINTS = [
  '/api/v1/reports/coverage',
  '/api/v1/reports/pass-rate-trend',
  '/api/v1/reports/defect-summary',
  '/api/v1/reports/plan-progress',
  '/api/v1/reports/release-readiness',
  '/api/v1/reports/workload',
  // WP-F13 Task 2 -- the traceability matrix, same guard chain
  // (keycloak.protect() -> requireProjectScope() -> authorize('read')) and
  // materialized/cached posture as every sibling above.
  '/api/v1/reports/traceability'
];

function decodeJwtPayload(token) {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

const anonClient = axios.create({ baseURL: BASE_URL, validateStatus: () => true });

async function ensureDefaultProjectMembership(token, role = 'admin') {
  const sub = decodeJwtPayload(token).sub;
  const userServiceClient = axios.create({
    baseURL: USER_SERVICE_URL,
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true
  });
  const listResp = await userServiceClient.get('/api/v1/projects');
  const defaultProject = listResp.data.data.find((p) => p.id === DEFAULT_PROJECT_ID);
  if (!defaultProject) {
    throw new Error(`Default Project (id=${DEFAULT_PROJECT_ID}) not found -- WP-020 backfill precondition unmet`);
  }
  await userServiceClient.post(`/api/v1/projects/${defaultProject._id}/members`, { userId: sub, role });
  return defaultProject;
}

describe('reportingService API (live)', () => {
  describe('every route requires authentication', () => {
    const protectedRoutes = [
      ...REPORT_ENDPOINTS.map((p) => ['get', p]),
      ['post', '/api/v1/reports/refresh']
    ];

    // WP-023: unauthenticated is rejected AT KONG now (401), not by the
    // service itself (which would 403 via requireProjectScope() only after
    // keycloak.protect() already let it through) -- see EXECUTION_LOG.md.
    it.each(protectedRoutes)('%s %s rejects a request with no token (401 from Kong)', async (method, path) => {
      const resp = await anonClient.request({ method, url: path });
      expect(resp.status).toBe(401);
    });
  });

  describe('authenticated but no X-Project-Id header -> 403', () => {
    let client;
    beforeAll(async () => {
      const token = await getServiceToken();
      await ensureDefaultProjectMembership(token);
      client = axios.create({ baseURL: BASE_URL, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true });
    }, 15000);

    it.each(REPORT_ENDPOINTS)('GET %s -> 403', async (path) => {
      const resp = await client.get(path);
      expect(resp.status).toBe(403);
    });

    it('an unknown projectId -> 403 (not a leaked read of another project)', async () => {
      const resp = await client.get('/api/v1/reports/coverage', { headers: { [PROJECT_ID_HEADER]: '999999' } });
      expect(resp.status).toBe(403);
    });
  });

  describe('authenticated + scoped: every report responds 200 with the shared envelope', () => {
    let client;
    beforeAll(async () => {
      const token = await getServiceToken();
      await ensureDefaultProjectMembership(token);
      client = axios.create({
        baseURL: BASE_URL,
        headers: { Authorization: `Bearer ${token}`, ...PROJECT_SCOPE_HEADERS },
        validateStatus: () => true
      });
    }, 15000);

    it.each(REPORT_ENDPOINTS)('GET %s -> 200, {success,projectId,reportType,computedAt,stale,data}', async (path) => {
      const resp = await client.get(path);
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);
      expect(resp.data.projectId).toBe(DEFAULT_PROJECT_ID);
      expect(typeof resp.data.reportType).toBe('string');
      expect(resp.data.stale).toBe(false);
      expect(resp.data.computedAt).toBeTruthy();
      expect(resp.data.data).toBeTruthy();
    });

    it('POST /refresh recomputes and re-caches all six reports for the caller project, under 30s', async () => {
      const start = Date.now();
      const resp = await client.post('/api/v1/reports/refresh');
      const elapsedMs = Date.now() - start;
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);
      // 7, not 6 -- WP-F13 Task 2 added 'traceability' to postRefresh's own
      // reportTypes list (controllers/reports.js), not just to
      // ReportCache's schema enum. This assertion is the live proof that
      // premise 7 (an entry added to one list but not the other never
      // refreshes) is actually caught: it would still read 6 if that
      // second list update had been skipped.
      expect(resp.data.reports).toHaveLength(7);
      resp.data.reports.forEach((r) => expect(r.success).toBe(true));
      expect(elapsedMs).toBeLessThan(30000);
      // Server's own measured duration, independent of this test's wall-clock.
      expect(resp.data.durationMs).toBeLessThan(30000);
    }, 35000);

    it('a second GET right after refresh serves the freshly-cached value (stale:false, same computedAt)', async () => {
      const refreshResp = await client.post('/api/v1/reports/refresh');
      expect(refreshResp.status).toBe(200);
      const coverageResp = await client.get('/api/v1/reports/coverage');
      expect(coverageResp.status).toBe(200);
      expect(coverageResp.data.stale).toBe(false);
    });
  });

  describe('RBAC (WP-022 matrix, real persona): viewer can read every report, cannot POST refresh', () => {
    // Deliberately NOT added to the shared Default Project (id=1) -- unlike
    // the ensureDefaultProjectMembership() suites above, which only ever
    // upsert the one shared service-account identity's own membership, a
    // disposable persona added to Default Project's members[] would leave a
    // permanent dead-user entry behind after cleanup() deletes the Keycloak
    // user (there is no membership-removal call to undo it with). Same
    // throwaway-org-and-project pattern as testRepoService's own
    // __tests__/rbacMatrix.test.js for exactly this reason. Report VALUES
    // are not asserted here (this fresh project has no seeded cross-service
    // data) -- only that the RBAC gate itself is wired correctly; the real
    // hand-verified numbers live in handVerifiedFigures.test.js against
    // project 1.
    const runId = Date.now();
    let viewerClient;
    let scopedAdminClient;
    let persona;
    let userServiceClient;
    let orgId;
    let projectMongoId;
    let projectNumericId;

    beforeAll(async () => {
      const adminToken = await getServiceToken();
      userServiceClient = axios.create({
        baseURL: USER_SERVICE_URL,
        headers: { Authorization: `Bearer ${adminToken}` },
        validateStatus: () => true
      });

      const orgResp = await userServiceClient.post('/api/v1/organizations', {
        name: `WP-040 rbac org ${runId}`,
        key: `wp040-rbac-org-${runId}`
      });
      expect(orgResp.status).toBe(201);
      orgId = orgResp.data.data._id;
      trackOrganization(orgId);

      const projResp = await userServiceClient.post('/api/v1/projects', {
        name: `WP-040 rbac project ${runId}`,
        key: `wp040-rbac-proj-${runId}`,
        organizationId: orgId
      });
      expect(projResp.status).toBe(201);
      projectMongoId = projResp.data.data._id;
      trackProject(projectMongoId);
      projectNumericId = projResp.data.data.id;
      trackProject(projectNumericId);
      const scopeHeaders = { [PROJECT_ID_HEADER]: String(projectNumericId) };

      // Creator (the service account) is already an implicit admin member;
      // this client exercises the write-gated endpoint as a control.
      scopedAdminClient = axios.create({
        baseURL: BASE_URL,
        headers: { Authorization: `Bearer ${adminToken}`, ...scopeHeaders },
        validateStatus: () => true
      });

      persona = await createTestPersona('reporting-viewer');
      const addResp = await userServiceClient.post(`/api/v1/projects/${projectMongoId}/members`, {
        userId: persona.userId,
        role: 'viewer'
      });
      expect(addResp.status).toBe(200);

      const viewerToken = await persona.getToken();
      viewerClient = axios.create({
        baseURL: BASE_URL,
        headers: { Authorization: `Bearer ${viewerToken}`, ...scopeHeaders },
        validateStatus: () => true
      });
    }, 60000);

    afterAll(async () => {
      await persona.cleanup().catch(() => {});
      if (projectMongoId) {
        await userServiceClient.delete(`/api/v1/projects/${projectMongoId}`).catch(() => {});
      }
      if (orgId) {
        await userServiceClient.delete(`/api/v1/organizations/${orgId}`).catch(() => {});
      }
    }, 20000);

    // requireProjectScope()'s in-process project-membership cache (30s TTL,
    // service-core/middleware/projectScope.js) is PER CONTAINER, not
    // shared -- reportingService's own copy of it can warm up (200) while
    // requirementService/linkIssueService's SEPARATE copies (hit by
    // computeCoverage() etc, forwarding this same viewer token) are still
    // serving a project list cached from moments before this brand-new
    // project/membership existed. That downstream 403 has no prior cache
    // to fall back on for a project queried for the first time ever, so
    // controllers/reports.js's getOrCompute() correctly reports it as a
    // 503 (fail closed, nothing honest to serve yet) rather than a 403 --
    // both are exactly the same underlying "a downstream cache hasn't
    // caught up yet" race the brief documents, just observed one hop
    // apart, so both are retried here. Not an authorization bug in either
    // service; same race testRepoService's own RBAC suite documents.
    async function withCacheRetry(fn, { retries = 15, delayMs = 500 } = {}) {
      let resp;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        resp = await fn();
        if (resp.status !== 403 && resp.status !== 503) return resp;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return resp;
    }

    it.each(REPORT_ENDPOINTS)(
      'viewer can GET %s (200)',
      async (path) => {
        const resp = await withCacheRetry(() => viewerClient.get(path));
        expect(resp.status).toBe(200);
        expect(resp.data.success).toBe(true);
      },
      15000
    );

    it(
      'viewer cannot POST /refresh (403, write-gated)',
      async () => {
        const resp = await withCacheRetry(() => viewerClient.post('/api/v1/reports/refresh'));
        expect(resp.status).toBe(403);
      },
      15000
    );

    it('admin CAN POST /refresh (control: proves the 403 above is role-based, not a broken route)', async () => {
      const resp = await scopedAdminClient.post('/api/v1/reports/refresh');
      expect(resp.status).toBe(200);
    });
  });

  // WP-F15/F18 Task 4 — the release lens. A separate describe block (not
  // folded into REPORT_ENDPOINTS above) because this route takes a
  // required `releaseId` query param and is never cached, unlike the other
  // six -- its own auth/scope/shape behavior is proven here against a real,
  // disposable release created and torn down within this block, never
  // against any of the seeded project-1 fixtures (GR: don't mutate/delete
  // seeded data).
  describe('GET /release-lens (live, own disposable fixture)', () => {
    let client;
    let releaseId;
    let releaseMongoId;

    beforeAll(async () => {
      const token = await getServiceToken();
      await ensureDefaultProjectMembership(token);
      client = axios.create({
        baseURL: BASE_URL,
        headers: { Authorization: `Bearer ${token}`, ...PROJECT_SCOPE_HEADERS },
        validateStatus: () => true
      });
      const createResp = await client.post('/api/v1/releases', {
        name: 'WP-F15/F18 Task 4 api.test.js fixture release',
        status: 'planned'
      });
      expect(createResp.status).toBe(201);
      releaseId = createResp.data.data.releaseId;
      releaseMongoId = createResp.data.data._id;
    }, 20000);

    afterAll(async () => {
      if (releaseMongoId) {
        await client.delete(`/api/v1/releases/${releaseMongoId}`).catch(() => {});
      }
    }, 20000);

    it('no token -> 401 at Kong', async () => {
      const resp = await anonClient.get('/api/v1/reports/release-lens', { params: { releaseId } });
      expect(resp.status).toBe(401);
    });

    it('missing releaseId query param -> 400', async () => {
      const resp = await client.get('/api/v1/reports/release-lens');
      expect(resp.status).toBe(400);
      expect(resp.data.success).toBe(false);
    });

    it('a releaseId that does not exist in this project -> 404', async () => {
      const resp = await client.get('/api/v1/reports/release-lens', { params: { releaseId: 'REL-does-not-exist' } });
      expect(resp.status).toBe(404);
      expect(resp.data.success).toBe(false);
    });

    it('a real, freshly-created release with nothing linked -> 200, zeros with denominators (R5)', async () => {
      const resp = await client.get('/api/v1/reports/release-lens', { params: { releaseId } });
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);
      expect(resp.data.releaseId).toBe(releaseId);
      expect(resp.data.data.release.releaseId).toBe(releaseId);
      expect(resp.data.data.requirements).toEqual({ linkedCount: 0, linked: [], derivedCount: 0, derived: [] });
      expect(resp.data.data.testCases).toEqual({ linkedCount: 0, linked: [], derivedCount: 0, derived: [] });
      expect(resp.data.data.defects.linkedCount).toBe(0);
      expect(resp.data.data.testPlans).toEqual({ configuredCount: 0, linkedCount: 0, unresolvedCount: 0, linked: [] });
      expect(resp.data.data.executions).toMatchObject({ executed: 0, passed: 0, failed: 0, blocked: 0, passRatePercent: null });
      expect(resp.data.data.executions.note).toMatch(/no executed test cases/);
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
