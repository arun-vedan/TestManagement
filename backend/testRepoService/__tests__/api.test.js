const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');

// Black-box HTTP tests against the running service (same pattern as
// testPlanExecutionService's suite, Sprint 1.3) — validates routing and auth
// gating, including the two new Sprint 2.1 endpoints. The actual versioning
// hook behavior (snapshot-on-update, version increment, default hydration on
// pre-existing data) was verified directly against the real database inside
// the running container as part of Sprint 2.1 — see the kickoff plan's
// Sprint 2.1 record for that verification, since it requires an authenticated
// mutation this suite can't perform without a real Keycloak token.

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';
const DUMMY_ID = '000000000000000000000000';

const client = axios.create({
  baseURL: BASE_URL,
  validateStatus: () => true
});

describe('testRepoService API (live)', () => {
  describe('every route requires authentication, including the new Sprint 2.1 endpoints', () => {
    const protectedRoutes = [
      ['get', '/api/v1/testrepo'],
      ['post', '/api/v1/testrepo'],
      ['get', `/api/v1/testrepo/${DUMMY_ID}`],
      ['put', `/api/v1/testrepo/${DUMMY_ID}`],
      ['delete', `/api/v1/testrepo/${DUMMY_ID}`],
      ['get', '/api/v1/testrepo/wildcardsearch?search=x'],
      ['put', '/api/v1/testrepo/updateTestCaseByParam?tcid=x'],
      ['put', `/api/v1/testrepo/${DUMMY_ID}/status`],
      ['get', `/api/v1/testrepo/${DUMMY_ID}/versions`]
    ];

    it.each(protectedRoutes)('%s %s rejects a request with no token', async (method, path) => {
      const resp = await client.request({ method, url: path });
      expect(resp.status).not.toBeLessThan(400);
      expect(resp.status).not.toBe(404);
    });
  });

  describe('correlation ID propagation', () => {
    it('echoes back a caller-supplied correlation ID', async () => {
      const resp = await client.get('/api/v1/testrepo', {
        headers: { 'x-correlation-id': 'test-suite-trace-id' }
      });
      expect(resp.headers['x-correlation-id']).toBe('test-suite-trace-id');
    });
  });
});

