const path = require('path');
const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { loadSpec, assertResponseMatches } = require('../../shared/test-utils/openApiContract');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');

// WP-062 (ADR-007) — see testRepoService/__tests__/contract.test.js for the
// harness. reportingService is read-only, so this suite validates the
// shared ReportEnvelope shape against a real live report rather than
// seeding/cleaning up fixtures of its own.

const KONG_URL = process.env.TEST_KONG_URL || 'http://localhost:8000';
const DEFAULT_PROJECT_ID = 1;

const spec = loadSpec(path.join(__dirname, '../openapi.yaml'));
const withScope = (projectId) => ({ headers: { [PROJECT_ID_HEADER]: String(projectId) } });

describe('reportingService contract (WP-062, live, validated against openapi.yaml)', () => {
  let client;
  let anonClient;

  beforeAll(async () => {
    const adminToken = await getServiceToken();
    client = axios.create({ baseURL: KONG_URL, headers: { Authorization: `Bearer ${adminToken}` }, validateStatus: () => true });
    anonClient = axios.create({ baseURL: KONG_URL, validateStatus: () => true });
  });

  it('GET /api/v1/reports/coverage with no token: 401 at Kong', async () => {
    const resp = await anonClient.get('/api/v1/reports/coverage');
    expect(resp.status).toBe(401);
  });

  it('GET /api/v1/reports/coverage with a valid token but no X-Project-Id: 403 matching ErrorResponse', async () => {
    const resp = await client.get('/api/v1/reports/coverage');
    expect(resp.status).toBe(403);
    assertResponseMatches(spec, '/api/v1/reports/coverage', 'get', 403, resp.data);
  });

  it('GET /api/v1/reports/coverage matches the shared ReportEnvelope shape (success, projectId, reportType, computedAt, stale, data)', async () => {
    const resp = await client.get('/api/v1/reports/coverage', withScope(DEFAULT_PROJECT_ID));
    // Either 200 (computed/cached fine) or 503 (no cache + dependency
    // unreachable) are both documented, real outcomes for this endpoint —
    // assert against whichever one actually came back rather than assuming.
    expect([200, 503]).toContain(resp.status);
    assertResponseMatches(spec, '/api/v1/reports/coverage', 'get', resp.status, resp.data);
  });

  it('GET /api/v1/reports/defect-summary matches the shared ReportEnvelope shape', async () => {
    const resp = await client.get('/api/v1/reports/defect-summary', withScope(DEFAULT_PROJECT_ID));
    expect([200, 503]).toContain(resp.status);
    assertResponseMatches(spec, '/api/v1/reports/defect-summary', 'get', resp.status, resp.data);
  });
});
