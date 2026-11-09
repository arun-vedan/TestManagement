const axios = require('axios');
const { execSync } = require('child_process');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
// WP-101 -- Mongo credentials come from backend/.env, not from source.
const { mongoUri } = require('../../shared/test-utils/mongoCredentials');

// WP-021b: this service is now tenant-scoped (requireProjectScope() +
// authorize()), same as testRepoService/requirementService/defectService
// -- every authenticated client below now needs X-Project-Id, and Default
// Project (id=1) is the project every fixture this file depends on
// (PLN-1..PLN-7, Run-1..Run-14) was backfilled into. The three
// unauthenticated-client describe blocks above (route-requires-auth,
// correlation-id propagation, merged-route-sets) are deliberately left
// alone -- they assert on keycloak.protect() rejecting a request with no
// token at all, a check that happens before requireProjectScope() ever
// runs, so they are unaffected by this WP.

// Black-box HTTP tests against the running service, not an in-process unit
// test — this is the first test suite for any backend service in this repo
// (Sprint 1.3), and the service's server.js calls app.listen() directly with
// no exported app, so testing the real deployed container (as Kong and the
// frontend actually see it) is more representative than refactoring server.js
// just to enable in-process testing. Requires the Docker stack to be running.
// Base URL defaults to hitting the container directly (bypasses Kong so these
// pass regardless of Kong's current route config); override with
// TEST_BASE_URL to run against the gateway instead.

// WP-101 — THIS SUITE DELIBERATELY BYPASSES KONG, and must keep doing so.
//
// Every other black-box suite in this repo now defaults to Kong
// (http://localhost:8000). This one does not, because it asserts on the
// SERVICE'S OWN auth layer: keycloak.protect() rejecting a request carrying no
// token, and the correlation-id middleware's behaviour on such a request.
// Through the gateway those are unobservable — Kong's jwt plugin answers 401
// before the request ever reaches the service, so the service's 403 and its
// x-correlation-id response header never happen. Pointing this file at Kong
// does not make it stricter, it makes it test Kong instead of the service.
//
// Hence the dedicated *_DIRECT_URL names: a blanket TEST_BASE_URL=<kong> in a
// CI job or a shell must not silently capture this file and turn its
// assertions into assertions about the gateway.
//
// CONSEQUENCE FOR DROPPING THE PUBLISHED HOST PORTS (WP-101's second bullet):
// this file and userService/__tests__/api.test.js are the only two that still
// need to address a service directly. When the host ports go, they must run
// INSIDE the compose network (where `http://<service>:3000` resolves) rather
// than be rewritten — rewriting them would delete the coverage, not move it.
const BASE_URL = process.env.TEST_TPES_DIRECT_URL || 'http://localhost:3017';
const TESTREPO_URL = process.env.TEST_TESTREPO_DIRECT_URL || 'http://localhost:3006';

const client = axios.create({
  baseURL: BASE_URL,
  validateStatus: () => true // we assert on status codes ourselves
});

