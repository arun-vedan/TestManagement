// WP-F15/F18 Task 4 — the release lens, unit-tested with every
// cross-service call mocked (same shape as this directory's own
// planProgress.test.js), so these run fast and deterministically in CI
// without a live stack. Live, fixture-backed verification against the
// running containers is the separate manual verification recorded in this
// task's report (mongosh-verified before/after counts) -- these tests
// prove the AGGREGATION LOGIC itself: given a fixed set of mocked
// responses, does computeReleaseLens produce exactly the right numbers.

jest.mock('@srckube/service-core', () => ({
  requestWithRetry: jest.fn(),
  CORRELATION_HEADER: 'x-correlation-id'
}));

jest.mock('../services/serviceUrls', () => ({
  REQUIREMENT_SERVICE: 'requirementservice:3000',
  TESTREPO_SERVICE: 'testreposervice:3000',
  DEFECT_SERVICE: 'defectservice:3000',
  TEST_PLAN_EXECUTION_SERVICE: 'testplanexecutionservice:3000',
  LINK_ISSUE_SERVICE: 'linkissueservice:3000',
  RELEASE_SERVICE: 'releaseservice:3000',
  ISTATUS_SERVICE: 'istatusservice:3000'
}));

const { computeReleaseLens } = require('../services/releaseLens');
const { requestWithRetry } = require('@srckube/service-core');

const HEADERS = { Authorization: 'Bearer x', 'x-project-id': '1', 'x-correlation-id': 'corr-1' };

// Queues up the 10 sequential requestWithRetry responses computeReleaseLens
// issues, in the exact order it issues them: the release lookup, then the
// Promise.all of [srcLinks, destLinks, requirements, testCases, defects,
// istatus, testplans, testexecutions, allLinks]. `allLinks` (WP-F15b Task 1,
// R5) is the single unfiltered link-collection fetch used to derive the
// case -> requirement hop; it is appended LAST so every pre-existing test
// above keeps its original 9 positional mocks unshifted.
function mockResponses({
  release,
  srcLinks = [],
  destLinks = [],
  requirements = [],
  testCases = [],
  defects = [],
  statuses = [],
  plans = [],
  executions = [],
  allLinks = []
}) {
  requestWithRetry
    .mockResolvedValueOnce({ data: { data: release ? [release] : [] } }) // GET /releases?releaseId=
    .mockResolvedValueOnce({ data: { data: srcLinks } })
    .mockResolvedValueOnce({ data: { data: destLinks } })
    .mockResolvedValueOnce({ data: { data: requirements } })
    .mockResolvedValueOnce({ data: { data: testCases } })
    .mockResolvedValueOnce({ data: { data: defects } })
    .mockResolvedValueOnce({ data: { data: statuses } })
    .mockResolvedValueOnce({ data: { data: plans } })
    .mockResolvedValueOnce({ data: { data: executions } })
    .mockResolvedValueOnce({ data: { data: allLinks } });
}

