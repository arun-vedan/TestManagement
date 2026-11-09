const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');

// Black-box HTTP tests against the running service (WP-012 service-core
// rollout). Container: fieldsservice, Kong route: /api/v1/fields.
//
// Wave A-1 -- this service's `/field` routes now require requireProjectScope()
// + authorize(action) (see routes/field.js), same chain as this service's
// own savedView.js sibling (WP-043) and the other WP-021/WP-022-migrated
// services. Every authenticated call below now carries X-Project-Id: 1
// (the seeded Default Project, id=1 -- WP-020 backfill -- which the
// getServiceToken.js service account is a member of). The dedicated
// cross-project vulnerability coverage (foreign project isolation,
// createField ignoring a client-supplied foreign projectId, missing-header
// rejection) lives in tenantIsolation.test.js, mirroring
// requirementService's split between a plain CRUD-happy-path api.test.js
// and a separate tenant-isolation suite.

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';
const DUMMY_ID = '000000000000000000000000';
const DEFAULT_PROJECT_ID = 1;

const client = axios.create({
  baseURL: BASE_URL,
  validateStatus: () => true
});

const withScope = (projectId) => ({ [PROJECT_ID_HEADER]: String(projectId) });

describe('fieldsService API (live)', () => {
  describe('every route requires authentication', () => {
    const protectedRoutes = [
      ['get', '/api/v1/fields'],
      ['post', '/api/v1/fields'],
      ['get', `/api/v1/fields/${DUMMY_ID}`],
      ['put', `/api/v1/fields/${DUMMY_ID}`],
      ['delete', `/api/v1/fields/${DUMMY_ID}`]
    ];

    it.each(protectedRoutes)('%s %s rejects a request with no token', async (method, path) => {
      const resp = await client.request({ method, url: path });
      expect(resp.status).not.toBeLessThan(400);
      expect(resp.status).not.toBe(404);
    });
  });

  describe('authenticated CRUD flow (scoped to the Default Project)', () => {
    let token;
    let createdId;

    const newField = () => ({
      fieldName: `test_field_${Date.now()}`,
      displayName: 'Test Field',
      fieldType: 'Text',
      moduleId: 1,
      isDisplayed: true,
      isDefault: false,
      isEnabled: true,
      isMandatory: false
    });

    beforeAll(async () => {
      token = await getServiceToken();
    });

    afterAll(async () => {
      if (createdId) {
        await client.delete(`/api/v1/fields/${createdId}`, {
          headers: { Authorization: `Bearer ${token}`, ...withScope(DEFAULT_PROJECT_ID) }
        });
      }
    });

    it('creates a field and returns it, stamped with the requesting project', async () => {
      const payload = newField();
      const resp = await client.post('/api/v1/fields', payload, {
        headers: { Authorization: `Bearer ${token}`, ...withScope(DEFAULT_PROJECT_ID) }
      });
      expect(resp.status).toBe(201);
      expect(resp.data.success).toBe(true);
      expect(resp.data.data).toHaveProperty('_id');
      expect(resp.data.data.fieldName).toBe(payload.fieldName);
      expect(resp.data.data.projectId).toBe(DEFAULT_PROJECT_ID);
      createdId = resp.data.data._id;
    });

    it('lists fields, filterable down to the one just created', async () => {
      const resp = await client.get(`/api/v1/fields?_id=${createdId}`, {
        headers: { Authorization: `Bearer ${token}`, ...withScope(DEFAULT_PROJECT_ID) }
      });
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);
      expect(resp.data.data).toHaveLength(1);
      expect(resp.data.data[0]._id).toBe(createdId);
    });

    it('fetches a single field by id', async () => {
      const resp = await client.get(`/api/v1/fields/${createdId}`, {
        headers: { Authorization: `Bearer ${token}`, ...withScope(DEFAULT_PROJECT_ID) }
      });
      expect(resp.status).toBe(200);
      expect(resp.data.data._id).toBe(createdId);
    });

    it('updates a field', async () => {
      const resp = await client.put(
        `/api/v1/fields/${createdId}`,
        { displayName: 'Updated Display Name' },
        { headers: { Authorization: `Bearer ${token}`, ...withScope(DEFAULT_PROJECT_ID) } }
      );
      expect(resp.status).toBe(200);
      expect(resp.data.data.displayName).toBe('Updated Display Name');
    });

    it('deletes a field', async () => {
      const resp = await client.delete(`/api/v1/fields/${createdId}`, {
        headers: { Authorization: `Bearer ${token}`, ...withScope(DEFAULT_PROJECT_ID) }
      });
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);

      const getResp = await client.get(`/api/v1/fields/${createdId}`, {
        headers: { Authorization: `Bearer ${token}`, ...withScope(DEFAULT_PROJECT_ID) }
      });
      expect(getResp.status).toBe(404);
      createdId = null;
    });
  });

  describe('project scope is mandatory', () => {
    let token;

    beforeAll(async () => {
      token = await getServiceToken();
    });

    it('a request with no X-Project-Id header is rejected with 403', async () => {
      const resp = await client.get('/api/v1/fields', {
        headers: { Authorization: `Bearer ${token}` }
      });
      expect(resp.status).toBe(403);
    });

    it('an unknown projectId is rejected with 403', async () => {
      const resp = await client.get('/api/v1/fields', {
        headers: { Authorization: `Bearer ${token}`, ...withScope(999999) }
      });
      expect(resp.status).toBe(403);
    });
  });
});
