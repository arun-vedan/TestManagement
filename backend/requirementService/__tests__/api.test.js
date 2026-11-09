const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');

// Black-box HTTP tests against the running service (same pattern as
// testPlanExecutionService's suite, Sprint 1.3). The actual versioning hook
// behavior was verified directly against the real database inside the
// running container as part of Sprint 2.1 — see the kickoff plan's Sprint 2.1
// record, since it requires an authenticated mutation this suite can't
// perform without a real Keycloak token.

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';
// Fix 4 (WP-F03e): GET /api/v1/audit is commentsService's route, not
// requirementService's -- only reachable from this suite through Kong,
// same convention as this package's own contract.test.js and
// testRepoService/__tests__/bulk.test.js's audit-count proof.
const KONG_URL = process.env.TEST_KONG_URL || 'http://localhost:8000';
const DUMMY_ID = '000000000000000000000000';

const client = axios.create({
  baseURL: BASE_URL,
  validateStatus: () => true
});

describe('requirementService API (live)', () => {
  describe('every route requires authentication, including the new Sprint 2.1 endpoints', () => {
    const protectedRoutes = [
      ['get', '/api/v1/requirement'],
      ['post', '/api/v1/requirement'],
      ['get', `/api/v1/requirement/${DUMMY_ID}`],
      ['put', `/api/v1/requirement/${DUMMY_ID}`],
      ['delete', `/api/v1/requirement/${DUMMY_ID}`],
      ['get', '/api/v1/requirement/wildcardsearch?search=x'],
      ['put', '/api/v1/requirement/updateRequirementByParam?reqid=x'],
      ['put', `/api/v1/requirement/${DUMMY_ID}/status`],
      ['get', `/api/v1/requirement/${DUMMY_ID}/versions`],
      ['patch', '/api/v1/requirement/bulk'],   // WP-F03b: added alongside testPlanExecutionService's bulk routes
      ['delete', '/api/v1/requirement/bulk']
    ];

    it.each(protectedRoutes)('%s %s rejects a request with no token', async (method, path) => {
      const resp = await client.request({ method, url: path });
      expect(resp.status).not.toBeLessThan(400);
      expect(resp.status).not.toBe(404);
    });
  });

  describe('correlation ID propagation', () => {
    it('echoes back a caller-supplied correlation ID', async () => {
      const resp = await client.get('/api/v1/requirement', {
        headers: { 'x-correlation-id': 'test-suite-trace-id' }
      });
      expect(resp.headers['x-correlation-id']).toBe('test-suite-trace-id');
    });
  });
});