describe('computeReleaseLens', () => {
  beforeEach(() => {
    // mockReset (not clearAllMocks): different scenarios below consume a
    // different NUMBER of queued mockResolvedValueOnce calls (the "release
    // not found" case short-circuits after just 1), so any calls left
    // queued from a prior test must be thrown away, not just have their
    // call-count history cleared, or the next test's real calls would
    // start consuming leftover mock data from the previous one.
    requestWithRetry.mockReset();
  });

  // Breaks if the projectId/scope forwarding to releaseService's own
  // project-scoped list route is ever dropped: without it, a release
  // belonging to another project would resolve instead of returning null.
  it('a release not found in this project (foreign project, or never existed) is invisible: returns null, not an empty lens', async () => {
    mockResponses({ release: null });

    const result = await computeReleaseLens('REL-999', HEADERS);

    expect(result).toBeNull();
    // Only the release lookup should have been attempted -- no link graph
    // or downstream service call happens for a release this lens can't
    // even see. (Breaks if a future change reorders the release check
    // after the Promise.all.)
    expect(requestWithRetry).toHaveBeenCalledTimes(1);
    // The scoping proof itself: the release lookup must actually carry the
    // caller's project header through to releaseService, since THAT header
    // (not any client-side filter here) is what makes a foreign-project
    // release resolve to nothing. Breaks if that forwarding is ever
    // dropped (e.g. `headers: {}` instead of `headers`).
    expect(requestWithRetry.mock.calls[0][0].headers).toBe(HEADERS);
  });

  // R5: a release with nothing linked reports zeros AND SAYS SO (an
  // explicit denominator on every count), never a bare/ambiguous zero and
  // never an error.
  it('a release with nothing linked reports zeros, with denominators, not an error', async () => {
    mockResponses({
      release: { releaseId: 'REL-1', name: 'Empty Release', status: 'planned', linkedTestPlanIds: [] }
    });

    const result = await computeReleaseLens('REL-1', HEADERS);

    expect(result).not.toBeNull();
    // WP-F15b Task 1: derived sibling keys ship alongside the untouched
    // explicit ones, zeroed and explicit about it (R2/R4) -- not omitted.
    expect(result.requirements).toEqual({ linkedCount: 0, linked: [], derivedCount: 0, derived: [] });
    expect(result.testCases).toEqual({ linkedCount: 0, linked: [], derivedCount: 0, derived: [] });
    expect(result.defects.linkedCount).toBe(0);
    expect(result.testPlans).toEqual({ configuredCount: 0, linkedCount: 0, unresolvedCount: 0, linked: [] });
    expect(result.links).toEqual({
      rawLinkRowsSeen: 0,
      distinctCounterparts: 0,
      resolvedCount: 0,
      unresolvedCount: 0,
      ignoredOtherModuleCount: 0,
      // Fix round (Finding 4): the new denominator-caveat pair, present and
      // false/undefined -- not omitted -- for the ordinary untruncated case.
      derivationTruncated: false,
      note: undefined
    });
    // Says so: an explicit note distinguishing "nothing ran" from "0%
    // passed", not a bare null/0 that reads as ambiguous.
    expect(result.executions).toMatchObject({ executed: 0, passed: 0, failed: 0, blocked: 0, passRatePercent: null });
    expect(result.executions.note).toMatch(/no executed test cases/);
  });

  // The headline scenario from the task brief: two linked defects and one
  // linked plan reports exactly that -- plus a THIRD defect-shaped link
  // whose destination no longer exists, proving constraint 1 (resolve-only
  // links) rather than merely asserting it. Breaks if the link-traversal
  // (collectCounterparts, or the requirement/testCase/defect Set lookups)
  // is ever removed or shortcut to "count raw link rows".
  it('two linked defects and one linked (resolved) test plan report exactly that, and a link to a since-deleted defect is excluded', async () => {
    mockResponses({
      release: { releaseId: 'REL-2', name: 'Real Release', status: 'in-progress', linkedTestPlanIds: ['plan-a', 'plan-b'] },
      // Forward links (release as source): two real defects, plus one
      // dangling reference to a defect that no longer exists anywhere in
      // this project's defect list below (defectsResp has no 'Bug-DELETED').
      srcLinks: [
        { sourceId: 'REL-2', srcModule: 6, destinationId: 'Bug-1', destinationModule: 5 },
        { sourceId: 'REL-2', srcModule: 6, destinationId: 'Bug-DELETED', destinationModule: 5 }
      ],
      // Reverse link (release as destination) for the second defect --
      // exercises the "query both directions" requirement directly: this
      // defect is ONLY visible via the destLinks query, never srcLinks.
      destLinks: [{ sourceId: 'Bug-2', srcModule: 5, destinationId: 'REL-2', destinationModule: 6 }],
      defects: [
        { defectId: 'Bug-1', summary: 'First', Status: 1, Severity: 'High' },
        { defectId: 'Bug-2', summary: 'Second', Status: 8, Severity: 'Minor' }
        // 'Bug-DELETED' deliberately absent -- simulates the endpoint
        // having been deleted after the link was created.
      ],
      statuses: [
        { id: 1, istatus: 'New' },
        { id: 8, istatus: 'Closed' }
      ],
      // Two configured plan ids; only 'plan-a' resolves to a real TestPlan
      // below -- 'plan-b' simulates a deleted plan, same resolve-only-what-
      // exists rule applied to the OTHER linking mechanism.
      plans: [{ _id: 'plan-a', TestPlanId: 'PLN-1' }],
      executions: [
        {
          TestPlanId: 'plan-a',
          TestCases: [
            { TestCaseId: 'TC-1', TestStatus: 'Pass' },
            { TestCaseId: 'TC-2', TestStatus: 'Fail' },
            { TestCaseId: 'TC-3', TestStatus: 'No Run' }
          ]
        },
        // An execution against the UNRESOLVED plan -- must not be counted,
        // proving executions are reached only THROUGH a resolved plan, not
        // matched by TestPlanId string alone.
        { TestPlanId: 'plan-b', TestCases: [{ TestCaseId: 'TC-9', TestStatus: 'Pass' }] }
      ]
    });

    const result = await computeReleaseLens('REL-2', HEADERS);

    expect(result.defects.linkedCount).toBe(2);
    expect(result.defects.linked.map((d) => d.defectId).sort()).toEqual(['Bug-1', 'Bug-2']);
    expect(result.links.distinctCounterparts).toBe(3); // Bug-1, Bug-DELETED, Bug-2
    expect(result.links.resolvedCount).toBe(2);
    expect(result.links.unresolvedCount).toBe(1); // Bug-DELETED, excluded

    const byStatus = {};
    result.defects.byStatus.categories.forEach((c, i) => {
      byStatus[c] = result.defects.byStatus.series[0].data[i];
    });
    expect(byStatus).toEqual({ New: 1, Closed: 1 });

    expect(result.testPlans.configuredCount).toBe(2);
    expect(result.testPlans.linkedCount).toBe(1);
    expect(result.testPlans.unresolvedCount).toBe(1);
    expect(result.testPlans.linked).toEqual([{ _id: 'plan-a', TestPlanId: 'PLN-1' }]);

    // Only plan-a's execution counted -- plan-b's is unreachable (plan-b
    // never resolved), proving traversal happens THROUGH the resolved plan
    // set, not by a bare TestPlanId string match against every execution.
    expect(result.executions).toMatchObject({ executed: 2, passed: 1, failed: 1, blocked: 0, passRatePercent: 50 });
  });

  // Directional coverage: a link visible ONLY as a one-way document (no
  // mirrored reverse row -- the real, live shape confirmed for one of the
  // 11 logical links in this dataset) is still counted exactly once, from
  // whichever side has the document.
  it('a one-way link (visible from only one direction) is still counted once', async () => {
    mockResponses({
      release: { releaseId: 'REL-3', name: 'One-way', status: 'planned', linkedTestPlanIds: [] },
      srcLinks: [{ sourceId: 'REL-3', srcModule: 6, destinationId: 'Req-1', destinationModule: 2 }],
      destLinks: [],
      requirements: [{ reqId: 'Req-1', requirementSummary: 'Only one document links to this' }]
    });

    const result = await computeReleaseLens('REL-3', HEADERS);

    expect(result.requirements.linkedCount).toBe(1);
    expect(result.links.rawLinkRowsSeen).toBe(1);
    expect(result.links.distinctCounterparts).toBe(1);
  });

  // A mirrored pair (the ordinary client double-write) must collapse to
  // ONE logical member, not two -- otherwise every normal link would be
  // double-counted.
  it('a mirrored (forward + reverse) pair for the same counterpart counts as one linked test case', async () => {
    mockResponses({
      release: { releaseId: 'REL-4', name: 'Mirrored', status: 'planned', linkedTestPlanIds: [] },
      srcLinks: [{ sourceId: 'REL-4', srcModule: 6, destinationId: 'TC-1', destinationModule: 1 }],
      destLinks: [{ sourceId: 'TC-1', srcModule: 1, destinationId: 'REL-4', destinationModule: 6 }],
      testCases: [{ TestCaseId: 'TC-1', TestCaseSummary: 'Login works' }]
    });

    const result = await computeReleaseLens('REL-4', HEADERS);

    expect(result.testCases.linkedCount).toBe(1);
    expect(result.links.rawLinkRowsSeen).toBe(2); // both documents seen
    expect(result.links.distinctCounterparts).toBe(1); // collapsed to one
  });

  // Fix round (Finding 4, MINOR) -- the allLinks fetch (used for the case ->
  // requirement hop) is the one link fetch in this function that is NOT
  // project-scoped, capped at limit: 10000, and accumulates across every
  // tenant. advancedResults() (backend/shared/service-core/middleware/
  // advancedResults.js) sets `pagination.next` on its own response whenever
  // more documents exist than the page it returned -- the only signal
  // available that rows fell off the cutoff. Breaks if that signal is read
  // from the wrong response, or read but not carried through to the
  // returned `links` object.
  it('reports links.derivationTruncated (with a note) when the unscoped allLinks fetch is capped short of the full collection', async () => {
    requestWithRetry
      .mockResolvedValueOnce({ data: { data: [{ releaseId: 'REL-18', name: 'Truncated', status: 'planned', linkedTestPlanIds: [] }] } }) // release
      .mockResolvedValueOnce({ data: { data: [] } }) // srcLinks
      .mockResolvedValueOnce({ data: { data: [] } }) // destLinks
      .mockResolvedValueOnce({ data: { data: [] } }) // requirements
      .mockResolvedValueOnce({ data: { data: [] } }) // testCases
      .mockResolvedValueOnce({ data: { data: [] } }) // defects
      .mockResolvedValueOnce({ data: { data: [] } }) // statuses
      .mockResolvedValueOnce({ data: { data: [] } }) // plans
      .mockResolvedValueOnce({ data: { data: [] } }) // executions
      .mockResolvedValueOnce({
        data: { success: true, count: 10000, pagination: { next: { page: 2, limit: 10000 } }, data: [] }
      }); // allLinks -- advancedResults' own truncation signal

    const result = await computeReleaseLens('REL-18', HEADERS);

    expect(result.links.derivationTruncated).toBe(true);
    expect(result.links.note).toMatch(/more link rows exist/);
  });

  // WP-F15b Task 1: the lens derives membership through attached plans
  // (premise 3/7) rather than requiring a human to link every case by
  // hand. These tests cover the brief's Step 1 list one-for-one.
  describe('derived membership (WP-F15b Task 1)', () => {
    // Breaks if the plan -> case traversal (resolvedPlans[].TestCases) is
    // ever dropped, or if a derived case is miscounted as explicit.
    it('a release with one attached plan containing 3 cases reports 3 derived cases and 0 explicit', async () => {
      mockResponses({
        release: { releaseId: 'REL-10', name: 'Plan-driven', status: 'planned', linkedTestPlanIds: ['plan-x'] },
        testCases: [
          { TestCaseId: 'TC-1', TestCaseSummary: 'One' },
          { TestCaseId: 'TC-2', TestCaseSummary: 'Two' },
          { TestCaseId: 'TC-3', TestCaseSummary: 'Three' }
        ],
        plans: [
          {
            _id: 'plan-x',
            TestPlanId: 'PLN-3',
            TestCases: [
              { TestCaseId: 'TC-1', TestCaseSummary: 'One', TestStatus: 'Pass' },
              { TestCaseId: 'TC-2', TestCaseSummary: 'Two', TestStatus: 'Fail' },
              { TestCaseId: 'TC-3', TestCaseSummary: 'Three', TestStatus: 'No Run' }
            ]
          }
        ]
      });

      const result = await computeReleaseLens('REL-10', HEADERS);

      expect(result.testCases.linkedCount).toBe(0);
      expect(result.testCases.linked).toEqual([]);
      expect(result.testCases.derivedCount).toBe(3);
      expect(result.testCases.derived.map((tc) => tc.TestCaseId).sort()).toEqual(['TC-1', 'TC-2', 'TC-3']);
      // R2: says WHY -- the attached plan that put it there.
      result.testCases.derived.forEach((tc) => {
        expect(tc.via).toEqual([{ _id: 'plan-x', TestPlanId: 'PLN-3' }]);
      });
    });

    // R2's dedup rule: an assertion outranks an inference. Breaks if the
    // explicit/derived dedup by TestCaseId is ever removed.
    it('a case that is BOTH in an attached plan and explicitly linked is reported once, marked explicit', async () => {
      mockResponses({
        release: { releaseId: 'REL-11', name: 'Both', status: 'planned', linkedTestPlanIds: ['plan-y'] },
        srcLinks: [{ sourceId: 'REL-11', srcModule: 6, destinationId: 'TC-1', destinationModule: 1 }],
        testCases: [{ TestCaseId: 'TC-1', TestCaseSummary: 'One' }],
        plans: [
          {
            _id: 'plan-y',
            TestPlanId: 'PLN-4',
            TestCases: [{ TestCaseId: 'TC-1', TestCaseSummary: 'One', TestStatus: 'Pass' }]
          }
        ]
      });

      const result = await computeReleaseLens('REL-11', HEADERS);

      expect(result.testCases.linkedCount).toBe(1);
      expect(result.testCases.linked.map((tc) => tc.TestCaseId)).toEqual(['TC-1']);
      expect(result.testCases.derivedCount).toBe(0);
      expect(result.testCases.derived).toEqual([]);
    });

    // Premise 4 + 6: the case -> requirement hop must traverse a derived
    // case's links in EITHER direction, since bidirectionality is a
    // client-side double write, not guaranteed. This test's own link row
    // (below) is `{sourceId: 'TC-5', srcModule: TEST_CASE, destinationId:
    // 'Req-9', destinationModule: REQUIREMENT}` -- the FORWARD shape
    // (case as source), so it exercises only the `if` half of that
    // traversal (`l.srcModule === MODULE.TEST_CASE && l.destinationModule
    // === MODULE.REQUIREMENT`), not the reverse `else if` half. Fix round
    // (Finding 3): the claim this comment used to make -- "breaks if the
    // traversal only checks one of sourceId/destinationId" -- was false;
    // deleting the entire reverse (`else if`) branch left every test in
    // this file green, this one included, since it never supplies a
    // reverse-direction row. See the dedicated reverse-direction test
    // immediately below this one for the case that actually breaks when
    // that branch is removed.
    it('requirements linked to derived cases are derived, found via a one-way link row', async () => {
      mockResponses({
        release: { releaseId: 'REL-12', name: 'Traversal', status: 'planned', linkedTestPlanIds: ['plan-z'] },
        testCases: [{ TestCaseId: 'TC-5', TestCaseSummary: 'Derived case' }],
        requirements: [{ reqId: 'Req-9', requirementSummary: 'Reached through TC-5' }],
        plans: [
          {
            _id: 'plan-z',
            TestPlanId: 'PLN-5',
            TestCases: [{ TestCaseId: 'TC-5', TestCaseSummary: 'Derived case', TestStatus: 'Pass' }]
          }
        ],
        // One-way: TC-5 -> Req-9 only, no mirrored Req-9 -> TC-5 row. Also
        // includes a distractor row (module 5<->2, defect<->requirement)
        // that must NOT be treated as a case link.
        allLinks: [
          { sourceId: 'TC-5', srcModule: 1, destinationId: 'Req-9', destinationModule: 2 },
          { sourceId: 'Bug-1', srcModule: 5, destinationId: 'Req-9', destinationModule: 2 }
        ]
      });

      const result = await computeReleaseLens('REL-12', HEADERS);

      expect(result.testCases.derivedCount).toBe(1);
      expect(result.requirements.linkedCount).toBe(0);
      expect(result.requirements.derivedCount).toBe(1);
      expect(result.requirements.derived).toEqual([
        { reqId: 'Req-9', requirementSummary: 'Reached through TC-5', via: [{ TestCaseId: 'TC-5', TestCaseSummary: 'Derived case' }] }
      ]);
    });

    // Fix round (Finding 3, MINOR) -- the actual reverse-direction case the
    // comment above claimed was already covered: this link row is
    // `{sourceId: 'Req-9', srcModule: REQUIREMENT, destinationId: 'TC-5',
    // destinationModule: TEST_CASE}` -- the requirement is the SOURCE and
    // the derived case is the DESTINATION, the shape only the `else if`
    // branch of the case->requirement hop matches
    // (`l.destinationModule === MODULE.TEST_CASE && l.srcModule ===
    // MODULE.REQUIREMENT`). Real link rows are a client-side double write
    // (linkissue.tsx), not a backend guarantee, so a one-way row can land
    // in either orientation. Confirmed non-vacuous: deleting the entire
    // `else if` branch in releaseLens.js's case->requirement hop makes this
    // test's `derivedCount`/`derived` assertions fail (both come back 0/[])
    // while every other test in this file stays green -- restored after
    // confirming red.
    it('a requirement reachable ONLY through a reverse-direction link row (requirement as source, derived case as destination) is still derived', async () => {
      mockResponses({
        release: { releaseId: 'REL-17', name: 'Reverse traversal', status: 'planned', linkedTestPlanIds: ['plan-r'] },
        testCases: [{ TestCaseId: 'TC-20', TestCaseSummary: 'Derived case' }],
        requirements: [{ reqId: 'Req-30', requirementSummary: 'Reached in reverse' }],
        plans: [
          {
            _id: 'plan-r',
            TestPlanId: 'PLN-9',
            TestCases: [{ TestCaseId: 'TC-20', TestCaseSummary: 'Derived case', TestStatus: 'Pass' }]
          }
        ],
        // Reverse only: Req-30 is sourceId, TC-20 is destinationId -- no
        // mirrored TC-20 -> Req-30 row exists in this fixture at all.
        allLinks: [{ sourceId: 'Req-30', srcModule: 2, destinationId: 'TC-20', destinationModule: 1 }]
      });

      const result = await computeReleaseLens('REL-17', HEADERS);

      expect(result.testCases.derivedCount).toBe(1);
      expect(result.requirements.linkedCount).toBe(0);
      expect(result.requirements.derivedCount).toBe(1);
      expect(result.requirements.derived).toEqual([
        { reqId: 'Req-30', requirementSummary: 'Reached in reverse', via: [{ TestCaseId: 'TC-20', TestCaseSummary: 'Derived case' }] }
      ]);
    });

    // Premise 2 applied to the case -> requirement hop: a link row can name
    // a requirement id that no longer resolves against requirementsById --
    // either genuinely deleted, or (requirementService being
    // project-scoped, unlike linkIssueService) belonging to a different
    // project than the caller's. Breaks if the requirement end of the hop
    // is trusted without checking requirementsById first.
    it('a derived case linked to a requirement id that does not resolve in this project is not counted', async () => {
      mockResponses({
        release: { releaseId: 'REL-16', name: 'Unresolved req', status: 'planned', linkedTestPlanIds: ['plan-u'] },
        testCases: [{ TestCaseId: 'TC-6', TestCaseSummary: 'Case' }],
        // Req-99 deliberately absent from `requirements` -- simulates a
        // deleted requirement, or one scoped to a different project.
        requirements: [],
        plans: [
          {
            _id: 'plan-u',
            TestPlanId: 'PLN-8',
            TestCases: [{ TestCaseId: 'TC-6', TestCaseSummary: 'Case', TestStatus: 'Pass' }]
          }
        ],
        allLinks: [{ sourceId: 'TC-6', srcModule: 1, destinationId: 'Req-99', destinationModule: 2 }]
      });

      const result = await computeReleaseLens('REL-16', HEADERS);

      expect(result.testCases.derivedCount).toBe(1);
      expect(result.requirements.derivedCount).toBe(0);
      expect(result.requirements.derived).toEqual([]);
    });

    // Premise 2 applied to the plan->case hop: a plan can still list a case
    // whose own document was deleted. Breaks if the derivation resolves
    // TestCaseId strings without checking they still exist in testCasesById.
    it('a plan listing a deleted case does not count it as a derived member', async () => {
      mockResponses({
        release: { releaseId: 'REL-13', name: 'Stale plan', status: 'planned', linkedTestPlanIds: ['plan-w'] },
        testCases: [{ TestCaseId: 'TC-7', TestCaseSummary: 'Still exists' }],
        plans: [
          {
            _id: 'plan-w',
            TestPlanId: 'PLN-6',
            TestCases: [
              { TestCaseId: 'TC-7', TestCaseSummary: 'Still exists', TestStatus: 'Pass' },
              { TestCaseId: 'TC-DELETED', TestCaseSummary: 'Gone', TestStatus: 'Pass' }
            ]
          }
        ]
      });

      const result = await computeReleaseLens('REL-13', HEADERS);

      expect(result.testCases.derivedCount).toBe(1);
      expect(result.testCases.derived.map((tc) => tc.TestCaseId)).toEqual(['TC-7']);
    });

    // R5: a release with genuinely nothing linked AND nothing derivable
    // reports zeros for the new keys too, with the same "says so" posture
    // as the pre-existing explicit-only zero state.
    it('a release with no plans and no links reports zero derived membership, and says so', async () => {
      mockResponses({
        release: { releaseId: 'REL-14', name: 'Truly empty', status: 'planned', linkedTestPlanIds: [] }
      });

      const result = await computeReleaseLens('REL-14', HEADERS);

      expect(result.testCases.derivedCount).toBe(0);
      expect(result.testCases.derived).toEqual([]);
      expect(result.requirements.derivedCount).toBe(0);
      expect(result.requirements.derived).toEqual([]);
    });

    // R3, non-vacuously: a defect linked to a requirement that is ONLY
    // reachable as a derived member must still not be counted. Proves R3
    // isn't satisfied merely by accident (no defect derivation code path
    // exists at all) but that the presence of a plausible defect<->
    // requirement link row in the very same unfiltered fetch used for
    // case->requirement traversal doesn't leak a defect in.
    it('a defect linked to a derived requirement is not counted (R3: defects stay explicit-only)', async () => {
      mockResponses({
        release: { releaseId: 'REL-15', name: 'No defect leak', status: 'planned', linkedTestPlanIds: ['plan-v'] },
        testCases: [{ TestCaseId: 'TC-8', TestCaseSummary: 'Case' }],
        requirements: [{ reqId: 'Req-20', requirementSummary: 'Derived requirement' }],
        defects: [{ defectId: 'Bug-50', summary: 'Unrelated bug', Status: 1, Severity: 'High' }],
        statuses: [{ id: 1, istatus: 'New' }],
        plans: [
          {
            _id: 'plan-v',
            TestPlanId: 'PLN-7',
            TestCases: [{ TestCaseId: 'TC-8', TestCaseSummary: 'Case', TestStatus: 'Pass' }]
          }
        ],
        allLinks: [
          { sourceId: 'TC-8', srcModule: 1, destinationId: 'Req-20', destinationModule: 2 },
          { sourceId: 'Bug-50', srcModule: 5, destinationId: 'Req-20', destinationModule: 2 }
        ]
      });

      const result = await computeReleaseLens('REL-15', HEADERS);

      expect(result.requirements.derivedCount).toBe(1);
      expect(result.defects.linkedCount).toBe(0);
      expect(result.defects).not.toHaveProperty('derivedCount');
      expect(result.defects).not.toHaveProperty('derived');
    });
  });

  // WP-F23 Task 1, fix round 1 (R3 amended) -- per-test-case latest
  // execution status, scoped to THIS release's own resolved plans, added
  // to both `testCases.linked` and `testCases.derived` so the Lens's
  // default sort (frontend) can surface failing cases first instead of the
  // derived-vs-asserted proxy the task originally shipped with.
  describe('per-test-case latest execution status (WP-F23 Task 1 fix round 1, R3 amended)', () => {
    it("a linked test case and a derived test case each carry their own latest status from this release's own executions", async () => {
      mockResponses({
        release: { releaseId: 'REL-20', name: 'Status Release', status: 'in-progress', linkedTestPlanIds: ['plan-a'] },
        srcLinks: [{ sourceId: 'REL-20', srcModule: 6, destinationId: 'TC-1', destinationModule: 1 }],
        testCases: [
          { TestCaseId: 'TC-1', TestCaseSummary: 'Linked case' },
          { TestCaseId: 'TC-2', TestCaseSummary: 'Derived case' }
        ],
        plans: [
          {
            _id: 'plan-a',
            TestPlanId: 'PLN-1',
            // TC-2 is not explicitly linked above -- reaching it only
            // through this plan's own containment is what makes it derived.
            TestCases: [{ TestCaseId: 'TC-2', TestCaseSummary: 'Derived case', TestStatus: 'Pass' }]
          }
        ],
        executions: [
          {
            TestPlanId: 'plan-a',
            TestCases: [
              { TestCaseId: 'TC-1', TestStatus: 'Fail' },
              { TestCaseId: 'TC-2', TestStatus: 'Pass' }
            ]
          }
        ]
      });

      const result = await computeReleaseLens('REL-20', HEADERS);

      expect(result.testCases.linked.find((tc) => tc.TestCaseId === 'TC-1').latestStatus).toBe('Fail');
      expect(result.testCases.derived.find((tc) => tc.TestCaseId === 'TC-2').latestStatus).toBe('Pass');
    });

    // The whole reason this needed its own sentinel rather than reusing
    // 'No Run' (see releaseLens.js's own comment on NOT_EXECUTED_IN_RELEASE):
    // "never executed here" and "executed here and recorded No Run" are
    // different claims a release sign-off reader needs told apart.
    it("a test case with no execution in this release's own plans reads as \"Not run in this release\", not \"No Run\"", async () => {
      mockResponses({
        release: { releaseId: 'REL-21', name: 'No Exec Release', status: 'planned', linkedTestPlanIds: ['plan-a'] },
        srcLinks: [{ sourceId: 'REL-21', srcModule: 6, destinationId: 'TC-5', destinationModule: 1 }],
        testCases: [{ TestCaseId: 'TC-5', TestCaseSummary: 'Never run here' }],
        plans: [{ _id: 'plan-a', TestPlanId: 'PLN-5' }],
        executions: []
      });

      const result = await computeReleaseLens('REL-21', HEADERS);

      const row = result.testCases.linked.find((tc) => tc.TestCaseId === 'TC-5');
      expect(row.latestStatus).toBe('Not run in this release');
      expect(row.latestStatus).not.toBe('No Run');
    });

    // R3 amended's own semantic decision: a case that passed under some
    // OTHER, unconfigured plan must not make THIS release read green.
    // 'plan-b' is deliberately absent from the `plans` response, so it
    // never resolves and its execution must be invisible to this release.
    it("a case that passed under an unconfigured plan does not read as passing here -- status is scoped to this release's own resolved plans, not project-wide", async () => {
      mockResponses({
        release: { releaseId: 'REL-22', name: 'Scoped Release', status: 'planned', linkedTestPlanIds: ['plan-a'] },
        srcLinks: [{ sourceId: 'REL-22', srcModule: 6, destinationId: 'TC-7', destinationModule: 1 }],
        testCases: [{ TestCaseId: 'TC-7', TestCaseSummary: 'Cross-release case' }],
        plans: [{ _id: 'plan-a', TestPlanId: 'PLN-A' }],
        executions: [
          { TestPlanId: 'plan-b', TestCases: [{ TestCaseId: 'TC-7', TestStatus: 'Pass' }] }
        ]
      });

      const result = await computeReleaseLens('REL-22', HEADERS);

      const row = result.testCases.linked.find((tc) => tc.TestCaseId === 'TC-7');
      expect(row.latestStatus).toBe('Not run in this release');
      expect(row.latestStatus).not.toBe('Pass');
    });

    // The backend must not narrow or normalize the vocabulary -- WP-F13
    // established that normalize.js's Pass/Fail/No Run set is the CI
    // ingestion vocabulary, not everything the human path writes (real
    // data includes 'InProgress'). 'QuarkEntangled' appears nowhere else in
    // this codebase, so this genuinely exercises "whatever was stored",
    // not a value someone already special-cased.
    it('an execution status this vocabulary has never seen is passed through verbatim, not normalized or dropped', async () => {
      mockResponses({
        release: { releaseId: 'REL-23', name: 'Odd Status Release', status: 'planned', linkedTestPlanIds: ['plan-a'] },
        srcLinks: [{ sourceId: 'REL-23', srcModule: 6, destinationId: 'TC-42', destinationModule: 1 }],
        testCases: [{ TestCaseId: 'TC-42', TestCaseSummary: 'Odd status case' }],
        plans: [{ _id: 'plan-a', TestPlanId: 'PLN-42' }],
        executions: [
          { TestPlanId: 'plan-a', TestCases: [{ TestCaseId: 'TC-42', TestStatus: 'QuarkEntangled' }] }
        ]
      });

      const result = await computeReleaseLens('REL-23', HEADERS);

      const row = result.testCases.linked.find((tc) => tc.TestCaseId === 'TC-42');
      expect(row.latestStatus).toBe('QuarkEntangled');
    });
  });
});
