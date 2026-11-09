const axios = require('axios');
const { execSync, spawn } = require('child_process');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
// WP-101 -- Mongo credentials come from backend/.env, not from source.
const { mongoUri } = require('../../shared/test-utils/mongoCredentials');

// WP-F07b Task 2 -- black-box HTTP tests against the running containers,
// same convention as api.test.js/iterationAddressing.test.js: this
// service's server.js has no exported app, so the real deployed container
// is what actually exercises routing, the strict schema's casting, and a
// real cross-service call to testRepoService (the enrichment fetch this
// whole task is about).
//
// This suite proves enrichment EXPANDS a dataset-bound case into one row
// per data row, snapshotting each row's substituted text and its own
// `iterationValues` -- and that everything else (no dataset, an empty
// dataset) still produces exactly the one row it always has.
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';
const TESTREPO_URL = process.env.TEST_TESTREPO_URL || 'http://localhost:8000';
const DEFAULT_PROJECT_ID = '1';

// Same MongoDB credentials already committed in plaintext in
// backend/docker-compose.yml (MONGO_URI_TESTEXECUTION) -- reused here, not
// a new secret, to seed one piece of DB state the HTTP API itself cannot
// produce: createTestExecution always defaults TestSteps to `[]` (a real,
// truthy array), so the enrichment branch (`if (!TestCases[0].TestSteps)`)
// never fires through the API alone. A real un-enriched record has the
// field genuinely ABSENT, so it's removed directly here, exactly as
// api.test.js's TD-23 block already does for the pre-existing enrichment
// test.
const MONGO_URI = mongoUri('srckube-testexecution', 'localhost:27017');

function unsetTestSteps(exeid) {
  execSync(
    `docker exec mongodb mongosh "${MONGO_URI}" --quiet --eval '${`db.testexecutions.updateOne({TestExecutionId:"${exeid}"},{$unset:{"TestCases.0.TestSteps":""}})`.replace(/'/g, "'\\''")}'`,
    { stdio: 'pipe' }
  );
}

// Fix round 1 -- a genuine "plain field write" that does NOT bump the
// document's own `__v`, matching the review's own reproduction exactly.
// Issued as a RAW MongoDB update (positional `$`, matched by TestCaseId),
// not through updateTestStep: that route's own `.set()` also replaces
// `TestSteps` (an ARRAY-typed field) in the same call, and Mongoose
// treats ANY $set of an array-typed VALUE as a full version bump
// (mongoose/lib/model.js's operand(): `Array.isArray(val)` is checked
// BEFORE the "subpath of array" case, so it wins even for a nested path)
// -- that would make this helper accidentally exercise a DIFFERENT
// scenario (a write that DOES bump `__v`, which correctly surfaces as
// the fixed updateTestStep's new 409 instead of data loss, per fix round
// 1 item 3, rather than the silent loss this test is about). A raw
// single-field $set is the precise, unambiguous "does not bump __v" case
// the review's finding depends on.
//
// Deliberately still `docker exec mongodb mongosh`, same as
// unsetTestSteps above, and NOT a raw driver connection from the host
// process straight to localhost:27017 -- tried that first, and it hit the
// exact hazard the task's own constraints name: `lsof -nP -iTCP:27017
// -sTCP:LISTEN` on this machine shows a STRAY native `mongod` ALSO bound
// to 127.0.0.1:27017 (the same port-shadowing class of bug documented
// for Redis in docker-compose.yml), so a host-side client connecting to
// "localhost:27017" is not guaranteed to reach the Docker container at
// all -- it authentication-failed here because it was talking to the
// stray process, not the real one. `docker exec mongodb mongosh` is the
// only path that reaches the actual container unambiguously, hence the
// task's own "NEVER a host mongosh" rule -- which extends to any host
// driver, not literally just the mongosh binary.
//
// A FRESH `docker exec ... mongosh --eval` per call was tried first and
// measured live at ~500-700ms just to start (mongosh's own Node-based CLI
// startup, not the query) -- slower than case A's entire read-to-save
// window even at the MAX_DATASET_ROWS cap, so it could never land inside
// it. Fixed by opening ONE persistent `docker exec -i mongodb mongosh`
// process up front (paying that startup cost once, well before case A's
// request is even fired) and feeding it commands over its own stdin --
// each subsequent command only pays for the actual round trip, typically
// single-digit milliseconds, which is what makes hitting a narrow window
// actually possible while never leaving the mandated docker-exec path.
function startPersistentMongoShell() {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', ['exec', '-i', 'mongodb', 'mongosh', MONGO_URI, '--quiet'], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    proc.on('error', reject);
    // No reliable "ready" signal in --quiet mode -- a fixed startup
    // allowance (comfortably above the ~700ms measured for a fresh
    // invocation, paid here ONCE) is simplest and this only runs before
    // the timing-critical part of the test, not during it.
    setTimeout(() => resolve(proc), 1500);
  });
}

