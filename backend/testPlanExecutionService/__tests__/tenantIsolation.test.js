const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

// WP-021b — Multi-tenancy isolation suite for testPlanExecutionService
// (release-blocking, same class of suite as testRepoService/
// requirementService/defectService's WP-021 suites, and this WP's own
// acceptance criterion #4).
//
// WP-021 rolled requireProjectScope() out to testRepoService,
// requirementService, and defectService, then stopped ("the rest in later
// work"). Neither TestPlan nor TestExecution declared a projectId field at
// all before this WP -- /api/v1/testplan and /api/v1/testexecution were
// readable and writable across EVERY project by any authenticated user.
// This suite proves that gap is closed: a user scoped to one project can
// neither read nor write another project's plans/executions through any
// route (list, single, update, delete, or the TestExecution-specific
// sub-routes updateteststep/updateattachment/getexecutiontc), and that
// requests with no/foreign/unknown projectId are rejected -- mirroring
// testRepoService/__tests__/tenantIsolation.test.js's structure exactly.
//
// A separate section (3) proves WP-033's CI ingestion route
// (POST /api/v1/testexecution/ingest, API-key authenticated) lands its
// result in the API key's OWN bound project, never a project named in the
// request body, and that isolation extends to CI-sourced documents too.
//
// Only ONE real Keycloak identity is available to this test harness (the
// client_credentials service account from getServiceToken.js) -- see
// testRepoService's suite for the full explanation of why "user A" and "an
// attacker" are necessarily the same real token, with the CLAIMED scope
// (X-Project-Id) and this identity's real membership varied instead.
//
// Project A = the seeded Default Project (id=1, WP-020 backfill, and where
// this WP's own backfillProjectId.js run landed PLN-1..PLN-7/Run-1..Run-14).
// Project B = a fresh Organization+Project created by this suite.

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';
const USER_SERVICE_URL = process.env.TEST_USER_SERVICE_URL || 'http://localhost:8000';
const DUMMY_ID = '000000000000000000000000';
const runId = Date.now();