describe('testPlanExecutionService API (live)', () => {
  describe('every route requires authentication', () => {
    // Direct regression coverage for the exact bug class found in Phase 1 of
    // the strategy doc (fieldsService's duplicate unauthenticated route,
    // defectService's open list/create) — a route silently missing
    // keycloak.protect() should fail this test, not ship unnoticed.
    const protectedRoutes = [
      ['get', '/api/v1/testplan'],
      ['post', '/api/v1/testplan'],
      ['get', '/api/v1/testplan/000000000000000000000000'],
      ['put', '/api/v1/testplan/000000000000000000000000'],
      ['delete', '/api/v1/testplan/000000000000000000000000'],
      ['get', '/api/v1/testplan/wildcardsearch'],
      ['delete', '/api/v1/testplan/bulk'],      // WP-F03b: testPlanExecutionService
      ['patch', '/api/v1/testexecution/bulk'],
      ['delete', '/api/v1/testexecution/bulk'],
      ['get', '/api/v1/testexecution'],
      ['post', '/api/v1/testexecution'],
      ['get', '/api/v1/testexecution/000000000000000000000000'],
      ['put', '/api/v1/testexecution/000000000000000000000000'],
      ['delete', '/api/v1/testexecution/000000000000000000000000'],
      ['get', '/api/v1/testexecution/getexecutiontc?tcid=x&exeid=y'],
      ['put', '/api/v1/testexecution/updateteststep?tcid=x&exeid=y'],
      ['put', '/api/v1/testexecution/updateattachment?tcid=x&exeid=y'],
      ['get', '/api/v1/testexecution/wildcardsearch']
    ];

    it.each(protectedRoutes)('%s %s rejects a request with no token', async (method, path) => {
      const resp = await client.request({ method, url: path });
      // keycloak-connect bearer-only rejects with 403; the important
      // assertion is "not 2xx and not 404" — i.e. the route exists AND is gated.
      expect(resp.status).not.toBeLessThan(400);
      expect(resp.status).not.toBe(404);
    });
  });

  describe('correlation ID propagation', () => {
    it('echoes back a caller-supplied correlation ID even on a rejected request', async () => {
      const resp = await client.get('/api/v1/testplan', {
        headers: { 'x-correlation-id': 'test-suite-trace-id' }
      });

      expect(resp.headers['x-correlation-id']).toBe('test-suite-trace-id');
    });

    it('generates a correlation ID when the caller does not supply one', async () => {
      const resp = await client.get('/api/v1/testexecution');

      expect(resp.headers['x-correlation-id']).toEqual(expect.any(String));
      expect(resp.headers['x-correlation-id'].length).toBeGreaterThan(0);
    });
  });

  describe('both merged route sets are present (proves the strangler-fig merge kept everything)', () => {
    it('serves testplan routes', async () => {
      const resp = await client.get('/api/v1/testplan');
      expect(resp.status).toBe(403);
    });

    it('serves testexecution routes, including the sub-routes unique to the old testExecutionService', async () => {
      const getExecTc = await client.get('/api/v1/testexecution/getexecutiontc?tcid=x&exeid=y');
      const updateStep = await client.put('/api/v1/testexecution/updateteststep?tcid=x&exeid=y');
      const updateAttachment = await client.put('/api/v1/testexecution/updateattachment?tcid=x&exeid=y');

      expect(getExecTc.status).toBe(403);
      expect(updateStep.status).toBe(403);
      expect(updateAttachment.status).toBe(403);
    });
  });

  // Sprint 2.3 (TB-08): functional coverage for the TestCases schema
  // normalization (TestPlan.TestCases: [Mixed] -> typed sub-docs, strict;
  // TestExecution.TestCases: [Mixed] -> typed-but-permissive sub-docs,
  // strict: false). Confirms real, pre-existing data still round-trips
  // through the live service with the new schema in place — not just that
  // the routes are reachable.
  describe('TestCases schema normalization serves real data correctly', () => {
    let client;

    beforeAll(async () => {
      const token = await getServiceToken();
      client = axios.create({
        baseURL: BASE_URL,
        headers: { Authorization: `Bearer ${token}`, [PROJECT_ID_HEADER]: '1' },
        validateStatus: () => true
      });
    });

    it('TestPlan.TestCases entries only carry the 4 declared fields (strict schema, no _id)', async () => {
      const resp = await client.get('/api/v1/testplan');
      expect(resp.status).toBe(200);
      const withCases = resp.data.data.find((p) => p.TestCases.length > 0);
      expect(withCases).toBeDefined();
      withCases.TestCases.forEach((tc) => {
        expect(Object.keys(tc).sort()).toEqual(['TestCaseId', 'TestCaseSummary', 'TestStatus', 'id'].sort());
      });
    });

    it('TestExecution.TestCases preserves nested TestSteps and open-ended dynamicFields on a real enriched record', async () => {
      const resp = await client.get('/api/v1/testexecution');
      expect(resp.status).toBe(200);
      const run7 = resp.data.data.find((r) => r.TestExecutionId === 'Run-7');
      expect(run7).toBeDefined();
      expect(run7.TestCases.length).toBe(3);

      const tc1 = run7.TestCases.find((tc) => tc.TestCaseId === 'TC-1');
      expect(tc1.TestSteps.length).toBe(3);
      tc1.TestSteps.forEach((step) => {
        expect(step).toHaveProperty('testStep');
        expect(step).toHaveProperty('Expected');
        expect(step).toHaveProperty('status');
      });
      // dynamicFields is intentionally Mixed passthrough — just confirm it
      // survived the schema change rather than getting stripped.
      expect(tc1.dynamicFields).toBeTruthy();
    });

    it('TestExecution.TestCases still serves minimal (pre-enrichment) shapes without error', async () => {
      const resp = await client.get('/api/v1/testexecution');
      expect(resp.status).toBe(200);
      const run5 = resp.data.data.find((r) => r.TestExecutionId === 'Run-5');
      expect(run5).toBeDefined();
      const tc1 = run5.TestCases.find((tc) => tc.TestCaseId === 'TC-1');
      expect(tc1).toBeDefined();
      expect(tc1.TestCaseSummary).toEqual(expect.any(String));
    });
  });

  // TD-23 (WP-013): updateTestStep, updateAttachment, and the
  // getExecutionTestCaseDetails enrichment write used to go straight to the
  // DB via a raw MongoDB positional `$set` (TestExecution.updateOne),
  // bypassing Mongoose schema casting/strict enforcement for nested array
  // elements. All 3 now fetch-modify-save through ExecutionTestCaseSchema
  // (strict:false has also been removed -- see the model comment). This
  // block proves the write paths are actually validated now, not just that
  // the routes still respond.
  describe('TD-23: TestCases writes go through schema validation/casting', () => {
    let client;
    let testrepoClient; // WP-F06 Task 3 -- direct calls to testRepoService to build a shared-step fixture
    const createdExeIds = [];
    const createdTestCaseIds = []; // WP-F06 Task 3
    const createdSharedStepIds = []; // WP-F06 Task 3

    // Same MongoDB credentials already committed in plaintext in
    // backend/docker-compose.yml (MONGO_URI_TESTEXECUTION) -- not a new
    // secret, just reused here to seed one DB state the HTTP API itself
    // cannot produce (see the comment on the enrichment test below).
    const MONGO_URI = mongoUri('srckube-testexecution', 'localhost:27017');

    function runMongoEval(script) {
      execSync(
        `docker exec mongodb mongosh "${MONGO_URI}" --quiet --eval '${script.replace(/'/g, "'\\''")}'`,
        { stdio: 'pipe' }
      );
    }

    beforeAll(async () => {
      const token = await getServiceToken();
      client = axios.create({
        baseURL: BASE_URL,
        headers: { Authorization: `Bearer ${token}`, [PROJECT_ID_HEADER]: '1' },
        validateStatus: () => true
      });
      testrepoClient = axios.create({
        baseURL: TESTREPO_URL,
        headers: { Authorization: `Bearer ${token}`, [PROJECT_ID_HEADER]: '1' },
        validateStatus: () => true
      });
    });

    afterAll(async () => {
      // Best-effort cleanup: delete every TestExecution this suite created,
      // so repeat runs don't accumulate scratch data alongside the real
      // Run-1..Run-14 fixtures the rest of the file depends on.
      for (const id of createdExeIds) {
        await client.delete(`/api/v1/testexecution/${id}`);
      }
      // WP-F06 Task 3 -- test cases BEFORE the shared steps they reference:
      // a shared step still in use is refused by testRepoService's delete
      // guard (Task 1, R4), so deleting the referencing test case first is
      // required for this cleanup to actually succeed.
      for (const id of createdTestCaseIds) {
        await testrepoClient.delete(`/api/v1/testrepo/${id}`).catch(() => {});
      }
      for (const id of createdSharedStepIds) {
        await testrepoClient.delete(`/api/v1/sharedstep/${id}`).catch(() => {});
      }
    });

    async function createExecution(testCase) {
      const resp = await client.post('/api/v1/testexecution', {
        TestPlanId: '000000000000000000000000',
        TestCases: [testCase]
      });
      expect(resp.status).toBe(201);
      createdExeIds.push(resp.data.data._id);
      return resp.data.data.TestExecutionId;
    }

    it('updateTestStep round-trips a valid step update through the validated write path', async () => {
      const exeid = await createExecution({
        TestCaseId: 'TC-STEP',
        TestCaseSummary: 'wp-013 step test',
        TestStatus: 'No Run',
        id: 9001
      });

      const updateResp = await client.put(`/api/v1/testexecution/updateteststep?tcid=TC-STEP&exeid=${exeid}`, {
        TestSteps: [{ testStep: 'step 1', Expected: 'expected 1', status: 'Pass' }],
        TestStatus: 'Pass'
      });
      expect(updateResp.status).toBe(200);

      const listResp = await client.get('/api/v1/testexecution');
      const run = listResp.data.data.find((r) => r.TestExecutionId === exeid);
      const tc = run.TestCases.find((t) => t.TestCaseId === 'TC-STEP');
      expect(tc.TestStatus).toBe('Pass');
      expect(tc.TestSteps).toHaveLength(1);
      expect(tc.TestSteps[0]).toMatchObject({ testStep: 'step 1', Expected: 'expected 1', status: 'Pass' });
      // set via the caller's Keycloak token subject, not client input
      expect(tc['Executed By']).toEqual(expect.any(String));
    });

    // WP-F07b Task 2 fix round 1 (review, minor) -- a genuine
    // concurrent-write conflict (Mongoose's own __v optimistic lock,
    // tripped when two overlapping fetch-modify-save cycles race on the
    // SAME row) used to surface as an uncaught 500: a real, actionable
    // "someone else changed this at the same time" condition
    // indistinguishable from a server bug. Fixed by catching VersionError
    // specifically and responding 409 with a retry message, matching the
    // delete-guard 409 precedent elsewhere in this codebase (e.g.
    // testRepoService's deleteDataset).
    //
    // Firing several overlapping updateTestStep calls at the SAME row
    // (not a timing trick against a different one, like the enrichment
    // race elsewhere in this WP) is what makes a real version conflict
    // likely without needing precise timing: each sets TestSteps (an
    // array-typed field), which Mongoose's own versioning treats as a
    // full version bump (mongoose/lib/model.js's operand():
    // `Array.isArray(val)` triggers VERSION_ALL), so whichever of these
    // overlapping writes reads the row before an earlier one's save
    // commits will lose that race and hit VersionError -- proving the
    // catch block is reachable, not just plausible.
    it('a genuine concurrent-write conflict on the SAME row is reported as 409, never an uncaught 500', async () => {
      const exeid = await createExecution({
        TestCaseId: 'TC-CONFLICT',
        TestCaseSummary: 'wp-f07b fix round 1 version-conflict test',
        TestStatus: 'No Run',
        id: 9005
      });

      const attempts = await Promise.all(
        Array.from({ length: 8 }, (_, i) => client.put(`/api/v1/testexecution/updateteststep?tcid=TC-CONFLICT&exeid=${exeid}`, {
          TestSteps: [{ testStep: `step ${i}`, Expected: `expected ${i}`, status: 'Pass' }],
          TestStatus: 'Pass'
        }))
      );

      // Single-line break: removing the try/catch around execution.save()
      // (letting VersionError propagate to asyncHandler's default 500
      // handling) makes this assertion fail the moment any two of these
      // eight overlap.
      for (const resp of attempts) {
        expect([200, 409]).toContain(resp.status);
      }
      const conflicts = attempts.filter((resp) => resp.status === 409);
      expect(conflicts.length).toBeGreaterThan(0);
      for (const conflict of conflicts) {
        expect(conflict.data.success).toBe(false);
        expect(conflict.data.error).toMatch(/retry/i);
      }
    });

    // Non-vacuous by construction: manually verified against the
    // pre-TD-23 controller (git stash of controllers/testexecution.js +
    // models/TestExecution.js, rebuild, same request) that the old raw
    // $set stored `attachment` as the literal object `{ notAnArray: true }`
    // -- Array.isArray() on it is false, so this exact assertion fails
    // against the old code. The declared schema type is
    // `attachment: [mongoose.Schema.Types.Mixed]`; Mongoose's array cast
    // wraps a non-array value into a single-element array, which is what
    // the fetch-modify-save path now produces.
    it('updateAttachment casts a non-array payload to the declared array type (fails against the pre-TD-23 raw $set path)', async () => {
      const exeid = await createExecution({
        TestCaseId: 'TC-ATTACH',
        TestCaseSummary: 'wp-013 attachment test',
        TestStatus: 'No Run',
        id: 9002
      });

      const updateResp = await client.put(`/api/v1/testexecution/updateattachment?tcid=TC-ATTACH&exeid=${exeid}`, {
        attachment: { notAnArray: true }
      });
      expect(updateResp.status).toBe(200);

      const listResp = await client.get('/api/v1/testexecution');
      const run = listResp.data.data.find((r) => r.TestExecutionId === exeid);
      const tc = run.TestCases.find((t) => t.TestCaseId === 'TC-ATTACH');
      expect(Array.isArray(tc.attachment)).toBe(true);
      expect(tc.attachment[0]).toMatchObject({ notAnArray: true });
    });

    it('getExecutionTestCaseDetails enrichment writes through the validated path and no longer writes the dead "Test Status" field', async () => {
      const exeid = await createExecution({
        TestCaseId: 'TC-1',
        TestCaseSummary: 'wp-013 enrich test',
        TestStatus: 'No Run',
        id: 9003
      });

      // createTestExecution always defaults TestSteps to [] (Mongoose array
      // default), which reads truthy, so the enrichment branch in
      // getExecutionTestCaseDetails (`if (!TestCases[0].TestSteps)`) would
      // never trigger through the API alone. Real un-enriched execution
      // records (e.g. Run-5/TC-1 used elsewhere in this file) have the
      // field genuinely absent because they were seeded directly, not via
      // create(). Replicate that one piece of DB state directly so this
      // test exercises the real enrichment branch, exactly as it runs for
      // real pre-enrichment records.
      runMongoEval(
        `db.testexecutions.updateOne({TestExecutionId:"${exeid}"},{$unset:{"TestCases.0.TestSteps":""}})`
      );

      const resp = await client.get(`/api/v1/testexecution/getexecutiontc?tcid=TC-1&exeid=${exeid}`);
      expect(resp.status).toBe(200);
      const tc = resp.data.data[0].TestCases[0];
      expect(tc.TestSteps.length).toBeGreaterThan(0);
      tc.TestSteps.forEach((step) => {
        expect(step.status).toBe('No Run');
      });
      // TD-23: dropped from writes going forward -- this is a *newly*
      // enriched record, so its absence here proves the write site no
      // longer sets it (pre-existing enriched records, e.g. Run-7, keep
      // whatever value they already had; that's untouched by this change).
      expect(tc).not.toHaveProperty('Test Status');
    });

    // WP-F06 Task 3 -- the enrichment fetch from testRepoService must ask
    // for ?expand=steps. ExecutionTestStepSchema (models/TestExecution.js)
    // is strict (testStep/Expected/status only): a reference row's
    // sharedStepId has no home in that schema, so Mongoose silently drops
    // it and the run would snapshot a blank step -- no error, just an
    // empty step baked into the execution. An execution is a point-in-time
    // snapshot by design (what keeps a finished run honest when someone
    // later edits the shared step), so the resolved text must be captured
    // at enrichment time, not resolved live on every read.
    it("snapshots a shared step's rows into the execution, not the unexpanded reference", async () => {
      const shared = await testrepoClient.post('/api/v1/sharedstep', {
        title: `WP-F06 Task 3 login flow ${Date.now()}`,
        steps: [
          { testStep: 'Open /login', Expected: 'Login form is displayed' },
          { testStep: 'Enter valid credentials and submit', Expected: 'Redirected to the dashboard' }
        ]
      });
      expect(shared.status).toBe(201);
      const sharedStepId = shared.data.data._id;
      createdSharedStepIds.push(sharedStepId);

      const tcResp = await testrepoClient.post('/api/v1/testrepo', {
        TestCaseSummary: `WP-F06 Task 3 execution snapshot test ${Date.now()}`,
        TestCaseDescription: 'x',
        TestSteps: [{ sharedStepId }]
      });
      expect(tcResp.status).toBe(201);
      createdTestCaseIds.push(tcResp.data.data._id);
      const tcid = tcResp.data.data.TestCaseId;
      // Sanity: the test case genuinely holds an unexpanded reference, not
      // literal step text -- confirms the fixture actually exercises the
      // reference path this test is about.
      expect(tcResp.data.data.TestSteps).toHaveLength(1);
      expect(tcResp.data.data.TestSteps[0].sharedStepId).toBe(sharedStepId);
      expect(tcResp.data.data.TestSteps[0].testStep).toBeUndefined();

      const exeid = await createExecution({
        TestCaseId: tcid,
        TestCaseSummary: 'wp-f06 task 3 snapshot test',
        TestStatus: 'No Run',
        id: 9004
      });

      // Same reason as the enrichment test above: createTestExecution
      // defaults TestSteps to [], which reads truthy, so the enrichment
      // branch never fires through the API alone unless that field is
      // genuinely absent, as it is for a real pre-enrichment record.
      runMongoEval(
        `db.testexecutions.updateOne({TestExecutionId:"${exeid}"},{$unset:{"TestCases.0.TestSteps":""}})`
      );

      const resp = await client.get(`/api/v1/testexecution/getexecutiontc?tcid=${tcid}&exeid=${exeid}`);
      expect(resp.status).toBe(200);
      const tc = resp.data.data[0].TestCases[0];

      // ExecutionTestStepSchema is strict, so an unexpanded reference lands
      // as a blank step -- this is the assertion that fails if `expand=steps`
      // is ever dropped from the enrichment URL.
      expect(tc.TestSteps).toHaveLength(2);
      expect(tc.TestSteps[0].testStep).toBe('Open /login');
      expect(tc.TestSteps[0].Expected).toBeTruthy();
      expect(tc.TestSteps[1].testStep).toBe('Enter valid credentials and submit');
      expect(tc.TestSteps[1].Expected).toBeTruthy();
    });
  });

  // WP-013b: TestExecution.TestPlanId is a Mongoose ObjectId field (dates
  // to 9a000f1, out of scope to change here). advancedResults() (shared
  // across all 15 services) used to await the built query with no
  // catch/asyncHandler, so a non-castable filter value (a human-readable
  // "PLN-3" instead of a real ObjectId) rejected with an unhandled
  // Mongoose CastError -- next() was never called, the response was never
  // sent, and the client hung until its own timeout while the container
  // sat at 0% CPU (verified live: curl -m 8 against this exact endpoint
  // hit its 8s timeout with no response, container CPU 0% throughout --
  // see EXECUTION_LOG.md's WP-013b report). Both requests below give the
  // client a short timeout deliberately: if this ever regresses, the test
  // must fail fast with a clear timeout error, not stall the whole CI run
  // for 30s+ per case the way the live bug did.
  describe('WP-013b: advancedResults does not hang on a non-castable ObjectId filter', () => {
    let client;

    beforeAll(async () => {
      const token = await getServiceToken();
      client = axios.create({
        baseURL: BASE_URL,
        headers: { Authorization: `Bearer ${token}`, [PROJECT_ID_HEADER]: '1' },
        validateStatus: () => true,
        timeout: 5000
      });
    });

    it('GET /api/v1/testexecution?TestPlanId=PLN-3 returns 400 promptly, naming the field and value, instead of hanging', async () => {
      const start = Date.now();
      const resp = await client.get('/api/v1/testexecution', { params: { TestPlanId: 'PLN-3' } });
      const elapsedMs = Date.now() - start;

      expect(elapsedMs).toBeLessThan(5000);
      expect(resp.status).toBe(400);
      expect(resp.data.error).toEqual(expect.stringContaining('TestPlanId'));
      expect(resp.data.error).toEqual(expect.stringContaining('PLN-3'));
    }, 10000);

    it('a filter value that merely matches nothing (not malformed) still 400s promptly, not just a coincidentally-valid ObjectId case', async () => {
      const start = Date.now();
      const resp = await client.get('/api/v1/testexecution', { params: { TestPlanId: 'PLN-99999' } });
      const elapsedMs = Date.now() - start;

      expect(elapsedMs).toBeLessThan(5000);
      expect(resp.status).toBe(400);
    }, 10000);
  });

  // WP-014: additive TestPlan enrichment fields (objective, scope,
  // entryCriteria, exitCriteria, risk, schedule.{plannedStart,plannedEnd},
  // environment). All optional/free-text except `risk` (closed enum, chosen
  // because a dump of the 6 real TestPlan documents on 2026-08-28 found none
  // carrying any risk-like value -- see model comment) and `schedule`'s two
  // sub-fields (Date, not string -- see model comment for the timezone
  // reasoning). This block proves every field actually persists through the
  // strict schema (an undeclared field would silently be dropped rather than
  // rejected) and round-trips losslessly on both create and update, and that
  // pre-existing plans are untouched.
  describe('WP-014: TestPlan enrichment fields', () => {
    let client;
    const createdPlanIds = [];

    beforeAll(async () => {
      const token = await getServiceToken();
      client = axios.create({
        baseURL: BASE_URL,
        headers: { Authorization: `Bearer ${token}`, [PROJECT_ID_HEADER]: '1' },
        validateStatus: () => true
      });
    });

    afterAll(async () => {
      for (const id of createdPlanIds) {
        await client.delete(`/api/v1/testplan/${id}`);
      }
    });

    const fullEnrichment = {
      objective: 'Verify checkout flow end to end',
      scope: 'Web checkout only; mobile app excluded',
      entryCriteria: 'Staging environment deployed and smoke-tested',
      exitCriteria: 'All P1/P2 test cases pass, no open blocker defects',
      risk: 'High',
      schedule: { plannedStart: '2026-09-01', plannedEnd: '2026-09-15' },
      environment: 'staging'
    };

    it('create round-trips every enrichment field through Kong-equivalent HTTP', async () => {
      const resp = await client.post('/api/v1/testplan', {
        parentId: 0,
        TestCases: [],
        ...fullEnrichment
      });
      expect(resp.status).toBe(201);
      const created = resp.data.data;
      createdPlanIds.push(created._id);

      expect(created.objective).toBe(fullEnrichment.objective);
      expect(created.scope).toBe(fullEnrichment.scope);
      expect(created.entryCriteria).toBe(fullEnrichment.entryCriteria);
      expect(created.exitCriteria).toBe(fullEnrichment.exitCriteria);
      expect(created.risk).toBe(fullEnrichment.risk);
      expect(created.schedule.plannedStart.slice(0, 10)).toBe('2026-09-01');
      expect(created.schedule.plannedEnd.slice(0, 10)).toBe('2026-09-15');
      expect(created.environment).toBe(fullEnrichment.environment);

      // Read back via GET (not just trusting the create response) to prove
      // it actually persisted, not merely echoed.
      const getResp = await client.get(`/api/v1/testplan/${created._id}`);
      expect(getResp.status).toBe(200);
      const fetched = getResp.data.data;
      expect(fetched.objective).toBe(fullEnrichment.objective);
      expect(fetched.risk).toBe(fullEnrichment.risk);
      expect(fetched.schedule.plannedStart.slice(0, 10)).toBe('2026-09-01');
      expect(fetched.schedule.plannedEnd.slice(0, 10)).toBe('2026-09-15');
      expect(fetched.environment).toBe(fullEnrichment.environment);
    });

    it('update (edit) round-trips every enrichment field, overwriting a previously-empty plan', async () => {
      const createResp = await client.post('/api/v1/testplan', { parentId: 0, TestCases: [] });
      expect(createResp.status).toBe(201);
      const planId = createResp.data.data._id;
      createdPlanIds.push(planId);

      // Confirm it truly starts without any enrichment fields set.
      expect(createResp.data.data.objective).toBeUndefined();
      expect(createResp.data.data.risk).toBeUndefined();
      expect(createResp.data.data.schedule).toBeUndefined();

      const updateResp = await client.put(`/api/v1/testplan/${planId}`, fullEnrichment);
      expect(updateResp.status).toBe(200);
      expect(updateResp.data.data.objective).toBe(fullEnrichment.objective);
      expect(updateResp.data.data.risk).toBe(fullEnrichment.risk);
      expect(updateResp.data.data.schedule.plannedStart.slice(0, 10)).toBe('2026-09-01');

      const getResp = await client.get(`/api/v1/testplan/${planId}`);
      expect(getResp.status).toBe(200);
      expect(getResp.data.data.scope).toBe(fullEnrichment.scope);
      expect(getResp.data.data.exitCriteria).toBe(fullEnrichment.exitCriteria);
      expect(getResp.data.data.environment).toBe(fullEnrichment.environment);
      expect(getResp.data.data.schedule.plannedEnd.slice(0, 10)).toBe('2026-09-15');
    });

    it('rejects an out-of-enum risk value', async () => {
      const resp = await client.post('/api/v1/testplan', {
        parentId: 0,
        TestCases: [],
        risk: 'Critical' // not in ['Low','Medium','High']
      });
      expect(resp.status).toBe(400);
      if (resp.data && resp.data.data && resp.data.data._id) {
        createdPlanIds.push(resp.data.data._id);
      }
    });

    it('leaves a pre-existing plan (created before WP-014) with no enrichment fields set', async () => {
      const resp = await client.get('/api/v1/testplan');
      expect(resp.status).toBe(200);
      const pln1 = resp.data.data.find((p) => p.TestPlanId === 'PLN-1');
      expect(pln1).toBeDefined();
      expect(pln1.objective).toBeUndefined();
      expect(pln1.scope).toBeUndefined();
      expect(pln1.entryCriteria).toBeUndefined();
      expect(pln1.exitCriteria).toBeUndefined();
      expect(pln1.risk).toBeUndefined();
      expect(pln1.schedule).toBeUndefined();
      expect(pln1.environment).toBeUndefined();
      // Its pre-existing fields are exactly as they were (see WP-013's
      // dump-checked baseline / the strategy doc's fixture description).
      expect(pln1.TestCases).toHaveLength(1);
      expect(pln1.TestCases[0].TestCaseId).toBe('TC-1');
    });
  });

  // WP-F01 -- wildcard search for test plans (module 3). Before this WP no
  // wildcardsearch route existed anywhere in this service, which is why
  // frontend/src/workbench/search/entitySearchConfigs.ts left modules 3 and
  // 4 undefined.
  describe('GET /api/v1/testplan/wildcardsearch', () => {
    let client;

    beforeAll(async () => {
      const token = await getServiceToken();
      client = axios.create({
        baseURL: BASE_URL,
        headers: { Authorization: `Bearer ${token}`, [PROJECT_ID_HEADER]: '1' },
        validateStatus: () => true
      });
    });

    it('matches a plan by its business id, case-insensitively', async () => {
      const resp = await client.get('/api/v1/testplan/wildcardsearch', { params: { search: 'pln-3' } });
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);
      expect(resp.data.data.map((p) => p.TestPlanId)).toContain('PLN-3');
    });

    it('scopes every result to the caller\'s project', async () => {
      const resp = await client.get('/api/v1/testplan/wildcardsearch', { params: { search: 'PLN' } });
      expect(resp.status).toBe(200);
      expect(resp.data.data.length).toBeGreaterThan(0);
      resp.data.data.forEach((p) => expect(p.projectId).toBe(1));
    });

    it('returns an empty array rather than an error when nothing matches', async () => {
      const resp = await client.get('/api/v1/testplan/wildcardsearch', { params: { search: 'zzz-no-such-plan' } });
      expect(resp.status).toBe(200);
      expect(resp.data.data).toEqual([]);
    });

    it('treats regex metacharacters as literal text, not as a pattern', async () => {
      // A user typing "." means the character, not "match anything". The three
      // pre-existing wildcardsearch routes get this wrong; this one does not.
      const resp = await client.get('/api/v1/testplan/wildcardsearch', { params: { search: '.' } });
      expect(resp.status).toBe(200);
      expect(resp.data.data).toEqual([]);
    });

    it('is not swallowed by the /:id route', async () => {
      // Registration order regression guard: if /wildcardsearch is registered
      // after /:id, Express matches getTestPlan with id="wildcardsearch" and
      // this returns 404 or 500, never 200.
      const resp = await client.get('/api/v1/testplan/wildcardsearch', { params: { search: 'PLN' } });
      expect(resp.status).toBe(200);
    });
  });

  // WP-F01 -- wildcard search for test runs (module 4).
  //
  // FINDING (recorded, not fixed here): TestExecution has no human-readable
  // title field at all -- its only top-level strings are TestExecutionId,
  // assignedTo, source and ciRunUrl. assignedTo is a Keycloak subject UUID,
  // not a name (confirmed against live data), so it is not searchable text
  // either -- nobody types a UUID. So a run is searchable by its business
  // id, and by nothing else (see controllers/testexecution.js's
  // wildcardSearch for the same reasoning). Naming a run is WP-F09.
  describe('GET /api/v1/testexecution/wildcardsearch', () => {
    let client;

    beforeAll(async () => {
      const token = await getServiceToken();
      client = axios.create({
        baseURL: BASE_URL,
        headers: { Authorization: `Bearer ${token}`, [PROJECT_ID_HEADER]: '1' },
        validateStatus: () => true
      });
    });

    it('matches a run by its business id, case-insensitively', async () => {
      const resp = await client.get('/api/v1/testexecution/wildcardsearch', { params: { search: 'run-1' } });
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);
      expect(resp.data.data.map((r) => r.TestExecutionId)).toContain('Run-1');
    });

    it('scopes every result to the caller\'s project', async () => {
      const resp = await client.get('/api/v1/testexecution/wildcardsearch', { params: { search: 'Run' } });
      expect(resp.status).toBe(200);
      expect(resp.data.data.length).toBeGreaterThan(0);
      resp.data.data.forEach((r) => expect(r.projectId).toBe(1));
    });

    it('returns an empty array rather than an error when nothing matches', async () => {
      const resp = await client.get('/api/v1/testexecution/wildcardsearch', { params: { search: 'zzz-no-such-run' } });
      expect(resp.status).toBe(200);
      expect(resp.data.data).toEqual([]);
    });

    it('treats regex metacharacters as literal text, not as a pattern', async () => {
      const resp = await client.get('/api/v1/testexecution/wildcardsearch', { params: { search: '.' } });
      expect(resp.status).toBe(200);
      expect(resp.data.data).toEqual([]);
    });

    it('is not swallowed by the /:id route', async () => {
      const resp = await client.get('/api/v1/testexecution/wildcardsearch', { params: { search: 'Run' } });
      expect(resp.status).toBe(200);
    });
  });
});

