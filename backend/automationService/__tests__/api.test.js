const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');

// Black-box HTTP tests against the running service (WP-012 service-core
// rollout). Container: automationservice, Kong route: /api/v1/automation.

// WP-117: every route now mounts requireProjectScope(), so an authenticated
// request without X-Project-Id is a 403. This suite exercises the Default
// Project. Same adjustment WP-021 and WP-111..116 each made.
const SCOPE = { [PROJECT_ID_HEADER]: '1' };

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';
const DUMMY_ID = '000000000000000000000000';

const client = axios.create({
  baseURL: BASE_URL,
  validateStatus: () => true
});

describe('automationService API (live)', () => {
  describe('protected routes require authentication', () => {
    const protectedRoutes = [
      ['get', '/api/v1/automation'],
      ['post', '/api/v1/automation'],
      ['get', `/api/v1/automation/${DUMMY_ID}`],
      ['put', `/api/v1/automation/${DUMMY_ID}`],
      ['delete', `/api/v1/automation/${DUMMY_ID}`]
    ];

    it.each(protectedRoutes)('%s %s rejects a request with no token', async (method, path) => {
      const resp = await client.request({ method, url: path });
      expect(resp.status).not.toBeLessThan(400);
      expect(resp.status).not.toBe(404);
    });
  });

  // WP-117 CHANGED THIS, and the reasoning matters because it overrides an
  // earlier decision.
  //
  // WP-012's report recorded this route as a "deviation found and preserved":
  // not keycloak-gated, "predates this migration, unrelated to service-core —
  // left exactly as found, covered by a new functional test instead of 'fixed'
  // into requiring auth." That was a SCOPE decision (not ours to change), not
  // a finding that anonymous access was needed. No rationale for anonymity was
  // ever given.
  //
  // WP-117 gates it, on evidence:
  //   - getStepDef returns the CONTENTS of every file under
  //     ./automationFramework/src/steps, so it is source disclosure.
  //   - Kong rejected it from outside (401), but hitting the service directly
  //     returned HTTP 200 with the source — verified both ways. The gateway
  //     was the only thing in front of it, while every sibling route also
  //     defended itself.
  //   - The ONLY consumer in the repo is frontend/src/api/apiCalls.tsx:131,
  //     which calls it through axiosPrivate — so it already sent a bearer
  //     token and, via that interceptor, X-Project-Id. Gating breaks no
  //     caller. Kong's `config.anonymous` pass-through covers only
  //     /testexecution/ingest (WP-032/033), never this path.
  //
  // The assertions below are inverted from WP-012's accordingly.
  describe('getstepdef (WP-117: now authenticated and scoped)', () => {
    it('rejects an unauthenticated request', async () => {
      const resp = await client.get('/api/v1/automation/getstepdef');
      expect(resp.status).not.toBe(200);
      expect(resp.status).toBeGreaterThanOrEqual(400);
    });

    it('lists the automation framework step definition files with content, for a scoped caller', async () => {
      const token = await getServiceToken();
      const resp = await client.get('/api/v1/automation/getstepdef', {
        headers: { Authorization: `Bearer ${token}`, ...SCOPE }
      });
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);
      expect(Array.isArray(resp.data.data)).toBe(true);
      expect(resp.data.data.length).toBeGreaterThan(0);
      for (const entry of resp.data.data) {
        expect(entry).toHaveProperty('uri');
        expect(entry).toHaveProperty('content');
      }
    });
  });

  describe('authenticated CRUD flow', () => {
    let token;
    let createdId;

    beforeAll(async () => {
      token = await getServiceToken();
    });

    afterAll(async () => {
      if (createdId) {
        await client.delete(`/api/v1/automation/${createdId}`, {
          headers: { Authorization: `Bearer ${token}`, ...SCOPE }
        });
      }
    });

    it('creates an automation record, auto-assigning id/version', async () => {
      const TestCaseId = `TC-${Date.now()}`;
      const resp = await client.post(
        '/api/v1/automation',
        { TestCaseId, automationScript: "console.log('hello')" },
        { headers: { Authorization: `Bearer ${token}`, ...SCOPE } }
      );
      expect(resp.status).toBe(201);
      expect(resp.data.success).toBe(true);
      expect(resp.data.data).toHaveProperty('_id');
      expect(resp.data.data.TestCaseId).toBe(TestCaseId);
      expect(resp.data.data.version).toBe(1);
      createdId = resp.data.data._id;
    });

    it('lists records, filterable down to the one just created', async () => {
      const resp = await client.get(`/api/v1/automation?_id=${createdId}`, {
        headers: { Authorization: `Bearer ${token}`, ...SCOPE }
      });
      expect(resp.status).toBe(200);
      expect(resp.data.data).toHaveLength(1);
      expect(resp.data.data[0]._id).toBe(createdId);
    });

    it('fetches a single record by id', async () => {
      const resp = await client.get(`/api/v1/automation/${createdId}`, {
        headers: { Authorization: `Bearer ${token}`, ...SCOPE }
      });
      expect(resp.status).toBe(200);
      expect(resp.data.data._id).toBe(createdId);
    });

    it('updates a record', async () => {
      const resp = await client.put(
        `/api/v1/automation/${createdId}`,
        { automationScript: "console.log('updated')" },
        { headers: { Authorization: `Bearer ${token}`, ...SCOPE } }
      );
      expect(resp.status).toBe(200);
      expect(resp.data.data.automationScript).toBe("console.log('updated')");
    });

    it('deletes a record', async () => {
      const resp = await client.delete(`/api/v1/automation/${createdId}`, {
        headers: { Authorization: `Bearer ${token}`, ...SCOPE }
      });
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);

      const getResp = await client.get(`/api/v1/automation/${createdId}`, {
        headers: { Authorization: `Bearer ${token}`, ...SCOPE }
      });
      expect(getResp.data.data).toBeNull();
      createdId = null;
    });
  });
});
