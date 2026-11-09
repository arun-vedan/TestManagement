const { requestWithRetry } = require('@srckube/service-core');
const { REQUIREMENT_SERVICE, TESTREPO_SERVICE, LINK_ISSUE_SERVICE, TEST_PLAN_EXECUTION_SERVICE } = require('./serviceUrls');

// WP-F13 Task 1 — requirement coverage, corrected.
//
// THE BUG THIS REPLACES: the WP-040 version defined "tested" as a
// LinkIssue document matching {linkType:'tests', srcModule:2} -- but every
// MANUAL link affordance this workbench ships (ReleaseDetail/DefectDetail/
// TestRunDetail, and the requirement's own Links tab) hardcodes
// linkType:'relates-to'; none of them ever write 'tests'. (Corrected,
// final fix round: 'tests' is not unwritable in an absolute sense -- WP-051's
// AI-accept flow, api/aiApi.ts, does write a bidirectional 'tests' link
// when a user accepts an AI-generated test case -- but the live census
// below is unaffected by that either way, and R1 makes the distinction
// moot: any linkType counts.) Live census at the time of this fix: all 23
// link rows in this environment are 'relates-to'; zero are 'tests'. That
// made the old definition wrong by construction, not by a data-quality
// accident: every project always read 0% regardless of how much real
// linking existed.
//
// R1 — "tested" now means ANY LinkIssue document joining a requirement and
// a test case, in EITHER direction, regardless of linkType. linkType is a
// label on the relationship, not a gate on whether the relationship counts;
// gating on one specific value made a real, existing link invisible.
//
// R2 (amended, fix round 1) — a single coverage percentage collapses four
// different, separately actionable situations into one number. This
// reports four mutually exclusive, exhaustive segments instead, evaluated
// over a requirement's linked cases in this precedence:
//   1. no linked cases                    -> NO_TESTS_LINKED
//   2. ANY linked case has a Fail verdict  -> EXECUTED_FAILING
//   3. EVERY linked case has a Pass verdict -> EXECUTED_PASSING
//   4. otherwise                          -> NOT_FULLY_VERIFIED
// The first cut of this task classified "executed, not failing" as
// EXECUTED_PASSING -- wrong on two counts a corrected ruling caught: a
// case whose only entry is 'InProgress' (not a terminal result) is not
// passing, and a requirement with two linked cases (one Pass, one No Run)
// is not "all passing" just because one of them ran. "All passing" now
// means every linked case has an actual Pass verdict; anything short of
// that (No Run, InProgress, or a status this vocabulary doesn't even know
// about) lands in NOT_FULLY_VERIFIED, never in EXECUTED_PASSING. Fail still
// takes precedence over an incomplete/unknown verdict elsewhere in the same
// requirement.
async function computeCoverage(projectId, headers) {
  if (!REQUIREMENT_SERVICE) {
    throw new Error('requirementService is not configured');
  }
  if (!TESTREPO_SERVICE) {
    throw new Error('testRepoService is not configured');
  }
  if (!LINK_ISSUE_SERVICE) {
    throw new Error('linkIssueService is not configured');
  }
  if (!TEST_PLAN_EXECUTION_SERVICE) {
    throw new Error('testPlanExecutionService is not configured');
  }

  // WP-111 — linkIssueService is now project-scoped, so the caller's
  // X-Project-Id must be forwarded like it is to every other dependency.
  //
  // This used to strip it deliberately, with a comment that the service
  // "carries no project-scoping concept". That was true when written and is
  // now false (LinkIssue.projectId is required+indexed and every route mounts
  // requireProjectScope()), which is the same way reportingService's WP-103
  // guards went stale. Leaving it stripped made every linkIssue fetch 403, so
  // coverage and traceability silently served their LAST CACHED value with
  // stale:true -- a report that looks fine and is quietly frozen, which is
  // precisely the failure the stale label exists to make visible.
  const linkHeaders = headers;

  const [reqResp, tcResp, linkResp, execResp] = await Promise.all([
    requestWithRetry({
      method: 'get',
      url: `http://${REQUIREMENT_SERVICE}/api/v1/requirement`,
      params: { select: 'reqId', limit: 10000 },
      headers
    }),
    requestWithRetry({
      method: 'get',
      url: `http://${TESTREPO_SERVICE}/api/v1/testrepo`,
      params: { select: 'TestCaseId', limit: 10000 },
      headers
    }),
    // Unfiltered -- premise 3: bidirectionality is a client-side double
    // write, not a backend guarantee (at least one live link is one-way),
    // so every row must be inspected from both ends rather than trusting a
    // single-direction query. Same "fetch everything, filter client-side"
    // pattern releaseLens.js's own allLinksResp fetch already uses against
    // this same unscoped dependency.
    requestWithRetry({
      method: 'get',
      url: `http://${LINK_ISSUE_SERVICE}/api/v1/linkIssue`,
      params: { limit: 10000 },
      headers: linkHeaders
    }),
    // R5 -- every execution, unfiltered by `source`. See the comment above
    // resolveExecutionSets below for why.
    requestWithRetry({
      method: 'get',
      url: `http://${TEST_PLAN_EXECUTION_SERVICE}/api/v1/testexecution`,
      params: { limit: 10000 },
      headers
    })
  ]);

  const requirements = (reqResp.data && reqResp.data.data) || [];
  const testCases = (tcResp.data && tcResp.data.data) || [];
  const links = (linkResp.data && linkResp.data.data) || [];
  const executions = (execResp.data && execResp.data.data) || [];

  // Premise 4 — linkIssueService keys on human ids and has no project
  // scoping of its own; scoping comes from intersecting its rows against
  // these two ALREADY project-scoped lists (requirementService/
  // testRepoService both sit behind requireProjectScope()). A link naming
  // an id that isn't in this project's own requirement or test-case list
  // (deleted, or belonging to a different project) is silently dropped.
  const reqIdSet = new Set(requirements.map((r) => r.reqId));
  const caseIdSet = new Set(testCases.map((tc) => tc.TestCaseId));

  const linkedCaseIdsByReq = buildLinkedCaseIdsByReq(links, reqIdSet, caseIdSet);
  const { passingCaseIds, failingCaseIds } = resolveExecutionSets(executions, caseIdSet);

  const counts = {
    [SEGMENTS.NO_TESTS_LINKED]: 0,
    [SEGMENTS.NOT_FULLY_VERIFIED]: 0,
    [SEGMENTS.EXECUTED_FAILING]: 0,
    [SEGMENTS.EXECUTED_PASSING]: 0
  };
  requirements.forEach((r) => {
    const segment = classifyRequirementSegment(linkedCaseIdsByReq.get(r.reqId), passingCaseIds, failingCaseIds);
    counts[segment] += 1;
  });

  const total = requirements.length;
  // The linkage headline (R6's denominator rule, kept for continuity with
  // the dashboard's existing "N of M requirements have a linked test"
  // caption) is DERIVED from the same segment counts above, never computed
  // separately -- R3: one function decides both, so a headline and a
  // segment breakdown can never quietly disagree with each other.
  const untested = counts[SEGMENTS.NO_TESTS_LINKED];
  const tested = total - untested;

  return {
    label: 'Requirement coverage',
    total,
    tested,
    untested,
    // R6 -- a project with zero requirements reports zeros AND says so,
    // rather than a bare "0" a reader could mistake for "everything
    // covered" or for a transient loading state.
    note: total === 0 ? 'no requirements defined in this project yet' : undefined,
    segments: counts,
    // DonutChart-shaped (Components/charts/DonutChart.tsx: `data:
    // DonutSlice[]`) -- four slices now, replacing the old two-slice
    // tested/untested split with the honest four-way breakdown (R2).
    breakdown: {
      data: [
        { id: SEGMENTS.NO_TESTS_LINKED, label: 'No tests linked', value: counts[SEGMENTS.NO_TESTS_LINKED] },
        { id: SEGMENTS.NOT_FULLY_VERIFIED, label: 'Tests linked, not fully verified', value: counts[SEGMENTS.NOT_FULLY_VERIFIED] },
        { id: SEGMENTS.EXECUTED_FAILING, label: 'Executed, failing', value: counts[SEGMENTS.EXECUTED_FAILING] },
        { id: SEGMENTS.EXECUTED_PASSING, label: 'Executed, all passing', value: counts[SEGMENTS.EXECUTED_PASSING] }
      ]
    }
  };
}