// WP-F03 -- bulk operations for test plans (delete only) and test runs
// (assign + delete). The asymmetry is the data model's, not a shortcut:
// TestPlan has neither status nor assignedTo, TestExecution has assignedTo
// but no lifecycle status.
describe('bulk operations on test plans and test runs', () => {
  let client;
  const plans = [];
  const runs = [];

  beforeAll(async () => {
    const token = await getServiceToken();
    client = axios.create({
      baseURL: BASE_URL,
      headers: { Authorization: `Bearer ${token}`, [PROJECT_ID_HEADER]: '1' },
      validateStatus: () => true
    });
    for (let i = 0; i < 2; i += 1) {
      const p = await client.post('/api/v1/testplan', { objective: `WP-F03 bulk plan ${i}` });
      plans.push(p.data.data._id);
      const r = await client.post('/api/v1/testexecution', { TestPlanId: p.data.data._id });
      runs.push(r.data.data._id);
    }
  });

  afterAll(async () => {
    for (const id of runs) await client.delete(`/api/v1/testexecution/${id}`);
    for (const id of plans) await client.delete(`/api/v1/testplan/${id}`);
  });

  it('assigns every run in one call', async () => {
    const resp = await client.patch('/api/v1/testexecution/bulk', { ids: runs, action: 'assign', assignedTo: 'wpf03-user' });
    expect(resp.status).toBe(200);
    expect(resp.data.policy).toBe('all-or-nothing');
    expect(resp.data.updated).toBe(runs.length);
    const one = await client.get(`/api/v1/testexecution/${runs[0]}`);
    expect(one.data.data.assignedTo).toBe('wpf03-user');
  });

  it('assigns nothing when one run id is missing', async () => {
    const resp = await client.patch('/api/v1/testexecution/bulk', {
      ids: [...runs, '000000000000000000000000'],
      action: 'assign',
      assignedTo: 'should-not-apply'
    });
    expect(resp.status).toBe(422);
    const one = await client.get(`/api/v1/testexecution/${runs[0]}`);
    expect(one.data.data.assignedTo).toBe('wpf03-user');
  });

  it('offers no status action for runs -- TestExecution has no lifecycle status', async () => {
    const resp = await client.patch('/api/v1/testexecution/bulk', { ids: runs, action: 'status', status: 'approved' });
    expect(resp.status).toBe(400);
  });

  it('offers no PATCH bulk route for test plans at all', async () => {
    // TestPlan has neither status nor assignedTo, so there is nothing to
    // bulk-update. Only DELETE /bulk exists.
    const resp = await client.patch('/api/v1/testplan/bulk', { ids: plans, action: 'assign', assignedTo: 'x' });
    expect([404, 405]).toContain(resp.status);
  });

  it('bulk-deletes plans, and nothing when one id is missing', async () => {
    const extra = await client.post('/api/v1/testplan', { objective: 'WP-F03 delete fixture' });
    const extraId = extra.data.data._id;

    const bad = await client.delete('/api/v1/testplan/bulk', { data: { ids: [extraId, '000000000000000000000000'] } });
    expect(bad.status).toBe(422);
    expect((await client.get(`/api/v1/testplan/${extraId}`)).status).toBe(200);

    const ok = await client.delete('/api/v1/testplan/bulk', { data: { ids: [extraId] } });
    expect(ok.status).toBe(200);
    expect(ok.data.deleted).toBe(1);
    expect((await client.get(`/api/v1/testplan/${extraId}`)).status).toBe(404);
  });

  it('neither bulk route is swallowed by /:id', async () => {
    const p = await client.delete('/api/v1/testplan/bulk', { data: { ids: [] } });
    expect(p.status).toBe(400); // reached the bulk handler, not a cast error on id='bulk'
    const r = await client.patch('/api/v1/testexecution/bulk', { ids: [], action: 'assign', assignedTo: 'x' });
    expect(r.status).toBe(400);
  });
});

