// WP-F13 Task 2 — the traceability matrix, unit-tested with every
// cross-service call mocked (same shape as this directory's own
// coverage.test.js/releaseLens.test.js), so these run fast and
// deterministically without a live stack. Live, hand-verified figures
// against the running containers are the separate check in
// handVerifiedFigures.test.js.
//
// Each `it` below documents, in a trailing comment, the single-line
// production change that would make it fail — the non-vacuity bar this
// programme holds tests to.

jest.mock('@srckube/service-core', () => ({
  requestWithRetry: jest.fn()
}));

jest.mock('../services/serviceUrls', () => ({
  REQUIREMENT_SERVICE: 'requirementservice:3000',
  TESTREPO_SERVICE: 'testreposervice:3000',
  LINK_ISSUE_SERVICE: 'linkissueservice:3000',
  TEST_PLAN_EXECUTION_SERVICE: 'testplanexecutionservice:3000',
  DEFECT_SERVICE: 'defectservice:3000',
  ISTATUS_SERVICE: 'istatusservice:3000'
}));

const { computeTraceability } = require('../services/traceability');
const { computeCoverage, SEGMENTS } = require('../services/coverage');
const { requestWithRetry } = require('@srckube/service-core');

const HEADERS = { Authorization: 'Bearer x', 'x-project-id': '1', 'x-correlation-id': 'corr-1' };

// Queues the 6 sequential requestWithRetry responses computeTraceability
// issues, in the exact Promise.all order it issues them: requirements,
// test cases, links, executions, defects, issue statuses.
function mockTraceabilityResponses({ requirements = [], testCases = [], links = [], executions = [], defects = [], statuses = [] }) {
  requestWithRetry
    .mockResolvedValueOnce({ data: { data: requirements } })
    .mockResolvedValueOnce({ data: { data: testCases } })
    .mockResolvedValueOnce({ data: { data: links } })
    .mockResolvedValueOnce({ data: { data: executions } })
    .mockResolvedValueOnce({ data: { data: defects } })
    .mockResolvedValueOnce({ data: { data: statuses } });
}

// The 4 sequential responses computeCoverage issues (coverage.test.js's
// own helper, reproduced here since the R3 guard test below needs to
// drive BOTH entry points from the same fixture in one test).
function mockCoverageResponses({ requirements = [], testCases = [], links = [], executions = [] }) {
  requestWithRetry
    .mockResolvedValueOnce({ data: { data: requirements } })
    .mockResolvedValueOnce({ data: { data: testCases } })
    .mockResolvedValueOnce({ data: { data: links } })
    .mockResolvedValueOnce({ data: { data: executions } });
}

