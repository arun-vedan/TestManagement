const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
// WP-101 -- Mongo credentials come from backend/.env, not from source.
const { mongoUri } = require('../../shared/test-utils/mongoCredentials');

// WP-F07b Task 1 -- black-box HTTP tests against the running service, same
// approach as api.test.js (this service's server.js has no exported app,
// so testing the real deployed container is what actually exercises the
// route wiring, the schema's strict casting, and a real Mongo round trip --
// see api.test.js's header comment for the full reasoning).
//
// This suite proves the addressing change itself: a case within a run is
// now found by TestCaseId PLUS iterationIndex, not TestCaseId alone. Before
// this WP, `.find((tc) => tc.TestCaseId === tcid)` returned the first
// matching row regardless of which iteration a caller meant -- these tests
// are the ones that catch that regressing.
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';

describe('WP-F07b Task 1: TestCases[] addressed by TestCaseId + iterationIndex', () => {
  let client;
  const createdExeIds = [];

  beforeAll(async () => {
    const token = await getServiceToken();
    client = axios.create({
      baseURL: BASE_URL,
      headers: { Authorization: `Bearer ${token}`, [PROJECT_ID_HEADER]: '1' },
      validateStatus: () => true
    });
  });

  afterAll(async () => {
    // Best-effort cleanup: delete every TestExecution this suite created --
    // never touches the 14 real Run-1..Run-14 fixtures, which this suite
    // never writes to.
    for (const id of createdExeIds) {
      // eslint-disable-next-line no-await-in-loop
      await client.delete(`/api/v1/testexecution/${id}`);
    }
  });

  async function createExecution(testCases) {
    const resp = await client.post('/api/v1/testexecution', {
      TestPlanId: '000000000000000000000000',
      TestCases: testCases
    });
    expect(resp.status).toBe(201);
    createdExeIds.push(resp.data.data._id);
    return resp.data.data.TestExecutionId;
  }

  async function getExecution(exeid) {
    const listResp = await client.get('/api/v1/testexecution');
    expect(listResp.status).toBe(200);
    return listResp.data.data.find((r) => r.TestExecutionId === exeid);
  }

  // -------------------------------------------------------------------
  // Step 3 -- the schemas are strict: an undeclared field is silently
  // dropped on save (this is exactly how WP-F06 lost sharedStepTitle
  // through five reviewed tasks). Proves iterationIndex and
  // iterationValues survive a REAL save-and-read, not just an in-memory
  // echo of the create response.
  // -------------------------------------------------------------------
  describe('the new fields round-trip through a real save and a fresh read', () => {
    it('iterationIndex and iterationValues persist through create and a subsequent GET', async () => {
      const exeid = await createExecution([{
        TestCaseId: 'TC-ITER-RT',
        TestCaseSummary: 'round trip test',
        TestStatus: 'No Run',
        id: 9101,
        iterationIndex: 2,
        iterationValues: { role: 'admin', env: 'staging' }
      }]);

      // The create response alone would only prove the field wasn't
      // stripped before the FIRST save -- read it back via a fresh GET
      // (a separate request, a separate hydration from Mongo) to prove it
      // actually persisted rather than merely being echoed back in-memory.
      const run = await getExecution(exeid);
      expect(run).toBeDefined();
      const tc = run.TestCases.find((t) => t.TestCaseId === 'TC-ITER-RT');
      expect(tc).toBeDefined();
      expect(tc.iterationIndex).toBe(2);
      expect(tc.iterationValues).toEqual({ role: 'admin', env: 'staging' });
    });

    it('a row created with no iterationIndex/iterationValues reads back with iterationIndex 0 and no values', async () => {
      const exeid = await createExecution([{
        TestCaseId: 'TC-ITER-DEFAULT',
        TestCaseSummary: 'default iteration test',
        TestStatus: 'No Run',
        id: 9102
      }]);

      const run = await getExecution(exeid);
      const tc = run.TestCases.find((t) => t.TestCaseId === 'TC-ITER-DEFAULT');
      expect(tc).toBeDefined();
      // R1: absent means 0 -- NOT undefined, NOT swallowed by a falsy
      // check anywhere in the read path.
      expect(tc.iterationIndex).toBe(0);
      expect(tc.iterationValues).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------
  // Step 1 -- the test the whole package exists for: two rows sharing one
  // TestCaseId, different iterationIndex, independently addressable. This
  // fails today (pre-fix) because .find() returns the first match, so
  // updating iteration 1 actually lands on iteration 0.
  // -------------------------------------------------------------------
  describe('two iterations of the same TestCaseId are independently addressable', () => {
    async function createTwoIterationRun(prefix) {
      // Reachability fix (final review of WP-F07b, 2026-09-14/15): `TC-${prefix}`
      // is a fabricated TestCaseId that was never created via testRepoService --
      // this describe block is testing ADDRESSING (which row a given
      // iterationIndex resolves to), not enrichment. Before the fix,
      // `getExecutionTestCaseDetails`'s enrichment guard could never fire (a
      // freshly-created stub's `TestSteps` was always a truthy `[]`), so a GET
      // against this fake tcid harmlessly returned the row as-is. Now that the
      // guard actually fires on a genuinely-absent `TestSteps`, a GET here
      // would try to fetch `TC-${prefix}` from testRepoService and 500 (it
      // doesn't exist). Declaring `TestSteps` explicitly marks these rows
      // already-enriched -- the same shape a real post-enrichment row has --
      // so the fixture keeps testing addressing only, exactly as before.
      return createExecution([
        {
          TestCaseId: `TC-${prefix}`,
          TestCaseSummary: 'iteration 0 (viewer)',
          TestStatus: 'No Run',
          id: 9200,
          iterationIndex: 0,
          iterationValues: { role: 'viewer' },
          TestSteps: []
        },
        {
          TestCaseId: `TC-${prefix}`,
          TestCaseSummary: 'iteration 1 (admin)',
          TestStatus: 'No Run',
          id: 9201,
          iterationIndex: 1,
          iterationValues: { role: 'admin' },
          TestSteps: []
        }
      ]);
    }

    it('updating iteration 1 leaves iteration 0 untouched (updateteststep)', async () => {
      const exeid = await createTwoIterationRun('IND1');

      const upd = await client.put(
        `/api/v1/testexecution/updateteststep?tcid=TC-IND1&exeid=${exeid}&iterationIndex=1`,
        { TestSteps: [{ testStep: 'step', Expected: 'expected', status: 'Fail' }], TestStatus: 'Fail' }
      );
      expect(upd.status).toBe(200);
      expect(upd.data.data.matchedCount).toBe(1);
      expect(upd.data.data.modifiedCount).toBe(1);

      const run = await getExecution(exeid);
      const iter0 = run.TestCases.find((t) => t.TestCaseId === 'TC-IND1' && t.iterationIndex === 0);
      const iter1 = run.TestCases.find((t) => t.TestCaseId === 'TC-IND1' && t.iterationIndex === 1);
      expect(iter0.TestStatus).toBe('No Run'); // untouched
      expect(iter1.TestStatus).toBe('Fail'); // the one we targeted
    });

    // TRAP 2's mirror: iterationIndex 0 must be addressable on its own,
    // not just "the row you get when you don't ask for iteration 1". If a
    // falsy check anywhere treated 0 as "no iteration specified" and fell
    // through to matching TestCaseId alone, this would still update
    // whichever row .find() hits first -- which happens to BE iteration 0
    // here, so this test also fails loudly (asserting iteration 1
    // unchanged) if that bug is present, rather than passing by accident.
    it('updating iteration 0 leaves iteration 1 untouched, and iteration 0 is reachable by an EXPLICIT ?iterationIndex=0', async () => {
      const exeid = await createTwoIterationRun('IND0');

      const upd = await client.put(
        `/api/v1/testexecution/updateteststep?tcid=TC-IND0&exeid=${exeid}&iterationIndex=0`,
        { TestSteps: [{ testStep: 'step', Expected: 'expected', status: 'Pass' }], TestStatus: 'Pass' }
      );
      expect(upd.status).toBe(200);
      expect(upd.data.data.modifiedCount).toBe(1);

      const run = await getExecution(exeid);
      const iter0 = run.TestCases.find((t) => t.TestCaseId === 'TC-IND0' && t.iterationIndex === 0);
      const iter1 = run.TestCases.find((t) => t.TestCaseId === 'TC-IND0' && t.iterationIndex === 1);
      expect(iter0.TestStatus).toBe('Pass');
      expect(iter1.TestStatus).toBe('No Run'); // untouched
    });

    // Deliberately stored with iteration 0's row LAST in the array (2, 1,
    // 0), not first. If the falsy-zero trap were present as "if
    // (iterationIndex) filter, else match TestCaseId alone", a request for
    // iteration 0 would fall through to Array.prototype.find()'s natural
    // first-match -- which would silently hit iteration 2, not iteration 0
    // -- and this is the one arrangement that catches it: with iteration 0
    // array-first (the two-iteration fixture above), that same bug would
    // coincidentally still return the right element and this class of test
    // would pass for the wrong reason.
    it('iteration 0 is addressed correctly even when it is NOT the first row in the array', async () => {
      const exeid = await createExecution([
        { TestCaseId: 'TC-ORDER', TestCaseSummary: 'iteration 2', TestStatus: 'No Run', id: 9210, iterationIndex: 2 },
        { TestCaseId: 'TC-ORDER', TestCaseSummary: 'iteration 1', TestStatus: 'No Run', id: 9211, iterationIndex: 1 },
        { TestCaseId: 'TC-ORDER', TestCaseSummary: 'iteration 0', TestStatus: 'No Run', id: 9212, iterationIndex: 0 }
      ]);

      const upd = await client.put(
        `/api/v1/testexecution/updateteststep?tcid=TC-ORDER&exeid=${exeid}&iterationIndex=0`,
        { TestSteps: [{ testStep: 'step', Expected: 'expected', status: 'Pass' }], TestStatus: 'Pass' }
      );
      expect(upd.status).toBe(200);
      expect(upd.data.data.modifiedCount).toBe(1);

      const run = await getExecution(exeid);
      const rows = run.TestCases.filter((t) => t.TestCaseId === 'TC-ORDER');
      const iter2 = rows.find((t) => t.iterationIndex === 2);
      const iter1 = rows.find((t) => t.iterationIndex === 1);
      const iter0 = rows.find((t) => t.iterationIndex === 0);
      expect(iter2.TestStatus).toBe('No Run'); // untouched -- would be hit by a first-match fallback bug
      expect(iter1.TestStatus).toBe('No Run'); // untouched
      expect(iter0.TestStatus).toBe('Pass'); // the one actually targeted
    });

    it('updateattachment also addresses by iteration -- attaching to iteration 1 leaves iteration 0 untouched', async () => {
      const exeid = await createTwoIterationRun('ATT1');

      const upd = await client.put(
        `/api/v1/testexecution/updateattachment?tcid=TC-ATT1&exeid=${exeid}&iterationIndex=1`,
        { attachment: [{ name: 'iteration-1-evidence.png' }] }
      );
      expect(upd.status).toBe(200);
      expect(upd.data.data.modifiedCount).toBe(1);

      const run = await getExecution(exeid);
      const iter0 = run.TestCases.find((t) => t.TestCaseId === 'TC-ATT1' && t.iterationIndex === 0);
      const iter1 = run.TestCases.find((t) => t.TestCaseId === 'TC-ATT1' && t.iterationIndex === 1);
      expect(Array.isArray(iter0.attachment) ? iter0.attachment.length : 0).toBe(0);
      expect(iter1.attachment).toHaveLength(1);
      expect(iter1.attachment[0]).toMatchObject({ name: 'iteration-1-evidence.png' });
    });

    it('getexecutiontc returns the requested iteration only, not whichever row matches TestCaseId first', async () => {
      const exeid = await createTwoIterationRun('GET1');

      const resp0 = await client.get(`/api/v1/testexecution/getexecutiontc?tcid=TC-GET1&exeid=${exeid}&iterationIndex=0`);
      const resp1 = await client.get(`/api/v1/testexecution/getexecutiontc?tcid=TC-GET1&exeid=${exeid}&iterationIndex=1`);
      expect(resp0.status).toBe(200);
      expect(resp1.status).toBe(200);
      expect(resp0.data.data[0].TestCases[0].TestCaseSummary).toBe('iteration 0 (viewer)');
      expect(resp1.data.data[0].TestCases[0].TestCaseSummary).toBe('iteration 1 (admin)');
      expect(resp0.data.data[0].TestCases[0].iterationValues).toEqual({ role: 'viewer' });
      expect(resp1.data.data[0].TestCases[0].iterationValues).toEqual({ role: 'admin' });
    });
  });

  // -------------------------------------------------------------------
  // "A request with no iteration resolves to 0" + "existing single-row
  // documents keep working unchanged" -- the backward-compatibility half
  // of Step 1. No caller has been updated to send iterationIndex yet
  // (Task 4, frontend, is out of scope here), so every existing call site
  // must keep working exactly as before.
  // -------------------------------------------------------------------
  describe('omitting iterationIndex resolves to 0 -- unchanged behaviour for every pre-existing caller', () => {
    it('updateteststep with no iterationIndex query param updates the (single, iteration-0) row', async () => {
      const exeid = await createExecution([{
        TestCaseId: 'TC-NOARG',
        TestCaseSummary: 'no iteration arg test',
        TestStatus: 'No Run',
        id: 9300
      }]);

      const upd = await client.put(`/api/v1/testexecution/updateteststep?tcid=TC-NOARG&exeid=${exeid}`, {
        TestSteps: [{ testStep: 'step', Expected: 'expected', status: 'Pass' }],
        TestStatus: 'Pass'
      });
      expect(upd.status).toBe(200);
      expect(upd.data.data.modifiedCount).toBe(1);

      const run = await getExecution(exeid);
      const tc = run.TestCases.find((t) => t.TestCaseId === 'TC-NOARG');
      expect(tc.TestStatus).toBe('Pass');
    });

    it('getexecutiontc with no iterationIndex query param still returns the single row', async () => {
      const exeid = await createExecution([{
        TestCaseId: 'TC-1', // a real, enrichable TestCaseId (used by other suites too)
        TestCaseSummary: 'no iteration arg getexecutiontc test',
        TestStatus: 'No Run',
        id: 9301
      }]);

      const resp = await client.get(`/api/v1/testexecution/getexecutiontc?tcid=TC-1&exeid=${exeid}`);
      expect(resp.status).toBe(200);
      expect(resp.data.data[0].TestCases).toHaveLength(1);
      expect(resp.data.data[0].TestCases[0].TestCaseId).toBe('TC-1');
    });
  });

  // -------------------------------------------------------------------
  // Input validation -- same "canonical non-negative integer only"
  // contract F07a already established for `?substitute=`, so a malformed
  // value is rejected loudly rather than silently resolving to iteration 0
  // and landing a write on the wrong row.
  // -------------------------------------------------------------------
  describe('a malformed iterationIndex is rejected, not silently coerced', () => {
    it.each([['-1'], ['abc'], ['1.5'], ['01'], ['0x1'], [' 1'], ['']])(
      'rejects iterationIndex=%s with 400',
      async (bad) => {
        const exeid = await createExecution([{
          TestCaseId: 'TC-BADITER',
          TestCaseSummary: 'malformed iteration test',
          TestStatus: 'No Run',
          id: 9400
        }]);

        const resp = await client.put(
          `/api/v1/testexecution/updateteststep?tcid=TC-BADITER&exeid=${exeid}&iterationIndex=${encodeURIComponent(bad)}`,
          { TestSteps: [], TestStatus: 'Pass' }
        );
        expect(resp.status).toBe(400);
      }
    );
  });

  // -------------------------------------------------------------------
  // Pre-existing (pre-backfill-shaped) data: a row genuinely missing
  // iterationIndex in storage (simulated the same way api.test.js
  // simulates a pre-enrichment record: seeded via create() then the field
  // removed directly in Mongo) must still be addressable as iteration 0 --
  // proves caseIterationQuery's $in:[0,null] handling, not just the
  // schema default on the create path.
  // -------------------------------------------------------------------
  describe('a row with iterationIndex genuinely absent in storage is still addressed as iteration 0', () => {
    const { execSync } = require('child_process');
    const MONGO_URI = mongoUri('srckube-testexecution', 'localhost:27017');

    function runMongoEval(script) {
      execSync(
        `docker exec mongodb mongosh "${MONGO_URI}" --quiet --eval '${script.replace(/'/g, "'\\''")}'`,
        { stdio: 'pipe' }
      );
    }

    it('updateteststep with ?iterationIndex=0 (or omitted) reaches a row whose iterationIndex field is unset', async () => {
      const exeid = await createExecution([{
        TestCaseId: 'TC-PREMIGRATE',
        TestCaseSummary: 'pre-migration shape test',
        TestStatus: 'No Run',
        id: 9500
      }]);

      // create() stamps the schema default (iterationIndex: 0) explicitly
      // into storage -- $unset it to simulate a genuinely pre-backfill
      // document, the shape the backfill script (and caseIterationQuery's
      // null-handling) exists for.
      runMongoEval(
        `db.testexecutions.updateOne({TestExecutionId:"${exeid}"},{$unset:{"TestCases.0.iterationIndex":""}})`
      );

      const upd = await client.put(
        `/api/v1/testexecution/updateteststep?tcid=TC-PREMIGRATE&exeid=${exeid}&iterationIndex=0`,
        { TestSteps: [{ testStep: 'step', Expected: 'expected', status: 'Pass' }], TestStatus: 'Pass' }
      );
      expect(upd.status).toBe(200);
      expect(upd.data.data.matchedCount).toBe(1);
      expect(upd.data.data.modifiedCount).toBe(1);

      const run = await getExecution(exeid);
      const tc = run.TestCases.find((t) => t.TestCaseId === 'TC-PREMIGRATE');
      expect(tc.TestStatus).toBe('Pass');
    });
  });
});
