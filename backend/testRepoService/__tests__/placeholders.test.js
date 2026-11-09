// WP-F07a Task 2 -- extractPlaceholders() unit tests, and the
// GET /:id/parameters route's behaviour (missing/unused reporting,
// cross-project/dangling dataset-binding rejection).
//
// Two different harnesses in one file, deliberately:
//
// extractPlaceholders() is a plain, pure function (module utils/
// placeholders.js) with zero collaborators -- there is nothing here that
// needs a live container or Mongo, and this repo already has exactly this
// style of test for another pure module (__tests__/expandSteps.test.js).
//
// The /:id/parameters route, and the create/update binding-validation it
// depends on, DO need the live container: they exercise real routing,
// auth, tenant scoping, a real bound Dataset, and -- for the R4 ordering
// requirement -- a real SharedStep expansion. Follows this service's
// established black-box HTTP convention (api.test.js/dataset.test.js/
// sharedStep.test.js): reached directly against the running container
// (BASE_URL), bypassing Kong, since keycloak.protect() verifies the JWT
// itself independent of Kong.
const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
const { extractPlaceholders } = require('../utils/placeholders');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

describe('extractPlaceholders (pure)', () => {
  it('finds a placeholder in testStep and one in Expected, on separate rows', () => {
    const steps = [
      { testStep: 'Log in as {{username}}', Expected: 'ok' },
      { testStep: 'ok', Expected: 'Redirected to {{destination}}' },
    ];
    // Single-line break: dropping the `for (const text of [step.testStep,
    // step.Expected])` loop down to just step.testStep would still pass
    // the first row but lose 'destination' entirely.
    expect(extractPlaceholders(steps)).toEqual(['username', 'destination']);
  });

  it('de-duplicates repeated names, keeping first-appearance order', () => {
    const steps = [
      { testStep: 'Log in as {{role}}', Expected: '{{role}} sees the dashboard' },
      { testStep: 'Log out {{role}}', Expected: 'Back to {{page}} for {{role}}' },
    ];
    // Single-line break: removing the `g` flag from PLACEHOLDER_REGEX (so
    // only the first match per string is ever found) still finds 'role'
    // and 'page' once each here, in the same order -- this test alone
    // would pass a non-global regex. It's the companion "same name twice
    // in ONE string" case below that a non-global regex actually breaks.
    expect(extractPlaceholders(steps)).toEqual(['role', 'page']);
  });

  it('finds every occurrence within a single string, not just the first', () => {
    // Single-line break: `/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/` without the `g`
    // flag matches only 'role' here and never reaches 'team' -- exec()
    // would return the same first match forever instead of advancing.
    const steps = [{ testStep: '{{role}} handles {{team}} tickets', Expected: 'ok' }];
    expect(extractPlaceholders(steps)).toEqual(['role', 'team']);
  });

  it('tolerates surrounding whitespace inside the braces', () => {
    // Single-line break: dropping either `\s*` from the regex rejects
    // '{{ role }}' (only the bare '{{role}}' form would match).
    const steps = [{ testStep: 'Log in as {{ role }}', Expected: '{{role}} ok' }];
    expect(extractPlaceholders(steps)).toEqual(['role']);
  });

  it('ignores a lone brace and an unclosed placeholder', () => {
    // Single-line break: a regex that made the closing `}}` optional (or
    // used a single `{`/`}` anywhere) would match 'role' out of the
    // unclosed text below; this asserts it finds nothing there at all.
    const steps = [{ testStep: 'A { lone brace, and {{unclosed', Expected: 'still no match here }}' }];
    expect(extractPlaceholders(steps)).toEqual([]);
  });

  it('returns [] for steps with no placeholders, and for an empty/undefined input', () => {
    expect(extractPlaceholders([{ testStep: 'plain', Expected: 'plain' }])).toEqual([]);
    expect(extractPlaceholders([])).toEqual([]);
    expect(extractPlaceholders(undefined)).toEqual([]);
  });
});

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';
const USER_SERVICE_URL = process.env.TEST_USER_SERVICE_URL || 'http://localhost:8000';
const DEFAULT_PROJECT_ID = 1;
const runId = Date.now();