// WP-F05 -- tags. Additive array field; filtering comes free from
// advancedResults copying req.query into the Mongo filter, where a scalar
// matches any element of an array. testPlanExecutionService covers TWO
// models (TestPlan, TestExecution); neither has any required body field
// (confirmed above -- e.g. `{ objective: 'WP-F03 delete fixture' }` alone
// creates a valid TestPlan), so the fixtures below need nothing beyond
// tags/an identifying label.
describe('tags on TestPlan', () => {
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
    for (const id of created) await client.delete(`/api/v1/testplan/${id}`);
  });

  it('accepts tags on create and returns them', async () => {
    const resp = await client.post('/api/v1/testplan', {
      objective: 'WP-F05 tagged plan',
      tags: ['regression', 'smoke']
    });
    expect(resp.status).toBe(201);
    created.push(resp.data.data._id);
    expect(resp.data.data.tags.sort()).toEqual(['regression', 'smoke']);
  });

  it('normalises case and whitespace, and de-duplicates', async () => {
    const resp = await client.post('/api/v1/testplan', {
      objective: 'WP-F05 messy tags',
      tags: ['  Regression ', 'REGRESSION', 'smoke']
    });
    expect(resp.status).toBe(201);
    created.push(resp.data.data._id);
    expect(resp.data.data.tags.sort()).toEqual(['regression', 'smoke']);
  });

  it('rejects a tag containing a space rather than silently rewriting it', async () => {
    const resp = await client.post('/api/v1/testplan', {
      objective: 'WP-F05 bad tag',
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
    const resp = await client.post('/api/v1/testplan', {
      objective: 'WP-F05 scalar tag',
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
    const resp = await client.post('/api/v1/testplan', {
      objective: 'WP-F05 null tags',
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
    const made = await client.post('/api/v1/testplan', {
      objective: 'WP-F05 filter target', tags: [unique]
    });
    created.push(made.data.data._id);

    const resp = await client.get(`/api/v1/testplan?tags=${unique}`);
    expect(resp.status).toBe(200);
    expect(resp.data.data.map((d) => d._id)).toEqual([made.data.data._id]);
  });

  it('leaves an entity created without tags readable, with no tags', async () => {
    const resp = await client.post('/api/v1/testplan', {
      objective: 'WP-F05 untagged'
    });
    expect(resp.status).toBe(201);
    created.push(resp.data.data._id);
    expect(resp.data.data.tags).toEqual([]);
  });

  it('adds a tag on update without disturbing the rest of the document', async () => {
    const made = await client.post('/api/v1/testplan', {
      objective: 'keep me'
    });
    created.push(made.data.data._id);

    const upd = await client.put(`/api/v1/testplan/${made.data.data._id}`, { tags: ['p1'] });
    expect(upd.status).toBe(200);

    const read = await client.get(`/api/v1/testplan/${made.data.data._id}`);
    expect(read.data.data.tags).toEqual(['p1']);
    expect(read.data.data.objective).toBe('keep me');
  });

  // Fix round 1, Fix 3: the create-path tests above never actually proved
  // findOneAndUpdate normalises/rejects the same way create() does -- the
  // only prior evidence was an uncommitted manual script. These two tests
  // are the committed regression guard for that.
  it('normalises messy tags on update, the same as on create', async () => {
    const made = await client.post('/api/v1/testplan', {
      objective: 'WP-F05 update-normalise target'
    });
    created.push(made.data.data._id);

    const upd = await client.put(`/api/v1/testplan/${made.data.data._id}`, {
      tags: ['  MESSY ', 'messy', 'MESSY']
    });
    expect(upd.status).toBe(200);
    expect(upd.data.data.tags).toEqual(['messy']);

    const read = await client.get(`/api/v1/testplan/${made.data.data._id}`);
    expect(read.data.data.tags).toEqual(['messy']);
  });

  it('rejects a bad tag on update, leaving the entity unchanged', async () => {
    const made = await client.post('/api/v1/testplan', {
      objective: 'WP-F05 update-reject target', tags: ['keep']
    });
    created.push(made.data.data._id);

    const upd = await client.put(`/api/v1/testplan/${made.data.data._id}`, { tags: ['bad tag'] });
    expect(upd.status).toBe(400);

    const read = await client.get(`/api/v1/testplan/${made.data.data._id}`);
    expect(read.data.data.tags).toEqual(['keep']);
  });

  // Fix round 2: Fix 1/Fix 2's regression guards previously only covered
  // create() -- the PUT path was untested. This matters specifically for
  // Fix 2, whose whole rationale is a path asymmetry (the setter runs for
  // null on create()/save() but findOneAndUpdate never invokes it at all),
  // so leaving the PUT path unproven left the most fragile part of this
  // design backed only by an uncommitted manual script.
  it('normalises a bare string into a one-element cleaned array on update (Fix 1)', async () => {
    const made = await client.post('/api/v1/testplan', {
      objective: 'WP-F05 update-scalar target'
    });
    created.push(made.data.data._id);

    const upd = await client.put(`/api/v1/testplan/${made.data.data._id}`, { tags: 'REGRESSION' });
    expect(upd.status).toBe(200);

    const read = await client.get(`/api/v1/testplan/${made.data.data._id}`);
    expect(read.data.data.tags).toEqual(['regression']);
  });

  it('rejects tags: null on update with an accurate message, leaving tags unchanged (Fix 2)', async () => {
    const made = await client.post('/api/v1/testplan', {
      objective: 'WP-F05 update-null target', tags: ['keep']
    });
    created.push(made.data.data._id);

    const upd = await client.put(`/api/v1/testplan/${made.data.data._id}`, { tags: null });
    expect(upd.status).toBe(400);
    expect(upd.data.error).toMatch(/null/i);
    expect(upd.data.error).not.toMatch(/whitespace/i);

    const read = await client.get(`/api/v1/testplan/${made.data.data._id}`);
    expect(read.data.data.tags).toEqual(['keep']);
  });
});

describe('tags on TestExecution', () => {
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
    for (const id of created) await client.delete(`/api/v1/testexecution/${id}`);
  });

  it('accepts tags on create and returns them', async () => {
    const resp = await client.post('/api/v1/testexecution', {
      ciRunUrl: 'WP-F05 tagged execution',
      tags: ['regression', 'smoke']
    });
    expect(resp.status).toBe(201);
    created.push(resp.data.data._id);
    expect(resp.data.data.tags.sort()).toEqual(['regression', 'smoke']);
  });

  it('normalises case and whitespace, and de-duplicates', async () => {
    const resp = await client.post('/api/v1/testexecution', {
      ciRunUrl: 'WP-F05 messy tags',
      tags: ['  Regression ', 'REGRESSION', 'smoke']
    });
    expect(resp.status).toBe(201);
    created.push(resp.data.data._id);
    expect(resp.data.data.tags.sort()).toEqual(['regression', 'smoke']);
  });

  it('rejects a tag containing a space rather than silently rewriting it', async () => {
    const resp = await client.post('/api/v1/testexecution', {
      ciRunUrl: 'WP-F05 bad tag',
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
    const resp = await client.post('/api/v1/testexecution', {
      ciRunUrl: 'WP-F05 scalar tag',
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
    const resp = await client.post('/api/v1/testexecution', {
      ciRunUrl: 'WP-F05 null tags',
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
    const made = await client.post('/api/v1/testexecution', {
      ciRunUrl: 'WP-F05 filter target', tags: [unique]
    });
    created.push(made.data.data._id);

    const resp = await client.get(`/api/v1/testexecution?tags=${unique}`);
    expect(resp.status).toBe(200);
    expect(resp.data.data.map((d) => d._id)).toEqual([made.data.data._id]);
  });

  it('leaves an entity created without tags readable, with no tags', async () => {
    const resp = await client.post('/api/v1/testexecution', {
      ciRunUrl: 'WP-F05 untagged'
    });
    expect(resp.status).toBe(201);
    created.push(resp.data.data._id);
    expect(resp.data.data.tags).toEqual([]);
  });

  it('adds a tag on update without disturbing the rest of the document', async () => {
    const made = await client.post('/api/v1/testexecution', {
      ciRunUrl: 'keep me'
    });
    created.push(made.data.data._id);

    const upd = await client.put(`/api/v1/testexecution/${made.data.data._id}`, { tags: ['p1'] });
    expect(upd.status).toBe(200);

    const read = await client.get(`/api/v1/testexecution/${made.data.data._id}`);
    expect(read.data.data.tags).toEqual(['p1']);
    expect(read.data.data.ciRunUrl).toBe('keep me');
  });

  // Fix round 1, Fix 3: the create-path tests above never actually proved
  // findOneAndUpdate normalises/rejects the same way create() does -- the
  // only prior evidence was an uncommitted manual script. These two tests
  // are the committed regression guard for that.
  it('normalises messy tags on update, the same as on create', async () => {
    const made = await client.post('/api/v1/testexecution', {
      ciRunUrl: 'WP-F05 update-normalise target'
    });
    created.push(made.data.data._id);

    const upd = await client.put(`/api/v1/testexecution/${made.data.data._id}`, {
      tags: ['  MESSY ', 'messy', 'MESSY']
    });
    expect(upd.status).toBe(200);
    expect(upd.data.data.tags).toEqual(['messy']);

    const read = await client.get(`/api/v1/testexecution/${made.data.data._id}`);
    expect(read.data.data.tags).toEqual(['messy']);
  });

  it('rejects a bad tag on update, leaving the entity unchanged', async () => {
    const made = await client.post('/api/v1/testexecution', {
      ciRunUrl: 'WP-F05 update-reject target', tags: ['keep']
    });
    created.push(made.data.data._id);

    const upd = await client.put(`/api/v1/testexecution/${made.data.data._id}`, { tags: ['bad tag'] });
    expect(upd.status).toBe(400);

    const read = await client.get(`/api/v1/testexecution/${made.data.data._id}`);
    expect(read.data.data.tags).toEqual(['keep']);
  });

  // Fix round 2: Fix 1/Fix 2's regression guards previously only covered
  // create() -- the PUT path was untested. This matters specifically for
  // Fix 2, whose whole rationale is a path asymmetry (the setter runs for
  // null on create()/save() but findOneAndUpdate never invokes it at all),
  // so leaving the PUT path unproven left the most fragile part of this
  // design backed only by an uncommitted manual script.
  it('normalises a bare string into a one-element cleaned array on update (Fix 1)', async () => {
    const made = await client.post('/api/v1/testexecution', {
      ciRunUrl: 'WP-F05 update-scalar target'
    });
    created.push(made.data.data._id);

    const upd = await client.put(`/api/v1/testexecution/${made.data.data._id}`, { tags: 'REGRESSION' });
    expect(upd.status).toBe(200);

    const read = await client.get(`/api/v1/testexecution/${made.data.data._id}`);
    expect(read.data.data.tags).toEqual(['regression']);
  });

  it('rejects tags: null on update with an accurate message, leaving tags unchanged (Fix 2)', async () => {
    const made = await client.post('/api/v1/testexecution', {
      ciRunUrl: 'WP-F05 update-null target', tags: ['keep']
    });
    created.push(made.data.data._id);

    const upd = await client.put(`/api/v1/testexecution/${made.data.data._id}`, { tags: null });
    expect(upd.status).toBe(400);
    expect(upd.data.error).toMatch(/null/i);
    expect(upd.data.error).not.toMatch(/whitespace/i);

    const read = await client.get(`/api/v1/testexecution/${made.data.data._id}`);
    expect(read.data.data.tags).toEqual(['keep']);
  });
});
