const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');

// WP-025 — black-box HTTP regression suite for releaseService, same shape
// as defectService/testRepoService/requirementService's api.test.js (GR-6:
// functional assertions against the live container via Kong, never
// documenting broken behavior as expected).
//
// Every route requires requireProjectScope() from birth (WP-025 dispatch
// brief), so the authenticated blocks below always send X-Project-Id: 1
// (the seeded Default Project, WP-020 backfill) and ensure the test
// identity is a member of it first. See __tests__/tenantIsolation.test.js
// for the dedicated multi-tenancy suite and __tests__/gateStatus.test.js
// for the quality-gate evaluation acceptance suite.

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';
const USER_SERVICE_URL = process.env.TEST_USER_SERVICE_URL || 'http://localhost:8000';
const DUMMY_ID = '000000000000000000000000';
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

describe('releaseService API (live)', () => {
  describe('every route requires authentication', () => {
    const protectedRoutes = [
      ['get', '/api/v1/releases'],
      ['post', '/api/v1/releases'],
      ['get', `/api/v1/releases/${DUMMY_ID}`],
      ['put', `/api/v1/releases/${DUMMY_ID}`],
      ['delete', `/api/v1/releases/${DUMMY_ID}`],
      ['get', `/api/v1/releases/${DUMMY_ID}/gate-status`],
      ['post', `/api/v1/releases/${DUMMY_ID}/plans`],
      ['delete', `/api/v1/releases/${DUMMY_ID}/plans/${DUMMY_ID}`],
      ['get', '/api/v1/environments'],
      ['post', '/api/v1/environments'],
      ['get', `/api/v1/environments/${DUMMY_ID}`],
      ['put', `/api/v1/environments/${DUMMY_ID}`],
      ['delete', `/api/v1/environments/${DUMMY_ID}`]
    ];

    it.each(protectedRoutes)('%s %s rejects a request with no token', async (method, path) => {
      const resp = await anonClient.request({ method, url: path });
      expect(resp.status).not.toBeLessThan(400);
      expect(resp.status).not.toBe(404);
    });
  });

  describe('authenticated but no X-Project-Id header -> 403', () => {
    let client;
    beforeAll(async () => {
      const token = await getServiceToken();
      await ensureDefaultProjectMembership(token);
      client = axios.create({ baseURL: BASE_URL, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true });
    }, 15000);

    it('GET /api/v1/releases -> 403', async () => {
      const resp = await client.get('/api/v1/releases');
      expect(resp.status).toBe(403);
    });

    it('GET /api/v1/environments -> 403', async () => {
      const resp = await client.get('/api/v1/environments');
      expect(resp.status).toBe(403);
    });

    it('an unknown projectId -> 403', async () => {
      const resp = await client.get('/api/v1/releases', { headers: { [PROJECT_ID_HEADER]: '999999' } });
      expect(resp.status).toBe(403);
    });
  });

  describe('Release CRUD, authenticated + scoped', () => {
    let client;
    let createdId;

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
      if (createdId) {
        await client.delete(`/api/v1/releases/${createdId}`);
      }
    });

    it('GET /api/v1/releases returns the advancedResults envelope', async () => {
      const resp = await client.get('/api/v1/releases');
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);
      expect(Array.isArray(resp.data.data)).toBe(true);
      expect(resp.data.count).toBe(resp.data.data.length);
    });

    it('POST /api/v1/releases creates a release, stamping id/releaseId/projectId/createdBy server-side', async () => {
      const resp = await client.post('/api/v1/releases', {
        name: 'WP-025 regression test release',
        targetDate: '2026-12-01',
        notes: 'Created by releaseService/__tests__/api.test.js',
        // A client-supplied projectId must never win over the scoped header.
        projectId: 999999
      });
      expect(resp.status).toBe(201);
      expect(resp.data.success).toBe(true);
      expect(resp.data.data.releaseId).toMatch(/^REL-\d+$/);
      expect(resp.data.data.status).toBe('planned'); // schema default
      expect(resp.data.data.projectId).toBe(DEFAULT_PROJECT_ID);
      expect(resp.data.data.createdBy).toBeTruthy();
      createdId = resp.data.data._id;
    });

    it('GET /api/v1/releases/:id returns the created release', async () => {
      const resp = await client.get(`/api/v1/releases/${createdId}`);
      expect(resp.status).toBe(200);
      expect(resp.data.data._id).toBe(createdId);
      expect(resp.data.data.name).toBe('WP-025 regression test release');
    });

    it('PUT /api/v1/releases/:id updates status/notes', async () => {
      const resp = await client.put(`/api/v1/releases/${createdId}`, { status: 'in-progress', notes: 'updated' });
      expect(resp.status).toBe(200);
      expect(resp.data.data.status).toBe('in-progress');
      expect(resp.data.data.notes).toBe('updated');
    });

    it('rejects an invalid status value (schema enum)', async () => {
      const resp = await client.put(`/api/v1/releases/${createdId}`, { status: 'not-a-real-status' });
      expect(resp.status).toBe(400);
    });

    // WP-F24 Task 1 (fix round 1) -- the coordinator's own concern: adding
    // `dynamicFields` to fieldsService (moduleId-generic) never implied
    // Release itself could STORE a configured field's value, since
    // Release.js declared no such path and this controller's own
    // findOneAndUpdate runs against a strict schema (undeclared keys in
    // the update payload are dropped by Mongoose silently, no error). This
    // is the real round trip this task's own frontend unit tests (mocked
    // updateRelease) cannot prove on their own: write a `dynamicFields`
    // value through the live PUT route, then GET it back from a SEPARATE
    // request -- not just read the PUT response's echo -- to rule out the
    // response merely reflecting the request body without anything having
    // actually reached Mongo.
    it('PUT /api/v1/releases/:id persists dynamicFields, readable back from a separate GET', async () => {
      const putResp = await client.put(`/api/v1/releases/${createdId}`, {
        dynamicFields: { priority: 'High' }
      });
      expect(putResp.status).toBe(200);
      expect(putResp.data.data.dynamicFields).toEqual({ priority: 'High' });

      const getResp = await client.get(`/api/v1/releases/${createdId}`);
      expect(getResp.status).toBe(200);
      expect(getResp.data.data.dynamicFields).toEqual({ priority: 'High' });
    });

    it('POST /:id/plans links a TestPlan id, idempotently', async () => {
      const fakePlanId = '66f2e8911e414a16d1f204b3';
      const first = await client.post(`/api/v1/releases/${createdId}/plans`, { testPlanId: fakePlanId });
      expect(first.status).toBe(200);
      expect(first.data.data.linkedTestPlanIds).toContain(fakePlanId);

      const second = await client.post(`/api/v1/releases/${createdId}/plans`, { testPlanId: fakePlanId });
      expect(second.status).toBe(200);
      expect(second.data.data.linkedTestPlanIds.filter((id) => id === fakePlanId)).toHaveLength(1);

      const unlink = await client.delete(`/api/v1/releases/${createdId}/plans/${fakePlanId}`);
      expect(unlink.status).toBe(200);
      expect(unlink.data.data.linkedTestPlanIds).not.toContain(fakePlanId);
    });

    it('DELETE /api/v1/releases/:id removes the release (404 afterward, not a leaked read)', async () => {
      const resp = await client.delete(`/api/v1/releases/${createdId}`);
      expect(resp.status).toBe(200);

      const getResp = await client.get(`/api/v1/releases/${createdId}`);
      expect(getResp.status).toBe(404);
      createdId = null;
    });
  });

  describe('Environment CRUD, authenticated + scoped', () => {
    let client;
    let createdId;

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
      if (createdId) {
        await client.delete(`/api/v1/environments/${createdId}`);
      }
    });

    it('POST /api/v1/environments creates an environment', async () => {
      const resp = await client.post('/api/v1/environments', {
        name: 'WP-025 regression test environment',
        description: 'Created by releaseService/__tests__/api.test.js',
        url: 'https://staging.example.test'
      });
      expect(resp.status).toBe(201);
      expect(resp.data.data.projectId).toBe(DEFAULT_PROJECT_ID);
      expect(typeof resp.data.data.id).toBe('number');
      createdId = resp.data.data._id;
    });

    it('GET /api/v1/environments lists it', async () => {
      const resp = await client.get('/api/v1/environments');
      expect(resp.status).toBe(200);
      expect(resp.data.data.some((e) => e._id === createdId)).toBe(true);
    });

    it('PUT /api/v1/environments/:id updates it', async () => {
      const resp = await client.put(`/api/v1/environments/${createdId}`, { description: 'updated description' });
      expect(resp.status).toBe(200);
      expect(resp.data.data.description).toBe('updated description');
    });

    it('DELETE /api/v1/environments/:id removes it', async () => {
      const resp = await client.delete(`/api/v1/environments/${createdId}`);
      expect(resp.status).toBe(200);
      const getResp = await client.get(`/api/v1/environments/${createdId}`);
      expect(getResp.status).toBe(404);
      createdId = null;
    });
  });
});
