const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
// WP-166 — AI is switched off for this deployment during the closed beta,
// so every route below answers 403 before reaching a provider. The suite
// skips LOUDLY rather than reporting red for a feature that is deliberately
// disabled. See shared/test-utils/aiDeploymentEnabled.js.
const { describeIfAiEnabled } = require('../../shared/test-utils/aiDeploymentEnabled');

// WP-050 — black-box HTTP suite for aiService, same shape as
// releaseService/reportingService's api.test.js (GR-6: functional
// assertions against the live container via Kong, never documenting broken
// behavior as expected).
//
// This suite runs against whatever AI_PROVIDER the live aiservice
// container is configured with -- in this environment that is 'mock'
// (docker-compose.yml's default), so every assertion below is written
// against mockProvider.js's documented, deterministic output shape (see
// that file). GR-6's "tests must mock the provider, no live-API dependency
// in CI" is satisfied structurally: there is no code path here or in the
// running container that reaches a real vendor -- see
// __tests__/openaiProvider.test.js for the one place a real HTTP call
// shape IS exercised, against a local stubbed server, never a live vendor.
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';
const USER_SERVICE_URL = process.env.TEST_USER_SERVICE_URL || 'http://localhost:3001';
const DEFAULT_PROJECT_ID = 1;
const PROJECT_SCOPE_HEADERS = { [PROJECT_ID_HEADER]: String(DEFAULT_PROJECT_ID) };