// Runs one JS statement in an already-open persistent shell (see above)
// and resolves once ITS OWN sentinel print appears in stdout -- proof the
// statement actually executed against the real database, not just that
// it was written to the pipe.
function runInPersistentShell(proc, jsStatement) {
  return new Promise((resolve, reject) => {
    const sentinel = `__DONE_${Date.now()}_${Math.random().toString(36).slice(2)}__`;
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString();
      if (buffer.includes(sentinel)) {
        proc.stdout.removeListener('data', onData);
        proc.stderr.removeListener('data', onErr);
        resolve(buffer);
      }
    };
    const onErr = (chunk) => {
      buffer += chunk.toString();
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onErr);
    proc.stdin.write(`${jsStatement}\nprint("${sentinel}")\n`, (err) => {
      if (err) reject(err);
    });
  });
}

describe('WP-F07b Task 2: enrichment expands a bound case into N iterations', () => {
  let client;
  let testrepoClient;
  const createdExeIds = [];
  const createdTestCaseIds = [];
  const createdDatasetIds = [];

  beforeAll(async () => {
    const token = await getServiceToken();
    client = axios.create({
      baseURL: BASE_URL,
      headers: { Authorization: `Bearer ${token}`, [PROJECT_ID_HEADER]: DEFAULT_PROJECT_ID },
      validateStatus: () => true
    });
    testrepoClient = axios.create({
      baseURL: TESTREPO_URL,
      headers: { Authorization: `Bearer ${token}`, [PROJECT_ID_HEADER]: DEFAULT_PROJECT_ID },
      validateStatus: () => true
    });
  });

  afterAll(async () => {
    // Best-effort cleanup, on every path -- never touches the 14 real
    // Run-1..Run-14 fixtures, which this suite never writes to.
    for (const id of createdExeIds) {
      // eslint-disable-next-line no-await-in-loop
      await client.delete(`/api/v1/testexecution/${id}`).catch(() => {});
    }
    // Delete order: test cases before the datasets they reference (a
    // dataset still bound to a case is refused by testRepoService's own
    // delete guard).
    for (const id of createdTestCaseIds) {
      // eslint-disable-next-line no-await-in-loop
      await testrepoClient.delete(`/api/v1/testrepo/${id}`).catch(() => {});
    }
    for (const id of createdDatasetIds) {
      // eslint-disable-next-line no-await-in-loop
      await testrepoClient.delete(`/api/v1/dataset/${id}`).catch(() => {});
    }
  });

  async function createExecution(testCase) {
    const resp = await client.post('/api/v1/testexecution', {
      TestPlanId: '000000000000000000000000',
      TestCases: [testCase]
    });
    expect(resp.status).toBe(201);
    createdExeIds.push(resp.data.data._id);
    return { exeid: resp.data.data.TestExecutionId, mongoId: resp.data.data._id };
  }

  async function createDataset(columns, rows) {
    const resp = await testrepoClient.post('/api/v1/dataset', {
      title: `WP-F07b Task 2 dataset ${Date.now()}-${Math.random()}`,
      columns,
      rows
    });
    expect(resp.status).toBe(201);
    createdDatasetIds.push(resp.data.data._id);
    return resp.data.data._id;
  }

  async function createBoundCase(datasetId, summary) {
    const resp = await testrepoClient.post('/api/v1/testrepo', {
      TestCaseSummary: summary,
      TestCaseDescription: 'x',
      datasetId,
      TestSteps: [
        { testStep: 'Log in as {{role}}', Expected: '{{role}} sees the dashboard' }
      ]
    });
    expect(resp.status).toBe(201);
    createdTestCaseIds.push(resp.data.data._id);
    return resp.data.data.TestCaseId;
  }

  async function createUnboundCase(summary) {
    const resp = await testrepoClient.post('/api/v1/testrepo', {
      TestCaseSummary: summary,
      TestCaseDescription: 'x',
      TestSteps: [
        { testStep: 'Plain step, no placeholders', Expected: 'ok' }
      ]
    });
    expect(resp.status).toBe(201);
    createdTestCaseIds.push(resp.data.data._id);
    return resp.data.data.TestCaseId;
  }

  // -------------------------------------------------------------------
  // REACHABILITY REGRESSION (final review of WP-F07b, 2026-09-14/15).
  //
  // Every test below this point calls unsetTestSteps() to force enrichment
  // to fire, because createTestExecution's stub used to always persist a
  // real, truthy `TestSteps: []` -- Mongoose's own default for an
  // array-typed path -- and `getExecutionTestCaseDetails`'s guard
  // (`if (!TestCases[0].TestSteps)`) can never fire against `![]` (`false`).
  // The final review proved live, through the real API with no Mongo
  // assist anywhere in the flow, that per-iteration expansion was therefore
  // UNREACHABLE by any user-facing path: a real "Create Execution" click
  // followed by opening the case got one stub row back, forever.
  //
  // This test is the one the package was missing: it does NOT call
  // unsetTestSteps. If the model's `TestSteps` default is `[]` (the bug),
  // the row this test opens already has a truthy `TestSteps: []` the
  // instant it's created, the enrichment guard never fires, and every
  // assertion below fails (iterationIndex stays 0 with no iteration 1,
  // TestSteps stays `[]`, not the substituted step text). With the fix --
  // `TestSteps: { type: [ExecutionTestStepSchema], default: undefined }` in
  // models/TestExecution.js -- the field is genuinely absent on a
  // freshly-created stub, the guard fires on first open exactly as it did
  // before the `[Mixed]` -> schema normalisation, and this test passes.
  describe('enrichment fires with NO Mongo assist -- the reachability fix itself', () => {
    it('a real "Create Execution" click followed by opening the case expands into N rows unassisted', async () => {
      const datasetId = await createDataset(['role', 'env'], [['admin', 'prod'], ['viewer', 'staging']]);
      const tcid = await createBoundCase(datasetId, `WP-F07b reachability-fix case ${Date.now()}`);

      // EXACT shape TestPlanDetail.tsx's "Create Execution" button posts --
      // TestCaseId/TestCaseSummary/TestStatus/id, TestPlanId, no TestSteps.
      const { exeid, mongoId } = await createExecution({
        TestCaseId: tcid,
        TestCaseSummary: 'wp-f07b reachability-fix test',
        TestStatus: 'No Run',
        id: 44001
      });

      // NOTE: no unsetTestSteps(exeid) call. This is the whole point.

      const iter0 = await client.get(`/api/v1/testexecution/getexecutiontc?tcid=${tcid}&exeid=${exeid}`);
      expect(iter0.status).toBe(200);
      const row0 = iter0.data.data[0].TestCases[0];
      expect(row0.iterationIndex).toBe(0);
      expect(row0.iterationValues).toMatchObject({ role: 'admin', env: 'prod' });
      expect(row0.TestSteps[0].testStep).toBe('Log in as admin');
      expect(row0.TestSteps[0].status).toBe('No Run');

      const iter1 = await client.get(`/api/v1/testexecution/getexecutiontc?tcid=${tcid}&exeid=${exeid}&iterationIndex=1`);
      expect(iter1.status).toBe(200);
      const row1 = iter1.data.data[0].TestCases[0];
      expect(row1.iterationIndex).toBe(1);
      expect(row1.iterationValues).toMatchObject({ role: 'viewer', env: 'staging' });
      expect(row1.TestSteps[0].testStep).toBe('Log in as viewer');

      // Exactly 2 rows -- not 1 (unreachable) and not more.
      const full = await client.get(`/api/v1/testexecution/${mongoId}`);
      expect(full.data.data.TestCases).toHaveLength(2);

      // Re-opening iteration 0 must not re-fire enrichment a second time --
      // the once-only guard this fix relies on to avoid the duplicate-row
      // trap (the reason the controller-side `|| length === 0` fix was
      // rejected).
      const reopened = await client.get(`/api/v1/testexecution/getexecutiontc?tcid=${tcid}&exeid=${exeid}`);
      expect(reopened.status).toBe(200);
      const fullAfterReopen = await client.get(`/api/v1/testexecution/${mongoId}`);
      expect(fullAfterReopen.data.data.TestCases).toHaveLength(2);
    });

    it('an unbound case still produces exactly ONE row unassisted (the regression guard for every existing run)', async () => {
      const tcid = await createUnboundCase(`WP-F07b reachability-fix unbound case ${Date.now()}`);

      const { exeid, mongoId } = await createExecution({
        TestCaseId: tcid,
        TestCaseSummary: 'wp-f07b reachability-fix unbound test',
        TestStatus: 'No Run',
        id: 44002
      });

      // NOTE: no unsetTestSteps(exeid) call here either.

      const resp = await client.get(`/api/v1/testexecution/getexecutiontc?tcid=${tcid}&exeid=${exeid}`);
      expect(resp.status).toBe(200);
      const row = resp.data.data[0].TestCases[0];
      expect(row.iterationIndex).toBe(0);
      expect(row.TestSteps).toHaveLength(1);
      expect(row.TestSteps[0].testStep).toBe('Plain step, no placeholders');

      const full = await client.get(`/api/v1/testexecution/${mongoId}`);
      expect(full.data.data.TestCases).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------
  // The core case: a 3-row dataset expands into 3 rows.
  // -------------------------------------------------------------------
  describe('a case bound to a dataset with rows', () => {
    it('creates one row per data row, iterationIndex 0..N-1, each with its own substituted text and iterationValues', async () => {
      const datasetId = await createDataset(['role'], [['admin'], ['editor'], ['viewer']]);
      const tcid = await createBoundCase(datasetId, `WP-F07b Task 2 3-row case ${Date.now()}`);

      const { exeid, mongoId } = await createExecution({
        TestCaseId: tcid,
        TestCaseSummary: 'wp-f07b task 2 3-row test',
        TestStatus: 'No Run',
        id: 42001
      });
      unsetTestSteps(exeid);

      // Triggers enrichment (iterationIndex defaults to 0, the only stub
      // that exists pre-expansion) and returns row 0.
      const iter0 = await client.get(`/api/v1/testexecution/getexecutiontc?tcid=${tcid}&exeid=${exeid}`);
      expect(iter0.status).toBe(200);
      const row0 = iter0.data.data[0].TestCases[0];
      expect(row0.iterationIndex).toBe(0);
      expect(row0.iterationValues).toMatchObject({ role: 'admin' });
      expect(row0.TestSteps[0].testStep).toBe('Log in as admin');
      expect(row0.TestSteps[0].Expected).toBe('admin sees the dashboard');
      expect(row0.TestSteps[0].status).toBe('No Run');

      // Iterations 1 and 2 must already exist from that SAME expansion --
      // no re-fetch/re-enrichment needed (TestSteps is already populated).
      const iter1 = await client.get(`/api/v1/testexecution/getexecutiontc?tcid=${tcid}&exeid=${exeid}&iterationIndex=1`);
      expect(iter1.status).toBe(200);
      const row1 = iter1.data.data[0].TestCases[0];
      expect(row1.iterationIndex).toBe(1);
      expect(row1.iterationValues).toMatchObject({ role: 'editor' });
      expect(row1.TestSteps[0].testStep).toBe('Log in as editor');

      const iter2 = await client.get(`/api/v1/testexecution/getexecutiontc?tcid=${tcid}&exeid=${exeid}&iterationIndex=2`);
      expect(iter2.status).toBe(200);
      const row2 = iter2.data.data[0].TestCases[0];
      expect(row2.iterationIndex).toBe(2);
      expect(row2.iterationValues).toMatchObject({ role: 'viewer' });
      expect(row2.TestSteps[0].testStep).toBe('Log in as viewer');

      // There is no iteration 3 -- expansion created exactly N rows, not
      // more.
      const iter3 = await client.get(`/api/v1/testexecution/getexecutiontc?tcid=${tcid}&exeid=${exeid}&iterationIndex=3`);
      expect(iter3.status).toBe(404);

      // Full-document check: the execution now holds exactly 3 TestCases
      // rows for this one bound case, not 1.
      const full = await client.get(`/api/v1/testexecution/${mongoId}`);
      expect(full.data.data.TestCases).toHaveLength(3);
    });

    // R2 -- the property that makes runs honest: editing the dataset AFTER
    // enrichment must never rewrite the already-stored rows. Single-line
    // break this probes: resolving placeholders live at read time (instead
    // of snapshotting at enrichment time) would make this test fail --
    // iteration 0 would read back 'contractor', not the 'admin' it was
    // enriched with.
    it('does not rewrite already-enriched rows when the dataset is edited afterwards', async () => {
      const datasetId = await createDataset(['role'], [['admin'], ['editor']]);
      const tcid = await createBoundCase(datasetId, `WP-F07b Task 2 R2 case ${Date.now()}`);

      const { exeid } = await createExecution({
        TestCaseId: tcid,
        TestCaseSummary: 'wp-f07b task 2 R2 test',
        TestStatus: 'No Run',
        id: 42002
      });
      unsetTestSteps(exeid);

      const before = await client.get(`/api/v1/testexecution/getexecutiontc?tcid=${tcid}&exeid=${exeid}`);
      expect(before.status).toBe(200);
      expect(before.data.data[0].TestCases[0].TestSteps[0].testStep).toBe('Log in as admin');

      const update = await testrepoClient.put(`/api/v1/dataset/${datasetId}`, {
        rows: [['contractor'], ['editor']]
      });
      expect(update.status).toBe(200);

      const after = await client.get(`/api/v1/testexecution/getexecutiontc?tcid=${tcid}&exeid=${exeid}`);
      expect(after.status).toBe(200);
      // Still 'admin' -- the row snapshot from enrichment time, not a live
      // re-resolution against the now-edited dataset.
      expect(after.data.data[0].TestCases[0].TestSteps[0].testStep).toBe('Log in as admin');
      expect(after.data.data[0].TestCases[0].iterationValues).toMatchObject({ role: 'admin' });
    });
  });

  // -------------------------------------------------------------------
  // The most important test in this task: unchanged behaviour for every
  // existing run. Single-line break this probes: dropping the
  // `dataset.rows.length === 0` branch of the guard (i.e. always taking
  // the N-row path) would make this fail -- an unbound case has no
  // datasetId, dataset.rows is [], and the code would try to build ZERO
  // rows instead of falling back to one.
  // -------------------------------------------------------------------
  describe('a case with no dataset bound', () => {
    it('creates exactly one row, iterationIndex 0, unsubstituted (unchanged pre-WP-F07b behaviour)', async () => {
      const tcid = await createUnboundCase(`WP-F07b Task 2 unbound case ${Date.now()}`);

      const { exeid, mongoId } = await createExecution({
        TestCaseId: tcid,
        TestCaseSummary: 'wp-f07b task 2 unbound test',
        TestStatus: 'No Run',
        id: 42003
      });
      unsetTestSteps(exeid);

      const resp = await client.get(`/api/v1/testexecution/getexecutiontc?tcid=${tcid}&exeid=${exeid}`);
      expect(resp.status).toBe(200);
      const row = resp.data.data[0].TestCases[0];
      expect(row.iterationIndex).toBe(0);
      expect(row.iterationValues).toBeFalsy();
      expect(row.TestSteps).toHaveLength(1);
      expect(row.TestSteps[0].testStep).toBe('Plain step, no placeholders');
      expect(row.TestSteps[0].status).toBe('No Run');

      const full = await client.get(`/api/v1/testexecution/${mongoId}`);
      expect(full.data.data.TestCases).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------
  // Zero-row dataset: must behave like unbound, never like "zero rows".
  // Single-line break this probes: a version of the guard that only
  // checked `!baseCase.datasetId` (never the row COUNT) would try to
  // expand into 0 rows here and the execution would end up with none.
  // -------------------------------------------------------------------
  describe('a case bound to a dataset with zero rows', () => {
    it('behaves like an unbound case -- exactly one row, not zero', async () => {
      const datasetId = await createDataset(['role'], []);
      const tcid = await createBoundCase(datasetId, `WP-F07b Task 2 zero-row case ${Date.now()}`);

      const { exeid, mongoId } = await createExecution({
        TestCaseId: tcid,
        TestCaseSummary: 'wp-f07b task 2 zero-row test',
        TestStatus: 'No Run',
        id: 42004
      });
      unsetTestSteps(exeid);

      const resp = await client.get(`/api/v1/testexecution/getexecutiontc?tcid=${tcid}&exeid=${exeid}`);
      expect(resp.status).toBe(200);
      const row = resp.data.data[0].TestCases[0];
      expect(row.iterationIndex).toBe(0);
      expect(row.iterationValues).toBeFalsy();
      // Unsubstituted -- the literal {{placeholder}}, exactly the "behave
      // like unbound" content, not a crash and not an empty TestCases[].
      expect(row.TestSteps[0].testStep).toBe('Log in as {{role}}');

      const full = await client.get(`/api/v1/testexecution/${mongoId}`);
      expect(full.data.data.TestCases).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------
  // Fix round 1 (review, Important) -- the lost-update hazard.
  //
  // The first version of this handler replaced the stub row with N new
  // rows via DocumentArray#splice(), which Mongoose registers as a
  // whole-array modification: save() sent the ENTIRE `TestCases` array
  // back as one `$set`, built from whatever this handler read at the
  // START of the request. A concurrent PLAIN update to a DIFFERENT case
  // in the SAME execution, landing between that read and this save, was
  // silently reverted -- no error, no version conflict (a plain field
  // write never bumps `__v`, so save()'s own optimistic lock never fires).
  //
  // Fixed by never replacing the stub: it stays in place as iteration 0
  // (a targeted $set on just its own subpaths, same mechanism the
  // unbound-case branch above already uses) and the remaining rows are
  // appended with DocumentArray#push (a genuine $push atomic -- confirmed
  // by reading mongoose/lib/types/core_array.js: push() calls
  // `_registerAtomic('$push', ...)`, a different code path from splice()'s
  // `_registerAtomic('$set', this)`). Neither operation reads, rewrites,
  // or even references any OTHER element of the array, so this outcome no
  // longer depends on timing at all -- unlike the bug it replaces, this
  // test does not need to win a race to prove the fix (see below for how
  // it still exercises one anyway, since that is the shape of the bug the
  // review reproduced).
  // -------------------------------------------------------------------
  describe('a concurrent write to a DIFFERENT case is not lost during expansion (fix round 1)', () => {
    // 30 rows: comfortably under the MAX_DATASET_ROWS=100 cap (fix round
    // 1, item 2). Measured live that case A's OWN read-to-save window
    // (between its execution.findOne() and its final save()) is short --
    // tens to a few hundred ms even at dozens of rows, since each
    // `?substitute=<i>` round trip inside the same Docker network is only
    // a few ms -- which is exactly why rawSetCaseStatus uses an
    // already-open persistent shell (see its own comment) rather than a
    // fresh `docker exec` per write: only a near-instant write has any
    // chance of landing inside a window that narrow.
    const ROW_COUNT = 30;
    let mongoShellProc;

    beforeAll(async () => {
      mongoShellProc = await startPersistentMongoShell();
    }, 15000);

    afterAll(() => {
      // Crash-safe: this runs whether the test above passed, failed, or
      // threw partway through -- the persistent shell is never left
      // running past this file's own test run.
      if (mongoShellProc) {
        mongoShellProc.kill();
      }
    });

    it("case A's expansion does not revert case B's concurrent status update", async () => {
      const rows = Array.from({ length: ROW_COUNT }, (_, i) => [`role-${i}`]);
      const datasetId = await createDataset(['role'], rows);
      const tcidA = await createBoundCase(datasetId, `WP-F07b fix round 1 case A ${Date.now()}`);
      const tcidB = await createUnboundCase(`WP-F07b fix round 1 case B ${Date.now()}`);

      // One execution holding BOTH cases -- ids pushed to the shared
      // cleanup arrays (createdExeIds/createdTestCaseIds/createdDatasetIds,
      // cleaned up in this file's afterAll unconditionally) immediately
      // after each resource is confirmed created, before any further
      // assertion in this test can throw -- a crash partway through this
      // test still leaves nothing behind, per the review's caution about
      // its own probe leaking scratch docs on a mid-script crash.
      const createResp = await client.post('/api/v1/testexecution', {
        TestPlanId: '000000000000000000000000',
        TestCases: [
          { TestCaseId: tcidA, TestCaseSummary: 'case A (bound)', TestStatus: 'No Run', id: 43001 },
          { TestCaseId: tcidB, TestCaseSummary: 'case B (unrelated)', TestStatus: 'No Run', id: 43002 }
        ]
      });
      expect(createResp.status).toBe(201);
      const exeid = createResp.data.data.TestExecutionId;
      const mongoId = createResp.data.data._id;
      createdExeIds.push(mongoId);

      // Only case A needs the $unset trick (see the file header comment)
      // -- it's TestCases.0. Case B is TestCases.1 and is left exactly as
      // created; its "concurrent write" below is a raw, targeted
      // TestStatus $set over the persistent shell, standing in for a real
      // tester's plain status update without touching TestSteps (see
      // runInPersistentShell/startPersistentMongoShell's own comments for
      // why that distinction, and that mechanism, both matter here).
      unsetTestSteps(exeid);

      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      // Fire case A's enrichment WITHOUT awaiting it yet, then fire case
      // B's write after the smallest deliberate head start -- long enough
      // that A's handler has very likely reached its own
      // execution.findOne() (a handful of fast steps: the initial
      // aggregate, the base-case fetch, the dataset fetch), short enough
      // that A's own loop (ROW_COUNT more sequential round trips) is
      // still in flight when B's write -- now a live round trip over an
      // already-open shell, not a fresh process -- completes a few ms
      // later. This is what gives the OLD code's bug its best chance to
      // manifest -- the FIXED code's correctness does not depend on this
      // window at all (see the describe-level header comment above): B's
      // write is never at risk regardless of when it lands relative to
      // A's reads/saves.
      const enrichPromise = client.get(`/api/v1/testexecution/getexecutiontc?tcid=${tcidA}&exeid=${exeid}`);
      await sleep(40);
      await runInPersistentShell(
        mongoShellProc,
        `db.testexecutions.updateOne({TestExecutionId:"${exeid}","TestCases.TestCaseId":"${tcidB}"},{$set:{"TestCases.$.TestStatus":"Failed"}})`
      );

      const enrichResp = await enrichPromise;
      expect(enrichResp.status).toBe(200);

      // Case A's own expansion still worked -- this isn't a test that the
      // fix broke the feature to fix the race.
      const full = await client.get(`/api/v1/testexecution/${mongoId}`);
      const caseARows = full.data.data.TestCases.filter((tc) => tc.TestCaseId === tcidA);
      expect(caseARows).toHaveLength(ROW_COUNT);

      // The property under test: case B's concurrent write survives.
      // Single-line break: reverting the fix (replace the stub-in-place
      // push/set with the old splice-and-whole-array-$set) makes this
      // assertion fail -- B reverts to 'No Run', the value case A's stale
      // read of the execution held at the moment it started.
      const caseB = full.data.data.TestCases.find((tc) => tc.TestCaseId === tcidB);
      expect(caseB.TestStatus).toBe('Failed');
    }, 20000);
  });
});
