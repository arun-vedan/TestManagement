// WP-F13 Task 1 — requirement coverage, corrected, unit-tested with every
// cross-service call mocked (same shape as this directory's own
// releaseLens.test.js/planProgress.test.js), so these run fast and
// deterministically without a live stack. Live, hand-verified figures
// against the running containers are the separate check recorded in this
// task's report (handVerifiedFigures.test.js + a manual mongosh census).
//
// Fix round 1: the first cut's classifier read "executed, not failing" as
// EXECUTED_PASSING -- wrong for a case whose only entry is a non-terminal
// status (e.g. 'InProgress'), and wrong for a requirement with two linked
// cases where only one of them ran. The tests below cover both regressions
// plus the corrected precedence (Fail beats an incomplete/unknown verdict
// beats an actual Pass).
//
// Each `it` below documents, in a trailing comment, the single-line
// production change that would make it fail -- the non-vacuity bar this
// programme holds tests to.

jest.mock('@srckube/service-core', () => ({
  requestWithRetry: jest.fn()
}));

jest.mock('../services/serviceUrls', () => ({
  REQUIREMENT_SERVICE: 'requirementservice:3000',
  TESTREPO_SERVICE: 'testreposervice:3000',
  LINK_ISSUE_SERVICE: 'linkissueservice:3000',
  TEST_PLAN_EXECUTION_SERVICE: 'testplanexecutionservice:3000'
}));

const { computeCoverage, classifyRequirementSegment, resolveExecutionSets, SEGMENTS } = require('../services/coverage');
const { requestWithRetry } = require('@srckube/service-core');

const HEADERS = { Authorization: 'Bearer x', 'x-project-id': '1', 'x-correlation-id': 'corr-1' };

// Queues the 4 sequential requestWithRetry responses computeCoverage
// issues, in the exact Promise.all order it issues them: requirements,
// test cases, links, executions.
function mockResponses({ requirements = [], testCases = [], links = [], executions = [] }) {
  requestWithRetry
    .mockResolvedValueOnce({ data: { data: requirements } })
    .mockResolvedValueOnce({ data: { data: testCases } })
    .mockResolvedValueOnce({ data: { data: links } })
    .mockResolvedValueOnce({ data: { data: executions } });
}