function decodeJwtPayload(token) {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

const anonClient = axios.create({ baseURL: BASE_URL, validateStatus: () => true });

async function ensureDefaultProjectMembership(token) {
  const sub = decodeJwtPayload(token).sub;
  const userServiceClient = axios.create({
    baseURL: USER_SERVICE_URL,
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true
  });
  const listResp = await userServiceClient.get('/api/v1/projects');
  const defaultProject = listResp.data.data.find((p) => p.id === DEFAULT_PROJECT_ID);
  if (!defaultProject) {
    throw new Error(`Default Project (id=${DEFAULT_PROJECT_ID}) not found -- WP-020 backfill precondition unmet`);
  }
  await userServiceClient.post(`/api/v1/projects/${defaultProject._id}/members`, { userId: sub, role: 'admin' });
}

describeIfAiEnabled('aiService API (live)')('aiService API (live)', () => {
  describe('every route requires authentication', () => {
    // WP-023: an unauthenticated request is rejected AT KONG with 401
    // (jwt plugin, before ever reaching this service) -- not 403. See
    // aiRoute in srckube-kong/kong.yml.
    const protectedRoutes = [
      ['get', '/api/v1/ai/health'],
      ['post', '/api/v1/ai/complete'],
      ['post', '/api/v1/ai/structured'],
      ['get', '/api/v1/ai/interactions'],
      ['get', '/api/v1/ai/settings'],
      ['put', '/api/v1/ai/settings']
    ];

    it.each(protectedRoutes)('%s %s -> 401 with no token', async (method, path) => {
      const resp = await anonClient.request({ method, url: path });
      expect(resp.status).toBe(401);
    });
  });

  describe('authenticated but no X-Project-Id header -> 403', () => {
    let client;
    beforeAll(async () => {
      const token = await getServiceToken();
      await ensureDefaultProjectMembership(token);
      client = axios.create({ baseURL: BASE_URL, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true });
    }, 15000);

    it('GET /api/v1/ai/health -> 403', async () => {
      const resp = await client.get('/api/v1/ai/health');
      expect(resp.status).toBe(403);
    });

    it('an unknown projectId -> 403', async () => {
      const resp = await client.get('/api/v1/ai/health', { headers: { [PROJECT_ID_HEADER]: '999999' } });
      expect(resp.status).toBe(403);
    });
  });

  describe('AI round-trip through the configured (mock) provider', () => {
    let client;

    beforeAll(async () => {
      const token = await getServiceToken();
      await ensureDefaultProjectMembership(token);
      client = axios.create({
        baseURL: BASE_URL,
        headers: { Authorization: `Bearer ${token}`, ...PROJECT_SCOPE_HEADERS },
        validateStatus: () => true
      });
      // Make sure the project is enabled before this block's assertions --
      // a prior failed run in the same environment could have left it
      // disabled (see the dedicated disable/re-enable block below, which
      // always restores it in its own afterAll, but this guards against
      // that afterAll not having run).
      await client.put('/api/v1/ai/settings', { enabled: true });
    }, 15000);

    it('GET /api/v1/ai/health round-trips through the provider', async () => {
      const resp = await client.get('/api/v1/ai/health');
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);
      expect(resp.data.data.provider).toBe('mock');
      expect(resp.data.data.model).toBe('mock-echo-1');
      expect(resp.data.data.echo).toEqual(expect.stringContaining('ping'));
      expect(typeof resp.data.data.latencyMs).toBe('number');
    });

    it('POST /api/v1/ai/complete returns an advisory, draft-only completion', async () => {
      const resp = await client.post('/api/v1/ai/complete', {
        system: 'You are a helpful assistant.',
        messages: [{ role: 'user', content: 'Suggest a test case title for a login form.' }]
      });
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);
      expect(resp.data.advisory).toBe(true);
      expect(resp.data.draftOnly).toBe(true);
      expect(resp.data.data.text).toEqual(expect.stringContaining('Suggest a test case title'));
      expect(resp.data.data.model).toBe('mock-echo-1');
      expect(resp.data.data.usage.totalTokens).toBeGreaterThan(0);
    });

    it('rejects /complete with no messages', async () => {
      const resp = await client.post('/api/v1/ai/complete', {});
      expect(resp.status).toBe(400);
    });

    it('POST /api/v1/ai/structured returns deterministic structured output matching the schema shape', async () => {
      const schema = {
        type: 'object',
        properties: {
          title: { type: 'string' },
          priority: { type: 'number' },
          automatable: { type: 'boolean' }
        }
      };
      const resp = await client.post('/api/v1/ai/structured', {
        messages: [{ role: 'user', content: 'Draft a test case.' }],
        schema
      });
      expect(resp.status).toBe(200);
      expect(resp.data.advisory).toBe(true);
      expect(resp.data.draftOnly).toBe(true);
      expect(resp.data.data.result).toEqual({
        title: 'mock-title',
        priority: 0,
        automatable: true
      });
    });

    it('rejects /structured with no schema', async () => {
      const resp = await client.post('/api/v1/ai/structured', { messages: [{ role: 'user', content: 'hi' }] });
      expect(resp.status).toBe(400);
    });

    it('logs an AiInteraction per call, without storing full prompt text by default', async () => {
      const uniquePrompt = `WP-050 logging probe ${Date.now()}`;
      const completeResp = await client.post('/api/v1/ai/complete', {
        messages: [{ role: 'user', content: uniquePrompt }]
      });
      expect(completeResp.status).toBe(200);

      const listResp = await client.get('/api/v1/ai/interactions?limit=10');
      expect(listResp.status).toBe(200);
      const match = listResp.data.data.find((i) => i.promptPreview && i.promptPreview.includes(uniquePrompt));
      expect(match).toBeTruthy();
      expect(match.feature).toBe('complete');
      expect(match.provider).toBe('mock');
      expect(match.status).toBe('ok');
      expect(match.promptHash).toEqual(expect.any(String));
      // AI_STORE_FULL_TEXT defaults to false -- the full text field must
      // never be present on the wire.
      expect(match.promptFull).toBeUndefined();
      expect(typeof match.latencyMs).toBe('number');
    });
  });

  describe('per-project enable/disable -> 403 feature-disabled, distinguishable from other failures', () => {
    let client;

    beforeAll(async () => {
      const token = await getServiceToken();
      await ensureDefaultProjectMembership(token);
      client = axios.create({
        baseURL: BASE_URL,
        headers: { Authorization: `Bearer ${token}`, ...PROJECT_SCOPE_HEADERS },
        validateStatus: () => true
      });
    }, 15000);

    afterAll(async () => {
      // Always restore the shared Default Project to enabled -- other
      // suites in this run (and future runs) depend on AI being usable
      // there. Fixture-cleanup discipline per the environment hazard notes.
      if (client) {
        await client.put('/api/v1/ai/settings', { enabled: true });
      }
    });

    it('GET /settings defaults to enabled:true with no document yet', async () => {
      const resp = await client.get('/api/v1/ai/settings');
      expect(resp.status).toBe(200);
      expect(resp.data.data.projectId).toBe(DEFAULT_PROJECT_ID);
      expect(typeof resp.data.data.enabled).toBe('boolean');
    });

    it('PUT /settings {enabled:false} then GET /health -> 403 feature-disabled (not 401/503)', async () => {
      const putResp = await client.put('/api/v1/ai/settings', { enabled: false });
      expect(putResp.status).toBe(200);
      expect(putResp.data.data.enabled).toBe(false);

      const healthResp = await client.get('/api/v1/ai/health');
      expect(healthResp.status).toBe(403);
      expect(healthResp.data.error).toMatch(/AI feature is disabled/i);

      const completeResp = await client.post('/api/v1/ai/complete', {
        messages: [{ role: 'user', content: 'should be blocked' }]
      });
      expect(completeResp.status).toBe(403);
      expect(completeResp.data.error).toMatch(/AI feature is disabled/i);
    });

    it('re-enabling restores normal service', async () => {
      const putResp = await client.put('/api/v1/ai/settings', { enabled: true });
      expect(putResp.status).toBe(200);

      const healthResp = await client.get('/api/v1/ai/health');
      expect(healthResp.status).toBe(200);
    });
  });
});
