const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');

// WP-001: defectService's controllers/routes required deleted local
// middleware/utils files (MODULE_NOT_FOUND on rebuild) and had zero tests
// despite jest being configured. This suite is the black-box regression
// test proving the @srckube/service-core migration actually works end to
// end (list/create/get through the live container via Kong), not just that
// the process boots.
//
// WP-021: every protected route now requires requireProjectScope() (see
// backend/defectService/routes/defects.js), so the authenticated CRUD block
// below sends X-Project-Id: 1 (the seeded Default Project, WP-020 backfill)
// on every request, and ensures the test identity is a member of it first.
// See backend/defectService/__tests__/tenantIsolation.test.js for the
// dedicated multi-tenancy isolation suite.

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

// Idempotent: userService's addMember either creates the membership or
// updates the role if it already exists (see
// backend/userService/controllers/projects.js#addMember) -- safe to call
// on every test run.
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

describe('defectService API (live)', () => {
  describe('every route requires authentication', () => {
    const protectedRoutes = [
      ['get', '/api/v1/defects'],
      ['post', '/api/v1/defects'],
      ['get', `/api/v1/defects/${DUMMY_ID}`],
      ['put', `/api/v1/defects/${DUMMY_ID}`],
      ['delete', `/api/v1/defects/${DUMMY_ID}`],
      ['get', '/api/v1/defects/wildcardsearch?search=x'],
      ['put', `/api/v1/defects/${DUMMY_ID}/status`]
    ];

    it.each(protectedRoutes)('%s %s rejects a request with no token', async (method, path) => {
      const resp = await anonClient.request({ method, url: path });
      expect(resp.status).not.toBeLessThan(400);
      expect(resp.status).not.toBe(404);
    });
  });

  describe('defect CRUD, authenticated', () => {
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
        await client.delete(`/api/v1/defects/${createdId}`);
      }
    });

    it('GET /api/v1/defects returns the advancedResults envelope', async () => {
      const resp = await client.get('/api/v1/defects');
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);
      expect(Array.isArray(resp.data.data)).toBe(true);
      expect(resp.data.count).toBe(resp.data.data.length);
    });

    it('POST /api/v1/defects creates a defect and stamps createdBy/updatedBy from the token', async () => {
      const resp = await client.post('/api/v1/defects', {
        summary: 'WP-001 regression test defect',
        Priority: 'Low',
        Severity: 'Minor',
        description: 'Created by defectService/__tests__/api.test.js',
        Status: 'Open'
      });
      expect(resp.status).toBe(201);
      expect(resp.data.success).toBe(true);
      expect(resp.data.data).toHaveProperty('_id');
      expect(resp.data.data.defectId).toMatch(/^Bug-\d+$/);
      expect(resp.data.data.createdBy).toBeTruthy();
      expect(resp.data.data.updatedBy).toBeTruthy();
      createdId = resp.data.data._id;
    });

    it('GET /api/v1/defects/:id returns the created defect', async () => {
      const resp = await client.get(`/api/v1/defects/${createdId}`);
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);
      expect(resp.data.data._id).toBe(createdId);
      expect(resp.data.data.summary).toBe('WP-001 regression test defect');
    });

    it('PUT /api/v1/defects/:id updates the defect', async () => {
      const resp = await client.put(`/api/v1/defects/${createdId}`, {
        Status: 'Closed'
      });
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);
      expect(resp.data.data.Status).toBe('Closed');
    });

    it('GET /api/v1/defects/wildcardsearch finds the created defect by summary', async () => {
      const resp = await client.get('/api/v1/defects/wildcardsearch', {
        params: { search: 'WP-001 regression' }
      });
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);
      expect(resp.data.data.some((d) => d._id === createdId)).toBe(true);
    });

    it('DELETE /api/v1/defects/:id removes the defect', async () => {
      const resp = await client.delete(`/api/v1/defects/${createdId}`);
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);

      // WP-021: getDefect now does a scoped findOne({_id, projectId}) and
      // returns a proper 404 when nothing matches (needed so a document
      // belonging to a DIFFERENT project reads back as "not found", not as
      // its content -- see getDefect's comment in controllers/defects.js).
      // That same not-found path is exercised here too: a deleted id no
      // longer round-trips as `200 {data: null}` (the pre-WP-021 behavior,
      // an unscoped findById on a missing id) -- it's a real 404 now, which
      // is the more correct REST semantic and was not something GR-6 lets
      // this suite keep asserting as "expected".
      const getResp = await client.get(`/api/v1/defects/${createdId}`);
      expect(getResp.status).toBe(404);
      expect(getResp.data.success).toBe(false);

      createdId = null;
    });
  });

  // WP-010 (Sprint 2.4): PUT /api/v1/defects/:id/status, validated against
  // istatusservice's real parentId graph (New -> Open -> Fixed/Rejected/
  // Deffered -> Retest -> Re-open/Closed, with Re-open looping back to
  // Fixed -- verified directly against the live srckube-issuestatus.staus
  // collection, see EXECUTION_LOG.md). Separate defect from the CRUD block
  // above so this suite doesn't depend on ordering/state from those tests.
  describe('PUT /api/v1/defects/:id/status (WP-010)', () => {
    let client;
    let statusDefectId;

    beforeAll(async () => {
      const token = await getServiceToken();
      await ensureDefaultProjectMembership(token);
      client = axios.create({
        baseURL: BASE_URL,
        headers: { Authorization: `Bearer ${token}`, ...PROJECT_SCOPE_HEADERS },
        validateStatus: () => true
      });

      const createResp = await client.post('/api/v1/defects', {
        summary: 'WP-010 status workflow test defect',
        Priority: 'Low',
        Severity: 'Minor',
        description: 'Created by defectService/__tests__/api.test.js',
        Status: 'New'
      });
      expect(createResp.status).toBe(201);
      statusDefectId = createResp.data.data._id;
    }, 15000);

    afterAll(async () => {
      if (statusDefectId) {
        await client.delete(`/api/v1/defects/${statusDefectId}`);
      }
    });

    it('rejects a request with no status in the body', async () => {
      const resp = await client.put(`/api/v1/defects/${statusDefectId}/status`, {});
      expect(resp.status).toBe(400);
      expect(resp.data.success).toBe(false);
    });

    it('rejects a target status istatusservice does not recognize', async () => {
      const resp = await client.put(`/api/v1/defects/${statusDefectId}/status`, {
        status: 'NotARealStatus'
      });
      expect(resp.status).toBe(400);
      expect(resp.data.error).toMatch(/not a recognized status/i);
    });

    it('rejects an invalid transition (New -> Closed is not a valid edge)', async () => {
      const resp = await client.put(`/api/v1/defects/${statusDefectId}/status`, {
        status: 'Closed'
      });
      expect(resp.status).toBe(400);
      expect(resp.data.success).toBe(false);
      expect(resp.data.error).toMatch(/Invalid transition/i);
      expect(resp.data.error).toMatch(/Open/); // the one real valid next status from New

      // and the defect's Status must be unchanged by the rejected attempt
      const getResp = await client.get(`/api/v1/defects/${statusDefectId}`);
      expect(getResp.data.data.Status).toBe('New');
    });

    it('accepts a valid transition (New -> Open) through Kong with a service token, and it persists', async () => {
      const resp = await client.put(`/api/v1/defects/${statusDefectId}/status`, {
        status: 'Open'
      });
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);
      expect(resp.data.data.Status).toBe('Open');
      expect(resp.data.data.statusHistory).toHaveLength(1);
      expect(resp.data.data.statusHistory[0]).toMatchObject({ from: 'New', to: 'Open' });

      const getResp = await client.get(`/api/v1/defects/${statusDefectId}`);
      expect(getResp.status).toBe(200);
      expect(getResp.data.data.Status).toBe('Open');
    });

    it('returns 404 for a status transition on a nonexistent defect', async () => {
      const resp = await client.put(`/api/v1/defects/${DUMMY_ID}/status`, {
        status: 'Open'
      });
      expect(resp.status).toBe(404);
    });

    // The workbench draft flow creates a defect with no Status at all. The
    // graph's start state (New, parentId [0]) must be reachable from that,
    // or the defect can never enter the workflow.
    it('lets a defect created with no Status enter the workflow at its start state', async () => {
      const createResp = await client.post('/api/v1/defects', {
        summary: 'No-status defect',
        description: 'Created by defectService/__tests__/api.test.js'
      });
      expect(createResp.status).toBe(201);
      const noStatusId = createResp.data.data._id;
      try {
        const skipResp = await client.put(`/api/v1/defects/${noStatusId}/status`, { status: 'Open' });
        expect(skipResp.status).toBe(400);
        expect(skipResp.data.error).toMatch(/Invalid transition/i);

        const resp = await client.put(`/api/v1/defects/${noStatusId}/status`, { status: 'New' });
        expect(resp.status).toBe(200);
        expect(resp.data.data.Status).toBe('New');
        expect(resp.data.data.statusHistory[0]).toMatchObject({ to: 'New' });
      } finally {
        await client.delete(`/api/v1/defects/${noStatusId}`);
      }
    });
  });

  // WP-F05 -- tags. Additive array field; filtering comes free from
  // advancedResults copying req.query into the Mongo filter, where a scalar
  // matches any element of an array. Adapted from the brief's
  // testRepoService block: defectService's create needs `summary` (the
  // model has no `required` on it, but the CRUD block above's live create
  // uses summary/Priority/Severity/description/Status, so this suite
  // matches that shape rather than assuming a stricter or looser one), and
  // create returns 201 (confirmed just above).
  describe('tags', () => {
    let client;
    const created = [];

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
      for (const id of created) await client.delete(`/api/v1/defects/${id}`);
    });

    it('accepts tags on create and returns them', async () => {
      const resp = await client.post('/api/v1/defects', {
        summary: 'WP-F05 tagged defect',
        Priority: 'Low',
        Severity: 'Minor',
        description: 'x',
        Status: 'Open',
        tags: ['regression', 'smoke']
      });
      expect(resp.status).toBe(201);
      created.push(resp.data.data._id);
      expect(resp.data.data.tags.sort()).toEqual(['regression', 'smoke']);
    });

    it('normalises case and whitespace, and de-duplicates', async () => {
      const resp = await client.post('/api/v1/defects', {
        summary: 'WP-F05 messy tags',
        Priority: 'Low',
        Severity: 'Minor',
        description: 'x',
        Status: 'Open',
        tags: ['  Regression ', 'REGRESSION', 'smoke']
      });
      expect(resp.status).toBe(201);
      created.push(resp.data.data._id);
      expect(resp.data.data.tags.sort()).toEqual(['regression', 'smoke']);
    });

    it('rejects a tag containing a space rather than silently rewriting it', async () => {
      const resp = await client.post('/api/v1/defects', {
        summary: 'WP-F05 bad tag',
        Priority: 'Low',
        Severity: 'Minor',
        description: 'x',
        Status: 'Open',
        tags: ['not one token']
      });
      // Defensive cleanup: this test expects a 400 (nothing created), but
      // if that expectation is ever wrong (e.g. a regression), the fixture
      // must still be tracked for deletion -- exactly the leak that
      // happened during this package's own RED phase, where a test
      // expecting 400 got a 201 instead and its id never reached `created`.
      if (resp.status < 300 && resp.data && resp.data.data && resp.data.data._id) {
        created.push(resp.data.data._id);
      }
      expect(resp.status).toBe(400);
    });

    // Fix round 1, Fix 1 regression guard: a bare scalar (not an array)
    // used to bypass the cleaning pipeline entirely and get silently
    // auto-wrapped uppercase/untrimmed by Mongoose's own array cast.
    // Verified live before fixing that the setter DOES receive the raw
    // string here; the bug was the setter's own early return, not
    // Mongoose's casting.
    it('normalises a bare string into a one-element cleaned array (Fix 1)', async () => {
      const resp = await client.post('/api/v1/defects', {
        summary: 'WP-F05 scalar tag',
        Priority: 'Low',
        Severity: 'Minor',
        description: 'x',
        Status: 'Open',
        tags: 'REGRESSION'
      });
      if (resp.status < 300 && resp.data && resp.data.data && resp.data.data._id) {
        created.push(resp.data.data._id);
      }
      expect(resp.status).toBe(201);
      expect(resp.data.data.tags).toEqual(['regression']);
    });

    // Fix round 1, Fix 2 regression guard: tags: null used to reach the
    // validator and fail with the whitespace message -- accurate for a
    // malformed array, nonsense for a client trying to clear tags.
    // Verified live that findOneAndUpdate(..., {runValidators:true}) never
    // invokes the setter for null (only create()/save() do), so null is
    // rejected identically and accurately on both paths rather than
    // silently becoming [] on only one of them.
    it('rejects tags: null with an accurate message, not the whitespace one (Fix 2)', async () => {
      const resp = await client.post('/api/v1/defects', {
        summary: 'WP-F05 null tags',
        Priority: 'Low',
        Severity: 'Minor',
        description: 'x',
        Status: 'Open',
        tags: null
      });
      if (resp.status < 300 && resp.data && resp.data.data && resp.data.data._id) {
        created.push(resp.data.data._id);
      }
      expect(resp.status).toBe(400);
      expect(resp.data.error).not.toMatch(/whitespace/i);
      expect(resp.data.error).toMatch(/null/i);
    });

    it('filters the list by tag', async () => {
      const unique = `wpf05-${Date.now()}`;
      const made = await client.post('/api/v1/defects', {
        summary: 'WP-F05 filter target',
        Priority: 'Low',
        Severity: 'Minor',
        description: 'x',
        Status: 'Open',
        tags: [unique]
      });
      created.push(made.data.data._id);

      const resp = await client.get(`/api/v1/defects?tags=${unique}`);
      expect(resp.status).toBe(200);
      expect(resp.data.data.map((d) => d._id)).toEqual([made.data.data._id]);
    });

    it('leaves an entity created without tags readable, with no tags', async () => {
      const resp = await client.post('/api/v1/defects', {
        summary: 'WP-F05 untagged',
        Priority: 'Low',
        Severity: 'Minor',
        description: 'x',
        Status: 'Open'
      });
      expect(resp.status).toBe(201);
      created.push(resp.data.data._id);
      expect(resp.data.data.tags).toEqual([]);
    });

    it('adds a tag on update without disturbing the rest of the document', async () => {
      const made = await client.post('/api/v1/defects', {
        summary: 'keep me',
        Priority: 'Low',
        Severity: 'Minor',
        description: 'x',
        Status: 'Open'
      });
      created.push(made.data.data._id);

      const upd = await client.put(`/api/v1/defects/${made.data.data._id}`, { tags: ['p1'] });
      expect(upd.status).toBe(200);

      const read = await client.get(`/api/v1/defects/${made.data.data._id}`);
      expect(read.data.data.tags).toEqual(['p1']);
      expect(read.data.data.summary).toBe('keep me');
    });

    // Fix round 1, Fix 3: the create-path tests above never actually
    // proved findOneAndUpdate normalises/rejects the same way create()
    // does -- the only prior evidence was an uncommitted manual script.
    // These two tests are the committed regression guard for that.
    it('normalises messy tags on update, the same as on create', async () => {
      const made = await client.post('/api/v1/defects', {
        summary: 'WP-F05 update-normalise target',
        Priority: 'Low',
        Severity: 'Minor',
        description: 'x',
        Status: 'Open'
      });
      created.push(made.data.data._id);

      const upd = await client.put(`/api/v1/defects/${made.data.data._id}`, {
        tags: ['  MESSY ', 'messy', 'MESSY']
      });
      expect(upd.status).toBe(200);
      expect(upd.data.data.tags).toEqual(['messy']);

      const read = await client.get(`/api/v1/defects/${made.data.data._id}`);
      expect(read.data.data.tags).toEqual(['messy']);
    });

    it('rejects a bad tag on update, leaving the entity unchanged', async () => {
      const made = await client.post('/api/v1/defects', {
        summary: 'WP-F05 update-reject target',
        Priority: 'Low',
        Severity: 'Minor',
        description: 'x',
        Status: 'Open',
        tags: ['keep']
      });
      created.push(made.data.data._id);

      const upd = await client.put(`/api/v1/defects/${made.data.data._id}`, { tags: ['bad tag'] });
      expect(upd.status).toBe(400);

      const read = await client.get(`/api/v1/defects/${made.data.data._id}`);
      expect(read.data.data.tags).toEqual(['keep']);
    });

    // Fix round 2: Fix 1/Fix 2's regression guards previously only covered
    // create() -- the PUT path was untested. This matters specifically for
    // Fix 2, whose whole rationale is a path asymmetry (the setter runs for
    // null on create()/save() but findOneAndUpdate never invokes it at
    // all), so leaving the PUT path unproven left the most fragile part of
    // this design backed only by an uncommitted manual script.
    it('normalises a bare string into a one-element cleaned array on update (Fix 1)', async () => {
      const made = await client.post('/api/v1/defects', {
        summary: 'WP-F05 update-scalar target',
        Priority: 'Low',
        Severity: 'Minor',
        description: 'x',
        Status: 'Open'
      });
      created.push(made.data.data._id);

      const upd = await client.put(`/api/v1/defects/${made.data.data._id}`, { tags: 'REGRESSION' });
      expect(upd.status).toBe(200);

      const read = await client.get(`/api/v1/defects/${made.data.data._id}`);
      expect(read.data.data.tags).toEqual(['regression']);
    });

    it('rejects tags: null on update with an accurate message, leaving tags unchanged (Fix 2)', async () => {
      const made = await client.post('/api/v1/defects', {
        summary: 'WP-F05 update-null target',
        Priority: 'Low',
        Severity: 'Minor',
        description: 'x',
        Status: 'Open',
        tags: ['keep']
      });
      created.push(made.data.data._id);

      const upd = await client.put(`/api/v1/defects/${made.data.data._id}`, { tags: null });
      expect(upd.status).toBe(400);
      expect(upd.data.error).toMatch(/null/i);
      expect(upd.data.error).not.toMatch(/whitespace/i);

      const read = await client.get(`/api/v1/defects/${made.data.data._id}`);
      expect(read.data.data.tags).toEqual(['keep']);
    });
  });
});
