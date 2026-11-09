const path = require('path');
const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { loadSpec, assertResponseMatches } = require('../../shared/test-utils/openApiContract');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
// WP-166 — AI is switched off for this deployment during the closed beta,
// so every route below answers 403 before reaching a provider. The suite
// skips LOUDLY rather than reporting red for a feature that is deliberately
// disabled. See shared/test-utils/aiDeploymentEnabled.js.
const { describeIfAiEnabled } = require('../../shared/test-utils/aiDeploymentEnabled');

// A real provider (not the mock) takes seconds per call; Jest's 5s default
// would fail a correct response on latency alone.
jest.setTimeout(60000);

// WP-062 (ADR-007) — see testRepoService/__tests__/contract.test.js for the
// harness. aiService has the largest route surface of the 8 covered
// services; this suite validates a representative slice (health, the
// GR-8 advisory envelope on /complete, and settings) rather than every
// one of its 12 operations — see EXECUTION_LOG.md's WP-062 report for the
// explicit scope statement.

const KONG_URL = process.env.TEST_KONG_URL || 'http://localhost:8000';
const DEFAULT_PROJECT_ID = 1;

const spec = loadSpec(path.join(__dirname, '../openapi.yaml'));
const withScope = (projectId) => ({ headers: { [PROJECT_ID_HEADER]: String(projectId) } });

describeIfAiEnabled('WP-062 contract')('aiService contract (WP-062, live, validated against openapi.yaml)', () => {
  let client;
  let anonClient;

  beforeAll(async () => {
    const adminToken = await getServiceToken();
    client = axios.create({ baseURL: KONG_URL, headers: { Authorization: `Bearer ${adminToken}` }, validateStatus: () => true });
    anonClient = axios.create({ baseURL: KONG_URL, validateStatus: () => true });
  });

  it('GET /api/v1/ai/health with no token: 401 at Kong', async () => {
    const resp = await anonClient.get('/api/v1/ai/health');
    expect(resp.status).toBe(401);
  });

  it('GET /api/v1/ai/health matches the documented {success,data:{provider,model,echo,latencyMs}} shape', async () => {
    const resp = await client.get('/api/v1/ai/health', withScope(DEFAULT_PROJECT_ID));
    expect(resp.status).toBe(200);
    assertResponseMatches(spec, '/api/v1/ai/health', 'get', 200, resp.data);
  });

  it('POST /api/v1/ai/complete matches the AdvisoryEnvelope shape (advisory:true, draftOnly:true — GR-8)', async () => {
    const resp = await client.post(
      '/api/v1/ai/complete',
      { messages: [{ role: 'user', content: 'WP-062 contract test ping' }], maxTokens: 512 },
      withScope(DEFAULT_PROJECT_ID)
    );
    expect(resp.status).toBe(200);
    assertResponseMatches(spec, '/api/v1/ai/complete', 'post', 200, resp.data);
    expect(resp.data.advisory).toBe(true);
    expect(resp.data.draftOnly).toBe(true);
  });

  it('POST /api/v1/ai/complete with no messages[]: 400 matching ErrorResponse', async () => {
    const resp = await client.post('/api/v1/ai/complete', {}, withScope(DEFAULT_PROJECT_ID));
    expect(resp.status).toBe(400);
    assertResponseMatches(spec, '/api/v1/ai/complete', 'post', 400, resp.data);
  });

  it('GET /api/v1/ai/settings matches the documented {success,data:{projectId,enabled}} shape', async () => {
    const resp = await client.get('/api/v1/ai/settings', withScope(DEFAULT_PROJECT_ID));
    expect(resp.status).toBe(200);
    assertResponseMatches(spec, '/api/v1/ai/settings', 'get', 200, resp.data);
  });
});