// WP-F03 -- bulk operations for requirements. Before this WP, /bulk existed
// only on testRepoService and defectService; requirements, test plans and
// test runs had no bulk anything, which entityListConfigs.tsx recorded
// honestly as an empty bulkActions array rather than a fabricated one.
describe('bulk operations on requirements', () => {
  let client;
  const created = [];

  beforeAll(async () => {
    const token = await getServiceToken();
    client = axios.create({
      baseURL: BASE_URL,
      headers: { Authorization: `Bearer ${token}`, [PROJECT_ID_HEADER]: '1' },
      validateStatus: () => true
    });
    for (let i = 0; i < 3; i += 1) {
      // NOTE: the model (models/requirement.js) requires
      // `requirementDescription`, not `description` -- confirmed live
      // against the running service (a `description`-only POST comes back
      // 400 "Please add a Display name"). Matching reality, not the field
      // name a first draft of this test assumed.
      const resp = await client.post('/api/v1/requirement', {
        requirementSummary: `WP-F03 bulk fixture ${i}`,
        requirementDescription: 'created by the WP-F03 bulk suite'
      });
      expect(resp.status).toBe(201);
      created.push(resp.data.data._id);
    }
  });

  afterAll(async () => {
    for (const id of created) {
      await client.delete(`/api/v1/requirement/${id}`);
    }
  });

  it('changes the status of every id in one call', async () => {
    const resp = await client.patch('/api/v1/requirement/bulk', { ids: created, action: 'status', status: 'review' });
    expect(resp.status).toBe(200);
    expect(resp.data.policy).toBe('all-or-nothing');
    expect(resp.data.updated).toBe(created.length);

    for (const id of created) {
      const one = await client.get(`/api/v1/requirement/${id}`);
      expect(one.data.data.status).toBe('review');
    }
  });

  it('writes NOTHING when one id in the batch does not exist', async () => {
    const before = await client.get(`/api/v1/requirement/${created[0]}`);
    const statusBefore = before.data.data.status;

    const resp = await client.patch('/api/v1/requirement/bulk', {
      ids: [...created, '000000000000000000000000'],
      action: 'status',
      status: 'approved'
    });
    expect(resp.status).toBe(422);
    expect(resp.data.policy).toBe('all-or-nothing');

    const after = await client.get(`/api/v1/requirement/${created[0]}`);
    expect(after.data.data.status).toBe(statusBefore);
  });

  it('rejects an invalid status without writing', async () => {
    const resp = await client.patch('/api/v1/requirement/bulk', { ids: created, action: 'status', status: 'not-a-status' });
    expect(resp.status).toBe(400);
  });

  it('rejects an empty id list', async () => {
    const resp = await client.patch('/api/v1/requirement/bulk', { ids: [], action: 'status', status: 'review' });
    expect(resp.status).toBe(400);
  });

  it('has no assign action -- requirements carry no assignedTo field', async () => {
    const resp = await client.patch('/api/v1/requirement/bulk', { ids: created, action: 'assign', assignedTo: 'someone' });
    expect(resp.status).toBe(400);
  });

  it('is not swallowed by the /:id route', async () => {
    // Registration-order guard: if /bulk is registered after /:id, Express
    // matches updateRequirement with id='bulk' and this is never a 200/422.
    // (review -> draft is a legal edge -- see the previous tests' history --
    // so this is expected to land on 200, not 422; the assertion tolerates
    // either because that registration-order guard is this test's actual
    // point, not the transition's legality.)
    const resp = await client.patch('/api/v1/requirement/bulk', { ids: created, action: 'status', status: 'draft' });
    expect([200, 422]).toContain(resp.status);
  });

  // Fix 1 (WP-F03e final review, CRITICAL): the whole-branch review found
  // that bulkUpdateRequirements validated the target status was in the
  // LIFECYCLE_STATUSES enum but never that the transition itself was legal
  // (shared/service-core/lifecycle.js's VALID_TRANSITIONS graph), unlike
  // the single-item PUT /:id/status path and the canonical
  // testRepoService/controllers/testrepo.js:389-400. The existing bulk
  // tests above happen to only exercise legal edges (draft->review,
  // review->draft), which is exactly why this shipped unnoticed. Every
  // fixture is 'draft' after the previous test's review->draft bulk
  // change; draft's only legal edge is ->review, so a straight jump to
  // 'approved' must be rejected with 422/invalidIds and must leave every
  // fixture's status untouched.
  it('rejects a bulk status change that is not a legal lifecycle transition, and writes nothing', async () => {
    const resp = await client.patch('/api/v1/requirement/bulk', { ids: created, action: 'status', status: 'approved' });
    expect(resp.status).toBe(422);
    expect(resp.data.policy).toBe('all-or-nothing');
    expect(resp.data.invalidIds).toBeDefined();
    expect(resp.data.invalidIds.length).toBe(created.length);

    for (const id of created) {
      const one = await client.get(`/api/v1/requirement/${id}`);
      expect(one.data.data.status).toBe('draft');
    }
  });

  it('deletes every id in one call, and nothing when one is missing', async () => {
    const extra = await client.post('/api/v1/requirement', { requirementSummary: 'WP-F03 delete fixture', requirementDescription: 'x' });
    const extraId = extra.data.data._id;

    const bad = await client.delete('/api/v1/requirement/bulk', { data: { ids: [extraId, '000000000000000000000000'] } });
    expect(bad.status).toBe(422);
    const stillThere = await client.get(`/api/v1/requirement/${extraId}`);
    expect(stillThere.status).toBe(200);

    const ok = await client.delete('/api/v1/requirement/bulk', { data: { ids: [extraId] } });
    expect(ok.status).toBe(200);
    expect(ok.data.deleted).toBe(1);
    const gone = await client.get(`/api/v1/requirement/${extraId}`);
    expect(gone.status).toBe(404);
  });

  // Fix 4 (WP-F03e final review, Important): "exactly N audit events for N
  // items" is a stated Global Constraint of this package and a WP-043
  // acceptance criterion (proved there by counting GET /api/v1/audit rows
  // for testRepoService), but nothing in either backend suite had ever
  // queried the audit API back for requirementService's own bulk paths.
  // That matters more than ordinary coverage because
  // shared/service-core/audit.js's audit() is CONTRACTUALLY SILENT on
  // failure -- a wrong entityId, a missing AUDIT_MONGO_URI, or a dropped
  // write all resolve to `null` and merely log, so every status-code
  // assertion above would still pass even if not one audit row were ever
  // written. Reached through Kong (KONG_URL), not this suite's own
  // BASE_URL, because GET /api/v1/audit is commentsService's route, not
  // requirementService's -- mirrors
  // testRepoService/__tests__/bulk.test.js's identical audit-count proof,
  // including scoping the match by correlationId (not entityId) so a
  // leftover prior run's rows for the same reqId can't double-count.
  it('bulk status change produces EXACTLY N audit rows, one per item, named bulk-status-change', async () => {
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const resp = await client.post('/api/v1/requirement', {
        requirementSummary: `WP-F03e Fix4 audit-count fixture ${i}`,
        requirementDescription: 'seeded for the audit-count proof, cleaned up in this test'
      });
      expect(resp.status).toBe(201);
      ids.push(resp.data.data._id);
    }

    try {
      const bulkResp = await client.patch('/api/v1/requirement/bulk', { ids, action: 'status', status: 'review' });
      expect(bulkResp.status).toBe(200);
      expect(bulkResp.data.updated).toBe(3);

      const correlationId = bulkResp.headers['x-correlation-id'];
      expect(correlationId).toBeTruthy();

      const kongToken = await getServiceToken();
      const kongClient = axios.create({
        baseURL: KONG_URL,
        headers: { Authorization: `Bearer ${kongToken}`, [PROJECT_ID_HEADER]: '1' },
        validateStatus: () => true
      });
      const auditResp = await kongClient.get('/api/v1/audit?entityType=requirement&action=bulk-status-change&limit=200');
      expect(auditResp.status).toBe(200);
      const matching = auditResp.data.data.filter((e) => e.correlationId === correlationId);
      expect(matching.length).toBe(3);
      expect(matching.every((e) => e.actor && e.actor.length > 0)).toBe(true);
      expect(matching.every((e) => e.summary && e.summary.after && e.summary.after.status === 'review')).toBe(true);
    } finally {
      for (const id of ids) {
        // eslint-disable-next-line no-await-in-loop
        await client.delete(`/api/v1/requirement/${id}`);
      }
    }
  }, 30000);
});

