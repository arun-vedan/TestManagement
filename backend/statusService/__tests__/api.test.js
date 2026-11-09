const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');

// Black-box HTTP tests against the running service (WP-012 service-core
// rollout). Container: istatusservice, Kong route: /api/v1/issuestatus.

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';
const DUMMY_ID = '000000000000000000000000';

// WP-116: every statusService route now mounts requireProjectScope(), so an
// authenticated request without X-Project-Id is a 403. This suite exercises the
// Default Project's status vocabulary.
const SCOPE = { [PROJECT_ID_HEADER]: '1' };

const client = axios.create({
  baseURL: BASE_URL,
  validateStatus: () => true
});

describe('statusService API (live)', () => {
  describe('every route requires authentication', () => {
    const protectedRoutes = [
      ['get', '/api/v1/issuestatus'],
      ['post', '/api/v1/issuestatus'],
      ['get', `/api/v1/issuestatus/${DUMMY_ID}`],
      ['put', `/api/v1/issuestatus/${DUMMY_ID}`],
      ['delete', `/api/v1/issuestatus/${DUMMY_ID}`]
    ];

    it.each(protectedRoutes)('%s %s rejects a request with no token', async (method, path) => {
      const resp = await client.request({ method, url: path });
      expect(resp.status).not.toBeLessThan(400);
      expect(resp.status).not.toBe(404);
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
        await client.delete(`/api/v1/issuestatus/${createdId}`, {
          headers: { Authorization: `Bearer ${token}`, ...SCOPE }
        });
      }
    });

    it('creates an issue status and returns it', async () => {
      const istatus = `test-status-${Date.now()}`;
      const resp = await client.post(
        '/api/v1/issuestatus',
        { istatus },
        { headers: { Authorization: `Bearer ${token}`, ...SCOPE } }
      );
      expect(resp.status).toBe(201);
      expect(resp.data.success).toBe(true);
      expect(resp.data.data).toHaveProperty('_id');
      expect(resp.data.data.istatus).toBe(istatus);
      createdId = resp.data.data._id;
    });

    it('lists issue statuses, filterable down to the one just created', async () => {
      const resp = await client.get(`/api/v1/issuestatus?_id=${createdId}`, {
        headers: { Authorization: `Bearer ${token}`, ...SCOPE }
      });
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);
      expect(Array.isArray(resp.data.data)).toBe(true);
      expect(resp.data.data).toHaveLength(1);
      expect(resp.data.data[0]._id).toBe(createdId);
    });

    it('fetches a single issue status by id', async () => {
      const resp = await client.get(`/api/v1/issuestatus/${createdId}`, {
        headers: { Authorization: `Bearer ${token}`, ...SCOPE }
      });
      expect(resp.status).toBe(200);
      expect(resp.data.data._id).toBe(createdId);
    });

    it('updates an issue status', async () => {
      const updatedIstatus = `updated-status-${Date.now()}`;
      const resp = await client.put(
        `/api/v1/issuestatus/${createdId}`,
        { istatus: updatedIstatus },
        { headers: { Authorization: `Bearer ${token}`, ...SCOPE } }
      );
      expect(resp.status).toBe(200);
      expect(resp.data.data.istatus).toBe(updatedIstatus);
    });

    it('deletes an issue status', async () => {
      const resp = await client.delete(`/api/v1/issuestatus/${createdId}`, {
        headers: { Authorization: `Bearer ${token}`, ...SCOPE }
      });
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);

      const getResp = await client.get(`/api/v1/issuestatus/${createdId}`, {
        headers: { Authorization: `Bearer ${token}`, ...SCOPE }
      });
      expect(getResp.data.data).toBeNull();
      createdId = null;
    });
  });

  // WP-116 follow-up — the seed endpoint that gives a new project a usable
  // defect workflow. WP-116 made the vocabulary per-project, which left a new
  // project unable to transition a defect at all; this is the repair, and
  // userService's createProject calls it automatically.
  describe('POST /seed — default defect workflow', () => {
    let token;
    beforeAll(async () => {
      token = await getServiceToken();
    });

    it('is idempotent: a project that already has statuses is left untouched', async () => {
      // Project 1 has the 8-status workflow, so this must report seeded:false
      // rather than topping it up or duplicating it.
      const before = await client.get('/api/v1/issuestatus?limit=1000', {
        headers: { Authorization: `Bearer ${token}`, ...SCOPE }
      });
      const countBefore = before.data.data.length;

      const resp = await client.post('/api/v1/issuestatus/seed', {}, {
        headers: { Authorization: `Bearer ${token}`, ...SCOPE }
      });
      expect(resp.status).toBe(200);
      expect(resp.data.seeded).toBe(false);
      expect(String(resp.data.reason)).toMatch(/already has/i);

      const after = await client.get('/api/v1/issuestatus?limit=1000', {
        headers: { Authorization: `Bearer ${token}`, ...SCOPE }
      });
      expect(after.data.data.length).toBe(countBefore);
    });

    it('requires a project scope', async () => {
      const resp = await client.post('/api/v1/issuestatus/seed', {}, {
        headers: { Authorization: `Bearer ${token}` }
      });
      expect(resp.status).toBe(403);
    });

    it('requires authentication', async () => {
      const resp = await client.post('/api/v1/issuestatus/seed', {}, { headers: { ...SCOPE } });
      expect(resp.status).not.toBe(200);
      expect(resp.status).toBeGreaterThanOrEqual(400);
    });

    it('is not swallowed by the /:id route (path precedence)', async () => {
      // "seed" must not be captured as an :id and looked up as a Mongo _id.
      const resp = await client.post('/api/v1/issuestatus/seed', {}, {
        headers: { Authorization: `Bearer ${token}`, ...SCOPE }
      });
      // A 200/201 proves it reached the seed handler; a CastError 400/500 would
      // mean it was parsed as an id.
      expect([200, 201]).toContain(resp.status);
    });
  });
});
