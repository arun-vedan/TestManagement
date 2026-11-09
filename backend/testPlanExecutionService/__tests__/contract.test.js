const path = require('path');
const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { loadSpec, assertResponseMatches } = require('../../shared/test-utils/openApiContract');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');

// WP-062 (ADR-007) — see testRepoService/__tests__/contract.test.js for the
// harness.
//
// WP-021b UPDATE: this suite used to pin down this service's own spec's
// headline discrepancy note -- testplan.js/testexecution.js's main CRUD
// routes were NOT tenant-scoped, so a plain GET succeeded WITHOUT
// X-Project-Id, unlike every other WP-021-migrated service. That gap is
// now closed (requireProjectScope()+authorize() mounted on every route,
// same as testRepoService/requirementService/defectService) -- both
// openapi.yaml and this suite are updated to match the new, scoped
// behavior. This is exactly the "if a future change adds
// requireProjectScope() here, this test breaks immediately" scenario the
// old comment predicted; the spec and the test are doing their job.

const KONG_URL = process.env.TEST_KONG_URL || 'http://localhost:8000';
const DEFAULT_PROJECT_ID = 1;
const runId = Date.now();

const spec = loadSpec(path.join(__dirname, '../openapi.yaml'));
const withScope = (projectId) => ({ headers: { [PROJECT_ID_HEADER]: String(projectId) } });