// linkIssueService's module ids for the two entity types this traversal
// cares about (same numbering releaseLens.js's own MODULE map uses).
const MODULE = { TEST_CASE: 1, REQUIREMENT: 2 };

const SEGMENTS = {
  NO_TESTS_LINKED: 'noTestsLinked',
  NOT_FULLY_VERIFIED: 'notFullyVerified',
  EXECUTED_FAILING: 'executedFailing',
  EXECUTED_PASSING: 'executedPassing'
};

// R1 + R7, applied to the WHOLE link collection in one pass (batch, not
// per-requirement -- premise 4's scoping is cheaper done once here than
// requested per id). A row counts only when its module tags name ONE side
// as a requirement and the OTHER as a test case -- checked on BOTH sides,
// not just one. That second check is what R7 actually depends on: this
// pass never asks "does either id look like a requirement/case", only
// "do this row's OWN module tags say requirement<->test-case" -- so a
// case<->case (1<->1) row is rejected purely on its module tags, even in
// the adversarial case where its sourceId/destinationId happen to collide
// with real requirement/case ids (four 1<->1 rows exist live; following one
// would inflate coverage through a relationship that was never a
// requirement being covered at all).
function buildLinkedCaseIdsByReq(links, reqIdSet, caseIdSet) {
  const linkedCaseIdsByReq = new Map(); // reqId -> Set<TestCaseId>
  links.forEach((l) => {
    let reqId;
    let caseId;
    if (l.srcModule === MODULE.REQUIREMENT && l.destinationModule === MODULE.TEST_CASE) {
      reqId = l.sourceId;
      caseId = l.destinationId;
    } else if (l.destinationModule === MODULE.REQUIREMENT && l.srcModule === MODULE.TEST_CASE) {
      reqId = l.destinationId;
      caseId = l.sourceId;
    } else {
      return; // any other module pairing, including 1<->1 -- not counted
    }
    if (!reqIdSet.has(reqId) || !caseIdSet.has(caseId)) {
      return; // premise 4 scoping: not this project's requirement/case
    }
    const set = linkedCaseIdsByReq.get(reqId) || new Set();
    set.add(caseId);
    linkedCaseIdsByReq.set(reqId, set);
  });
  return linkedCaseIdsByReq;
}