// WP-F05 -- tags. Additive array field; filtering comes free from
// advancedResults copying req.query into the Mongo filter, where a scalar
// matches any element of an array.
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
    for (const id of created) await client.delete(`/api/v1/testrepo/${id}`);
  });

  it('accepts tags on create and returns them', async () => {
    const resp = await client.post('/api/v1/testrepo', {
      TestCaseSummary: 'WP-F05 tagged case',
      TestCaseDescription: 'x',
      tags: ['regression', 'smoke']
    });
    expect(resp.status).toBe(201);
    created.push(resp.data.data._id);
    expect(resp.data.data.tags.sort()).toEqual(['regression', 'smoke']);
  });

  it('normalises case and whitespace, and de-duplicates', async () => {
    const resp = await client.post('/api/v1/testrepo', {
      TestCaseSummary: 'WP-F05 messy tags',
      TestCaseDescription: 'x',
      tags: ['  Regression ', 'REGRESSION', 'smoke']
    });
    expect(resp.status).toBe(201);
    created.push(resp.data.data._id);
    expect(resp.data.data.tags.sort()).toEqual(['regression', 'smoke']);
  });

  it('rejects a tag containing a space rather than silently rewriting it', async () => {
    const resp = await client.post('/api/v1/testrepo', {
      TestCaseSummary: 'WP-F05 bad tag',
      TestCaseDescription: 'x',
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
    const resp = await client.post('/api/v1/testrepo', {
      TestCaseSummary: 'WP-F05 scalar tag',
      TestCaseDescription: 'x',
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
    const resp = await client.post('/api/v1/testrepo', {
      TestCaseSummary: 'WP-F05 null tags',
      TestCaseDescription: 'x',
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
    const made = await client.post('/api/v1/testrepo', {
      TestCaseSummary: 'WP-F05 filter target', TestCaseDescription: 'x', tags: [unique]
    });
    created.push(made.data.data._id);

    const resp = await client.get(`/api/v1/testrepo?tags=${unique}`);
    expect(resp.status).toBe(200);
    expect(resp.data.data.map((d) => d._id)).toEqual([made.data.data._id]);
  });

  it('leaves an entity created without tags readable, with no tags', async () => {
    const resp = await client.post('/api/v1/testrepo', {
      TestCaseSummary: 'WP-F05 untagged', TestCaseDescription: 'x'
    });
    expect(resp.status).toBe(201);
    created.push(resp.data.data._id);
    expect(resp.data.data.tags).toEqual([]);
  });

  it('adds a tag on update without disturbing the rest of the document', async () => {
    const made = await client.post('/api/v1/testrepo', {
      TestCaseSummary: 'WP-F05 update target', TestCaseDescription: 'keep me'
    });
    created.push(made.data.data._id);

    const upd = await client.put(`/api/v1/testrepo/${made.data.data._id}`, { tags: ['p1'] });
    expect(upd.status).toBe(200);

    const read = await client.get(`/api/v1/testrepo/${made.data.data._id}`);
    expect(read.data.data.tags).toEqual(['p1']);
    expect(read.data.data.TestCaseDescription).toBe('keep me');
  });

  // Fix round 1, Fix 3: the create-path tests above never actually proved
  // findOneAndUpdate normalises/rejects the same way create() does -- the
  // only prior evidence was an uncommitted manual script. These two tests
  // are the committed regression guard for that.
  it('normalises messy tags on update, the same as on create', async () => {
    const made = await client.post('/api/v1/testrepo', {
      TestCaseSummary: 'WP-F05 update-normalise target', TestCaseDescription: 'x'
    });
    created.push(made.data.data._id);

    const upd = await client.put(`/api/v1/testrepo/${made.data.data._id}`, {
      tags: ['  MESSY ', 'messy', 'MESSY']
    });
    expect(upd.status).toBe(200);
    expect(upd.data.data.tags).toEqual(['messy']);

    const read = await client.get(`/api/v1/testrepo/${made.data.data._id}`);
    expect(read.data.data.tags).toEqual(['messy']);
  });

  it('rejects a bad tag on update, leaving the entity unchanged', async () => {
    const made = await client.post('/api/v1/testrepo', {
      TestCaseSummary: 'WP-F05 update-reject target', TestCaseDescription: 'x', tags: ['keep']
    });
    created.push(made.data.data._id);

    const upd = await client.put(`/api/v1/testrepo/${made.data.data._id}`, { tags: ['bad tag'] });
    expect(upd.status).toBe(400);

    const read = await client.get(`/api/v1/testrepo/${made.data.data._id}`);
    expect(read.data.data.tags).toEqual(['keep']);
  });

  // Fix round 2: Fix 1/Fix 2's regression guards previously only covered
  // create() -- the PUT path was untested. This matters specifically for
  // Fix 2, whose whole rationale is a path asymmetry (the setter runs for
  // null on create()/save() but findOneAndUpdate never invokes it at all),
  // so leaving the PUT path unproven left the most fragile part of this
  // design backed only by an uncommitted manual script.
  it('normalises a bare string into a one-element cleaned array on update (Fix 1)', async () => {
    const made = await client.post('/api/v1/testrepo', {
      TestCaseSummary: 'WP-F05 update-scalar target', TestCaseDescription: 'x'
    });
    created.push(made.data.data._id);

    const upd = await client.put(`/api/v1/testrepo/${made.data.data._id}`, { tags: 'REGRESSION' });
    expect(upd.status).toBe(200);

    const read = await client.get(`/api/v1/testrepo/${made.data.data._id}`);
    expect(read.data.data.tags).toEqual(['regression']);
  });

  it('rejects tags: null on update with an accurate message, leaving tags unchanged (Fix 2)', async () => {
    const made = await client.post('/api/v1/testrepo', {
      TestCaseSummary: 'WP-F05 update-null target', TestCaseDescription: 'x', tags: ['keep']
    });
    created.push(made.data.data._id);

    const upd = await client.put(`/api/v1/testrepo/${made.data.data._id}`, { tags: null });
    expect(upd.status).toBe(400);
    expect(upd.data.error).toMatch(/null/i);
    expect(upd.data.error).not.toMatch(/whitespace/i);

    const read = await client.get(`/api/v1/testrepo/${made.data.data._id}`);
    expect(read.data.data.tags).toEqual(['keep']);
  });
});

// WP-F06 Task 2 -- expand=steps is opt-in only (R2). This is the core
// design decision under test: a read WITHOUT ?expand=steps must return the
// reference row untouched, because expanding on every read would mean the
// editor reads flat rows, PUTs flat rows back, and silently converts every
// reference into a copy with no error and nothing to notice.
describe('expand=steps (WP-F06 Task 2)', () => {
  let client;
  const createdTestCaseIds = [];
  const createdSharedStepIds = [];
  let sharedStepId;
  let testCaseId;
  let testCaseTestCaseId; // the human TC-<n> id, for the list-route filter test

  beforeAll(async () => {
    const token = await getServiceToken();
    client = axios.create({
      baseURL: BASE_URL,
      headers: { Authorization: `Bearer ${token}`, [PROJECT_ID_HEADER]: '1' },
      validateStatus: () => true
    });

    const shared = await client.post('/api/v1/sharedstep', {
      title: 'WP-F06 expand test shared step',
      steps: [
        { testStep: 'Open /login', Expected: 'Login form' },
        { testStep: 'Submit admin creds', Expected: 'Redirected to dashboard' }
      ]
    });
    expect(shared.status).toBe(201);
    sharedStepId = shared.data.data._id;
    createdSharedStepIds.push(sharedStepId);

    const tc = await client.post('/api/v1/testrepo', {
      TestCaseSummary: 'WP-F06 expand test case',
      TestCaseDescription: 'x',
      TestSteps: [{ sharedStepId }]
    });
    expect(tc.status).toBe(201);
    testCaseId = tc.data.data._id;
    testCaseTestCaseId = tc.data.data.TestCaseId;
    createdTestCaseIds.push(testCaseId);
  });

  afterAll(async () => {
    // Test cases first, THEN shared steps -- a shared step still
    // referenced by a test case is refused by the delete guard (R4), so
    // deleting in the other order would leave the shared step behind on
    // every run (the exact fixture-cleanup bug Task 1 hit and fixed).
    for (const id of createdTestCaseIds) {
      // eslint-disable-next-line no-await-in-loop
      await client.delete(`/api/v1/testrepo/${id}`).catch(() => {});
    }
    for (const id of createdSharedStepIds) {
      // eslint-disable-next-line no-await-in-loop
      await client.delete(`/api/v1/sharedstep/${id}`).catch(() => {});
    }
  });

  // Review fix round 1, minor finding 3: this test's name promised a
  // read-modify-write round trip but only ever asserted the GET shape (no
  // PUT was issued). A genuine PUT round trip is cheap in this harness
  // (every other describe block here does plain PUTs), so this now does
  // the real thing instead of just renaming the claim away: GET the case
  // unexpanded, PUT its own TestSteps array straight back (exactly what a
  // naive editor that never asked for ?expand=steps would do), then GET
  // again and confirm the reference row is still a reference -- not
  // silently flattened into a copy of the shared step's rows, which is
  // the core failure this whole feature exists to prevent.
  it('returns reference rows unexpanded by default, so a read-modify-write round trip preserves them', async () => {
    const res = await client.get(`/api/v1/testrepo/${testCaseId}`);
    expect(res.status).toBe(200);
    expect(res.data.data.TestSteps[0].sharedStepId).toBeDefined();
    expect(res.data.data.TestSteps).toHaveLength(1); // NOT the 2 rows of the shared step

    const put = await client.put(`/api/v1/testrepo/${testCaseId}`, {
      TestSteps: res.data.data.TestSteps
    });
    expect(put.status).toBe(200);

    const reread = await client.get(`/api/v1/testrepo/${testCaseId}`);
    expect(reread.status).toBe(200);
    expect(reread.data.data.TestSteps).toHaveLength(1);
    expect(reread.data.data.TestSteps[0].sharedStepId).toBe(sharedStepId);
  });

  it('expands reference rows only when ?expand=steps is asked for', async () => {
    const res = await client.get(`/api/v1/testrepo/${testCaseId}?expand=steps`);
    expect(res.status).toBe(200);
    expect(res.data.data.TestSteps).toHaveLength(2);
    expect(res.data.data.TestSteps[0].testStep).toBe('Open /login');
    expect(res.data.data.TestSteps[0].sharedStepTitle).toBe('WP-F06 expand test shared step');
    expect(res.data.data.TestSteps[0].sharedStepIndex).toBe(0);
  });

  it('expands on the list route too, which is the route execution enrichment uses', async () => {
    const res = await client.get(`/api/v1/testrepo?TestCaseId=${testCaseTestCaseId}&expand=steps`);
    expect(res.status).toBe(200);
    expect(res.data.data).toHaveLength(1);
    expect(res.data.data[0].TestSteps).toHaveLength(2);
    expect(res.data.data[0].TestSteps[0].testStep).toBe('Open /login');
  });

  it('does not let expand= leak into the Mongo filter and empty the result set', async () => {
    // Without 'expand' in advancedResults' removeFields this returns 0
    // rows, which would break execution enrichment silently rather than
    // loudly.
    const res = await client.get('/api/v1/testrepo?expand=steps');
    expect(res.status).toBe(200);
    expect(res.data.data.length).toBeGreaterThan(0);
  });
});