describe('testPlanExecutionService contract (WP-062, live, validated against openapi.yaml)', () => {
  let client;
  let anonClient;
  const createdPlanIds = [];
  const createdExecIds = [];

  beforeAll(async () => {
    const adminToken = await getServiceToken();
    client = axios.create({ baseURL: KONG_URL, headers: { Authorization: `Bearer ${adminToken}` }, validateStatus: () => true });
    anonClient = axios.create({ baseURL: KONG_URL, validateStatus: () => true });
  });

  afterAll(async () => {
    for (const id of createdPlanIds) {
      // eslint-disable-next-line no-await-in-loop
      await client.delete(`/api/v1/testplan/${id}`, withScope(DEFAULT_PROJECT_ID)).catch(() => {});
    }
    for (const id of createdExecIds) {
      // eslint-disable-next-line no-await-in-loop
      await client.delete(`/api/v1/testexecution/${id}`, withScope(DEFAULT_PROJECT_ID)).catch(() => {});
    }
  });

  it('GET /api/v1/testplan with no token: 401 at Kong', async () => {
    const resp = await anonClient.get('/api/v1/testplan');
    expect(resp.status).toBe(401);
  });

  it('GET /api/v1/testplan with a valid token but no X-Project-Id: 403 matching ErrorResponse (WP-021b: now tenant-scoped, like every other service)', async () => {
    const resp = await client.get('/api/v1/testplan');
    expect(resp.status).toBe(403);
    assertResponseMatches(spec, '/api/v1/testplan', 'get', 403, resp.data);
  });

  it('GET /api/v1/testexecution with a valid token but no X-Project-Id: 403 matching ErrorResponse', async () => {
    const resp = await client.get('/api/v1/testexecution');
    expect(resp.status).toBe(403);
    assertResponseMatches(spec, '/api/v1/testexecution', 'get', 403, resp.data);
  });

  it('GET /api/v1/testplan with a valid token and X-Project-Id: 1 succeeds and matches TestPlanList', async () => {
    const resp = await client.get('/api/v1/testplan', withScope(DEFAULT_PROJECT_ID));
    expect(resp.status).toBe(200);
    assertResponseMatches(spec, '/api/v1/testplan', 'get', 200, resp.data);
  });

  it('POST creates a test plan matching TestPlanSingle, stamped with the verified projectId', async () => {
    const createResp = await client.post('/api/v1/testplan', { TestCases: [] }, withScope(DEFAULT_PROJECT_ID));
    expect(createResp.status).toBe(201);
    assertResponseMatches(spec, '/api/v1/testplan', 'post', 201, createResp.data);
    expect(createResp.data.data.projectId).toBe(DEFAULT_PROJECT_ID);
    const id = createResp.data.data._id;
    createdPlanIds.push(id);
    expect(createResp.data.data.TestPlanId).toMatch(/^PLN-\d+$/);

    const singleResp = await client.get(`/api/v1/testplan/${id}`, withScope(DEFAULT_PROJECT_ID));
    expect(singleResp.status).toBe(200);
    assertResponseMatches(spec, '/api/v1/testplan/{id}', 'get', 200, singleResp.data);
  });

  it('POST creates a test execution matching TestExecutionSingle, stamped with the verified projectId', async () => {
    const createResp = await client.post('/api/v1/testexecution', { TestCases: [] }, withScope(DEFAULT_PROJECT_ID));
    expect(createResp.status).toBe(201);
    assertResponseMatches(spec, '/api/v1/testexecution', 'post', 201, createResp.data);
    expect(createResp.data.data.projectId).toBe(DEFAULT_PROJECT_ID);
    const id = createResp.data.data._id;
    createdExecIds.push(id);
    expect(createResp.data.data.TestExecutionId).toMatch(/^Run-\d+$/);

    const singleResp = await client.get(`/api/v1/testexecution/${id}`, withScope(DEFAULT_PROJECT_ID));
    expect(singleResp.status).toBe(200);
    assertResponseMatches(spec, '/api/v1/testexecution/{id}', 'get', 200, singleResp.data);
  });

  // A plan's "Create Execution" dialog lets the creator assign the run to
  // someone else; with no assignee the creator is assigned, as before.
  it('POST honours an assignedTo in the body, and defaults it to the creator otherwise', async () => {
    const assigned = await client.post(
      '/api/v1/testexecution',
      { TestCases: [], assignedTo: 'some-other-user-id' },
      withScope(DEFAULT_PROJECT_ID)
    );
    expect(assigned.status).toBe(201);
    createdExecIds.push(assigned.data.data._id);
    expect(assigned.data.data.assignedTo).toBe('some-other-user-id');

    const unassigned = await client.post('/api/v1/testexecution', { TestCases: [] }, withScope(DEFAULT_PROJECT_ID));
    expect(unassigned.status).toBe(201);
    createdExecIds.push(unassigned.data.data._id);
    expect(unassigned.data.data.assignedTo).toBeTruthy();
    expect(unassigned.data.data.assignedTo).not.toBe('some-other-user-id');
  });

  it('GET /api/v1/testplan/wildcardsearch matches TestPlanList-shaped response', async () => {
    const resp = await client.get('/api/v1/testplan/wildcardsearch', {
      params: { search: 'PLN' },
      ...withScope(DEFAULT_PROJECT_ID)
    });
    expect(resp.status).toBe(200);
    assertResponseMatches(spec, '/api/v1/testplan/wildcardsearch', 'get', 200, resp.data);
  });

  it('GET /api/v1/testexecution/wildcardsearch matches TestExecutionList-shaped response', async () => {
    const resp = await client.get('/api/v1/testexecution/wildcardsearch', {
      params: { search: 'Run' },
      ...withScope(DEFAULT_PROJECT_ID)
    });
    expect(resp.status).toBe(200);
    assertResponseMatches(spec, '/api/v1/testexecution/wildcardsearch', 'get', 200, resp.data);
  });

  it('POST /api/v1/testexecution/ingest with no X-Project-Id: 403 — same rule as every other route now, not an exception', async () => {
    const resp = await client.post(
      '/api/v1/testexecution/ingest',
      { testCaseId: `TC-contract-${runId}`, status: 'pass' },
      { headers: { 'Content-Type': 'application/json' } }
    );
    // requireAuth() falls through to keycloak.protect() (a valid Keycloak
    // bearer IS present here), so it passes; requireProjectScope() is what
    // rejects the missing header — 403, matching every other route on this
    // service since WP-021b, and every other WP-021-scoped service.
    expect(resp.status).toBe(403);
  });
});