describe('computeCoverage', () => {
  beforeEach(() => {
    requestWithRetry.mockReset();
  });

  // R1's whole point: this is premise 1's bug, verbatim. The old code
  // gated "tested" on {linkType:'tests', srcModule:2} -- a predicate zero
  // of 23 live link rows ever matched, because every real link this
  // workbench's UI can create carries linkType:'relates-to'. This is
  // exactly that shape.
  // BREAKS IF: a `if (l.linkType !== 'tests') return;` guard is added back
  // to buildLinkedCaseIdsByReq's link loop.
  it('a requirement linked to a case via a relates-to link counts as tested', async () => {
    mockResponses({
      requirements: [{ reqId: 'Req-1' }],
      testCases: [{ TestCaseId: 'TC-1' }],
      links: [{ linkType: 'relates-to', srcModule: 2, destinationModule: 1, sourceId: 'Req-1', destinationId: 'TC-1' }],
      executions: []
    });

    const result = await computeCoverage(1, HEADERS);

    expect(result.tested).toBe(1);
    expect(result.untested).toBe(0);
    expect(result.segments.notFullyVerified).toBe(1);
  });

  // Premise 3: bidirectionality is a client-side double write, not a
  // backend guarantee -- at least one live link is one-way. This row only
  // exists from the test case's side (test case as sourceId, requirement as
  // destinationId).
  // BREAKS IF: the reverse-direction branch's condition
  // `l.destinationModule === MODULE.REQUIREMENT` is changed to
  // `l.destinationModule === MODULE.TEST_CASE` (silently disabling it).
  it('a requirement linked only through a reverse-direction row still counts', async () => {
    mockResponses({
      requirements: [{ reqId: 'Req-1' }],
      testCases: [{ TestCaseId: 'TC-1' }],
      links: [{ linkType: 'relates-to', srcModule: 1, destinationModule: 2, sourceId: 'TC-1', destinationId: 'Req-1' }],
      executions: []
    });

    const result = await computeCoverage(1, HEADERS);

    expect(result.tested).toBe(1);
    expect(result.segments.notFullyVerified).toBe(1);
  });

  // R7: a case<->case (1<->1) row must be rejected on its OWN module tags,
  // never on whether its id strings happen to look like a requirement and a
  // test case. This row's ids are a real reqId and a real caseId, but both
  // module tags say TEST_CASE(1) -- exactly the shape four live rows have,
  // and exactly the shape R1's "follow any linkType" fix must not also
  // start following.
  // BREAKS IF: the forward branch's condition
  // `l.srcModule === MODULE.REQUIREMENT` is dropped (i.e. the branch
  // becomes `if (l.destinationModule === MODULE.TEST_CASE)`), trusting the
  // far side's module without checking the near side.
  it('a case<->case (1<->1) link is not counted, even when its ids look like a requirement and a case', async () => {
    mockResponses({
      requirements: [{ reqId: 'Req-1' }],
      testCases: [{ TestCaseId: 'TC-1' }],
      links: [{ linkType: 'relates-to', srcModule: 1, destinationModule: 1, sourceId: 'Req-1', destinationId: 'TC-1' }],
      executions: []
    });

    const result = await computeCoverage(1, HEADERS);

    expect(result.tested).toBe(0);
    expect(result.segments.noTestsLinked).toBe(1);
  });

  // R2: every requirement lands in exactly one of the four segments, and
  // the four counts sum to the total -- one requirement per segment here.
  // BREAKS IF: classifyRequirementSegment's final line is changed from
  // `return allPassing ? SEGMENTS.EXECUTED_PASSING : SEGMENTS.NOT_FULLY_VERIFIED;`
  // to always `return SEGMENTS.EXECUTED_PASSING;` (collapses two segments
  // into one, so the total still matches but the individual counts and
  // mutual exclusivity no longer do).
  it('the four segments are mutually exclusive and sum to the total', async () => {
    mockResponses({
      requirements: [{ reqId: 'Req-1' }, { reqId: 'Req-2' }, { reqId: 'Req-3' }, { reqId: 'Req-4' }],
      testCases: [{ TestCaseId: 'TC-2' }, { TestCaseId: 'TC-3' }, { TestCaseId: 'TC-4' }],
      links: [
        // Req-1: no link at all.
        { linkType: 'relates-to', srcModule: 2, destinationModule: 1, sourceId: 'Req-2', destinationId: 'TC-2' },
        { linkType: 'relates-to', srcModule: 2, destinationModule: 1, sourceId: 'Req-3', destinationId: 'TC-3' },
        { linkType: 'relates-to', srcModule: 2, destinationModule: 1, sourceId: 'Req-4', destinationId: 'TC-4' }
      ],
      executions: [
        // TC-2: never executed.
        { TestCases: [{ TestCaseId: 'TC-3', TestStatus: 'Pass' }] },
        { TestCases: [{ TestCaseId: 'TC-4', TestStatus: 'Fail' }] }
      ]
    });

    const result = await computeCoverage(1, HEADERS);

    expect(result.total).toBe(4);
    expect(result.segments).toEqual({
      noTestsLinked: 1,
      notFullyVerified: 1,
      executedFailing: 1,
      executedPassing: 1
    });
    const sum = Object.values(result.segments).reduce((a, b) => a + b, 0);
    expect(sum).toBe(result.total);
    const donutSum = result.breakdown.data.reduce((a, s) => a + s.value, 0);
    expect(donutSum).toBe(result.total);
  });

  // The execution vocabulary is exactly Pass | Fail | No Run
  // (testPlanExecutionService/adapters/normalize.js) -- 'No Run' on every
  // linked case's every entry means "never actually run", not "passing by
  // default".
  // BREAKS IF: resolveExecutionSets' `else if (tc.TestStatus === 'Fail')`
  // branch is changed to an unconditional `else`, treating 'No Run' (or
  // anything that isn't 'Pass') as a failure/pass by default instead of
  // neither.
  it('a requirement whose linked case has run entries all No Run lands in "not fully verified", not "passing"', async () => {
    mockResponses({
      requirements: [{ reqId: 'Req-1' }],
      testCases: [{ TestCaseId: 'TC-1' }],
      links: [{ linkType: 'relates-to', srcModule: 2, destinationModule: 1, sourceId: 'Req-1', destinationId: 'TC-1' }],
      executions: [{ TestCases: [{ TestCaseId: 'TC-1', TestStatus: 'No Run' }, { TestCaseId: 'TC-1', TestStatus: 'No Run' }] }]
    });

    const result = await computeCoverage(1, HEADERS);

    expect(result.segments.notFullyVerified).toBe(1);
    expect(result.segments.executedPassing).toBe(0);
  });

  // Fix round 1, regression (1): the bug the coordinator caught. Two linked
  // cases -- one Pass, one No Run. The OLD classifier called this
  // EXECUTED_PASSING because "at least one ran and none failed" was
  // satisfied by TC-1 alone; the corrected rule requires EVERY linked case
  // to have an actual Pass verdict.
  // BREAKS IF: classifyRequirementSegment's `if (!passingCaseIds.has(caseId))
  // allPassing = false;` line is removed (allPassing then stays true
  // whenever nothing failed, reintroducing the exact bug).
  it('one linked case Pass + one linked case No Run -> not fully verified, not passing', async () => {
    mockResponses({
      requirements: [{ reqId: 'Req-1' }],
      testCases: [{ TestCaseId: 'TC-1' }, { TestCaseId: 'TC-2' }],
      links: [
        { linkType: 'relates-to', srcModule: 2, destinationModule: 1, sourceId: 'Req-1', destinationId: 'TC-1' },
        { linkType: 'relates-to', srcModule: 2, destinationModule: 1, sourceId: 'Req-1', destinationId: 'TC-2' }
      ],
      executions: [
        { TestCases: [{ TestCaseId: 'TC-1', TestStatus: 'Pass' }] },
        { TestCases: [{ TestCaseId: 'TC-2', TestStatus: 'No Run' }] }
      ]
    });

    const result = await computeCoverage(1, HEADERS);

    expect(result.segments.notFullyVerified).toBe(1);
    expect(result.segments.executedPassing).toBe(0);
  });

  // Fix round 1, regression (2): a case whose only entry is 'InProgress' --
  // a real, live status (one project-1 execution has it) that is not a
  // terminal result. 'InProgress' is not 'No Run', so a looser "executed
  // and not failing" rule would call this passing; it hasn't concluded.
  // BREAKS IF: resolveExecutionSets grows a catch-all like
  // `else if (tc.TestStatus && tc.TestStatus !== 'No Run')
  // passingCaseIds.add(tc.TestCaseId);` -- treating any non-'No Run',
  // non-'Fail' status as a pass.
  it('a linked case whose only entry is InProgress -> not fully verified, never passing', async () => {
    mockResponses({
      requirements: [{ reqId: 'Req-1' }],
      testCases: [{ TestCaseId: 'TC-1' }],
      links: [{ linkType: 'relates-to', srcModule: 2, destinationModule: 1, sourceId: 'Req-1', destinationId: 'TC-1' }],
      executions: [{ TestCases: [{ TestCaseId: 'TC-1', TestStatus: 'InProgress' }] }]
    });

    const result = await computeCoverage(1, HEADERS);

    expect(result.segments.notFullyVerified).toBe(1);
    expect(result.segments.executedPassing).toBe(0);
    expect(result.segments.executedFailing).toBe(0);
  });

  // Fix round 1, the important one: an entirely fictional status string
  // that does not exist anywhere in this codebase (not in
  // testPlanExecutionService/adapters/normalize.js's vocabulary, not in any
  // fixture). This exercises the DEFAULT branch of resolveExecutionSets --
  // "anything that isn't an explicit 'Pass'/'Fail' joins neither set" --
  // rather than a value someone could special-case into an enumerated list
  // and call the property satisfied.
  // BREAKS IF: resolveExecutionSets' two `if`/`else if` checks are replaced
  // by anything that defaults an unmatched status into passingCaseIds
  // (e.g. an unconditional `else passingCaseIds.add(tc.TestCaseId);`).
  it('a linked case with a status this vocabulary has never seen -> not fully verified, never passing', async () => {
    mockResponses({
      requirements: [{ reqId: 'Req-1' }],
      testCases: [{ TestCaseId: 'TC-1' }],
      links: [{ linkType: 'relates-to', srcModule: 2, destinationModule: 1, sourceId: 'Req-1', destinationId: 'TC-1' }],
      executions: [{ TestCases: [{ TestCaseId: 'TC-1', TestStatus: 'Zorbulated-9f3' }] }]
    });

    const result = await computeCoverage(1, HEADERS);

    expect(result.segments.notFullyVerified).toBe(1);
    expect(result.segments.executedPassing).toBe(0);
  });

  // R2's precedence: Fail beats Pass. A requirement with one failing and
  // one passing linked case is EXECUTED_FAILING, not EXECUTED_PASSING and
  // not NOT_FULLY_VERIFIED.
  // BREAKS IF: classifyRequirementSegment's `if (anyFailing) { return
  // SEGMENTS.EXECUTED_FAILING; }` early return is removed (falls through to
  // the allPassing check, which would then decide the whole requirement's
  // segment while ignoring the failure entirely).
  it('one linked case Fail + one linked case Pass -> failing (fail beats pass)', async () => {
    mockResponses({
      requirements: [{ reqId: 'Req-1' }],
      testCases: [{ TestCaseId: 'TC-1' }, { TestCaseId: 'TC-2' }],
      links: [
        { linkType: 'relates-to', srcModule: 2, destinationModule: 1, sourceId: 'Req-1', destinationId: 'TC-1' },
        { linkType: 'relates-to', srcModule: 2, destinationModule: 1, sourceId: 'Req-1', destinationId: 'TC-2' }
      ],
      executions: [
        { TestCases: [{ TestCaseId: 'TC-1', TestStatus: 'Pass' }] },
        { TestCases: [{ TestCaseId: 'TC-2', TestStatus: 'Fail' }] }
      ]
    });

    const result = await computeCoverage(1, HEADERS);

    expect(result.segments.executedFailing).toBe(1);
    expect(result.segments.executedPassing).toBe(0);
    expect(result.segments.notFullyVerified).toBe(0);
  });

  // Every linked case has an actual Pass verdict -> EXECUTED_PASSING. Two
  // cases here (not one), so this can't be satisfied by accident the way
  // the old "any executed, none failed" rule could be.
  // BREAKS IF: classifyRequirementSegment's `allPassing` accumulator is
  // initialized to `false` instead of `true` (a fully-passing requirement
  // would then never reach EXECUTED_PASSING at all).
  it('every linked case Pass -> passing', async () => {
    mockResponses({
      requirements: [{ reqId: 'Req-1' }],
      testCases: [{ TestCaseId: 'TC-1' }, { TestCaseId: 'TC-2' }],
      links: [
        { linkType: 'relates-to', srcModule: 2, destinationModule: 1, sourceId: 'Req-1', destinationId: 'TC-1' },
        { linkType: 'relates-to', srcModule: 2, destinationModule: 1, sourceId: 'Req-1', destinationId: 'TC-2' }
      ],
      executions: [
        { TestCases: [{ TestCaseId: 'TC-1', TestStatus: 'Pass' }] },
        { TestCases: [{ TestCaseId: 'TC-2', TestStatus: 'Pass' }] }
      ]
    });

    const result = await computeCoverage(1, HEADERS);

    expect(result.segments.executedPassing).toBe(1);
    expect(result.segments.notFullyVerified).toBe(0);
    expect(result.segments.executedFailing).toBe(0);
  });

  // R6: a project with zero requirements reads as zeros WITH an explanation,
  // never as a bare 0 (which the old `total > 0 ? ... : 0` percent made
  // indistinguishable from "0% of a real, non-empty project").
  // BREAKS IF: the `note` field's ternary is deleted (note always
  // undefined) -- the zeros would still be correct but would no longer
  // "say so".
  it('a project with zero requirements reports zeros and says so, not 100%', async () => {
    mockResponses({ requirements: [], testCases: [], links: [], executions: [] });

    const result = await computeCoverage(1, HEADERS);

    expect(result.total).toBe(0);
    expect(result.tested).toBe(0);
    expect(result.untested).toBe(0);
    expect(result.segments).toEqual({
      noTestsLinked: 0,
      notFullyVerified: 0,
      executedFailing: 0,
      executedPassing: 0
    });
    expect(result.note).toMatch(/no requirements/i);
  });
});

