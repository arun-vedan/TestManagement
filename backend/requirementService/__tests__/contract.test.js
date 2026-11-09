const path = require('path');
const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { loadSpec, assertResponseMatches } = require('../../shared/test-utils/openApiContract');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');

// WP-062 (ADR-007) — see testRepoService/__tests__/contract.test.js for the
// full rationale (same harness, same live-through-Kong pattern). This
// suite is the lighter-touch companion for requirementService: it proves
// the same openApiContract.js harness generalizes to a second service's
// spec, not a second from-scratch design.

const KONG_URL = process.env.TEST_KONG_URL || 'http://localhost:8000';
const DEFAULT_PROJECT_ID = 1;
const runId = Date.now();

const spec = loadSpec(path.join(__dirname, '../openapi.yaml'));
const withScope = (projectId) => ({ headers: { [PROJECT_ID_HEADER]: String(projectId) } });

describe('requirementService contract (WP-062, live, validated against openapi.yaml)', () => {
  let client;
  let anonClient;
  const createdIds = [];

  beforeAll(async () => {
    const adminToken = await getServiceToken();
    client = axios.create({ baseURL: KONG_URL, headers: { Authorization: `Bearer ${adminToken}` }, validateStatus: () => true });
    anonClient = axios.create({ baseURL: KONG_URL, validateStatus: () => true });
  });

  afterAll(async () => {
    for (const id of createdIds) {
      // eslint-disable-next-line no-await-in-loop
      await client.delete(`/api/v1/requirement/${id}`, withScope(DEFAULT_PROJECT_ID)).catch(() => {});
    }
  });

  it('GET /api/v1/requirement with no token: 401 at Kong', async () => {
    const resp = await anonClient.get('/api/v1/requirement');
    expect(resp.status).toBe(401);
  });

  it('GET /api/v1/requirement with a valid token but no X-Project-Id: 403 matching ErrorResponse', async () => {
    const resp = await client.get('/api/v1/requirement');
    expect(resp.status).toBe(403);
    assertResponseMatches(spec, '/api/v1/requirement', 'get', 403, resp.data);
  });

  it('POST creates a requirement matching RequirementSingle; GET list/single match their schemas', async () => {
    const createResp = await client.post(
      '/api/v1/requirement',
      { requirementSummary: `WP-062 contract ${runId}`, requirementDescription: 'seeded for contract test' },
      withScope(DEFAULT_PROJECT_ID)
    );
    expect(createResp.status).toBe(201);
    assertResponseMatches(spec, '/api/v1/requirement', 'post', 201, createResp.data);
    const id = createResp.data.data._id;
    createdIds.push(id);
    expect(createResp.data.data.reqId).toMatch(/^Req-\d+$/);
    expect(createResp.data.data.status).toBe('draft');

    const listResp = await client.get('/api/v1/requirement', withScope(DEFAULT_PROJECT_ID));
    expect(listResp.status).toBe(200);
    assertResponseMatches(spec, '/api/v1/requirement', 'get', 200, listResp.data);

    const singleResp = await client.get(`/api/v1/requirement/${id}`, withScope(DEFAULT_PROJECT_ID));
    expect(singleResp.status).toBe(200);
    assertResponseMatches(spec, '/api/v1/requirement/{id}', 'get', 200, singleResp.data);
  });

  it('GET /api/v1/requirement/{id} for a nonexistent id: 404 matching ErrorResponse', async () => {
    const resp = await client.get('/api/v1/requirement/000000000000000000000000', withScope(DEFAULT_PROJECT_ID));
    expect(resp.status).toBe(404);
    assertResponseMatches(spec, '/api/v1/requirement/{id}', 'get', 404, resp.data);
  });
});
