const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');

// Black-box HTTP tests against the running service (WP-012 service-core
// rollout). Container: objectrepo, Kong route: /api/v1/objectrepo.

// WP-118: every route now mounts requireProjectScope(), so an authenticated
// request without X-Project-Id is a 403. This suite exercises the Default
// Project. Same adjustment WP-021 and WP-111..116 each made.
const SCOPE = { [PROJECT_ID_HEADER]: '1' };

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';
const DUMMY_ID = '000000000000000000000000';

const client = axios.create({
  baseURL: BASE_URL,
  validateStatus: () => true
});

describe('objectRepo API (live)', () => {
  describe('every route requires authentication', () => {
    const protectedRoutes = [
      ['get', '/api/v1/objectrepo'],
      ['post', '/api/v1/objectrepo'],
      ['get', `/api/v1/objectrepo/${DUMMY_ID}`],
      ['put', `/api/v1/objectrepo/${DUMMY_ID}`],
      ['delete', `/api/v1/objectrepo/${DUMMY_ID}`]
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
        await client.delete(`/api/v1/objectrepo/${createdId}`, {
          headers: { Authorization: `Bearer ${token}`, ...SCOPE }
        });
      }
    });

    it('creates an object repo entry and returns it, auto-assigning objectId/version', async () => {
      const objectName = `test_object_${Date.now()}`;
      const resp = await client.post(
        '/api/v1/objectrepo',
        { objectName, primaryProperty: 'id', secondaryProperty: 'name' },
        { headers: { Authorization: `Bearer ${token}`, ...SCOPE } }
      );
      expect(resp.status).toBe(201);
      expect(resp.data.success).toBe(true);
      expect(resp.data.data).toHaveProperty('_id');
      expect(resp.data.data.objectName).toBe(objectName);
      expect(resp.data.data.objectId).toMatch(/^OBJ-\d+$/);
      expect(resp.data.data.version).toBe(1);
      createdId = resp.data.data._id;
    });

    it('lists entries, filterable down to the one just created', async () => {
      const resp = await client.get(`/api/v1/objectrepo?_id=${createdId}`, {
        headers: { Authorization: `Bearer ${token}`, ...SCOPE }
      });
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);
      expect(resp.data.data).toHaveLength(1);
      expect(resp.data.data[0]._id).toBe(createdId);
    });

    it('fetches a single entry by id', async () => {
      const resp = await client.get(`/api/v1/objectrepo/${createdId}`, {
        headers: { Authorization: `Bearer ${token}`, ...SCOPE }
      });
      expect(resp.status).toBe(200);
      expect(resp.data.data._id).toBe(createdId);
    });

    it('updates an entry', async () => {
      const resp = await client.put(
        `/api/v1/objectrepo/${createdId}`,
        { primaryProperty: 'updated-property' },
        { headers: { Authorization: `Bearer ${token}`, ...SCOPE } }
      );
      expect(resp.status).toBe(200);
      expect(resp.data.data.primaryProperty).toBe('updated-property');
    });

    it('deletes an entry', async () => {
      const resp = await client.delete(`/api/v1/objectrepo/${createdId}`, {
        headers: { Authorization: `Bearer ${token}`, ...SCOPE }
      });
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);

      const getResp = await client.get(`/api/v1/objectrepo/${createdId}`, {
        headers: { Authorization: `Bearer ${token}`, ...SCOPE }
      });
      expect(getResp.data.data).toBeNull();
      createdId = null;
    });
  });
});
