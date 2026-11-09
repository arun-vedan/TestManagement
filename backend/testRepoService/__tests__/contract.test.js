const path = require('path');
const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { loadSpec, assertResponseMatches } = require('../../shared/test-utils/openApiContract');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');

// WP-062 (ADR-007) — contract tests: assert real, live HTTP responses
// against backend/testRepoService/openapi.yaml, not just against
// hand-picked field assertions. The point (per the WP brief) is that this
// suite FAILS when the response drifts from the spec, not that it merely
// exercises the routes — see the "demonstrated drift" note at the bottom
// of this file and EXECUTION_LOG.md's WP-062 entry for the actual failing
// run this was proven against.

const KONG_URL = process.env.TEST_KONG_URL || 'http://localhost:8000';
const DEFAULT_PROJECT_ID = 1;
const runId = Date.now();

const spec = loadSpec(path.join(__dirname, '../openapi.yaml'));
const withScope = (projectId) => ({ headers: { [PROJECT_ID_HEADER]: String(projectId) } });

describe('testRepoService contract (WP-062, live, validated against openapi.yaml)', () => {
  let adminToken;
  let client;
  let anonClient;
  const createdIds = [];

  beforeAll(async () => {
    adminToken = await getServiceToken();
    client = axios.create({
      baseURL: KONG_URL,
      headers: { Authorization: `Bearer ${adminToken}` },
      validateStatus: () => true
    });
    anonClient = axios.create({ baseURL: KONG_URL, validateStatus: () => true });
  });

  afterAll(async () => {
    for (const id of createdIds) {
      // eslint-disable-next-line no-await-in-loop
      await client.delete(`/api/v1/testrepo/${id}`, withScope(DEFAULT_PROJECT_ID)).catch(() => {});
    }
  });

  it('GET /api/v1/testrepo with no token: 401 at Kong (WP-023), not 403', async () => {
    const resp = await anonClient.get('/api/v1/testrepo');
    // This is the exact distinction this WP's brief calls out: Kong's jwt
    // plugin rejects with 401, DIFFERENT from a direct-to-service
    // keycloak.protect() 403. Going through Kong (as every real consumer
    // does), 401 is what must come back.
    expect(resp.status).toBe(401);
  });

  it('GET /api/v1/testrepo with a valid token but no X-Project-Id: 403, not 400 (WP-021)', async () => {
    const resp = await client.get('/api/v1/testrepo');
    expect(resp.status).toBe(403);
    assertResponseMatches(spec, '/api/v1/testrepo', 'get', 403, resp.data);
  });

  it('POST /api/v1/testrepo creates a test case matching TestCaseSingle, and GET list/single both match their spec schemas', async () => {
    const createResp = await client.post(
      '/api/v1/testrepo',
      { TestCaseSummary: `WP-062 contract ${runId}`, TestCaseDescription: 'seeded for contract test, cleaned up in afterAll' },
      withScope(DEFAULT_PROJECT_ID)
    );
    expect(createResp.status).toBe(201);
    assertResponseMatches(spec, '/api/v1/testrepo', 'post', 201, createResp.data);
    const id = createResp.data.data._id;
    createdIds.push(id);

    const listResp = await client.get('/api/v1/testrepo', withScope(DEFAULT_PROJECT_ID));
    expect(listResp.status).toBe(200);
    assertResponseMatches(spec, '/api/v1/testrepo', 'get', 200, listResp.data);

    const singleResp = await client.get(`/api/v1/testrepo/${id}`, withScope(DEFAULT_PROJECT_ID));
    expect(singleResp.status).toBe(200);
    assertResponseMatches(spec, '/api/v1/testrepo/{id}', 'get', 200, singleResp.data);
    expect(singleResp.data.data.TestCaseId).toMatch(/^TC-\d+$/);
  });

  it('GET /api/v1/testrepo/{id} for a nonexistent id: 404 matching the documented ErrorResponse shape', async () => {
    const resp = await client.get('/api/v1/testrepo/000000000000000000000000', withScope(DEFAULT_PROJECT_ID));
    expect(resp.status).toBe(404);
    assertResponseMatches(spec, '/api/v1/testrepo/{id}', 'get', 404, resp.data);
  });

  it('GET /api/v1/testrepo?<uncastable filter>: 400, not a hang (WP-013b) — matches the documented ErrorResponse shape', async () => {
    const resp = await client.get('/api/v1/testrepo', {
      ...withScope(DEFAULT_PROJECT_ID),
      params: { _id: 'not-a-valid-object-id' }
    });
    expect(resp.status).toBe(400);
    assertResponseMatches(spec, '/api/v1/testrepo', 'get', 400, resp.data);
  });

  // ---------------------------------------------------------------------
  // DEMONSTRATED DRIFT (WP-062 acceptance: "contract tests that actually
  // fail when a response drifts from its spec"). This is not a live test
  // left in the suite — it is the reproducible recipe, recorded here so
  // the failure is provable without permanently breaking CI:
  //
  //   1. Edit backend/testRepoService/openapi.yaml's TestCase schema and
  //      add `required: [..., 'thisFieldDoesNotExist']` to the TestCase
  //      object (or equivalently, temporarily rename a real field, e.g.
  //      TestCaseSummary -> TestCaseSummaryX, in the schema only).
  //   2. Run `npm test -- contract.test.js` in this directory.
  //   3. The "POST ... creates a test case matching TestCaseSingle" test
  //      above fails with:
  //        $.data: missing required property 'thisFieldDoesNotExist'
  //      (or, for the rename variant: the same missing-required-property
  //      error naming TestCaseSummaryX) — proving the harness actually
  //      reads response bodies and fails on a real mismatch, not just
  //      "the endpoint returned 2xx".
  //   4. Revert the spec edit; the suite passes again.
  //
  // EXECUTION_LOG.md's WP-062 entry records the actual `npm test` output
  // from running this exact recipe once, live, as the required
  // demonstration, together with the immediate revert-and-rerun proving
  // green again.
  // ---------------------------------------------------------------------
});
