const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { createTestPersona } = require('../../shared/test-utils/keycloakTestPersona');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

// WP-F06 Task 1 -- SharedStep CRUD, usage query, and delete guard.
//
// Follows this service's established black-box HTTP convention (see
// api.test.js/tenantIsolation.test.js/events.test.js): reached DIRECTLY
// against the running container (BASE_URL), bypassing Kong -- there is no
// Kong route configured for /api/v1/sharedstep yet (srckube-kong/kong.yml
// only routes /api/v1/testrepo for this service), and adding one is out of
// this task's scope (the brief only asks for the model/controller/router/
// server.js mount). keycloak.protect() is bearerOnly and verifies the JWT
// itself, independent of Kong, so a direct call is exactly as strong a
// proof of the real auth chain as going through the gateway (rbacMatrix.
// test.js's own header comment makes the same point: the value of real
// personas is the real distinct identity, not the extra network hop).
//
// Harness reused verbatim from the existing suites: getServiceToken() for
// the always-available service-account identity, X-Project-Id header for
// tenant scope, createTestPersona()/userService org+project setup for real
// distinct-role identities in the RBAC section.

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';
const USER_SERVICE_URL = process.env.TEST_USER_SERVICE_URL || 'http://localhost:8000';
const DEFAULT_PROJECT_ID = 1;
const runId = Date.now();

const withScope = (projectId) => ({ headers: { [PROJECT_ID_HEADER]: String(projectId) } });

