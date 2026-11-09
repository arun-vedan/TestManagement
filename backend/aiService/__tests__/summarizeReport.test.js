const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
// WP-166 — AI is switched off for this deployment during the closed beta,
// so every route below answers 403 before reaching a provider. The suite
// skips LOUDLY rather than reporting red for a feature that is deliberately
// disabled. See shared/test-utils/aiDeploymentEnabled.js.
const { describeIfAiEnabled } = require('../../shared/test-utils/aiDeploymentEnabled');

// WP-053 -- POST /api/v1/ai/summarize-report (black-box, GR-6). Same
// container topology as __tests__/generateTestCases.test.js: aiService is
// reached through Kong (its own real route matters, WP-050), the services
// this feature reads from (reportingService) or that seed real data for it
// (releaseService, defectService) are reached directly.
//
// THE POINT OF THIS SUITE: prove the endpoint (a) is gated by every one of
// WP-050's four failure modes, (b) produces a grounded narrative over REAL
// seeded data (not a hand-built fixture), (c) propagates staleness/
// provenance from reportingService, (d) never persists anything, and (e)
// regenerating after a real data change produces an updated narrative.
//
// THE HALLUCINATION-FIXTURE PROOF ITSELF lives in
// __tests__/groundingCheck.test.js, not here -- deliberately. This route
// takes NO free-text field from its caller (scope is an enum, releaseId/
// planId are looked up against real reportingService data, days is a
// number) -- unlike WP-051/052's endpoints, there is no user-controlled
// channel through which a live HTTP caller could embed
// FORCE_HALLUCINATION_TOKEN into the model's prompt. That is a deliberate,
// stated security property of this endpoint (no prompt-injection surface
// at all), not a gap papered over: the mock provider + groundingCheck.js
// integration is exercised directly there, using the exact same code this
// controller calls.

const KONG_URL = process.env.TEST_KONG_URL || 'http://localhost:8000';
const USER_SERVICE_URL = process.env.TEST_USER_SERVICE_URL || 'http://localhost:3001';
const RELEASE_URL = process.env.TEST_RELEASE_URL || 'http://localhost:3018';
const DEFECT_URL = process.env.TEST_DEFECT_URL || 'http://localhost:3014';
const REPORTING_URL = process.env.TEST_REPORTING_URL || 'http://localhost:3020';

const DEFAULT_PROJECT_ID = 1;
const PROJECT_SCOPE_HEADERS = { [PROJECT_ID_HEADER]: String(DEFAULT_PROJECT_ID) };
const runId = Date.now();

