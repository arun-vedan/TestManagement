const path = require('path');
const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { loadSpec, assertResponseMatches } = require('../../shared/test-utils/openApiContract');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');

// WP-062 (ADR-007) — see testRepoService/__tests__/contract.test.js for the
// full rationale (same harness). defectService's spec documents two real
// departures from testRepo/requirement's shape (istatusservice-graph
// status validation, bulk action=assign only) — this suite locks in the
// plain-CRUD contract; the status-graph and bulk behaviors already have
// their own dedicated black-box coverage elsewhere in this service's
// __tests__ (not duplicated here).

const KONG_URL = process.env.TEST_KONG_URL || 'http://localhost:8000';
const DEFAULT_PROJECT_ID = 1;
const runId = Date.now();

const spec = loadSpec(path.join(__dirname, '../openapi.yaml'));
const withScope = (projectId) => ({ headers: { [PROJECT_ID_HEADER]: String(projectId) } });

describe('defectService contract (WP-062, live, validated against openapi.yaml)', () => {
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
      await client.delete(`/api/v1/defects/${id}`, withScope(DEFAULT_PROJECT_ID)).catch(() => {});
    }
  });

  it('GET /api/v1/defects with no token: 401 at Kong', async () => {
    const resp = await anonClient.get('/api/v1/defects');
    expect(resp.status).toBe(401);
  });

  it('GET /api/v1/defects with a valid token but no X-Project-Id: 403 matching ErrorResponse', async () => {
    const resp = await client.get('/api/v1/defects');
    expect(resp.status).toBe(403);
    assertResponseMatches(spec, '/api/v1/defects', 'get', 403, resp.data);
  });

  it('POST creates a defect matching DefectSingle; GET list/single match their schemas', async () => {
    const createResp = await client.post(
      '/api/v1/defects',
      { summary: `WP-062 contract ${runId}`, description: 'seeded for contract test', Priority: 'Low', Severity: 'Minor' },
      withScope(DEFAULT_PROJECT_ID)
    );
    expect(createResp.status).toBe(201);
    assertResponseMatches(spec, '/api/v1/defects', 'post', 201, createResp.data);
    const id = createResp.data.data._id;
    createdIds.push(id);
    expect(createResp.data.data.defectId).toMatch(/^Bug-\d+$/);

    const listResp = await client.get('/api/v1/defects', withScope(DEFAULT_PROJECT_ID));
    expect(listResp.status).toBe(200);
    assertResponseMatches(spec, '/api/v1/defects', 'get', 200, listResp.data);

    const singleResp = await client.get(`/api/v1/defects/${id}`, withScope(DEFAULT_PROJECT_ID));
    expect(singleResp.status).toBe(200);
    assertResponseMatches(spec, '/api/v1/defects/{id}', 'get', 200, singleResp.data);
  });

  it('GET /api/v1/defects/{id} for a nonexistent id: 404 matching ErrorResponse', async () => {
    const resp = await client.get('/api/v1/defects/000000000000000000000000', withScope(DEFAULT_PROJECT_ID));
    expect(resp.status).toBe(404);
    assertResponseMatches(spec, '/api/v1/defects/{id}', 'get', 404, resp.data);
  });
});