function decodeJwtPayload(token) {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

// requireProjectScope()'s in-process project-list cache is global to the
// container (projectScope.js, PROJECT_SCOPE_CACHE_TTL_MS) -- same race
// tenantIsolation.test.js/rbacMatrix.test.js retry around: a membership
// change (new project, new member) can be momentarily invisible to a
// request that lands just after it.
async function withCacheRetry(fn, { retries = 8, delayMs = 400 } = {}) {
  let resp;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    resp = await fn();
    if (resp.status !== 403) return resp;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return resp;
}

describe('SharedStep CRUD, usage, and delete guard (WP-F06 Task 1)', () => {
  let client; // authed (service account), no default project header
  let userServiceClient;
  let sub;

  // Project B -- fresh org+project, used for the cross-project tests.
  let projectBId;
  let projectBMongoId;
  let orgBId;

  const createdSharedStepIds = []; // project 1
  const createdTestCaseIds = []; // project 1
  const createdSharedStepIdsB = []; // project B
  const createdTestCaseIdsB = []; // project B

  beforeAll(async () => {
    const token = await getServiceToken();
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

    // Ensure this identity is a member of Project A (Default, id=1) --
    // same defensive step tenantIsolation.test.js takes; membership isn't
    // otherwise guaranteed for the service account in every environment.
    const listResp = await userServiceClient.get('/api/v1/projects');
    expect(listResp.status).toBe(200);
    const projectA = listResp.data.data.find((p) => p.id === DEFAULT_PROJECT_ID);
    expect(projectA).toBeDefined();
    await userServiceClient.post(`/api/v1/projects/${projectA._id}/members`, { userId: sub, role: 'admin' });

    // Create Project B (this identity is auto-added as admin creator).
    const orgResp = await userServiceClient.post('/api/v1/organizations', {
      name: `WP-F06 sharedstep org B ${runId}`,
      key: `wpf06-ss-org-b-${runId}`
    });
    expect(orgResp.status).toBe(201);
    orgBId = orgResp.data.data._id;
    trackOrganization(orgBId);

    const projResp = await userServiceClient.post('/api/v1/projects', {
      name: `WP-F06 sharedstep project B ${runId}`,
      key: `wpf06-ss-proj-b-${runId}`,
      organizationId: orgBId
    });
    expect(projResp.status).toBe(201);
    projectBId = projResp.data.data.id;
    trackProject(projectBId);
    projectBMongoId = projResp.data.data._id;
    trackProject(projectBMongoId);
    expect(projectBId).not.toBe(DEFAULT_PROJECT_ID);
  }, 30000);

  afterAll(async () => {
    // Test cases first, THEN shared steps -- a shared step still referenced
    // by a test case is refused by the delete guard (by design, R4), so
    // deleting the referencing test case first is required for this
    // cleanup to actually succeed rather than silently no-op on a 409.
    for (const id of createdTestCaseIds) {
      // eslint-disable-next-line no-await-in-loop
      await client.delete(`/api/v1/testrepo/${id}`, withScope(DEFAULT_PROJECT_ID)).catch(() => {});
    }
    for (const id of createdTestCaseIdsB) {
      // eslint-disable-next-line no-await-in-loop
      await client.delete(`/api/v1/testrepo/${id}`, withScope(projectBId)).catch(() => {});
    }
    for (const id of createdSharedStepIds) {
      // eslint-disable-next-line no-await-in-loop
      await client.delete(`/api/v1/sharedstep/${id}`, withScope(DEFAULT_PROJECT_ID)).catch(() => {});
    }
    for (const id of createdSharedStepIdsB) {
      // eslint-disable-next-line no-await-in-loop
      await client.delete(`/api/v1/sharedstep/${id}`, withScope(projectBId)).catch(() => {});
    }
    if (projectBMongoId) {
      await userServiceClient.delete(`/api/v1/projects/${projectBMongoId}`);
    }
    if (orgBId) {
      await userServiceClient.delete(`/api/v1/organizations/${orgBId}`);
    }
  }, 30000);

  describe('SharedStep CRUD', () => {
    it("creates a shared step with a server-generated SS- id and the caller's projectId", async () => {
      const res = await withCacheRetry(() => client.post(
        '/api/v1/sharedstep',
        { title: `WP-F06 Log in as admin ${runId}`, steps: [{ testStep: 'Open /login', Expected: 'Login form' }] },
        withScope(DEFAULT_PROJECT_ID)
      ));
      expect(res.status).toBe(201);
      createdSharedStepIds.push(res.data.data._id);
      expect(res.data.data.SharedStepId).toMatch(/^SS-\d+$/);
      expect(res.data.data.projectId).toBe(DEFAULT_PROJECT_ID);
    });

    it("ignores a projectId supplied in the create body", async () => {
      const res = await client.post(
        '/api/v1/sharedstep',
        { title: `WP-F06 spoof projectId ${runId}`, projectId: 999, steps: [] },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(res.status).toBe(201);
      createdSharedStepIds.push(res.data.data._id);
      expect(res.data.data.projectId).toBe(DEFAULT_PROJECT_ID);
    });

    it("rejects a create with no title", async () => {
      const res = await client.post(
        '/api/v1/sharedstep',
        { steps: [] },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(res.status).toBe(400);
    });

    it("does not return another project's shared step (404 on GET /:id, absent from the list)", async () => {
      const created = await client.post(
        '/api/v1/sharedstep',
        { title: `WP-F06 project A only ${runId}`, steps: [] },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(created.status).toBe(201);
      createdSharedStepIds.push(created.data.data._id);
      const id = created.data.data._id;

      const crossRead = await withCacheRetry(() => client.get(`/api/v1/sharedstep/${id}`, withScope(projectBId)));
      expect(crossRead.status).toBe(404);

      const listB = await client.get('/api/v1/sharedstep', withScope(projectBId));
      expect(listB.status).toBe(200);
      expect(listB.data.data.some((s) => s._id === id)).toBe(false);
    });
  });

  describe('SharedStep usage and delete guard', () => {
    it('reports zero usage for an unreferenced shared step', async () => {
      const created = await client.post(
        '/api/v1/sharedstep',
        { title: `WP-F06 unreferenced ${runId}`, steps: [] },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(created.status).toBe(201);
      createdSharedStepIds.push(created.data.data._id);

      const usage = await client.get(`/api/v1/sharedstep/${created.data.data._id}/usage`, withScope(DEFAULT_PROJECT_ID));
      expect(usage.status).toBe(200);
      expect(usage.data.data.count).toBe(0);
      expect(usage.data.data.testCases).toEqual([]);
    });

    it('reports the referencing test cases', async () => {
      const shared = await client.post(
        '/api/v1/sharedstep',
        { title: `WP-F06 referenced ${runId}`, steps: [{ testStep: 'x', Expected: 'y' }] },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(shared.status).toBe(201);
      createdSharedStepIds.push(shared.data.data._id);
      const sharedStepId = shared.data.data._id;

      const tc = await client.post(
        '/api/v1/testrepo',
        {
          TestCaseSummary: `WP-F06 refers to shared step ${runId}`,
          TestCaseDescription: 'x',
          TestSteps: [{ sharedStepId }]
        },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(tc.status).toBe(201);
      createdTestCaseIds.push(tc.data.data._id);
      // Sanity: the reference actually persisted (would silently vanish if
      // Task 1's schema addition to TestStepSchema were missing/wrong).
      expect(tc.data.data.TestSteps[0].sharedStepId).toBe(sharedStepId);

      const usage = await client.get(`/api/v1/sharedstep/${sharedStepId}/usage`, withScope(DEFAULT_PROJECT_ID));
      expect(usage.status).toBe(200);
      expect(usage.data.data.count).toBe(1);
      expect(usage.data.data.testCases[0].TestCaseId).toBe(tc.data.data.TestCaseId);
    });

    it('refuses to delete a shared step that is in use, with 409 and the usage payload', async () => {
      const shared = await client.post(
        '/api/v1/sharedstep',
        { title: `WP-F06 delete-guard target ${runId}`, steps: [] },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(shared.status).toBe(201);
      createdSharedStepIds.push(shared.data.data._id);
      const sharedStepId = shared.data.data._id;

      const tc = await client.post(
        '/api/v1/testrepo',
        {
          TestCaseSummary: `WP-F06 delete-guard referencer ${runId}`,
          TestCaseDescription: 'x',
          TestSteps: [{ sharedStepId }]
        },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(tc.status).toBe(201);
      createdTestCaseIds.push(tc.data.data._id);

      const del = await client.delete(`/api/v1/sharedstep/${sharedStepId}`, withScope(DEFAULT_PROJECT_ID));
      expect(del.status).toBe(409);
      expect(del.data.success).toBe(false);
      expect(del.data.data.count).toBe(1);
      expect(del.data.data.testCases[0].TestCaseId).toBe(tc.data.data.TestCaseId);

      // and it genuinely was not deleted
      const stillThere = await client.get(`/api/v1/sharedstep/${sharedStepId}`, withScope(DEFAULT_PROJECT_ID));
      expect(stillThere.status).toBe(200);
    });

    it('deletes an unreferenced shared step', async () => {
      const shared = await client.post(
        '/api/v1/sharedstep',
        { title: `WP-F06 deletable ${runId}`, steps: [] },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(shared.status).toBe(201);
      const sharedStepId = shared.data.data._id;

      const del = await client.delete(`/api/v1/sharedstep/${sharedStepId}`, withScope(DEFAULT_PROJECT_ID));
      expect(del.status).toBe(200);
      expect(del.data.success).toBe(true);

      const read = await client.get(`/api/v1/sharedstep/${sharedStepId}`, withScope(DEFAULT_PROJECT_ID));
      expect(read.status).toBe(404);
      // Deleted for real -- don't track it in createdSharedStepIds for
      // cleanup (that would just be a harmless 404 delete, but leaving it
      // out is clearer about what this test actually proved).
    });

    it("counts usage only within the caller's project, and never expands another project's shared step text into a response", async () => {
      // Shared step lives in project 1 (A). Real step content (not an
      // empty array) is required here -- Task 2 review fix round 1: this
      // test now also proves the cross-project ?expand=steps leak guard
      // against a REAL running container/Mongo (the mocked unit test in
      // expandSteps.test.js proves the same property in isolation, but a
      // CRITICAL security property like "never leak another project's
      // step text" should also run against the real thing, not only a
      // mock -- and this fixture (already built for the usage/delete-guard
      // check below) is one HTTP call short of proving it live).
      const shared = await client.post(
        '/api/v1/sharedstep',
        {
          title: `WP-F06 cross-project reference target ${runId}`,
          steps: [{ testStep: 'PROJECT A SECRET STEP TEXT', Expected: 'PROJECT A SECRET EXPECTED TEXT' }]
        },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(shared.status).toBe(201);
      createdSharedStepIds.push(shared.data.data._id);
      const sharedStepId = shared.data.data._id;

      // A test case in project B "references" A's shared step _id. This is
      // a cross-tenant reference that should never happen through the real
      // UI (Task 3+ will only ever offer a project's own shared steps), but
      // it's exactly the shape that proves findUsage's projectId filter is
      // doing real work: without it, this row would be counted -- and it's
      // also the shape that proves expandSteps()' projectId filter is doing
      // real work: without it, project B could read project A's step text
      // by referencing its _id.
      const tcB = await withCacheRetry(() => client.post(
        '/api/v1/testrepo',
        {
          TestCaseSummary: `WP-F06 project B cross-reference ${runId}`,
          TestCaseDescription: 'x',
          TestSteps: [{ sharedStepId }]
        },
        withScope(projectBId)
      ));
      expect(tcB.status).toBe(201);
      createdTestCaseIdsB.push(tcB.data.data._id);

      // Project B reads its own test case with ?expand=steps. The
      // reference points at a shared step that exists but belongs to
      // project A -- expandSteps() must resolve it to nothing (dropped,
      // not a blank row) and project A's step text must not appear
      // anywhere in the response, live, against the real container and
      // real Mongo -- this must happen BEFORE the shared step is deleted
      // below.
      const expandRead = await client.get(
        `/api/v1/testrepo/${tcB.data.data._id}?expand=steps`,
        withScope(projectBId)
      );
      expect(expandRead.status).toBe(200);
      expect(expandRead.data.data.TestSteps).toEqual([]);
      expect(JSON.stringify(expandRead.data)).not.toMatch(/PROJECT A SECRET/);

      // Usage, scoped to project A: must NOT include project B's test case.
      const usage = await client.get(`/api/v1/sharedstep/${sharedStepId}/usage`, withScope(DEFAULT_PROJECT_ID));
      expect(usage.status).toBe(200);
      expect(usage.data.data.count).toBe(0);
      expect(usage.data.data.testCases).toEqual([]);

      // And the delete guard must not be blocked by it either. Deleting
      // the shared step here, before project B's referencing test case is
      // cleaned up in the top-level afterAll, is intentional and matches
      // this test's own point (a cross-project reference must not block
      // the owning project's delete) -- the referencing test case itself
      // is still cleaned up afterward, in the existing
      // createdTestCaseIdsB afterAll loop, and that loop already runs
      // test-case deletes before shared-step deletes at the top level, so
      // no fixture is left behind on any path, including this one where
      // the shared step is deleted mid-test rather than in afterAll.
      const del = await client.delete(`/api/v1/sharedstep/${sharedStepId}`, withScope(DEFAULT_PROJECT_ID));
      expect(del.status).toBe(200);
    });
  });

  describe('SharedStep RBAC (viewer read-only, contributor no delete)', () => {
    let projectId;
    let projectMongoId;
    let orgId;
    const personas = {};
    const createdEntities = [];

    beforeAll(async () => {
      const orgResp = await userServiceClient.post('/api/v1/organizations', {
        name: `WP-F06 sharedstep rbac org ${runId}`,
        key: `wpf06-ss-rbac-org-${runId}`
      });
      expect(orgResp.status).toBe(201);
      orgId = orgResp.data.data._id;
      trackOrganization(orgId);

      const projResp = await userServiceClient.post('/api/v1/projects', {
        name: `WP-F06 sharedstep rbac project ${runId}`,
        key: `wpf06-ss-rbac-proj-${runId}`,
        organizationId: orgId
      });
      expect(projResp.status).toBe(201);
      projectId = projResp.data.data.id;
      trackProject(projectId);
      projectMongoId = projResp.data.data._id;
      trackProject(projectMongoId);

      for (const role of ['contributor', 'viewer']) {
        // eslint-disable-next-line no-await-in-loop
        const persona = await createTestPersona(role);
        // eslint-disable-next-line no-await-in-loop
        const addResp = await userServiceClient.post(`/api/v1/projects/${projectMongoId}/members`, {
          userId: persona.userId,
          role
        });
        expect(addResp.status).toBe(200);
        // eslint-disable-next-line no-await-in-loop
        const token = await persona.getToken();
        personas[role] = {
          persona,
          client: axios.create({ baseURL: BASE_URL, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true })
        };
      }
    }, 60000);

    afterAll(async () => {
      for (const id of createdEntities) {
        // eslint-disable-next-line no-await-in-loop
        await client.delete(`/api/v1/sharedstep/${id}`, withScope(projectId)).catch(() => {});
      }
      for (const role of Object.keys(personas)) {
        // eslint-disable-next-line no-await-in-loop
        await personas[role].persona.cleanup().catch(() => {});
      }
      if (projectMongoId) {
        await userServiceClient.delete(`/api/v1/projects/${projectMongoId}`);
      }
      if (orgId) {
        await userServiceClient.delete(`/api/v1/organizations/${orgId}`);
      }
    }, 30000);

    it('viewer can GET the list', async () => {
      const resp = await withCacheRetry(() => personas.viewer.client.get('/api/v1/sharedstep', withScope(projectId)));
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);
    });

    it('viewer gets 403 on POST', async () => {
      const resp = await personas.viewer.client.post(
        '/api/v1/sharedstep',
        { title: 'viewer should never create this', steps: [] },
        withScope(projectId)
      );
      expect(resp.status).toBe(403);
    });

    it('viewer gets 403 on PUT', async () => {
      // Seed the target as the contributor (write-capable) so the PUT
      // attempt itself is the only thing under test.
      const seed = await personas.contributor.client.post(
        '/api/v1/sharedstep',
        { title: `WP-F06 rbac viewer-put target ${runId}`, steps: [] },
        withScope(projectId)
      );
      expect(seed.status).toBe(201);
      createdEntities.push(seed.data.data._id);

      const resp = await personas.viewer.client.put(
        `/api/v1/sharedstep/${seed.data.data._id}`,
        { title: 'viewer should never update this' },
        withScope(projectId)
      );
      expect(resp.status).toBe(403);
    });

    it('viewer gets 403 on DELETE', async () => {
      const seed = await personas.contributor.client.post(
        '/api/v1/sharedstep',
        { title: `WP-F06 rbac viewer-delete target ${runId}`, steps: [] },
        withScope(projectId)
      );
      expect(seed.status).toBe(201);
      createdEntities.push(seed.data.data._id);

      const resp = await personas.viewer.client.delete(`/api/v1/sharedstep/${seed.data.data._id}`, withScope(projectId));
      expect(resp.status).toBe(403);
    });

    it('contributor can POST (write, no delete)', async () => {
      const resp = await personas.contributor.client.post(
        '/api/v1/sharedstep',
        { title: `WP-F06 rbac contributor create ${runId}`, steps: [] },
        withScope(projectId)
      );
      expect(resp.status).toBe(201);
      createdEntities.push(resp.data.data._id);
    });

    it('contributor gets 403 on DELETE', async () => {
      const seed = await personas.contributor.client.post(
        '/api/v1/sharedstep',
        { title: `WP-F06 rbac contributor-delete target ${runId}`, steps: [] },
        withScope(projectId)
      );
      expect(seed.status).toBe(201);
      createdEntities.push(seed.data.data._id);

      const resp = await personas.contributor.client.delete(`/api/v1/sharedstep/${seed.data.data._id}`, withScope(projectId));
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
