const path = require('path');
const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { loadSpec, assertResponseMatches } = require('../../shared/test-utils/openApiContract');

// WP-062 (ADR-007) — see testRepoService/__tests__/contract.test.js for the
// harness. userService's spec deliberately covers only what Kong actually
// routes (organizations/projects/apikeys + GET /users/kcUser) — this
// suite validates exactly that surface, matching the spec's own scope.

const KONG_URL = process.env.TEST_KONG_URL || 'http://localhost:8000';
const runId = Date.now();

const spec = loadSpec(path.join(__dirname, '../openapi.yaml'));

describe('userService contract (WP-062, live, validated against openapi.yaml)', () => {
  let client;
  let anonClient;
  const createdOrgIds = [];

  beforeAll(async () => {
    const adminToken = await getServiceToken();
    client = axios.create({ baseURL: KONG_URL, headers: { Authorization: `Bearer ${adminToken}` }, validateStatus: () => true });
    anonClient = axios.create({ baseURL: KONG_URL, validateStatus: () => true });
  });

  afterAll(async () => {
    for (const id of createdOrgIds) {
      // eslint-disable-next-line no-await-in-loop
      await client.delete(`/api/v1/organizations/${id}`).catch(() => {});
    }
  });

  it('GET /api/v1/organizations with no token: 401 at Kong', async () => {
    const resp = await anonClient.get('/api/v1/organizations');
    expect(resp.status).toBe(401);
  });

  it('GET /api/v1/organizations matches the documented list shape (plain {success,count,data} — NOT advancedResults)', async () => {
    const resp = await client.get('/api/v1/organizations');
    expect(resp.status).toBe(200);
    assertResponseMatches(spec, '/api/v1/organizations', 'get', 200, resp.data);
  });

  it('POST /api/v1/organizations creates an org matching the documented schema', async () => {
    const key = `wp062-contract-${runId}`;
    const resp = await client.post('/api/v1/organizations', { name: `WP-062 contract org ${runId}`, key });
    expect(resp.status).toBe(201);
    assertResponseMatches(spec, '/api/v1/organizations', 'post', 201, resp.data);
    createdOrgIds.push(resp.data.data._id);
  });

  it('GET /api/v1/projects matches the documented list shape', async () => {
    const resp = await client.get('/api/v1/projects');
    expect(resp.status).toBe(200);
    assertResponseMatches(spec, '/api/v1/projects', 'get', 200, resp.data);
  });

  it('GET /api/v1/apikeys/{keyId} for a revoke on a nonexistent key without X-Project-Id: 403 (requireProjectScopeLocal)', async () => {
    const resp = await client.delete('/api/v1/apikeys/ak_doesnotexist');
    expect(resp.status).toBe(403);
    assertResponseMatches(spec, '/api/v1/apikeys/{keyId}', 'delete', 403, resp.data);
  });
});
