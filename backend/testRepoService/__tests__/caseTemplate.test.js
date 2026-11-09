const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { createTestPersona } = require('../../shared/test-utils/keycloakTestPersona');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

// WP-F08 Task 1 -- CaseTemplate CRUD and RBAC. Deliberately NO usage query
// and NO delete guard (R5, see models/CaseTemplate.js) -- unlike
// sharedStep.test.js/dataset.test.js, this suite proves delete succeeds
// unconditionally instead of proving a guard exists.
//
// Same black-box HTTP convention as sharedStep.test.js/dataset.test.js:
// reached DIRECTLY against the running container (BASE_URL), bypassing
// Kong for the CRUD/RBAC assertions below -- keycloak.protect() is
// bearerOnly and verifies the JWT itself, independent of Kong, so a direct
// call is exactly as strong a proof of the real auth chain as going
// through the gateway. Kong routing itself (401 not 404) is proved
// separately, by an unauthenticated curl reported in task-1-report.md, not
// by this suite.

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
// sharedStep.test.js/tenantIsolation.test.js/rbacMatrix.test.js retry
// around: a membership change (new project, new member) can be
// momentarily invisible to a request that lands just after it.
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

describe('CaseTemplate CRUD, moduleId validation, and no delete guard (WP-F08 Task 1)', () => {
  let client; // authed (service account), no default project header
  let userServiceClient;
  let sub;

  // Project B -- fresh org+project, used for the cross-project tests.
  let projectBId;
  let projectBMongoId;
  let orgBId;

  const createdCaseTemplateIds = []; // project 1
  const createdCaseTemplateIdsB = []; // project B

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
    // same defensive step sharedStep.test.js/tenantIsolation.test.js take;
    // membership isn't otherwise guaranteed for the service account in
    // every environment.
    const listResp = await userServiceClient.get('/api/v1/projects');
    expect(listResp.status).toBe(200);
    const projectA = listResp.data.data.find((p) => p.id === DEFAULT_PROJECT_ID);
    expect(projectA).toBeDefined();
    await userServiceClient.post(`/api/v1/projects/${projectA._id}/members`, { userId: sub, role: 'admin' });

    // Create Project B (this identity is auto-added as admin creator).
    const orgResp = await userServiceClient.post('/api/v1/organizations', {
      name: `WP-F08 casetemplate org B ${runId}`,
      key: `wpf08-ct-org-b-${runId}`
    });
    expect(orgResp.status).toBe(201);
    orgBId = orgResp.data.data._id;
    trackOrganization(orgBId);

    const projResp = await userServiceClient.post('/api/v1/projects', {
      name: `WP-F08 casetemplate project B ${runId}`,
      key: `wpf08-ct-proj-b-${runId}`,
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
    for (const id of createdCaseTemplateIds) {
      // eslint-disable-next-line no-await-in-loop
      await client.delete(`/api/v1/casetemplate/${id}`, withScope(DEFAULT_PROJECT_ID)).catch(() => {});
    }
    for (const id of createdCaseTemplateIdsB) {
      // eslint-disable-next-line no-await-in-loop
      await client.delete(`/api/v1/casetemplate/${id}`, withScope(projectBId)).catch(() => {});
    }
    if (projectBMongoId) {
      await userServiceClient.delete(`/api/v1/projects/${projectBMongoId}`);
    }
    if (orgBId) {
      await userServiceClient.delete(`/api/v1/organizations/${orgBId}`);
    }
  }, 30000);

  describe('CaseTemplate CRUD', () => {
    it("creates a case template with a server-generated CT- id and the caller's projectId", async () => {
      const res = await withCacheRetry(() => client.post(
        '/api/v1/casetemplate',
        { name: `WP-F08 Regression case template ${runId}`, moduleId: 1, prefill: { TestCaseSummary: 'x' } },
        withScope(DEFAULT_PROJECT_ID)
      ));
      expect(res.status).toBe(201);
      createdCaseTemplateIds.push(res.data.data._id);
      expect(res.data.data.CaseTemplateId).toMatch(/^CT-\d+$/);
      expect(res.data.data.projectId).toBe(DEFAULT_PROJECT_ID);
    });

    it("ignores a projectId supplied in the create body", async () => {
      const res = await client.post(
        '/api/v1/casetemplate',
        { name: `WP-F08 spoof projectId ${runId}`, moduleId: 1, projectId: 999, prefill: {} },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(res.status).toBe(201);
      createdCaseTemplateIds.push(res.data.data._id);
      expect(res.data.data.projectId).toBe(DEFAULT_PROJECT_ID);
    });

    it("rejects a create with no name", async () => {
      const res = await client.post(
        '/api/v1/casetemplate',
        { moduleId: 1, prefill: {} },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(res.status).toBe(400);
    });

    // Non-vacuity probe (performed, not just asserted -- see
    // task-1-report.md Step 7): with the moduleId enum validator removed
    // from models/CaseTemplate.js, this single test is the one that fails
    // (a create with moduleId: 4 would succeed with 201 instead of being
    // rejected with 400).
    it('rejects moduleId 4 (runs -- no draft flow)', async () => {
      const res = await client.post(
        '/api/v1/casetemplate',
        { name: `WP-F08 bad module 4 ${runId}`, moduleId: 4, prefill: {} },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(res.status).toBe(400);
    });

    it('rejects moduleId 6 (releases -- created from its own page)', async () => {
      const res = await client.post(
        '/api/v1/casetemplate',
        { name: `WP-F08 bad module 6 ${runId}`, moduleId: 6, prefill: {} },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(res.status).toBe(400);
    });

    it.each([1, 2, 3, 5])('accepts moduleId %i (draft-capable)', async (moduleId) => {
      const res = await client.post(
        '/api/v1/casetemplate',
        { name: `WP-F08 valid module ${moduleId} ${runId}`, moduleId, prefill: {} },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(res.status).toBe(201);
      createdCaseTemplateIds.push(res.data.data._id);
      expect(res.data.data.moduleId).toBe(moduleId);
    });

    // Round-trip proof for the Mixed `prefill` field (brief requirement,
    // and the exact shape of loss WP-F06 had with sharedStepTitle). Non-
    // vacuity probe performed for task-1-report.md Step 7: replacing
    // `prefill: { type: mongoose.Schema.Types.Mixed }` with a strict
    // sub-schema naming only some of these keys makes this test fail (the
    // unnamed keys come back undefined instead of round-tripping).
    it('round-trips every key of an arbitrary Mixed prefill through create and read', async () => {
      const prefill = {
        TestCaseSummary: `WP-F08 prefill summary ${runId}`,
        TestCaseDescription: 'multi-line\ndescription',
        priority: 'High',
        tags: ['smoke', 'regression'],
        datasetId: 'DS-42',
        nested: { steps: [{ testStep: 'Open /login', Expected: 'Login form', order: 1 }] },
        nullField: null,
        numericField: 7,
        boolField: false,
      };
      const created = await client.post(
        '/api/v1/casetemplate',
        { name: `WP-F08 prefill round trip ${runId}`, moduleId: 1, prefill },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(created.status).toBe(201);
      createdCaseTemplateIds.push(created.data.data._id);
      const id = created.data.data._id;

      // Assert immediately on the create response...
      expect(created.data.data.prefill).toEqual(prefill);

      // ...and again on a fresh GET, proving it was actually persisted to
      // Mongo and re-read, not merely echoed back from the request body.
      const read = await client.get(`/api/v1/casetemplate/${id}`, withScope(DEFAULT_PROJECT_ID));
      expect(read.status).toBe(200);
      expect(read.data.data.prefill).toEqual(prefill);
      for (const key of Object.keys(prefill)) {
        expect(read.data.data.prefill).toHaveProperty(key);
      }
    });

    // Non-vacuity probe performed for task-1-report.md Step 7: removing
    // the `projectId: req.projectScope.projectId` filter from
    // getCaseTemplate/findOneAndUpdate's query (controllers/
    // caseTemplate.js) makes this test fail (project B's GET would return
    // 200 with project A's template instead of 404).
    it("does not return another project's case template (404 on GET /:id, absent from the list)", async () => {
      const created = await client.post(
        '/api/v1/casetemplate',
        { name: `WP-F08 project A only ${runId}`, moduleId: 1, prefill: {} },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(created.status).toBe(201);
      createdCaseTemplateIds.push(created.data.data._id);
      const id = created.data.data._id;

      const crossRead = await withCacheRetry(() => client.get(`/api/v1/casetemplate/${id}`, withScope(projectBId)));
      expect(crossRead.status).toBe(404);

      const listB = await client.get('/api/v1/casetemplate', withScope(projectBId));
      expect(listB.status).toBe(200);
      expect(listB.data.data.some((t) => t._id === id)).toBe(false);
    });

    it("a PUT cannot move a template to another project via a spoofed projectId in the body", async () => {
      const created = await client.post(
        '/api/v1/casetemplate',
        { name: `WP-F08 put projectId spoof ${runId}`, moduleId: 1, prefill: {} },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(created.status).toBe(201);
      createdCaseTemplateIds.push(created.data.data._id);
      const id = created.data.data._id;

      const put = await client.put(
        `/api/v1/casetemplate/${id}`,
        { name: 'renamed', projectId: 999 },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(put.status).toBe(200);
      expect(put.data.data.projectId).toBe(DEFAULT_PROJECT_ID);
      expect(put.data.data.name).toBe('renamed');
    });
  });

  describe('CaseTemplate delete: no usage guard (R5)', () => {
    // R5's deliberate absence, proved directly: an unrelated test case
    // exists in this project throughout this suite (project A's seed
    // data, untouched), and delete still succeeds -- there is no
    // "in use" concept for a template to be blocked by.
    it('deletes a case template unconditionally, with no usage check', async () => {
      const created = await client.post(
        '/api/v1/casetemplate',
        { name: `WP-F08 deletable ${runId}`, moduleId: 1, prefill: { TestCaseSummary: 'anything' } },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(created.status).toBe(201);
      const id = created.data.data._id;

      const del = await client.delete(`/api/v1/casetemplate/${id}`, withScope(DEFAULT_PROJECT_ID));
      expect(del.status).toBe(200);
      expect(del.data.success).toBe(true);

      const read = await client.get(`/api/v1/casetemplate/${id}`, withScope(DEFAULT_PROJECT_ID));
      expect(read.status).toBe(404);
      // Deleted for real -- don't track it in createdCaseTemplateIds for
      // cleanup (that would just be a harmless 404 delete, but leaving it
      // out is clearer about what this test actually proved).
    });

    it('returns 404 deleting an already-deleted (or nonexistent) case template, not a guard-style 409', async () => {
      const created = await client.post(
        '/api/v1/casetemplate',
        { name: `WP-F08 double delete ${runId}`, moduleId: 1, prefill: {} },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(created.status).toBe(201);
      const id = created.data.data._id;

      const first = await client.delete(`/api/v1/casetemplate/${id}`, withScope(DEFAULT_PROJECT_ID));
      expect(first.status).toBe(200);

      const second = await client.delete(`/api/v1/casetemplate/${id}`, withScope(DEFAULT_PROJECT_ID));
      expect(second.status).toBe(404);
    });
  });

  describe('CaseTemplate RBAC (viewer read-only, contributor no delete)', () => {
    let projectId;
    let projectMongoId;
    let orgId;
    const personas = {};
    const createdEntities = [];

    beforeAll(async () => {
      const orgResp = await userServiceClient.post('/api/v1/organizations', {
        name: `WP-F08 casetemplate rbac org ${runId}`,
        key: `wpf08-ct-rbac-org-${runId}`
      });
      expect(orgResp.status).toBe(201);
      orgId = orgResp.data.data._id;
      trackOrganization(orgId);

      const projResp = await userServiceClient.post('/api/v1/projects', {
        name: `WP-F08 casetemplate rbac project ${runId}`,
        key: `wpf08-ct-rbac-proj-${runId}`,
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
        await client.delete(`/api/v1/casetemplate/${id}`, withScope(projectId)).catch(() => {});
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
      const resp = await withCacheRetry(() => personas.viewer.client.get('/api/v1/casetemplate', withScope(projectId)));
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);
    });

    it('viewer gets 403 on POST', async () => {
      const resp = await personas.viewer.client.post(
        '/api/v1/casetemplate',
        { name: 'viewer should never create this', moduleId: 1, prefill: {} },
        withScope(projectId)
      );
      expect(resp.status).toBe(403);
    });

    it('viewer gets 403 on PUT', async () => {
      // Seed the target as the contributor (write-capable) so the PUT
      // attempt itself is the only thing under test.
      const seed = await personas.contributor.client.post(
        '/api/v1/casetemplate',
        { name: `WP-F08 rbac viewer-put target ${runId}`, moduleId: 1, prefill: {} },
        withScope(projectId)
      );
      expect(seed.status).toBe(201);
      createdEntities.push(seed.data.data._id);

      const resp = await personas.viewer.client.put(
        `/api/v1/casetemplate/${seed.data.data._id}`,
        { name: 'viewer should never update this' },
        withScope(projectId)
      );
      expect(resp.status).toBe(403);
    });

    it('viewer gets 403 on DELETE', async () => {
      const seed = await personas.contributor.client.post(
        '/api/v1/casetemplate',
        { name: `WP-F08 rbac viewer-delete target ${runId}`, moduleId: 1, prefill: {} },
        withScope(projectId)
      );
      expect(seed.status).toBe(201);
      createdEntities.push(seed.data.data._id);

      const resp = await personas.viewer.client.delete(`/api/v1/casetemplate/${seed.data.data._id}`, withScope(projectId));
      expect(resp.status).toBe(403);
    });

    it('contributor can POST (write, no delete)', async () => {
      const resp = await personas.contributor.client.post(
        '/api/v1/casetemplate',
        { name: `WP-F08 rbac contributor create ${runId}`, moduleId: 1, prefill: {} },
        withScope(projectId)
      );
      expect(resp.status).toBe(201);
      createdEntities.push(resp.data.data._id);
    });

    // WP-F08's own instance of the exact RBAC gap releaseService shipped
    // on 2026-09-19 (nine protected routes, zero role checks, a viewer
    // could delete a release): this test is the one that proves DELETE
    // actually carries authorize('delete') and not just authorize('write')
    // or no authorize() at all. Non-vacuity probe performed for
    // task-1-report.md Step 7-adjacent check: temporarily changing
    // routes/caseTemplate.js's DELETE route from authorize('delete') to
    // authorize('write') makes this test fail (contributor has write:true,
    // so the delete would then succeed with 200 instead of 403).
    it('contributor gets 403 on DELETE', async () => {
      const seed = await personas.contributor.client.post(
        '/api/v1/casetemplate',
        { name: `WP-F08 rbac contributor-delete target ${runId}`, moduleId: 1, prefill: {} },
        withScope(projectId)
      );
      expect(seed.status).toBe(201);
      createdEntities.push(seed.data.data._id);

      const resp = await personas.contributor.client.delete(`/api/v1/casetemplate/${seed.data.data._id}`, withScope(projectId));
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