function decodeJwtPayload(token) {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

// requireProjectScope()'s in-process project-list cache (see
// service-core/middleware/projectScope.js, PROJECT_SCOPE_CACHE_TTL_MS) is
// global to the container, not per-request. Retry a handful of times, well
// within the local/test TTL, rather than flake on a create landing just
// before the cache refreshed -- same helper as testRepoService's suite.
async function postWithCacheRetry(axiosClient, url, body, headers, { retries = 8, delayMs = 400 } = {}) {
  let resp;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    resp = await axiosClient.post(url, body, headers);
    if (resp.status !== 403) return resp;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return resp;
}

// Same cache-latency problem as postWithCacheRetry above, hit for real
// during this suite's own development: afterAll re-grants B membership
// then immediately tries to delete B's fixtures through it -- with
// validateStatus: () => true, a 403 from the still-stale cache resolves
// silently (no thrown rejection), so an un-retried delete can "complete"
// having deleted nothing, leaving orphaned fixtures behind (hazard #5).
// Retry the delete itself, not just the membership POST, until the cache
// catches up or the retry budget is spent.
async function deleteWithCacheRetry(axiosClient, url, headers, { retries = 8, delayMs = 400 } = {}) {
  let resp;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    resp = await axiosClient.delete(url, headers);
    if (resp.status !== 403) return resp;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return resp;
}

describe('testPlanExecutionService tenant isolation (WP-021b, release-blocking)', () => {
  let token;
  let sub;
  let client; // authed client for testPlanExecutionService, no default X-Project-Id
  let userServiceClient; // authed client for userService (org/project admin)
  let projectAId; // numeric id, always 1 (Default Project)
  let projectBId; // numeric id, freshly created
  let projectBMongoId;
  let orgBId;
  let foreignPlanId; // _id of a TestPlan created under project B
  let foreignPlanBusinessId; // TestPlanId (e.g. "PLN-42") of the above
  let foreignExecId; // _id of a TestExecution created under project B
  let foreignExecBusinessId; // TestExecutionId (e.g. "Run-42") of the above

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

    // --- Ensure this identity is a member of Project A (Default, id=1) ---
    const listResp = await userServiceClient.get('/api/v1/projects');
    expect(listResp.status).toBe(200);
    const projectA = listResp.data.data.find((p) => p.id === 1);
    expect(projectA).toBeDefined(); // WP-020 backfill precondition
    projectAId = projectA.id;
    const addToA = await userServiceClient.post(`/api/v1/projects/${projectA._id}/members`, {
      userId: sub,
      role: 'admin'
    });
    expect(addToA.status).toBe(200);

    // --- Create Project B (this identity is auto-added as admin creator) ---
    const orgResp = await userServiceClient.post('/api/v1/organizations', {
      name: `WP-021b isolation org ${runId}`,
      key: `wp021b-iso-org-${runId}`
    });
    expect(orgResp.status).toBe(201);
    orgBId = orgResp.data.data._id;
    trackOrganization(orgBId);

    const projResp = await userServiceClient.post('/api/v1/projects', {
      name: `WP-021b isolation project B ${runId}`,
      key: `wp021b-iso-proj-b-${runId}`,
      organizationId: orgBId
    });
    expect(projResp.status).toBe(201);
    projectBId = projResp.data.data.id;
    trackProject(projectBId);
    projectBMongoId = projResp.data.data._id;
    trackProject(projectBMongoId);
    expect(projectBId).not.toBe(projectAId);

    // --- Seed one "foreign" TestPlan + TestExecution under project B ---
    const planResp = await postWithCacheRetry(
      client,
      '/api/v1/testplan',
      { TestCases: [] },
      withScope(projectBId)
    );
    expect(planResp.status).toBe(201);
    expect(planResp.data.data.projectId).toBe(projectBId);
    foreignPlanId = planResp.data.data._id;
    foreignPlanBusinessId = planResp.data.data.TestPlanId;

    const execResp = await postWithCacheRetry(
      client,
      '/api/v1/testexecution',
      { TestPlanId: foreignPlanId, TestCases: [{ TestCaseId: 'TC-iso', TestCaseSummary: 'foreign', TestStatus: 'No Run', id: 1 }] },
      withScope(projectBId)
    );
    expect(execResp.status).toBe(201);
    expect(execResp.data.data.projectId).toBe(projectBId);
    foreignExecId = execResp.data.data._id;
    foreignExecBusinessId = execResp.data.data.TestExecutionId;
    // NOTE: membership in B is intentionally left in place here -- section 1
    // below needs it (to independently verify B's documents via scope=B
    // after each cross-tenant attack attempt through scope=A). It's revoked
    // in section 2's own beforeAll, after section 1 has run.
  }, 30000);

  afterAll(async () => {
    // Best-effort cleanup: re-grant B membership so we can delete the
    // fixture data and the project/org, then leave A's membership as-is
    // (harmless / matches the seeded default-admin shape).
    if (projectBMongoId) {
      await userServiceClient.post(`/api/v1/projects/${projectBMongoId}/members`, { userId: sub, role: 'admin' });
    }
    if (foreignExecId) {
      await deleteWithCacheRetry(client, `/api/v1/testexecution/${foreignExecId}`, withScope(projectBId));
    }
    if (foreignPlanId) {
      await deleteWithCacheRetry(client, `/api/v1/testplan/${foreignPlanId}`, withScope(projectBId));
    }
    if (projectBMongoId) {
      await userServiceClient.delete(`/api/v1/projects/${projectBMongoId}`);
    }
    if (orgBId) {
      await userServiceClient.delete(`/api/v1/organizations/${orgBId}`);
    }
  }, 20000);

  describe('1. Query-level isolation (member of both A and B)', () => {
    describe('TestPlan', () => {
      it('GET list scoped to A does not include B\'s plan', async () => {
        const resp = await client.get('/api/v1/testplan', withScope(projectAId));
        expect(resp.status).toBe(200);
        expect(resp.data.data.some((p) => p._id === foreignPlanId)).toBe(false);
      });

      it('GET list scoped to B DOES include B\'s plan (positive control)', async () => {
        const resp = await client.get('/api/v1/testplan', withScope(projectBId));
        expect(resp.status).toBe(200);
        expect(resp.data.data.some((p) => p._id === foreignPlanId)).toBe(true);
      });

      it('GET single, scoped to A, 404s on B\'s plan (not found, not leaked)', async () => {
        const resp = await client.get(`/api/v1/testplan/${foreignPlanId}`, withScope(projectAId));
        expect(resp.status).toBe(404);
        expect(resp.data.success).toBe(false);
      });

      it('PUT, scoped to A, cannot modify B\'s plan', async () => {
        const resp = await client.put(
          `/api/v1/testplan/${foreignPlanId}`,
          { objective: 'HIJACKED from project A' },
          withScope(projectAId)
        );
        expect(resp.status).toBe(404);

        const verify = await client.get(`/api/v1/testplan/${foreignPlanId}`, withScope(projectBId));
        expect(verify.data.data.objective).toBeUndefined();
      });

      it('DELETE, scoped to A, cannot delete B\'s plan', async () => {
        const resp = await client.delete(`/api/v1/testplan/${foreignPlanId}`, withScope(projectAId));
        expect(resp.status).toBe(404);

        const verify = await client.get(`/api/v1/testplan/${foreignPlanId}`, withScope(projectBId));
        expect(verify.status).toBe(200); // still there
      });

      it('wildcardsearch, scoped to A, does not surface B\'s plan', async () => {
        const resp = await client.get('/api/v1/testplan/wildcardsearch', {
          params: { search: foreignPlanBusinessId },
          ...withScope(projectAId)
        });
        expect(resp.status).toBe(200);
        expect(resp.data.data.some((p) => p._id === foreignPlanId)).toBe(false);
      });
    });

    describe('TestExecution', () => {
      it('GET list scoped to A does not include B\'s execution', async () => {
        const resp = await client.get('/api/v1/testexecution', withScope(projectAId));
        expect(resp.status).toBe(200);
        expect(resp.data.data.some((e) => e._id === foreignExecId)).toBe(false);
      });

      it('GET list scoped to B DOES include B\'s execution (positive control)', async () => {
        const resp = await client.get('/api/v1/testexecution', withScope(projectBId));
        expect(resp.status).toBe(200);
        expect(resp.data.data.some((e) => e._id === foreignExecId)).toBe(true);
      });

      it('GET single, scoped to A, 404s on B\'s execution (not found, not leaked)', async () => {
        const resp = await client.get(`/api/v1/testexecution/${foreignExecId}`, withScope(projectAId));
        expect(resp.status).toBe(404);
        expect(resp.data.success).toBe(false);
      });

      it('PUT, scoped to A, cannot modify B\'s execution', async () => {
        const resp = await client.put(
          `/api/v1/testexecution/${foreignExecId}`,
          { assignedTo: 'HIJACKED from project A' },
          withScope(projectAId)
        );
        expect(resp.status).toBe(404);

        const verify = await client.get(`/api/v1/testexecution/${foreignExecId}`, withScope(projectBId));
        expect(verify.data.data.assignedTo).not.toBe('HIJACKED from project A');
      });

      it('updateteststep, scoped to A, does not touch B\'s execution (matchedCount 0)', async () => {
        const resp = await client.put(
          `/api/v1/testexecution/updateteststep?tcid=TC-iso&exeid=${foreignExecBusinessId}`,
          { TestSteps: [{ testStep: 'x', Expected: 'y', status: 'Pass' }], TestStatus: 'Pass' },
          withScope(projectAId)
        );
        expect(resp.status).toBe(200);
        expect(resp.data.data.matchedCount).toBe(0);

        // positive control: the identical call scoped to B DOES match
        const verify = await client.put(
          `/api/v1/testexecution/updateteststep?tcid=TC-iso&exeid=${foreignExecBusinessId}`,
          { TestSteps: [{ testStep: 'x', Expected: 'y', status: 'Pass' }], TestStatus: 'Pass' },
          withScope(projectBId)
        );
        expect(verify.status).toBe(200);
        expect(verify.data.data.matchedCount).toBe(1);
      });

      it('updateattachment, scoped to A, does not touch B\'s execution (matchedCount 0)', async () => {
        const resp = await client.put(
          `/api/v1/testexecution/updateattachment?tcid=TC-iso&exeid=${foreignExecBusinessId}`,
          { attachment: [{ hijack: true }] },
          withScope(projectAId)
        );
        expect(resp.status).toBe(200);
        expect(resp.data.data.matchedCount).toBe(0);
      });

      it('getexecutiontc, scoped to A, 404s on B\'s execution instead of leaking its test case details', async () => {
        const resp = await client.get(
          `/api/v1/testexecution/getexecutiontc?tcid=TC-iso&exeid=${foreignExecBusinessId}`,
          withScope(projectAId)
        );
        expect(resp.status).toBe(404);

        // positive control: scoped to B, it resolves (may 200 or error
        // deeper in the enrichment call depending on testRepoService state,
        // but it must NOT be the same 404-not-found-in-this-project error).
        const verify = await client.get(
          `/api/v1/testexecution/getexecutiontc?tcid=TC-iso&exeid=${foreignExecBusinessId}`,
          withScope(projectBId)
        );
        expect(verify.status).not.toBe(404);
      });

      it('DELETE, scoped to A, cannot delete B\'s execution', async () => {
        const resp = await client.delete(`/api/v1/testexecution/${foreignExecId}`, withScope(projectAId));
        expect(resp.status).toBe(404);

        const verify = await client.get(`/api/v1/testexecution/${foreignExecId}`, withScope(projectBId));
        expect(verify.status).toBe(200); // still there
      });

      it('wildcardsearch, scoped to A, does not surface B\'s execution', async () => {
        const resp = await client.get('/api/v1/testexecution/wildcardsearch', {
          params: { search: foreignExecBusinessId },
          ...withScope(projectAId)
        });
        expect(resp.status).toBe(200);
        expect(resp.data.data.some((e) => e._id === foreignExecId)).toBe(false);
      });
    });
  });

  describe('2. Membership-level authorization (identity is NOT a member of B)', () => {
    beforeAll(async () => {
      // Revoke membership of project B now, after section 1's tests (which
      // relied on being a member of both A and B) have already run.
      const removeResp = await userServiceClient.delete(`/api/v1/projects/${projectBMongoId}/members/${sub}`);
      expect(removeResp.status).toBe(200);

      // requireProjectScope() caches the project list briefly (in-process,
      // PROJECT_SCOPE_CACHE_TTL_MS -- see projectScope.js). The local/test
      // env sets this short specifically so this suite doesn't need to
      // sleep the 30s production default to observe the revocation above
      // take effect against testPlanExecutionService.
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }, 20000);

    it('claiming scope B outright is rejected with 403 on /testplan, not 404', async () => {
      const resp = await client.get('/api/v1/testplan', withScope(projectBId));
      expect(resp.status).toBe(403);
      expect(resp.data.success).toBe(false);
    });

    it('claiming scope B outright is rejected with 403 on /testexecution, not 404', async () => {
      const resp = await client.get('/api/v1/testexecution', withScope(projectBId));
      expect(resp.status).toBe(403);
      expect(resp.data.success).toBe(false);
    });

    it('a write attempt claiming scope B is rejected with 403 (testplan)', async () => {
      const resp = await client.post('/api/v1/testplan', { TestCases: [] }, withScope(projectBId));
      expect(resp.status).toBe(403);
    });

    it('a write attempt claiming scope B is rejected with 403 (testexecution)', async () => {
      const resp = await client.post('/api/v1/testexecution', { TestCases: [] }, withScope(projectBId));
      expect(resp.status).toBe(403);
    });

    it('missing X-Project-Id header is rejected with 403 on both routers', async () => {
      const planResp = await client.get('/api/v1/testplan');
      expect(planResp.status).toBe(403);
      const execResp = await client.get('/api/v1/testexecution');
      expect(execResp.status).toBe(403);
    });

    it('an unknown projectId is rejected with 403', async () => {
      const resp = await client.get('/api/v1/testplan', withScope(999999));
      expect(resp.status).toBe(403);
    });

    it('a non-integer projectId is rejected with 403', async () => {
      const resp = await client.get('/api/v1/testexecution', { headers: { [PROJECT_ID_HEADER]: 'not-a-number' } });
      expect(resp.status).toBe(403);
    });

    it(`GET /testplan/${DUMMY_ID} with valid scope A still 404s cleanly for a nonexistent id`, async () => {
      const resp = await client.get(`/api/v1/testplan/${DUMMY_ID}`, withScope(projectAId));
      expect(resp.status).toBe(404);
    });

    it(`GET /testexecution/${DUMMY_ID} with valid scope A still 404s cleanly for a nonexistent id`, async () => {
      const resp = await client.get(`/api/v1/testexecution/${DUMMY_ID}`, withScope(projectAId));
      expect(resp.status).toBe(404);
    });
  });

  // 3. WP-033 CI ingestion: proves the fix in controllers/ingest.js
  // (TestExecution.create() now stamps projectId: verifiedProjectId,
  // where verifiedProjectId is req.projectScope.projectId already set by
  // requireAuth()/apiKeyAuth.js from the API KEY's own bound projectId --
  // never a client-supplied value). An API key is already bound to
  // exactly one project (WP-032 SECURITY REQUIREMENT #4); this section
  // proves that binding now actually determines where the ingested
  // TestExecution document lands, and that isolation applies to
  // CI-sourced documents exactly like human-created ones.
  describe('3. WP-033 CI ingestion lands in the API key\'s bound project', () => {
    let keyId;
    let secret;
    let ingestedExecMongoId;
    let ingestedExecBusinessId;
    const ciTestCaseId = `TC-ci-iso-${runId}`;

    beforeAll(async () => {
      // Re-grant A membership just in case a prior describe block's
      // ordering ever changes (admin already added in the outer
      // beforeAll, but this keeps this block independently robust) and
      // mint a results:write API key bound to project A.
      const createKeyResp = await userServiceClient.post(
        '/api/v1/apikeys',
        { scopes: ['results:write'], name: `wp021b-ci-isolation-${runId}` },
        { headers: { [PROJECT_ID_HEADER]: String(projectAId) } }
      );
      expect(createKeyResp.status).toBe(201);
      keyId = createKeyResp.data.data.keyId;
      secret = createKeyResp.data.data.secret;
      expect(createKeyResp.data.data.projectId).toBe(projectAId);
    });

    afterAll(async () => {
      if (keyId) {
        await userServiceClient.delete(`/api/v1/apikeys/${keyId}`, { headers: { [PROJECT_ID_HEADER]: String(projectAId) } });
      }
      if (ingestedExecMongoId) {
        await client.delete(`/api/v1/testexecution/${ingestedExecMongoId}`, withScope(projectAId));
      }
    });

    it('POST /ingest with the key + its own bound X-Project-Id succeeds and the created TestExecution carries that projectId', async () => {
      const resp = await axios.post(
        `${BASE_URL}/api/v1/testexecution/ingest`,
        { testCaseId: ciTestCaseId, status: 'pass' },
        {
          headers: { 'X-Api-Key': `${keyId}.${secret}`, [PROJECT_ID_HEADER]: String(projectAId) },
          validateStatus: () => true
        }
      );
      expect(resp.status).toBe(201);
      expect(resp.data.data.projectId).toBe(projectAId);
      expect(resp.data.data.source).toBe('ci');
      ingestedExecMongoId = resp.data.data._id;
      ingestedExecBusinessId = resp.data.data.TestExecutionId;

      // Re-fetched (not just trusting the create response) through the
      // normal scoped GET, exactly like a human caller would see it.
      const getResp = await client.get(`/api/v1/testexecution/${ingestedExecMongoId}`, withScope(projectAId));
      expect(getResp.status).toBe(200);
      expect(getResp.data.data.projectId).toBe(projectAId);
      expect(getResp.data.data.TestCases[0].TestCaseId).toBe(ciTestCaseId);
    });

    it('the same key is rejected (403) when the request claims a DIFFERENT X-Project-Id than the key is bound to', async () => {
      const resp = await axios.post(
        `${BASE_URL}/api/v1/testexecution/ingest`,
        { testCaseId: `${ciTestCaseId}-wrong-project`, status: 'pass' },
        {
          headers: { 'X-Api-Key': `${keyId}.${secret}`, [PROJECT_ID_HEADER]: String(projectBId) },
          validateStatus: () => true
        }
      );
      expect(resp.status).toBe(403);
      expect(resp.data.error).toMatch(/not authorized for this project/i);
    });

    it('a payload projectId that disagrees with the key\'s verified project is rejected with 400, never silently trusted', async () => {
      const resp = await axios.post(
        `${BASE_URL}/api/v1/testexecution/ingest`,
        { testCaseId: `${ciTestCaseId}-body-mismatch`, status: 'pass', projectId: projectBId },
        {
          headers: { 'X-Api-Key': `${keyId}.${secret}`, [PROJECT_ID_HEADER]: String(projectAId) },
          validateStatus: () => true
        }
      );
      expect(resp.status).toBe(400);
      expect(resp.data.success).toBe(false);
      expect(resp.data.errors.some((e) => /projectId/.test(e.field) || /projectId/.test(e.message))).toBe(true);
    });

    it('query-level isolation extends to a CI-ingested document: invisible under a different real project\'s scope', async () => {
      // Re-add B membership for this one check (revoked in section 2).
      const addBack = await userServiceClient.post(`/api/v1/projects/${projectBMongoId}/members`, { userId: sub, role: 'admin' });
      expect(addBack.status).toBe(200);
      // Same cache-latency wait as section 2's beforeAll -- the in-process
      // project-list cache (PROJECT_SCOPE_CACHE_TTL_MS) must actually
      // expire before this re-added membership is visible to
      // requireProjectScope() again.
      await new Promise((resolve) => setTimeout(resolve, 2500));

      const listB = await client.get('/api/v1/testexecution', withScope(projectBId));
      expect(listB.status).toBe(200);
      expect(listB.data.data.some((e) => e._id === ingestedExecMongoId)).toBe(false);

      const listA = await client.get('/api/v1/testexecution', withScope(projectAId));
      expect(listA.status).toBe(200);
      expect(listA.data.data.some((e) => e._id === ingestedExecMongoId)).toBe(true);

      // Revoke again so it doesn't affect this describe block's own
      // afterAll ordering relative to section 2 (best-effort symmetry;
      // the outer suite afterAll re-grants B membership anyway for its
      // own cleanup).
      await userServiceClient.delete(`/api/v1/projects/${projectBMongoId}/members/${sub}`);
    }, 15000);
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