// WP-F05 -- tags. Additive array field; filtering comes free from
// advancedResults copying req.query into the Mongo filter, where a scalar
// matches any element of an array. Adapted from testRepoService's block:
// requirementService's create payload needs BOTH requirementSummary AND
// requirementDescription (confirmed live above, in the bulk-fixture setup --
// a requirementDescription-only-missing POST comes back 400 "Please add a
// Display name"), and create returns 201 (confirmed in the bulk block above
// too).
describe('tags', () => {
  let client;
  const created = [];

  beforeAll(async () => {
    const token = await getServiceToken();
    client = axios.create({
      baseURL: BASE_URL,
      headers: { Authorization: `Bearer ${token}`, [PROJECT_ID_HEADER]: '1' },
      validateStatus: () => true
    });
  });

  afterAll(async () => {
    for (const id of created) await client.delete(`/api/v1/requirement/${id}`);
  });

  it('accepts tags on create and returns them', async () => {
    const resp = await client.post('/api/v1/requirement', {
      requirementSummary: 'WP-F05 tagged requirement',
      requirementDescription: 'x',
      tags: ['regression', 'smoke']
    });
    expect(resp.status).toBe(201);
    created.push(resp.data.data._id);
    expect(resp.data.data.tags.sort()).toEqual(['regression', 'smoke']);
  });

  it('normalises case and whitespace, and de-duplicates', async () => {
    const resp = await client.post('/api/v1/requirement', {
      requirementSummary: 'WP-F05 messy tags',
      requirementDescription: 'x',
      tags: ['  Regression ', 'REGRESSION', 'smoke']
    });
    expect(resp.status).toBe(201);
    created.push(resp.data.data._id);
    expect(resp.data.data.tags.sort()).toEqual(['regression', 'smoke']);
  });

  it('rejects a tag containing a space rather than silently rewriting it', async () => {
    const resp = await client.post('/api/v1/requirement', {
      requirementSummary: 'WP-F05 bad tag',
      requirementDescription: 'x',
      tags: ['not one token']
    });
    // Defensive cleanup: this test expects a 400 (nothing created), but if
    // that expectation is ever wrong (e.g. a regression), the fixture must
    // still be tracked for deletion -- exactly the leak that happened
    // during this package's own RED phase, where a test expecting 400 got
    // a 201 instead and its id never reached `created`.
    if (resp.status < 300 && resp.data && resp.data.data && resp.data.data._id) {
      created.push(resp.data.data._id);
    }
    expect(resp.status).toBe(400);
  });

  // Fix round 1, Fix 1 regression guard: a bare scalar (not an array) used
  // to bypass the cleaning pipeline entirely and get silently auto-wrapped
  // uppercase/untrimmed by Mongoose's own array cast. Verified live before
  // fixing that the setter DOES receive the raw string here; the bug was
  // the setter's own early return, not Mongoose's casting.
  it('normalises a bare string into a one-element cleaned array (Fix 1)', async () => {
    const resp = await client.post('/api/v1/requirement', {
      requirementSummary: 'WP-F05 scalar tag',
      requirementDescription: 'x',
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
  // malformed array, nonsense for a client trying to clear tags. Verified
  // live that findOneAndUpdate(..., {runValidators:true}) never invokes
  // the setter for null (only create()/save() do), so null is rejected
  // identically and accurately on both paths rather than silently becoming
  // [] on only one of them.
  it('rejects tags: null with an accurate message, not the whitespace one (Fix 2)', async () => {
    const resp = await client.post('/api/v1/requirement', {
      requirementSummary: 'WP-F05 null tags',
      requirementDescription: 'x',
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
    const made = await client.post('/api/v1/requirement', {
      requirementSummary: 'WP-F05 filter target', requirementDescription: 'x', tags: [unique]
    });
    created.push(made.data.data._id);

    const resp = await client.get(`/api/v1/requirement?tags=${unique}`);
    expect(resp.status).toBe(200);
    expect(resp.data.data.map((d) => d._id)).toEqual([made.data.data._id]);
  });

  it('leaves an entity created without tags readable, with no tags', async () => {
    const resp = await client.post('/api/v1/requirement', {
      requirementSummary: 'WP-F05 untagged', requirementDescription: 'x'
    });
    expect(resp.status).toBe(201);
    created.push(resp.data.data._id);
    expect(resp.data.data.tags).toEqual([]);
  });

  it('adds a tag on update without disturbing the rest of the document', async () => {
    const made = await client.post('/api/v1/requirement', {
      requirementSummary: 'WP-F05 update target', requirementDescription: 'keep me'
    });
    created.push(made.data.data._id);

    const upd = await client.put(`/api/v1/requirement/${made.data.data._id}`, { tags: ['p1'] });
    expect(upd.status).toBe(200);

    const read = await client.get(`/api/v1/requirement/${made.data.data._id}`);
    expect(read.data.data.tags).toEqual(['p1']);
    expect(read.data.data.requirementDescription).toBe('keep me');
  });

  // Fix round 1, Fix 3: the create-path tests above never actually proved
  // findOneAndUpdate normalises/rejects the same way create() does -- the
  // only prior evidence was an uncommitted manual script. These two tests
  // are the committed regression guard for that.
  it('normalises messy tags on update, the same as on create', async () => {
    const made = await client.post('/api/v1/requirement', {
      requirementSummary: 'WP-F05 update-normalise target', requirementDescription: 'x'
    });
    created.push(made.data.data._id);

    const upd = await client.put(`/api/v1/requirement/${made.data.data._id}`, {
      tags: ['  MESSY ', 'messy', 'MESSY']
    });
    expect(upd.status).toBe(200);
    expect(upd.data.data.tags).toEqual(['messy']);

    const read = await client.get(`/api/v1/requirement/${made.data.data._id}`);
    expect(read.data.data.tags).toEqual(['messy']);
  });

  it('rejects a bad tag on update, leaving the entity unchanged', async () => {
    const made = await client.post('/api/v1/requirement', {
      requirementSummary: 'WP-F05 update-reject target', requirementDescription: 'x', tags: ['keep']
    });
    created.push(made.data.data._id);

    const upd = await client.put(`/api/v1/requirement/${made.data.data._id}`, { tags: ['bad tag'] });
    expect(upd.status).toBe(400);

    const read = await client.get(`/api/v1/requirement/${made.data.data._id}`);
    expect(read.data.data.tags).toEqual(['keep']);
  });

  // Fix round 2: Fix 1/Fix 2's regression guards previously only covered
  // create() -- the PUT path was untested. This matters specifically for
  // Fix 2, whose whole rationale is a path asymmetry (the setter runs for
  // null on create()/save() but findOneAndUpdate never invokes it at all),
  // so leaving the PUT path unproven left the most fragile part of this
  // design backed only by an uncommitted manual script.
  it('normalises a bare string into a one-element cleaned array on update (Fix 1)', async () => {
    const made = await client.post('/api/v1/requirement', {
      requirementSummary: 'WP-F05 update-scalar target', requirementDescription: 'x'
    });
    created.push(made.data.data._id);

    const upd = await client.put(`/api/v1/requirement/${made.data.data._id}`, { tags: 'REGRESSION' });
    expect(upd.status).toBe(200);

    const read = await client.get(`/api/v1/requirement/${made.data.data._id}`);
    expect(read.data.data.tags).toEqual(['regression']);
  });

  it('rejects tags: null on update with an accurate message, leaving tags unchanged (Fix 2)', async () => {
    const made = await client.post('/api/v1/requirement', {
      requirementSummary: 'WP-F05 update-null target', requirementDescription: 'x', tags: ['keep']
    });
    created.push(made.data.data._id);

    const upd = await client.put(`/api/v1/requirement/${made.data.data._id}`, { tags: null });
    expect(upd.status).toBe(400);
    expect(upd.data.error).toMatch(/null/i);
    expect(upd.data.error).not.toMatch(/whitespace/i);

    const read = await client.get(`/api/v1/requirement/${made.data.data._id}`);
    expect(read.data.data.tags).toEqual(['keep']);
  });
});