// R5 -- the automation seam is "do nothing special": a TestExecution's
// `source` field (manual vs CI-posted, WP-033) is never read or filtered on
// here.
//
// Fix round 1 -- safe-by-default status handling. Only an EXPLICIT 'Pass'
// makes a case passing, and only an explicit 'Fail' makes it failing.
// Everything else -- 'No Run', 'InProgress' (a real, live status this
// project's data contains that testPlanExecutionService/adapters/
// normalize.js's CI-ingestion vocabulary never mentions -- that file
// documents the vocabulary CI results are normalized INTO, not the full
// set the human execution path can write), a missing TestStatus, or any
// future status value nobody has enumerated here -- puts a case in
// NEITHER set. classifyRequirementSegment below can never read an
// unrecognised or non-terminal status as a pass: the one property this
// fix round exists to guarantee.
//
// Fix round 2 (WP-F13 Task 2 coordinator review) -- passingCaseIds/
// failingCaseIds are now decided by each case's LATEST status only, never
// by "this status occurred at some point in this case's history". The
// prior "any occurrence, ever" version had a real, live-reachable defect:
// a case that failed once and has since passed stayed in failingCaseIds
// forever, so classifyRequirementSegment kept returning EXECUTED_FAILING
// for a requirement whose only linked case currently shows Pass --
// traceability.js's row would then display that same case's status as
// 'Pass' while the row's own segment said "Executed, failing": a visible
// contradiction inside a single row, worse than the tile-vs-table
// disagreement R3 was written to prevent, because both halves are on
// screen together. "Latest" is also the only defensible reading of
// "failing" in the first place: a test that failed in April and passes
// today IS passing, and "has ever failed" gives a requirement no path back
// to non-failing once anything has gone red even once -- the segment would
// stop being actionable the moment it happened.
//
// `latestStatusByCaseId` (kept from fix round 1, for traceability.js's
// per-case display) and passingCaseIds/failingCaseIds are now the SAME
// underlying fact viewed two ways, computed together in the one pass
// below, ordered by each execution's own `updatedAt`/`createdAt` (later
// overwrites earlier): a case's latest status is either exactly 'Pass'
// (-> passingCaseIds), exactly 'Fail' (-> failingCaseIds), or anything
// else (-> neither -- 'InProgress'/'No Run'/an unknown value all still
// opt OUT of both sets, so fix round 1's safe-by-default guarantee is
// unchanged by this round). A case's earlier membership is evicted before
// its latest status is re-applied, so only the final, most-recent status
// ever determines where a case ends up when the pass finishes.
function executionTimestamp(execution) {
  const raw = execution.updatedAt || execution.createdAt;
  const t = raw ? new Date(raw).getTime() : NaN;
  return Number.isNaN(t) ? -Infinity : t;
}