const withScope = (projectId) => ({ headers: { [PROJECT_ID_HEADER]: String(projectId) } });

function decodeJwtPayload(token) {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

// Same in-process project-list cache race dataset.test.js/sharedStep.test.js
// retry around (projectScope.js, PROJECT_SCOPE_CACHE_TTL_MS).
async function withCacheRetry(fn, { retries = 8, delayMs = 400 } = {}) {
  let resp;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    resp = await fn();
    if (resp.status !== 403) return resp;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return resp;
}

describe('Dataset binding and GET /:id/parameters (WP-F07a Task 2)', () => {
  let client;
  let userServiceClient;
  let sub;

  let projectBId;
  let projectBMongoId;
  let orgBId;

  const createdTestCaseIds = []; // project 1
  const createdDatasetIds = []; // project 1
  const createdSharedStepIds = []; // project 1
  const createdTestCaseIdsB = []; // project B
  const createdDatasetIdsB = []; // project B

  beforeAll(async () => {
    const token = await getServiceToken();
    sub = decodeJwtPayload(token).sub;

    client = axios.create({
      baseURL: BASE_URL,
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true
    });
    userServiceClient = axios.create({
      baseURL: USER_SERVICE_URL,
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true
    });

    const listResp = await userServiceClient.get('/api/v1/projects');
    expect(listResp.status).toBe(200);
    const projectA = listResp.data.data.find((p) => p.id === DEFAULT_PROJECT_ID);
    expect(projectA).toBeDefined();
    await userServiceClient.post(`/api/v1/projects/${projectA._id}/members`, { userId: sub, role: 'admin' });

    const orgResp = await userServiceClient.post('/api/v1/organizations', {
      name: `WP-F07a params org B ${runId}`,
      key: `wpf07a-params-org-b-${runId}`
    });
    expect(orgResp.status).toBe(201);
    orgBId = orgResp.data.data._id;
    trackOrganization(orgBId);

    const projResp = await userServiceClient.post('/api/v1/projects', {
      name: `WP-F07a params project B ${runId}`,
      key: `wpf07a-params-proj-b-${runId}`,
      organizationId: orgBId
    });
    expect(projResp.status).toBe(201);
    projectBId = projResp.data.data.id;
    trackProject(projectBId);
    projectBMongoId = projResp.data.data._id;
    trackProject(projectBMongoId);
    expect(projectBId).not.toBe(DEFAULT_PROJECT_ID);
  }, 30000);

  afterAll(async () => {
    // Test cases BEFORE the datasets/shared steps they reference -- both
    // Task 1's dataset delete guard and WP-F06's shared-step delete guard
    // refuse a delete while a test case still references the target, so
    // deleting referencers first is required for this cleanup to actually
    // succeed rather than leak a document every run.
    for (const id of createdTestCaseIds) {
      // eslint-disable-next-line no-await-in-loop
      await client.delete(`/api/v1/testrepo/${id}`, withScope(DEFAULT_PROJECT_ID)).catch(() => {});
    }
    for (const id of createdTestCaseIdsB) {
      // eslint-disable-next-line no-await-in-loop
      await client.delete(`/api/v1/testrepo/${id}`, withScope(projectBId)).catch(() => {});
    }
    for (const id of createdDatasetIds) {
      // eslint-disable-next-line no-await-in-loop
      await client.delete(`/api/v1/dataset/${id}`, withScope(DEFAULT_PROJECT_ID)).catch(() => {});
    }
    for (const id of createdDatasetIdsB) {
      // eslint-disable-next-line no-await-in-loop
      await client.delete(`/api/v1/dataset/${id}`, withScope(projectBId)).catch(() => {});
    }
    for (const id of createdSharedStepIds) {
      // eslint-disable-next-line no-await-in-loop
      await client.delete(`/api/v1/sharedstep/${id}`, withScope(DEFAULT_PROJECT_ID)).catch(() => {});
    }
    if (projectBMongoId) {
      await userServiceClient.delete(`/api/v1/projects/${projectBMongoId}`);
    }
    if (orgBId) {
      await userServiceClient.delete(`/api/v1/organizations/${orgBId}`);
    }
  }, 30000);

  describe('binding validation on create/update', () => {
    it('rejects creating a test case with a datasetId that does not exist, 400', async () => {
      // A well-formed but never-issued ObjectId.
      const res = await client.post(
        '/api/v1/testrepo',
        { TestCaseSummary: `WP-F07a dangling binding ${runId}`, TestCaseDescription: 'x', datasetId: '507f1f77bcf86cd799439099' },
        withScope(DEFAULT_PROJECT_ID)
      );
      // Single-line break: removing the rejectInvalidDatasetBinding() call
      // from createTestCase turns this into a 201 with the dangling id
      // silently stored.
      expect(res.status).toBe(400);
    });

    it("rejects creating a test case with a datasetId that belongs to another project, 400", async () => {
      const datasetB = await withCacheRetry(() => client.post(
        '/api/v1/dataset',
        { title: `WP-F07a project B dataset ${runId}`, columns: ['x'], rows: [['1']] },
        withScope(projectBId)
      ));
      expect(datasetB.status).toBe(201);
      createdDatasetIdsB.push(datasetB.data.data._id);

      const res = await withCacheRetry(() => client.post(
        '/api/v1/testrepo',
        { TestCaseSummary: `WP-F07a cross-project binding ${runId}`, TestCaseDescription: 'x', datasetId: datasetB.data.data._id },
        withScope(DEFAULT_PROJECT_ID)
      ));
      // Single-line break: dropping `projectId` from the
      // Dataset.findOne({_id, projectId}) check in
      // rejectInvalidDatasetBinding would find project B's dataset by _id
      // alone and accept this as 201.
      expect(res.status).toBe(400);
    });

    it('rejects updating a test case to a datasetId from another project, 400, and leaves the binding unchanged', async () => {
      const datasetA = await client.post(
        '/api/v1/dataset',
        { title: `WP-F07a update-guard own dataset ${runId}`, columns: ['x'], rows: [] },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(datasetA.status).toBe(201);
      createdDatasetIds.push(datasetA.data.data._id);

      const datasetB = await withCacheRetry(() => client.post(
        '/api/v1/dataset',
        { title: `WP-F07a update-guard other project dataset ${runId}`, columns: ['x'], rows: [] },
        withScope(projectBId)
      ));
      expect(datasetB.status).toBe(201);
      createdDatasetIdsB.push(datasetB.data.data._id);

      const tc = await client.post(
        '/api/v1/testrepo',
        { TestCaseSummary: `WP-F07a update-guard case ${runId}`, TestCaseDescription: 'x', datasetId: datasetA.data.data._id },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(tc.status).toBe(201);
      createdTestCaseIds.push(tc.data.data._id);

      const upd = await client.put(
        `/api/v1/testrepo/${tc.data.data._id}`,
        { datasetId: datasetB.data.data._id },
        withScope(DEFAULT_PROJECT_ID)
      );
      // Single-line break: removing the same check from updateTestCase
      // accepts this as 200 and re-binds the case to another project's
      // dataset.
      expect(upd.status).toBe(400);

      const read = await client.get(`/api/v1/testrepo/${tc.data.data._id}`, withScope(DEFAULT_PROJECT_ID));
      expect(read.data.data.datasetId).toBe(datasetA.data.data._id);
    });

    it('allows clearing a binding with an explicit null, and leaves an absent key untouched', async () => {
      const dataset = await client.post(
        '/api/v1/dataset',
        { title: `WP-F07a clear-binding dataset ${runId}`, columns: [], rows: [] },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(dataset.status).toBe(201);
      createdDatasetIds.push(dataset.data.data._id);

      const tc = await client.post(
        '/api/v1/testrepo',
        { TestCaseSummary: `WP-F07a clear-binding case ${runId}`, TestCaseDescription: 'x', datasetId: dataset.data.data._id },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(tc.status).toBe(201);
      createdTestCaseIds.push(tc.data.data._id);

      // An unrelated metadata-only update must not be blocked by the
      // binding check just because a datasetId was set previously.
      const untouched = await client.put(
        `/api/v1/testrepo/${tc.data.data._id}`,
        { TestCaseDescription: 'still x' },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(untouched.status).toBe(200);
      expect(untouched.data.data.datasetId).toBe(dataset.data.data._id);

      const cleared = await client.put(
        `/api/v1/testrepo/${tc.data.data._id}`,
        { datasetId: null },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(cleared.status).toBe(200);
      expect(cleared.data.data.datasetId).toBeFalsy();
    });

    // Fix round 1 (review, important) -- updateTestCaseByParam is the
    // third write path that can set datasetId (alongside createTestCase
    // and updateTestCase, both already covered above), and the guard was
    // added there in the same commit specifically to close this hole.
    // Leaving it the one guarded-in-code-but-untested path would be an
    // odd place to stop -- this is exactly the "correct but untested"
    // state the brief's own history warns about.
    it('rejects updateTestCaseByParam setting a datasetId that belongs to another project, 400, and leaves the binding unchanged', async () => {
      const datasetA = await client.post(
        '/api/v1/dataset',
        { title: `WP-F07a byparam-guard own dataset ${runId}`, columns: ['x'], rows: [] },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(datasetA.status).toBe(201);
      createdDatasetIds.push(datasetA.data.data._id);

      const datasetB = await withCacheRetry(() => client.post(
        '/api/v1/dataset',
        { title: `WP-F07a byparam-guard other project dataset ${runId}`, columns: ['x'], rows: [] },
        withScope(projectBId)
      ));
      expect(datasetB.status).toBe(201);
      createdDatasetIdsB.push(datasetB.data.data._id);

      const tc = await client.post(
        '/api/v1/testrepo',
        { TestCaseSummary: `WP-F07a byparam-guard case ${runId}`, TestCaseDescription: 'x', datasetId: datasetA.data.data._id },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(tc.status).toBe(201);
      createdTestCaseIds.push(tc.data.data._id);

      const upd = await client.put(
        `/api/v1/testrepo/updateTestCaseByParam?tcid=${tc.data.data.TestCaseId}`,
        { datasetId: datasetB.data.data._id },
        withScope(DEFAULT_PROJECT_ID)
      );
      // Single-line break: removing the rejectInvalidDatasetBinding() call
      // from updateTestCaseByParam accepts this as 200 and re-binds the
      // case to another project's dataset via this second update route.
      expect(upd.status).toBe(400);

      const read = await client.get(`/api/v1/testrepo/${tc.data.data._id}`, withScope(DEFAULT_PROJECT_ID));
      expect(read.data.data.datasetId).toBe(datasetA.data.data._id);
    });

    // Fix round 1 (review, minor 3) -- a malformed datasetId (not shaped
    // like an ObjectId at all) makes Mongoose's own findOne() throw a
    // CastError, which rejectInvalidDatasetBinding must still treat as
    // "invalid dataset reference" (400), not let escape as an uncaught
    // 500 -- that's the one branch the review's error-classification fix
    // (distinguishing CastError from a genuine DB failure) must still
    // route to 400 exactly as before.
    it('rejects a malformed (non-ObjectId) datasetId with 400, not 500', async () => {
      const res = await client.post(
        '/api/v1/testrepo',
        { TestCaseSummary: `WP-F07a malformed datasetId ${runId}`, TestCaseDescription: 'x', datasetId: 'not-an-object-id' },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(res.status).toBe(400);
    });
  });

  describe('GET /:id/parameters', () => {
    it('404s for a test case that does not exist in the caller project', async () => {
      const res = await client.get('/api/v1/testrepo/507f1f77bcf86cd799439099/parameters', withScope(DEFAULT_PROJECT_ID));
      expect(res.status).toBe(404);
    });

    // Fix round 1 (review, important) -- a never-issued id (the test just
    // above) would 404 even if getTestCaseParameters dropped its
    // `projectId` filter entirely (findOne would still find nothing). This
    // is the sharper case: a test case that genuinely EXISTS, just not in
    // the caller's project, so it only 404s if the projectId scoping is
    // actually applied.
    it('404s for a test case that exists but belongs to another project', async () => {
      const tcB = await withCacheRetry(() => client.post(
        '/api/v1/testrepo',
        { TestCaseSummary: `WP-F07a cross-project parameters case ${runId}`, TestCaseDescription: 'x' },
        withScope(projectBId)
      ));
      expect(tcB.status).toBe(201);
      createdTestCaseIdsB.push(tcB.data.data._id);

      const res = await client.get(`/api/v1/testrepo/${tcB.data.data._id}/parameters`, withScope(DEFAULT_PROJECT_ID));
      // Single-line break: dropping `projectId` from
      // `TestCase.findOne({_id: req.params.id, projectId})` in
      // getTestCaseParameters would find this real document by _id alone
      // and return 200, leaking project B's test case into project A.
      expect(res.status).toBe(404);
    });

    // Fix round 1 (review, minor 4) -- a Dataset's `columns` array has no
    // uniqueness constraint, so `unused` must still report each name once
    // even if the dataset itself stores a column twice.
    it('de-duplicates the unused column list when the dataset has a repeated column name', async () => {
      const dataset = await client.post(
        '/api/v1/dataset',
        { title: `WP-F07a duplicate-column dataset ${runId}`, columns: ['dup', 'dup', 'other'], rows: [] },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(dataset.status).toBe(201);
      createdDatasetIds.push(dataset.data.data._id);

      const tc = await client.post(
        '/api/v1/testrepo',
        {
          TestCaseSummary: `WP-F07a duplicate-column case ${runId}`,
          TestCaseDescription: 'x',
          datasetId: dataset.data.data._id,
          TestSteps: [{ testStep: 'no placeholders here', Expected: 'ok' }],
        },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(tc.status).toBe(201);
      createdTestCaseIds.push(tc.data.data._id);

      const res = await client.get(`/api/v1/testrepo/${tc.data.data._id}/parameters`, withScope(DEFAULT_PROJECT_ID));
      expect(res.status).toBe(200);
      // Single-line break: filtering the raw `columns` array (instead of
      // the de-duplicated column set) reports 'dup' twice here.
      expect(res.data.data.unused).toEqual(['dup', 'other']);
    });

    it('reports missing placeholders (no column) and unused columns (no placeholder), correctly both ways', async () => {
      const dataset = await client.post(
        '/api/v1/dataset',
        { title: `WP-F07a missing+unused dataset ${runId}`, columns: ['username', 'extraColumn'], rows: [['alice', 'z']] },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(dataset.status).toBe(201);
      createdDatasetIds.push(dataset.data.data._id);

      const tc = await client.post(
        '/api/v1/testrepo',
        {
          TestCaseSummary: `WP-F07a missing+unused case ${runId}`,
          TestCaseDescription: 'x',
          datasetId: dataset.data.data._id,
          TestSteps: [
            { testStep: 'Log in as {{username}}', Expected: 'Redirected as {{unmappedRole}}' },
          ],
        },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(tc.status).toBe(201);
      createdTestCaseIds.push(tc.data.data._id);

      const res = await client.get(`/api/v1/testrepo/${tc.data.data._id}/parameters`, withScope(DEFAULT_PROJECT_ID));
      expect(res.status).toBe(200);
      expect(res.data.data.placeholders).toEqual(['username', 'unmappedRole']);
      expect(res.data.data.columns).toEqual(['username', 'extraColumn']);
      // Single-line break: swapping the `missing`/`unused` filter
      // predicates (or computing `missing` from `columns` instead of
      // `placeholders`) would report 'username' as missing here instead
      // of matched, or fail to flag 'extraColumn' as unused.
      expect(res.data.data.missing).toEqual(['unmappedRole']);
      expect(res.data.data.unused).toEqual(['extraColumn']);
    });

    it('reports every placeholder as missing, and no unused columns, when no dataset is bound', async () => {
      const tc = await client.post(
        '/api/v1/testrepo',
        {
          TestCaseSummary: `WP-F07a unbound case ${runId}`,
          TestCaseDescription: 'x',
          TestSteps: [{ testStep: 'Log in as {{username}}', Expected: 'ok' }],
        },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(tc.status).toBe(201);
      createdTestCaseIds.push(tc.data.data._id);

      const res = await client.get(`/api/v1/testrepo/${tc.data.data._id}/parameters`, withScope(DEFAULT_PROJECT_ID));
      expect(res.status).toBe(200);
      expect(res.data.data.placeholders).toEqual(['username']);
      expect(res.data.data.columns).toEqual([]);
      expect(res.data.data.missing).toEqual(['username']);
      expect(res.data.data.unused).toEqual([]);
    });

    // R4 -- the case most likely to be missed. A shared step's OWN text
    // carries a placeholder that never appears anywhere in the binding
    // case's own TestSteps rows; it only exists once the reference row is
    // expanded into the shared step's real testStep/Expected strings.
    it('finds a placeholder that lives only inside an expanded shared step, and lines it up against the dataset (R4)', async () => {
      const shared = await client.post(
        '/api/v1/sharedstep',
        {
          title: `WP-F07a params shared step ${runId}`,
          steps: [{ testStep: 'Log in as {{role}}', Expected: '{{role}} sees the dashboard' }],
        },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(shared.status).toBe(201);
      createdSharedStepIds.push(shared.data.data._id);

      const dataset = await client.post(
        '/api/v1/dataset',
        { title: `WP-F07a params shared-step dataset ${runId}`, columns: ['username', 'role'], rows: [['alice', 'admin']] },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(dataset.status).toBe(201);
      createdDatasetIds.push(dataset.data.data._id);

      const tc = await client.post(
        '/api/v1/testrepo',
        {
          TestCaseSummary: `WP-F07a params shared-step case ${runId}`,
          TestCaseDescription: 'x',
          datasetId: dataset.data.data._id,
          // The case's OWN step text mentions only 'username'. 'role'
          // exists solely inside the referenced shared step.
          TestSteps: [
            { testStep: 'Open the app as {{username}}', Expected: 'ok' },
            { sharedStepId: shared.data.data._id },
          ],
        },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(tc.status).toBe(201);
      createdTestCaseIds.push(tc.data.data._id);

      const res = await client.get(`/api/v1/testrepo/${tc.data.data._id}/parameters`, withScope(DEFAULT_PROJECT_ID));
      expect(res.status).toBe(200);
      // Single-line break: skipping expandSteps() in the /parameters
      // route (extracting from the raw TestSteps instead) leaves the
      // reference row's testStep/Expected undefined, so 'role' is never
      // found -- placeholders would be just ['username'], and 'role'
      // would wrongly show up as `unused` instead of matched.
      expect(res.data.data.placeholders).toEqual(['username', 'role']);
      expect(res.data.data.columns).toEqual(['username', 'role']);
      expect(res.data.data.missing).toEqual([]);
      expect(res.data.data.unused).toEqual([]);
    });
  });
});

// Suite teardown (WP-110 follow-up) — declared as its own top-level afterAll
// ON PURPOSE, not inside the suite's existing one.
//
// Jest runs afterAll hooks outermost-last, so this fires AFTER the suite's own
// cleanup has finished. Order matters: an earlier attempt called this first,
// which hard-deleted the fixture project before the suite's own teardown tried
// to touch it -- that teardown then logged a warning after the test run had
// ended, and Jest failed the whole suite with "Cannot log after tests are
// done" even though every test passed.
//
// Why this is needed at all: DELETE /api/v1/projects only ARCHIVES (the
// deliberate WP-022 project-deletion-orphaning decision), while
// DELETE /api/v1/organizations hard-deletes. API-only teardown therefore left
// the project behind with its organization gone -- which is where this
// environment's 701 orphaned projects came from. See
// shared/test-utils/fixtureCleanup.js.
afterAll(() => {
  purgeTrackedFixtures();
});