function decodeJwtPayload(token) {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

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

describeIfAiEnabled('WP-053')('POST /api/v1/ai/summarize-report (WP-053)', () => {
  let token;
  let aiClient; // Kong, X-Project-Id: 1
  let releaseClient; // direct
  let defectClient; // direct
  let reportingClient; // direct

  const createdReleaseIds = []; // Mongo _id
  const createdDefectIds = []; // Mongo _id

  beforeAll(async () => {
    token = await getServiceToken();
    await ensureDefaultProjectMembership(token);

    aiClient = axios.create({
      baseURL: KONG_URL,
      headers: { Authorization: `Bearer ${token}`, ...PROJECT_SCOPE_HEADERS },
      validateStatus: () => true
    });
    releaseClient = axios.create({
      baseURL: RELEASE_URL,
      headers: { Authorization: `Bearer ${token}`, ...PROJECT_SCOPE_HEADERS },
      validateStatus: () => true
    });
    defectClient = axios.create({
      baseURL: DEFECT_URL,
      headers: { Authorization: `Bearer ${token}`, ...PROJECT_SCOPE_HEADERS },
      validateStatus: () => true
    });
    reportingClient = axios.create({
      baseURL: REPORTING_URL,
      headers: { Authorization: `Bearer ${token}`, ...PROJECT_SCOPE_HEADERS },
      validateStatus: () => true
    });

    // Make sure AI is enabled for the Default Project -- a prior failed run
    // could have left it disabled (same guard as __tests__/api.test.js /
    // generateTestCases.test.js).
    await aiClient.put('/api/v1/ai/settings', { enabled: true });
  }, 20000);

  afterAll(async () => {
    for (const id of createdDefectIds) {
      // eslint-disable-next-line no-await-in-loop
      await defectClient.delete(`/api/v1/defects/${id}`).catch(() => {});
    }
    for (const id of createdReleaseIds) {
      // eslint-disable-next-line no-await-in-loop
      await releaseClient.delete(`/api/v1/releases/${id}`).catch(() => {});
    }
    // Leave reportingService's cache correct for whatever runs next.
    await reportingClient.post('/api/v1/reports/refresh').catch(() => {});
  });

  async function createRelease(name) {
    const resp = await releaseClient.post('/api/v1/releases', { name });
    expect(resp.status).toBe(201);
    createdReleaseIds.push(resp.data.data._id);
    return resp.data.data;
  }

  async function createDefect(summary, severity) {
    const resp = await defectClient.post('/api/v1/defects', { summary, Severity: severity });
    expect(resp.status).toBe(201);
    createdDefectIds.push(resp.data.data._id);
    return resp.data.data;
  }

  async function refreshReports() {
    const resp = await reportingClient.post('/api/v1/reports/refresh');
    expect([200, 207]).toContain(resp.status);
  }

  describe('auth/scope failure modes (WP-050\'s four, GR-1)', () => {
    it('no token -> 401 (Kong)', async () => {
      const anon = axios.create({ baseURL: KONG_URL, validateStatus: () => true });
      const resp = await anon.post('/api/v1/ai/summarize-report', { scope: 'release' });
      expect(resp.status).toBe(401);
    });

    it('authenticated but no X-Project-Id -> 403', async () => {
      const noScope = axios.create({ baseURL: KONG_URL, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true });
      const resp = await noScope.post('/api/v1/ai/summarize-report', { scope: 'release' });
      expect(resp.status).toBe(403);
    });

    it('AI disabled for this project -> 403, distinguishable from unauthorised', async () => {
      const off = await aiClient.put('/api/v1/ai/settings', { enabled: false });
      expect(off.status).toBe(200);
      try {
        const resp = await aiClient.post('/api/v1/ai/summarize-report', { scope: 'release' });
        expect(resp.status).toBe(403);
        expect(resp.data.error).toMatch(/AI feature is disabled/i);
      } finally {
        await aiClient.put('/api/v1/ai/settings', { enabled: true });
      }
    });
  });

  describe('input validation', () => {
    it('missing scope -> 400', async () => {
      const resp = await aiClient.post('/api/v1/ai/summarize-report', {});
      expect(resp.status).toBe(400);
      expect(resp.data.error).toMatch(/scope/i);
    });

    it('unsupported scope -> 400', async () => {
      const resp = await aiClient.post('/api/v1/ai/summarize-report', { scope: 'quarter' });
      expect(resp.status).toBe(400);
    });

    it('unknown releaseId -> 404', async () => {
      const resp = await aiClient.post('/api/v1/ai/summarize-report', { scope: 'release', releaseId: 'REL-does-not-exist-999' });
      expect(resp.status).toBe(404);
    });

    it('unknown planId -> 404', async () => {
      const resp = await aiClient.post('/api/v1/ai/summarize-report', { scope: 'plan', planId: 'PLN-does-not-exist-999' });
      expect(resp.status).toBe(404);
    });
  });

  describe('scope=release over real seeded data', () => {
    let release;
    let initialDefectTotal;

    beforeAll(async () => {
      release = await createRelease(`WP-053 summary release ${runId}`);
      await createDefect(`WP-053 seed defect A ${runId}`, 'Major');
      await refreshReports();
      const before = await reportingClient.get('/api/v1/reports/defect-summary');
      initialDefectTotal = before.data.data.total;
    }, 20000);

    it('references only real figures -- the post-check reports grounded:true, labelled AI-generated with a timestamp', async () => {
      const resp = await aiClient.post('/api/v1/ai/summarize-report', { scope: 'release', releaseId: release.releaseId });
      expect(resp.status).toBe(200);
      const { data } = resp.data;

      expect(resp.data.advisory).toBe(true);
      expect(resp.data.draftOnly).toBe(true);
      expect(data.generatedBy).toBe('ai');
      expect(typeof data.generatedAt).toBe('string');
      expect(new Date(data.generatedAt).toString()).not.toBe('Invalid Date');
      // Fresh timestamp -- generated just now, not cached/reused.
      expect(Date.now() - new Date(data.generatedAt).getTime()).toBeLessThan(15000);

      expect(data.releaseId).toBe(release.releaseId);
      expect(data.markdown).toMatch(/## What changed/);
      expect(data.markdown).toContain(release.releaseId);
      expect(data.markdown).toMatch(new RegExp(String(initialDefectTotal)));

      // THE post-check result, surfaced structurally -- acceptance:
      // "summary of a seeded release references only real figures
      // (post-check test green)".
      expect(data.grounding).toBeDefined();
      expect(data.grounding.grounded).toBe(true);
      expect(data.grounding.ungroundedFigures).toEqual([]);
      expect(data.markdown).not.toMatch(/UNVERIFIED FIGURE/);

      expect(data.stale).toBe(false);
      expect(Array.isArray(data.sourceReports)).toBe(true);
      expect(data.sourceReports.length).toBeGreaterThan(0);
      data.sourceReports.forEach((s) => {
        expect(typeof s.computedAt).toBe('string');
        expect(typeof s.stale).toBe('boolean');
      });
    });

    it('regenerate after a real data change produces an updated narrative (a new defect changes the cited total)', async () => {
      const first = await aiClient.post('/api/v1/ai/summarize-report', { scope: 'release', releaseId: release.releaseId });
      expect(first.status).toBe(200);
      const firstMarkdown = first.data.data.markdown;
      expect(firstMarkdown).toMatch(new RegExp(String(initialDefectTotal)));

      await createDefect(`WP-053 seed defect B ${runId}`, 'Minor');
      await refreshReports();

      const second = await aiClient.post('/api/v1/ai/summarize-report', { scope: 'release', releaseId: release.releaseId });
      expect(second.status).toBe(200);
      const secondData = second.data.data;

      expect(secondData.markdown).not.toBe(firstMarkdown);
      expect(secondData.markdown).toMatch(new RegExp(String(initialDefectTotal + 1)));
      expect(secondData.grounding.grounded).toBe(true);
      // A fresh generatedAt every call, never cached/reused.
      expect(secondData.generatedAt).not.toBe(first.data.data.generatedAt);
    }, 20000);

    it('mutates nothing (GR-8) -- the release and defect totals are unchanged by generating a summary', async () => {
      const beforeResp = await reportingClient.get('/api/v1/reports/defect-summary');
      const beforeTotal = beforeResp.data.data.total;

      await aiClient.post('/api/v1/ai/summarize-report', { scope: 'release', releaseId: release.releaseId });
      await aiClient.post('/api/v1/ai/summarize-report', { scope: 'release', releaseId: release.releaseId });

      const afterResp = await releaseClient.get(`/api/v1/releases/${release._id}`);
      expect(afterResp.data.data.name).toBe(release.name);
      const afterDefects = await reportingClient.get('/api/v1/reports/defect-summary');
      expect(afterDefects.data.data.total).toBe(beforeTotal);
    });
  });

  describe('scope=plan and scope=timerange smoke (both grounded)', () => {
    it('scope=plan returns a 200 grounded summary (or an honest "no plans" narrative if none tracked)', async () => {
      const resp = await aiClient.post('/api/v1/ai/summarize-report', { scope: 'plan' });
      expect(resp.status).toBe(200);
      expect(resp.data.data.grounding.grounded).toBe(true);
      expect(resp.data.data.markdown).toMatch(/## What changed/);
    });

    it('scope=timerange (custom days) returns a 200 grounded summary', async () => {
      const resp = await aiClient.post('/api/v1/ai/summarize-report', { scope: 'timerange', days: 7 });
      expect(resp.status).toBe(200);
      expect(resp.data.data.days).toBe(7);
      expect(resp.data.data.grounding.grounded).toBe(true);
    });
  });
});