function resolveExecutionSets(executions, caseIdSet) {
  const passingCaseIds = new Set();
  const failingCaseIds = new Set();
  const latestStatusByCaseId = new Map();

  // Stable-sorted oldest -> newest so that, within the single forEach pass
  // below, a later execution's status for a given case always overwrites
  // an earlier one's -- both in latestStatusByCaseId and in which of
  // passingCaseIds/failingCaseIds (if either) the case currently belongs
  // to.
  const byRecency = [...executions].sort((a, b) => executionTimestamp(a) - executionTimestamp(b));

  byRecency.forEach((execution) => {
    (execution.TestCases || []).forEach((tc) => {
      if (!tc || !tc.TestCaseId || !caseIdSet.has(tc.TestCaseId)) {
        return;
      }
      const status = tc.TestStatus || 'No Run';
      latestStatusByCaseId.set(tc.TestCaseId, status);
      // Evict any earlier membership before applying this (more recent)
      // status -- a case that was passing/failing as of an earlier
      // execution must not stay that way once a later execution changes
      // its status to something else (fix round 2's whole point).
      passingCaseIds.delete(tc.TestCaseId);
      failingCaseIds.delete(tc.TestCaseId);
      if (status === 'Pass') {
        passingCaseIds.add(tc.TestCaseId);
      } else if (status === 'Fail') {
        failingCaseIds.add(tc.TestCaseId);
      }
    });
  });
  return { passingCaseIds, failingCaseIds, latestStatusByCaseId };
}

// R3 — the ONE function that decides a single requirement's segment. Task 2
// (the traceability matrix) imports this exact function rather than
// reimplementing the four-way rule, so a matrix row and this summary's
// counts can never quietly disagree about which segment a requirement is
// in. Pure and synchronous: the caller resolves linkage and execution once
// (batch, above) and calls this per requirement.
//
// Precedence (R2, amended): a Fail anywhere among the linked cases wins
// outright, ahead of whether every case has passed -- a requirement with
// one Fail and one Pass is EXECUTED_FAILING, never EXECUTED_PASSING.
// EXECUTED_PASSING requires EVERY linked case to have an actual Pass
// verdict; a case that merely isn't failing (No Run, InProgress, unknown)
// is not a pass, so it pulls the whole requirement down to
// NOT_FULLY_VERIFIED instead.
//
// @param linkedCaseIds  Set<TestCaseId> this requirement is linked to
//                       (any direction, any linkType, case<->case
//                       excluded) -- undefined/empty means unlinked.
// @param passingCaseIds Set<TestCaseId> whose LATEST execution status is
//                       explicitly 'Pass', project-wide. Not "has ever
//                       passed" -- see resolveExecutionSets above; a case
//                       that failed once and passes now belongs here.
// @param failingCaseIds Set<TestCaseId> whose LATEST execution status is
//                       explicitly 'Fail', project-wide. Same rule: a case
//                       that failed in the past and has since passed is NOT
//                       in this set, or a requirement would read as failing
//                       forever with no action able to clear it.
function classifyRequirementSegment(linkedCaseIds, passingCaseIds, failingCaseIds) {
  if (!linkedCaseIds || linkedCaseIds.size === 0) {
    return SEGMENTS.NO_TESTS_LINKED;
  }
  let anyFailing = false;
  let allPassing = true;
  linkedCaseIds.forEach((caseId) => {
    if (failingCaseIds.has(caseId)) {
      anyFailing = true;
    }
    if (!passingCaseIds.has(caseId)) {
      allPassing = false;
    }
  });
  if (anyFailing) {
    return SEGMENTS.EXECUTED_FAILING;
  }
  return allPassing ? SEGMENTS.EXECUTED_PASSING : SEGMENTS.NOT_FULLY_VERIFIED;
}

// buildLinkedCaseIdsByReq/resolveExecutionSets exported alongside
// classifyRequirementSegment for WP-F13 Task 2 (the traceability matrix):
// R3's ONE-function guarantee only holds if Task 2 imports these three
// rather than reimplementing the R1/R7 link traversal or the opt-in-to-
// success status resolution a second time. Two copies of either would
// decay into "agrees today, drifts tomorrow" -- exactly what R3 exists to
// rule out.
module.exports = { computeCoverage, classifyRequirementSegment, buildLinkedCaseIdsByReq, resolveExecutionSets, SEGMENTS };