describe('computeTraceability', () => {
  beforeEach(() => {
    requestWithRetry.mockReset();
  });

  // Step 1's headline scenario: a requirement with 2 linked cases, one
  // passed and one never run at all (no execution record whatsoever, not
  // even an explicit 'No Run' entry). Both cases must appear on the one
  // row, with their own distinct statuses, testCount 2, and R2's
  // "notFullyVerified" segment (one Pass is not EVERY linked case passing).
  // BREAKS IF: the `testCaseRows` map stops including a case with no
  // execution record (e.g. filtering out cases absent from
  // latestStatusByCaseId instead of defaulting their status to 'No Run').
  it('a requirement with 2 linked cases (one Pass, one never run) produces one row with both cases, distinct statuses, testCount 2, notFullyVerified', async () => {
    mockTraceabilityResponses({
      requirements: [{ reqId: 'Req-1', requirementSummary: 'Login must work' }],
      testCases: [
        { TestCaseId: 'TC-1', TestCaseSummary: 'Happy path login' },
        { TestCaseId: 'TC-2', TestCaseSummary: 'Login with bad password' }
      ],
      links: [
        { linkType: 'relates-to', srcModule: 2, destinationModule: 1, sourceId: 'Req-1', destinationId: 'TC-1' },
        { linkType: 'relates-to', srcModule: 2, destinationModule: 1, sourceId: 'Req-1', destinationId: 'TC-2' }
      ],
      executions: [{ TestCases: [{ TestCaseId: 'TC-1', TestStatus: 'Pass' }] }]
      // TC-2: no execution record at all.
    });

    const result = await computeTraceability(1, HEADERS);

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row.reqId).toBe('Req-1');
    expect(row.requirementSummary).toBe('Login must work');
    expect(row.testCount).toBe(2);
    expect(row.testCases.sort((a, b) => a.TestCaseId.localeCompare(b.TestCaseId))).toEqual([
      { TestCaseId: 'TC-1', TestCaseSummary: 'Happy path login', status: 'Pass' },
      { TestCaseId: 'TC-2', TestCaseSummary: 'Login with bad password', status: 'No Run' }
    ]);
    expect(row.segment).toBe(SEGMENTS.NOT_FULLY_VERIFIED);
  });

  // Premise 2 + this task's dedup rule: a defect reachable through BOTH the
  // direct requirement<->defect edge (5<->2) AND the requirement's linked
  // case<->defect edge (5<->1, through TC-1) appears exactly once on the
  // row, not twice. This is the EXACT live shape (Req-1/TC-1/Bug-1 in
  // project 1's seeded data), not a synthetic corner case.
  // BREAKS IF: buildDefectIdsByReq's union uses an array/push instead of a
  // Set (or two separate arrays concatenated without dedup) so the same
  // defectId appears twice in `defects`.
  it('a defect reachable through both the direct requirement edge and the case edge is not double-counted', async () => {
    mockTraceabilityResponses({
      requirements: [{ reqId: 'Req-1', requirementSummary: 'R1' }],
      testCases: [{ TestCaseId: 'TC-1', TestCaseSummary: 'Case 1' }],
      links: [
        { linkType: 'relates-to', srcModule: 2, destinationModule: 1, sourceId: 'Req-1', destinationId: 'TC-1' },
        // 5<->2 direct edge.
        { linkType: 'relates-to', srcModule: 2, destinationModule: 5, sourceId: 'Req-1', destinationId: 'Bug-1' },
        { linkType: 'relates-to', srcModule: 5, destinationModule: 2, sourceId: 'Bug-1', destinationId: 'Req-1' },
        // 5<->1 edge, through the requirement's own linked case.
        { linkType: 'relates-to', srcModule: 1, destinationModule: 5, sourceId: 'TC-1', destinationId: 'Bug-1' },
        { linkType: 'relates-to', srcModule: 5, destinationModule: 1, sourceId: 'Bug-1', destinationId: 'TC-1' }
      ],
      executions: [],
      defects: [{ defectId: 'Bug-1', summary: 'Login is broken', Status: 'New', Severity: 'High' }],
      statuses: [{ id: 1, istatus: 'New' }]
    });

    const result = await computeTraceability(1, HEADERS);

    const row = result.rows[0];
    expect(row.defects).toHaveLength(1);
    expect(row.defects[0]).toEqual({ defectId: 'Bug-1', summary: 'Login is broken', Status: 'New', Severity: 'High' });
  });

  // A defect reached ONLY via the 5<->1 case edge (no direct 5<->2 link at
  // all) must still surface on the row -- proves the case edge is actually
  // traversed, not merely tolerated alongside the direct edge.
  // BREAKS IF: the `caseDefectIds` union step in buildDefectIdsByReq is
  // removed (only the direct reqDefectIds edge kept).
  it('a defect reachable only via the linked case (5<->1) edge still reaches the row', async () => {
    mockTraceabilityResponses({
      requirements: [{ reqId: 'Req-2', requirementSummary: 'R2' }],
      testCases: [{ TestCaseId: 'TC-2', TestCaseSummary: 'Case 2' }],
      links: [
        { linkType: 'relates-to', srcModule: 2, destinationModule: 1, sourceId: 'Req-2', destinationId: 'TC-2' },
        { linkType: 'relates-to', srcModule: 1, destinationModule: 5, sourceId: 'TC-2', destinationId: 'Bug-3' }
      ],
      executions: [],
      defects: [{ defectId: 'Bug-3', summary: 'Case-linked bug', Status: 'Open', Severity: 'High' }],
      statuses: [{ id: 2, istatus: 'Open' }]
    });

    const result = await computeTraceability(1, HEADERS);

    expect(result.rows[0].defects).toEqual([{ defectId: 'Bug-3', summary: 'Case-linked bug', Status: 'Open', Severity: 'High' }]);
  });

  // A link naming a case id that no longer exists in this project's own
  // test-case list (deleted, or never real) must not produce any row
  // entry for it -- premise 4's scoping applied to buildLinkedCaseIdsByReq,
  // which this file imports rather than reimplements.
  // BREAKS IF: the `caseIdSet.has(caseId)` scoping check inside
  // buildLinkedCaseIdsByReq (coverage.js) is ever removed.
  it('a link to a deleted/nonexistent case does not produce a test-case row entry', async () => {
    mockTraceabilityResponses({
      requirements: [{ reqId: 'Req-1', requirementSummary: 'R1' }],
      testCases: [], // TC-DELETED absent -- simulates a deleted case
      links: [{ linkType: 'relates-to', srcModule: 2, destinationModule: 1, sourceId: 'Req-1', destinationId: 'TC-DELETED' }],
      executions: []
    });

    const result = await computeTraceability(1, HEADERS);

    const row = result.rows[0];
    expect(row.testCases).toEqual([]);
    expect(row.testCount).toBe(0);
    expect(row.segment).toBe(SEGMENTS.NO_TESTS_LINKED);
  });

  // A requirement belonging to a DIFFERENT project never appears as a row
  // at all -- requirementService's own list is already project-scoped
  // (requireProjectScope()), so the mocked response here simply never
  // includes it, same as computeCoverage's own equivalent guarantee.
  // BREAKS IF: computeTraceability ever built its requirement list from
  // anywhere other than reqResp (e.g. inferring requirements from the link
  // collection itself, which is unscoped and would leak a foreign
  // requirement id through).
  it('a requirement in another project is absent from the rows entirely', async () => {
    mockTraceabilityResponses({
      // requirementService, already scoped to THIS caller's project,
      // returns only Req-1 -- 'newReq51' (a real requirement id, just in a
      // different project, same shape as premise 4's live example) is
      // simply never in this list.
      requirements: [{ reqId: 'Req-1', requirementSummary: 'R1' }],
      testCases: [{ TestCaseId: 'TC-1', TestCaseSummary: 'Case 1' }],
      links: [
        { linkType: 'relates-to', srcModule: 2, destinationModule: 1, sourceId: 'Req-1', destinationId: 'TC-1' },
        { linkType: 'relates-to', srcModule: 2, destinationModule: 1, sourceId: 'newReq51', destinationId: 'TC-1' }
      ],
      executions: []
    });

    const result = await computeTraceability(1, HEADERS);

    expect(result.rows).toHaveLength(1);
    expect(result.rows.map((r) => r.reqId)).toEqual(['Req-1']);
  });

  // R6: zero requirements -> zero rows, with an explanation, not a bare
  // empty array a reader could mistake for a loading/error state.
  // BREAKS IF: the `note` ternary is deleted.
  it('a project with zero requirements reports zero rows and says so', async () => {
    mockTraceabilityResponses({});

    const result = await computeTraceability(1, HEADERS);

    expect(result.total).toBe(0);
    expect(result.rows).toEqual([]);
    expect(result.note).toMatch(/no requirements/i);
  });

  // R4: testCount is a plain integer count, never a percentage/ratio --
  // this pins the shape so a future change can't quietly turn it into one.
  // BREAKS IF: testCount is computed as anything other than
  // testCaseRows.length (e.g. a pass rate).
  it('testCount is the plain count of linked cases, not a rate', async () => {
    mockTraceabilityResponses({
      requirements: [{ reqId: 'Req-1', requirementSummary: 'R1' }],
      testCases: [{ TestCaseId: 'TC-1' }, { TestCaseId: 'TC-2' }, { TestCaseId: 'TC-3' }],
      links: [
        { linkType: 'relates-to', srcModule: 2, destinationModule: 1, sourceId: 'Req-1', destinationId: 'TC-1' },
        { linkType: 'relates-to', srcModule: 2, destinationModule: 1, sourceId: 'Req-1', destinationId: 'TC-2' },
        { linkType: 'relates-to', srcModule: 2, destinationModule: 1, sourceId: 'Req-1', destinationId: 'TC-3' }
      ],
      executions: [
        { TestCases: [{ TestCaseId: 'TC-1', TestStatus: 'Fail' }] },
        { TestCases: [{ TestCaseId: 'TC-2', TestStatus: 'Pass' }] }
      ]
    });

    const result = await computeTraceability(1, HEADERS);

    expect(result.rows[0].testCount).toBe(3);
    expect(typeof result.rows[0].testCount).toBe('number');
  });

  // R7: a case<->case (1<->1) link must never be traversed by either the
  // linked-case build or the defect edge build, even when its ids look
  // exactly like a real requirement/case/defect id.
  // BREAKS IF: buildLinkedCaseIdsByReq's module-tag check is loosened to
  // trust one side only (same regression coverage.test.js's own R7 test
  // guards against, exercised here through computeTraceability instead).
  it('a case<->case (1<->1) link never produces a linked test case on any row', async () => {
    mockTraceabilityResponses({
      requirements: [{ reqId: 'Req-1', requirementSummary: 'R1' }],
      testCases: [{ TestCaseId: 'TC-1' }, { TestCaseId: 'TC-2' }],
      links: [{ linkType: 'relates-to', srcModule: 1, destinationModule: 1, sourceId: 'TC-1', destinationId: 'TC-2' }],
      executions: []
    });

    const result = await computeTraceability(1, HEADERS);

    expect(result.rows[0].testCases).toEqual([]);
    expect(result.rows[0].segment).toBe(SEGMENTS.NO_TESTS_LINKED);
  });

  // R3's guard, non-vacuously: the row segment (from computeTraceability)
  // and the summary's segment counts (from Task 1's computeCoverage) are
  // asserted to agree for the SAME fixture, IN THE SAME TEST, computed
  // through both entry points. This is what makes R3 structural rather
  // than "two implementations that happen to agree today" -- if either
  // function's classification logic drifts from the other (e.g. one still
  // imports classifyRequirementSegment and one doesn't), this fails.
  // BREAKS IF: computeTraceability stops importing classifyRequirementSegment
  // from ./coverage and reimplements even a slightly different rule (e.g.
  // treating 'InProgress' as passing) -- the row segments would then
  // disagree with computeCoverage's counts for this same data.
  //
  // Fix round 2 (coordinator review) -- strengthened per that review's
  // point 4: agreeing segment COUNTS is not enough to rule out the defect
  // that review caught (passingCaseIds/failingCaseIds built from "any
  // occurrence, ever" instead of the latest status). That defect kept the
  // TOTAL counts correct while making one row internally self-
  // contradictory (segment executedFailing, displayed status Pass) -- a
  // pure count comparison would never have caught it. So this fixture now
  // also includes Req-5/TC-5, which failed in the past and has since
  // passed (the coordinator's own concrete example), and the assertions
  // below check BOTH that counts agree AND that no individual row
  // contradicts its own displayed case statuses.
  it('R3 guard: row segments agree with summary counts, AND no row displays a status that contradicts its own segment', async () => {
    const fixture = {
      requirements: [
        { reqId: 'Req-1', requirementSummary: 'Unlinked' },
        { reqId: 'Req-2', requirementSummary: 'Not fully verified' },
        { reqId: 'Req-3', requirementSummary: 'Failing' },
        { reqId: 'Req-4', requirementSummary: 'All passing' },
        { reqId: 'Req-5', requirementSummary: 'Failed once, passing now' }
      ],
      testCases: [{ TestCaseId: 'TC-2' }, { TestCaseId: 'TC-3' }, { TestCaseId: 'TC-4' }, { TestCaseId: 'TC-5' }],
      links: [
        { linkType: 'relates-to', srcModule: 2, destinationModule: 1, sourceId: 'Req-2', destinationId: 'TC-2' },
        { linkType: 'relates-to', srcModule: 2, destinationModule: 1, sourceId: 'Req-3', destinationId: 'TC-3' },
        { linkType: 'relates-to', srcModule: 2, destinationModule: 1, sourceId: 'Req-4', destinationId: 'TC-4' },
        { linkType: 'relates-to', srcModule: 2, destinationModule: 1, sourceId: 'Req-5', destinationId: 'TC-5' }
      ],
      executions: [
        // TC-2: never run at all -> Req-2 notFullyVerified.
        { TestCases: [{ TestCaseId: 'TC-3', TestStatus: 'Fail' }] }, // Req-3 executedFailing
        { TestCases: [{ TestCaseId: 'TC-4', TestStatus: 'Pass' }] }, // Req-4 executedPassing
        // TC-5: failed in April, passing as of yesterday -- the
        // coordinator's own concrete regression example. The OLD "any
        // occurrence, ever" construction would have kept this in
        // failingCaseIds forever (Req-5 -> executedFailing, displayed
        // status 'Pass' -- self-contradictory). The fixed, latest-only
        // construction reads only the most recent entry -> Pass.
        { createdAt: '2024-04-01T00:00:00Z', updatedAt: '2024-04-01T00:00:00Z', TestCases: [{ TestCaseId: 'TC-5', TestStatus: 'Fail' }] },
        { createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z', TestCases: [{ TestCaseId: 'TC-5', TestStatus: 'Pass' }] }
      ]
    };

    // Entry point 1: the matrix.
    mockTraceabilityResponses(fixture);
    const traceability = await computeTraceability(1, HEADERS);

    requestWithRetry.mockReset();

    // Entry point 2: the summary, over the exact same requirement/case/
    // link/execution data.
    mockCoverageResponses(fixture);
    const coverage = await computeCoverage(1, HEADERS);

    // Assertion 1: the summary's per-segment counts must equal how many
    // matrix rows landed in that same segment.
    const rowCountsBySegment = {
      noTestsLinked: 0,
      notFullyVerified: 0,
      executedFailing: 0,
      executedPassing: 0
    };
    traceability.rows.forEach((row) => {
      rowCountsBySegment[row.segment] += 1;
    });
    expect(rowCountsBySegment).toEqual(coverage.segments);
    // And pinned to the concrete expectation for this fixture, so the
    // agreement isn't vacuously true because every count is 0. Req-5 now
    // lands in executedPassing, not executedFailing -- the fix round 2
    // regression's expected outcome.
    expect(coverage.segments).toEqual({
      noTestsLinked: 1,
      notFullyVerified: 1,
      executedFailing: 1,
      executedPassing: 2
    });

    // Assertion 2 (fix round 2's strengthening): no row's own displayed
    // case statuses may contradict its own segment. This is the check that
    // would actually have caught the "any occurrence, ever" defect -- a
    // count-only comparison could not, since the defect never changed a
    // single total, only which cases backed it.
    // BREAKS IF: resolveExecutionSets (coverage.js) reverts to building
    // passingCaseIds/failingCaseIds from "this status occurred at any
    // point", instead of each case's latest status only -- Req-5's row
    // would then be segment executedFailing while displaying TC-5's
    // status as 'Pass', tripping the executedFailing branch below (no
    // linked case shows a 'Fail' status even though the segment claims
    // one exists) instead of the executedPassing branch.
    traceability.rows.forEach((row) => {
      if (row.segment === SEGMENTS.EXECUTED_PASSING) {
        row.testCases.forEach((tc) => {
          expect(tc.status).toBe('Pass');
        });
      }
      if (row.segment === SEGMENTS.EXECUTED_FAILING) {
        expect(row.testCases.some((tc) => tc.status === 'Fail')).toBe(true);
      }
    });

    // And directly on Req-5: the regression's own headline claim.
    const req5 = traceability.rows.find((r) => r.reqId === 'Req-5');
    expect(req5.segment).toBe(SEGMENTS.EXECUTED_PASSING);
    expect(req5.testCases).toEqual([{ TestCaseId: 'TC-5', TestCaseSummary: undefined, status: 'Pass' }]);
  });
});
