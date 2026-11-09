const axios = require('axios');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { createTestPersona } = require('../../shared/test-utils/keycloakTestPersona');
const { aiDeploymentState } = require('../../shared/test-utils/aiDeploymentEnabled');

// WP-166 — GET /api/v1/ai/availability, the capability probe.
//
// RUNS UNCONDITIONALLY, unlike this service's other live suites. That is the
// point of the endpoint: it answers in every state, including the state where
// AI is switched off, which is exactly when a frontend most needs an answer.
// A probe that only works when the feature works would be useless.
//
// WHAT IT GUARDS. Five frontend components (AiTestCaseDrawer,
// AiDuplicateCheckDrawer, AiSummaryPanel, AiDuplicateAuditPanel, AiLintPanel)
// render AI entry points with no availability check at all, so with AI
// disabled they appear and then fail on a 403. This endpoint is the signal
// that lets them stop offering it. Since a UI will branch on these exact
// fields, the shape is a contract and this suite is where it is pinned —
// renaming `reason` or dropping `actionableByProjectAdmin` breaks a consumer
// that cannot see this file.

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';
const PROJECT_ID = 1;
const SCOPE = { [PROJECT_ID_HEADER]: String(PROJECT_ID) };
const PATH = '/api/v1/ai/availability';

const VALID_REASONS = [null, 'deployment-disabled', 'project-disabled', 'window-expired'];

let client;
let anon;

beforeAll(async () => {
  const token = await getServiceToken();
  client = axios.create({
    baseURL: BASE_URL,
    headers: { Authorization: `Bearer ${token}`, ...SCOPE },
    validateStatus: () => true
  });
  anon = axios.create({ baseURL: BASE_URL, validateStatus: () => true });
}, 120000);

describe('WP-166: AI availability probe', () => {
  it('answers 200 with a verdict, NOT a 403, whatever the AI state', async () => {
    const resp = await client.get(PATH);
    // The design decision this pins. A 403 would be indistinguishable from an
    // authorisation failure at the client, forcing a frontend to guess whether
    // to hide the feature or show a sign-in error. The caller is asking a
    // question, not attempting the action.
    expect(resp.status).toBe(200);
    expect(resp.data.success).toBe(true);
  }, 60000);

  it('returns the contract the frontend branches on', async () => {
    const { data } = (await client.get(PATH)).data;
    expect(typeof data.available).toBe('boolean');
    expect(VALID_REASONS).toContain(data.reason);
    expect(typeof data.actionableByProjectAdmin).toBe('boolean');
    // `message` carries display text when unavailable and is null when fine,
    // so a UI never prints "null" into a tooltip.
    if (data.available) {
      expect(data.reason).toBeNull();
      expect(data.message).toBeNull();
    } else {
      expect(typeof data.message).toBe('string');
      expect(data.message.length).toBeGreaterThan(0);
    }
  }, 60000);

  it('agrees with the deployment switch the middleware reads', async () => {
    // Cross-checks the endpoint against the container's own env rather than
    // against itself. If these ever disagree, the probe is lying to the UI,
    // which is worse than no probe: entry points would be shown for a feature
    // that refuses, or hidden for one that works.
    const state = aiDeploymentState();
    const { data } = (await client.get(PATH)).data;
    if (!state.enabled) {
      expect(data.available).toBe(false);
      expect(data.reason).toBe('deployment-disabled');
      // A deployment-level refusal is NOT actionable by a project admin, and
      // that flag is what tells a UI to hide the control rather than disable
      // it with advice nobody can follow.
      expect(data.actionableByProjectAdmin).toBe(false);
      expect(data.message).toMatch(/cannot be enabled per project/i);
    } else {
      // AI is on for this deployment, so any refusal must be project-level.
      expect(data.reason).not.toBe('deployment-disabled');
    }
  }, 60000);

  it('distinguishes a deployment refusal from a project refusal', async () => {
    const { data } = (await client.get(PATH)).data;
    if (data.reason === 'deployment-disabled') {
      // Deliberately says nothing about project settings: an admin reading it
      // should stop looking for a toggle they cannot use.
      expect(data.message).not.toMatch(/project admin can enable/i);
    }
    if (data.reason === 'project-disabled') {
      expect(data.message).toMatch(/project admin/i);
      expect(data.actionableByProjectAdmin).toBe(true);
    }
  }, 60000);

  it('is rejected at the gateway without a token', async () => {
    // Not public. Whether a tool is switched on is not secret from the people
    // who would use it, but it is not anonymous either.
    expect((await anon.get(PATH)).status).toBe(401);
  }, 60000);

  it('refuses a caller who is not a member of the project', async () => {
    const outsider = await createTestPersona('wp166-outsider');
    try {
      const oc = axios.create({
        baseURL: BASE_URL,
        headers: { Authorization: `Bearer ${await outsider.getToken()}`, ...SCOPE },
        validateStatus: () => true
      });
      // requireProjectScope/authorize still apply — only checkProjectEnabled
      // was deliberately left off this route.
      expect((await oc.get(PATH)).status).toBe(403);
    } finally {
      await outsider.cleanup();
    }
  }, 150000);

  it('requires a project scope header', async () => {
    const noScope = axios.create({
      baseURL: BASE_URL,
      headers: { Authorization: `Bearer ${await getServiceToken()}` },
      validateStatus: () => true
    });
    expect((await noScope.get(PATH)).status).toBe(403);
  }, 60000);
});