// Fix round 2 (coordinator review, WP-F13 Task 2) -- passingCaseIds/
// failingCaseIds must be built from each case's LATEST status only, never
// from "this status occurred at any point in this case's history". The
// prior "any occurrence, ever" version kept a case in failingCaseIds
// forever once it had failed even once, so a requirement whose only
// linked case failed in the past and has since passed still read as
// EXECUTED_FAILING -- a live-reachable defect (see the coordinator's own
// message: "TC-1 fails in April, passes yesterday"), and worse than a
// tile/table disagreement because traceability.js's row would display that
// same case as 'Pass' right next to a segment claiming a failure exists.
describe('resolveExecutionSets / classifyRequirementSegment (fix round 2 -- latest status wins)', () => {
  const caseIdSet = new Set(['TC-1']);

  // THE bug this fix round exists to close, written so it fails against
  // the pre-fix ("any occurrence, ever") code: a case that failed in the
  // past and has since passed must classify its requirement as
  // EXECUTED_PASSING, never EXECUTED_FAILING.
  // BREAKS IF: resolveExecutionSets goes back to adding a case to
  // failingCaseIds on ANY 'Fail' occurrence (instead of only when 'Fail'
  // is that case's LATEST status) -- e.g. removing the
  // `failingCaseIds.delete(tc.TestCaseId)` eviction before the `if
  // (status === 'Fail')` add.
  it('a case that failed then passed classifies its requirement as executedPassing, not executedFailing', async () => {
    mockResponses({
      requirements: [{ reqId: 'Req-1' }],
      testCases: [{ TestCaseId: 'TC-1' }],
      links: [{ linkType: 'relates-to', srcModule: 2, destinationModule: 1, sourceId: 'Req-1', destinationId: 'TC-1' }],
      executions: [
        { createdAt: '2024-04-01T00:00:00Z', updatedAt: '2024-04-01T00:00:00Z', TestCases: [{ TestCaseId: 'TC-1', TestStatus: 'Fail' }] },
        { createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z', TestCases: [{ TestCaseId: 'TC-1', TestStatus: 'Pass' }] }
      ]
    });

    const result = await computeCoverage(1, HEADERS);

    expect(result.segments.executedPassing).toBe(1);
    expect(result.segments.executedFailing).toBe(0);
  });

  // The mirror case: a case that passed and has since failed classifies as
  // executedFailing, not executedPassing -- proves this is genuinely about
  // recency, not merely "a later fix that only ever moves failures into
  // passing".
  // BREAKS IF: passingCaseIds is never evicted on a later non-'Pass'
  // status (e.g. the `passingCaseIds.delete(tc.TestCaseId)` eviction is
  // removed), so an earlier Pass keeps the case passing forever too.
  it('a case that passed then failed classifies its requirement as executedFailing, not executedPassing', async () => {
    mockResponses({
      requirements: [{ reqId: 'Req-1' }],
      testCases: [{ TestCaseId: 'TC-1' }],
      links: [{ linkType: 'relates-to', srcModule: 2, destinationModule: 1, sourceId: 'Req-1', destinationId: 'TC-1' }],
      executions: [
        { createdAt: '2024-04-01T00:00:00Z', updatedAt: '2024-04-01T00:00:00Z', TestCases: [{ TestCaseId: 'TC-1', TestStatus: 'Pass' }] },
        { createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z', TestCases: [{ TestCaseId: 'TC-1', TestStatus: 'Fail' }] }
      ]
    });

    const result = await computeCoverage(1, HEADERS);

    expect(result.segments.executedFailing).toBe(1);
    expect(result.segments.executedPassing).toBe(0);
  });

  // Opt-in-to-success, re-checked under the new latest-only rule: a case
  // whose latest status is 'InProgress' (a non-terminal status) is NOT
  // passing, even though an EARLIER entry for that same case was an actual
  // Pass. Fix round 1's guarantee must survive fix round 2's change to
  // WHICH occurrence is consulted.
  // BREAKS IF: the `if (status === 'Pass')` check is loosened to treat a
  // case as passing once it has EVER had a Pass, regardless of what its
  // latest status now is.
  it('a case whose latest status is InProgress after an earlier Pass is not passing', () => {
    const executions = [
      { createdAt: '2024-04-01T00:00:00Z', updatedAt: '2024-04-01T00:00:00Z', TestCases: [{ TestCaseId: 'TC-1', TestStatus: 'Pass' }] },
      { createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z', TestCases: [{ TestCaseId: 'TC-1', TestStatus: 'InProgress' }] }
    ];

    const { passingCaseIds, failingCaseIds } = resolveExecutionSets(executions, caseIdSet);

    expect(passingCaseIds.has('TC-1')).toBe(false);
    expect(failingCaseIds.has('TC-1')).toBe(false);
  });

  // Same guarantee against a status this vocabulary has never seen at all,
  // as the LATEST value, after an earlier real Pass -- the default-safe
  // property must hold for an unknown latest status too, not just a known
  // non-terminal one.
  // BREAKS IF: resolveExecutionSets defaults an unrecognised latest status
  // into passingCaseIds (e.g. an `else` branch that assumes "anything that
  // isn't 'Fail' is fine").
  it('a case whose latest status is an unrecognised value after an earlier Pass is not passing', () => {
    const executions = [
      { createdAt: '2024-04-01T00:00:00Z', updatedAt: '2024-04-01T00:00:00Z', TestCases: [{ TestCaseId: 'TC-1', TestStatus: 'Pass' }] },
      { createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z', TestCases: [{ TestCaseId: 'TC-1', TestStatus: 'Zorbulated-9f3' }] }
    ];

    const { passingCaseIds, failingCaseIds } = resolveExecutionSets(executions, caseIdSet);

    expect(passingCaseIds.has('TC-1')).toBe(false);
    expect(failingCaseIds.has('TC-1')).toBe(false);
  });
});

// R3 -- direct unit tests of the shared classifier itself, since WP-F13
// Task 2 (the traceability matrix) imports this exact function rather than
// reimplementing the four-way rule; its contract needs to hold on its own,
// not just through computeCoverage's aggregate counts.
describe('classifyRequirementSegment', () => {
  // BREAKS IF: the `!linkedCaseIds ||` half of the guard is dropped, so an
  // `undefined` linkedCaseIds (a requirement absent from the link map
  // entirely, the common case) throws instead of classifying as unlinked.
  it('classifies an undefined (never-linked) case set as noTestsLinked', () => {
    expect(classifyRequirementSegment(undefined, new Set(), new Set())).toBe(SEGMENTS.NO_TESTS_LINKED);
  });

  // BREAKS IF: `allPassing` is initialized to `false` instead of `true`,
  // so a linked, fully-passing case would never reach executedPassing.
  it('classifies a linked case with an actual Pass verdict as executedPassing', () => {
    const linked = new Set(['TC-1']);
    const passingCaseIds = new Set(['TC-1']);
    expect(classifyRequirementSegment(linked, passingCaseIds, new Set())).toBe(SEGMENTS.EXECUTED_PASSING);
  });
});
