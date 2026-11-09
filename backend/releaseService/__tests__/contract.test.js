const path = require('path');
const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { loadSpec, assertResponseMatches } = require('../../shared/test-utils/openApiContract');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');

// WP-062 (ADR-007) — see testRepoService/__tests__/contract.test.js for the harness.

const KONG_URL = process.env.TEST_KONG_URL || 'http://localhost:8000';
const DEFAULT_PROJECT_ID = 1;
const runId = Date.now();

const spec = loadSpec(path.join(__dirname, '../openapi.yaml'));
const withScope = (projectId) => ({ headers: { [PROJECT_ID_HEADER]: String(projectId) } });

describe('releaseService contract (WP-062, live, validated against openapi.yaml)', () => {
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
      await client.delete(`/api/v1/releases/${id}`, withScope(DEFAULT_PROJECT_ID)).catch(() => {});
    }
  });

  it('GET /api/v1/releases with no token: 401 at Kong', async () => {
    const resp = await anonClient.get('/api/v1/releases');
    expect(resp.status).toBe(401);
  });

  it('POST creates a release matching ReleaseSingle; GET list/gate-status match their schemas', async () => {
    const createResp = await client.post('/api/v1/releases', { name: `WP-062 contract ${runId}` }, withScope(DEFAULT_PROJECT_ID));
    expect(createResp.status).toBe(201);
    assertResponseMatches(spec, '/api/v1/releases', 'post', 201, createResp.data);
    const id = createResp.data.data._id;
    createdIds.push(id);
    expect(createResp.data.data.releaseId).toMatch(/^REL-\d+$/);

    const listResp = await client.get('/api/v1/releases', withScope(DEFAULT_PROJECT_ID));
    expect(listResp.status).toBe(200);
    assertResponseMatches(spec, '/api/v1/releases', 'get', 200, listResp.data);

    // No quality gates configured -> zero rules evaluated, no dependency
    // call needed at all -> 200 with rules:[] and overall:'green'.
    const gateResp = await client.get(`/api/v1/releases/${id}/gate-status`, withScope(DEFAULT_PROJECT_ID));
    expect(gateResp.status).toBe(200);
    assertResponseMatches(spec, '/api/v1/releases/{id}/gate-status', 'get', 200, gateResp.data);
    expect(gateResp.data.data.overall).toBe('green');
  });

  it('GET /api/v1/releases/{id} for a nonexistent id: 404 matching ErrorResponse', async () => {
    const resp = await client.get('/api/v1/releases/000000000000000000000000', withScope(DEFAULT_PROJECT_ID));
    expect(resp.status).toBe(404);
    assertResponseMatches(spec, '/api/v1/releases/{id}', 'get', 404, resp.data);
  });
});
