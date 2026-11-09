const { requestWithRetry, CORRELATION_HEADER } = require('@srckube/service-core');
const {
  REQUIREMENT_SERVICE,
  TESTREPO_SERVICE,
  DEFECT_SERVICE,
  TEST_PLAN_EXECUTION_SERVICE,
  LINK_ISSUE_SERVICE,
  RELEASE_SERVICE,
  ISTATUS_SERVICE
} = require('./serviceUrls');
// WP-F23 Task 1 fix round 1 (R3 amended) -- the shared per-case latest-
// status resolver (WP-F13), reused rather than reimplemented so the rule
// ('a case's LATEST status only, never "ever occurred"') is expressed
// exactly once across this service.
const { resolveExecutionSets } = require('./coverage');

// WP-F15/F18 Task 4 — the release lens. Unlike this service's other six
// reports (coverage/pass-rate-trend/defect-summary/plan-progress/
// release-readiness/workload), this is never written to ReportCache: that
// model's unique key is (projectId, reportType) — one document per report
// PER PROJECT — and a lens answers a question keyed by (projectId,
// releaseId), a strictly finer grain the cache schema was never built to
// hold without either colliding across releases or growing the model in a
// way this task doesn't need. So this is computed fresh on every call,
// same "always live, no cache" posture as releaseService's own
// getGateStatus, not the "materialized, periodically refreshed" posture of
// controllers/reports.js's getOrCompute six.
//
// A release joins two DIFFERENT linking mechanisms, and this lens reports
// on both without conflating them:
//   - `linkedTestPlanIds` (Release's own field, pre-dates this WP) — the
//     release's test plans, resolved against testPlanExecutionService by
//     Mongo _id, same reference releaseService's own evaluateMinPassRate
//     already uses for quality-gate evaluation.
//   - the generic link graph (linkIssueService, WP-F15/F18 Task 3) — the
//     release's requirements/test cases/defects, module 6 linked to
//     modules 2/1/5 respectively. A link to any OTHER module (e.g. another
//     release, or a test run) is deliberately not counted here: Task 3's
//     stated scope is defects/requirements/test cases, and test plans
//     already have their own dedicated, pre-existing mechanism above —
//     counting a module-3 link here too would let the same test plan be
//     "in" a release two different ways with two different answers for
//     whether it's a member.

function isExecuted(status) {
  const s = (status || '').toLowerCase();
  return s !== '' && s !== 'no run';
}

// Same status-resolution shape as this service's own defectSummary.js —
// defectService's `Status` field stores either the istatus numeric id (as
// a Number or a String) or the istatus name, and both call sites resolve
// it against istatusService's live list rather than assuming one shape.
function resolveStatusName(rawStatus, statusList) {
  if (rawStatus === undefined || rawStatus === null || rawStatus === '') {
    return 'Unknown';
  }
  const asNumber = Number(rawStatus);
  if (Number.isInteger(asNumber)) {
    const byId = statusList.find((s) => s.id === asNumber);
    if (byId) {
      return byId.istatus;
    }
  }
  const byName = statusList.find((s) => (s.istatus || '').toLowerCase() === String(rawStatus).toLowerCase());
  return byName ? byName.istatus : 'Unknown';
}

// linkIssueService's srcModule/destinationModule numbers this lens counts.
const MODULE = { TEST_CASE: 1, REQUIREMENT: 2, DEFECT: 5 };

// Every link this lens counts, keyed by its OWN sourceId/destinationId
// pair, has TWO documents once the client's double-write (linkissue.tsx)
// has completed — a forward row (release as sourceId) and a reverse row
// (release as destinationId), both naming the exact same counterpart
// entity. Querying both directions and collapsing on "module:id" is what
// makes that double-write invisible here: a mirrored pair collapses to one
// counterpart, and the rarer one-way link (the client's second write never
// landed) still surfaces exactly once, from whichever side has a document.
function collectCounterparts(releaseId, srcLinks, destLinks) {
  const counterparts = new Map(); // "module:id" -> { module, id }
  srcLinks.forEach((l) => {
    if (l.destinationId !== undefined && l.destinationId !== null && l.destinationModule !== undefined && l.destinationModule !== null) {
      counterparts.set(`${l.destinationModule}:${l.destinationId}`, { module: l.destinationModule, id: l.destinationId });
    }
  });
  destLinks.forEach((l) => {
    if (l.sourceId !== undefined && l.sourceId !== null && l.srcModule !== undefined && l.srcModule !== null) {
      counterparts.set(`${l.srcModule}:${l.sourceId}`, { module: l.srcModule, id: l.sourceId });
    }
  });
  return counterparts;
}

// @param releaseId  the release's human id (e.g. 'REL-3'), from the
//                    caller's ?releaseId= query param.
// @param headers     Authorization/X-Project-Id/X-Correlation-Id, forwarded
//                    from the caller's own request (never a service
//                    account) -- same as controllers/reports.js's other
//                    compute functions.
// @returns null when the release does not exist IN THIS PROJECT (either it
//         never existed, or it belongs to a different project) -- the
//         controller maps that to 404, never to a fabricated empty lens,
//         so "this release isn't yours" is never confused with "this
//         release has nothing linked".
async function computeReleaseLens(releaseId, headers) {
  if (!RELEASE_SERVICE) {
    throw new Error('releaseService is not configured');
  }
  if (!LINK_ISSUE_SERVICE) {
    throw new Error('linkIssueService is not configured');
  }
  if (!REQUIREMENT_SERVICE) {
    throw new Error('requirementService is not configured');
  }
  if (!TESTREPO_SERVICE) {
    throw new Error('testRepoService is not configured');
  }
  if (!DEFECT_SERVICE) {
    throw new Error('defectService is not configured');
  }
  if (!ISTATUS_SERVICE) {
    throw new Error('istatusService is not configured');
  }
  if (!TEST_PLAN_EXECUTION_SERVICE) {
    throw new Error('testPlanExecutionService is not configured');
  }

  // releaseService's own list route folds req.projectScope.projectId into
  // its Mongo filter server-side (same advancedResults() every WP-021
  // service uses) -- a release belonging to a different project is simply
  // never in this result, regardless of what releaseId a caller asks for.
  const releaseResp = await requestWithRetry({
    method: 'get',
    url: `http://${RELEASE_SERVICE}/api/v1/releases`,
    params: { releaseId, limit: 1 },
    headers
  });
  const release = ((releaseResp.data && releaseResp.data.data) || [])[0];
  if (!release) {
    return null;
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

  const [
    srcLinksResp,
    destLinksResp,
    reqResp,
    tcResp,
    defectsResp,
    statusResp,
    plansResp,
    execResp,
    allLinksResp
  ] = await Promise.all([
    requestWithRetry({
      method: 'get',
      url: `http://${LINK_ISSUE_SERVICE}/api/v1/linkIssue`,
      params: { sourceId: releaseId, limit: 10000 },
      headers: linkHeaders
    }),
    requestWithRetry({
      method: 'get',
      url: `http://${LINK_ISSUE_SERVICE}/api/v1/linkIssue`,
      params: { destinationId: releaseId, limit: 10000 },
      headers: linkHeaders
    }),
    requestWithRetry({
      method: 'get',
      url: `http://${REQUIREMENT_SERVICE}/api/v1/requirement`,
      params: { select: 'reqId,requirementSummary', limit: 10000 },
      headers
    }),
    requestWithRetry({
      method: 'get',
      url: `http://${TESTREPO_SERVICE}/api/v1/testrepo`,
      params: { select: 'TestCaseId,TestCaseSummary', limit: 10000 },
      headers
    }),
    requestWithRetry({
      method: 'get',
      url: `http://${DEFECT_SERVICE}/api/v1/defects`,
      params: { limit: 10000 },
      headers
    }),
    requestWithRetry({
      method: 'get',
      url: `http://${ISTATUS_SERVICE}/api/v1/issuestatus`,
      params: { limit: 1000 },
      headers
    }),
    requestWithRetry({
      method: 'get',
      url: `http://${TEST_PLAN_EXECUTION_SERVICE}/api/v1/testplan`,
      params: { limit: 10000 },
      headers
    }),
    requestWithRetry({
      method: 'get',
      url: `http://${TEST_PLAN_EXECUTION_SERVICE}/api/v1/testexecution`,
      params: { limit: 10000 },
      headers
    }),
    // WP-F15b Task 1, R5 — the case -> requirement hop of derived
    // membership needs every link whose endpoint is one of THIS release's
    // derived cases, and advancedResults has no $in support to filter that
    // server-side. One unfiltered fetch of the whole link collection (same
    // "fetch everything, filter client-side" pattern the requirement/
    // testCase/defect fetches above already use) beats one call per
    // derived case.
    requestWithRetry({
      method: 'get',
      url: `http://${LINK_ISSUE_SERVICE}/api/v1/linkIssue`,
      params: { limit: 10000 },
      headers: linkHeaders
    })
  ]);

  const srcLinks = (srcLinksResp.data && srcLinksResp.data.data) || [];
  const destLinks = (destLinksResp.data && destLinksResp.data.data) || [];
  const counterparts = collectCounterparts(releaseId, srcLinks, destLinks);

  // CONSTRAINT: count only links whose endpoint resolves. Every entity list
  // below (requirements/test cases/defects) is fetched already scoped to
  // this same project (requireProjectScope() on each of those services) --
  // so a counterpart id that has been deleted, or that names an entity in
  // a DIFFERENT project, simply never appears in these lists, and the
  // Set/Map membership checks below drop it silently rather than counting
  // a row for something that no longer resolves.
  const allRequirements = (reqResp.data && reqResp.data.data) || [];
  const allTestCases = (tcResp.data && tcResp.data.data) || [];
  const allDefects = (defectsResp.data && defectsResp.data.data) || [];
  const statusList = (statusResp.data && statusResp.data.data) || [];

  const requirementsById = new Map(allRequirements.map((r) => [r.reqId, r]));
  const testCasesById = new Map(allTestCases.map((tc) => [tc.TestCaseId, tc]));
  const defectsById = new Map(allDefects.map((d) => [d.defectId, d]));

  const linkedRequirements = [];
  const linkedTestCases = [];
  const linkedDefects = [];
  let ignoredOtherModuleCount = 0;

  counterparts.forEach(({ module, id }) => {
    if (module === MODULE.REQUIREMENT) {
      const req = requirementsById.get(id);
      if (req) {
        linkedRequirements.push({ reqId: req.reqId, requirementSummary: req.requirementSummary });
      }
    } else if (module === MODULE.TEST_CASE) {
      const tc = testCasesById.get(id);
      if (tc) {
        linkedTestCases.push({ TestCaseId: tc.TestCaseId, TestCaseSummary: tc.TestCaseSummary });
      }
    } else if (module === MODULE.DEFECT) {
      const defect = defectsById.get(id);
      if (defect) {
        linkedDefects.push({
          defectId: defect.defectId,
          summary: defect.summary,
          Status: resolveStatusName(defect.Status, statusList),
          Severity: defect.Severity || 'Unspecified'
        });
      }
    } else {
      ignoredOtherModuleCount += 1;
    }
  });

  const resolvedCount = linkedRequirements.length + linkedTestCases.length + linkedDefects.length;
  const unresolvedCount = counterparts.size - resolvedCount - ignoredOtherModuleCount;

  const defectStatusCounts = new Map();
  linkedDefects.forEach((d) => defectStatusCounts.set(d.Status, (defectStatusCounts.get(d.Status) || 0) + 1));
  const defectStatusCategories = Array.from(defectStatusCounts.keys());

  // Test plans: `linkedTestPlanIds` stores TestPlan Mongo `_id` strings
  // (Release.js's own field comment) -- resolved against every TestPlan
  // this dependency has (same "fetch everything, filter client-side"
  // pattern this service's own planProgress.js already uses against the
  // same unscoped dependency), so an id pointing at a deleted plan is
  // silently excluded rather than counted.
  const configuredPlanIds = release.linkedTestPlanIds || [];
  const configuredPlanIdSet = new Set(configuredPlanIds.map(String));
  const allPlans = (plansResp.data && plansResp.data.data) || [];
  const resolvedPlans = allPlans.filter((p) => configuredPlanIdSet.has(String(p._id)));
  const resolvedPlanIdSet = new Set(resolvedPlans.map((p) => String(p._id)));

  // WP-F15b Task 1 — derived membership. R1: this is pure inference over
  // data already fetched (or, for links, fetched unfiltered per R5); it
  // never writes a link row. R2: every derived entity ships alongside the
  // untouched explicit one as a SIBLING key, distinct and separately
  // countable, and carries `via` -- the reason it's a member -- rather
  // than a bare count.
  //
  // Hop 1, plan -> case (premise 3/7): resolvedPlans is already in hand
  // with its full TestCases array, so this needs no new fetch. A case id
  // that no longer resolves against testCasesById (the deleted-case case,
  // premise 2) is silently dropped, same resolve-only-what-exists rule
  // applied everywhere else in this lens.
  const derivedCaseVia = new Map(); // TestCaseId -> [{ _id, TestPlanId }, ...]
  resolvedPlans.forEach((plan) => {
    (plan.TestCases || []).forEach((tc) => {
      if (!tc || !tc.TestCaseId || !testCasesById.has(tc.TestCaseId)) {
        return;
      }
      const via = derivedCaseVia.get(tc.TestCaseId) || [];
      via.push({ _id: String(plan._id), TestPlanId: plan.TestPlanId });
      derivedCaseVia.set(tc.TestCaseId, via);
    });
  });

  // R2's dedup rule: an assertion outranks an inference. A case that is
  // BOTH explicitly linked and reachable via an attached plan is reported
  // once, as explicit -- but it still participates in the requirement hop
  // below, since the plan->case containment is a real fact regardless of
  // how the case itself gets reported.
  const explicitTestCaseIds = new Set(linkedTestCases.map((tc) => tc.TestCaseId));
  const derivedTestCases = [];
  derivedCaseVia.forEach((via, testCaseId) => {
    if (explicitTestCaseIds.has(testCaseId)) {
      return;
    }
    const tc = testCasesById.get(testCaseId);
    derivedTestCases.push({ TestCaseId: tc.TestCaseId, TestCaseSummary: tc.TestCaseSummary, via });
  });

  // Hop 2, case -> requirement (premise 4). Premise 6: bidirectionality is
  // a client-side double write, not a backend guarantee -- at least one
  // live link is one-way -- so both sourceId and destinationId are checked
  // against every derived case id, exactly like collectCounterparts()
  // already does for the release's own links above. A link whose OTHER
  // module pairing isn't test-case<->requirement (e.g. a defect<->
  // requirement row, module 5<->2, living in this same unfiltered fetch)
  // is not a match here -- R3 stays satisfied by construction, not by
  // omission.
  const allLinksData = allLinksResp.data || {};
  const allLinks = allLinksData.data || [];
  // Fix round (Finding 4, MINOR) -- this fetch is UNSCOPED (linkIssueService
  // has no project concept at all, unlike every other fetch in this
  // function) and capped at limit: 10000, so it accumulates across every
  // tenant. advancedResults() (backend/shared/service-core/middleware/
  // advancedResults.js) sets `pagination.next` whenever more documents
  // exist than the page just returned -- the same signal
  // requirements/testCases/defects/plans/executions above never need to
  // check, because those fetches are project-scoped and 10000 comfortably
  // covers one project. Reading only `.data` (as this fetch used to)
  // silently drops that signal: past the cutoff, the oldest rows fall off,
  // and a derived requirement reachable ONLY through one of them would
  // vanish from every release's lens with nothing in the response saying
  // so.
  const allLinksTruncated = Boolean(allLinksData.pagination && allLinksData.pagination.next);
  const derivedReqVia = new Map(); // reqId -> [{ TestCaseId, TestCaseSummary }, ...]
  allLinks.forEach((l) => {
    let caseId = null;
    let reqId = null;
    if (l.srcModule === MODULE.TEST_CASE && l.destinationModule === MODULE.REQUIREMENT && derivedCaseVia.has(l.sourceId)) {
      caseId = l.sourceId;
      reqId = l.destinationId;
    } else if (l.destinationModule === MODULE.TEST_CASE && l.srcModule === MODULE.REQUIREMENT && derivedCaseVia.has(l.destinationId)) {
      caseId = l.destinationId;
      reqId = l.sourceId;
    } else {
      return;
    }
    // Resolve-only-what-exists (premise 2) applied to the requirement end.
    if (!requirementsById.has(reqId)) {
      return;
    }
    const tc = testCasesById.get(caseId);
    const via = derivedReqVia.get(reqId) || [];
    if (!via.some((v) => v.TestCaseId === caseId)) {
      via.push({ TestCaseId: tc.TestCaseId, TestCaseSummary: tc.TestCaseSummary });
    }
    derivedReqVia.set(reqId, via);
  });

  const explicitReqIds = new Set(linkedRequirements.map((r) => r.reqId));
  const derivedRequirements = [];
  derivedReqVia.forEach((via, reqId) => {
    if (explicitReqIds.has(reqId)) {
      return;
    }
    const req = requirementsById.get(reqId);
    derivedRequirements.push({ reqId: req.reqId, requirementSummary: req.requirementSummary, via });
  });

  const allExecutions = (execResp.data && execResp.data.data) || [];
  const relevantExecutions = allExecutions.filter(
    (execution) => execution.TestPlanId && resolvedPlanIdSet.has(String(execution.TestPlanId))
  );

  // Fix round (WP-F23 Task 1, R3 amended) -- R2's default sort for test
  // cases needs a REAL per-case execution signal, not the derived-vs-
  // asserted proxy this task shipped with initially (recorded as a finding
  // in that task's own report, now closed). `resolveExecutionSets`
  // (coverage.js, WP-F13) already resolves "this case's LATEST recorded
  // status" from a set of executions -- reused here rather than
  // reimplemented, per WP-F13's own R3 lesson that a rule expressed twice
  // drifts. Scoped to `relevantExecutions` (already filtered above to
  // executions of THIS release's own resolved plans), never
  // `allExecutions` -- a case that passed under some unrelated plan must
  // not make this release read green (WP-F15b's R3 "which release
  // actually found this" honesty, applied to test-case status too).
  const testCaseIdSet = new Set(allTestCases.map((tc) => tc.TestCaseId));
  const { latestStatusByCaseId } = resolveExecutionSets(relevantExecutions, testCaseIdSet);

  // A case absent from `latestStatusByCaseId` was never executed under ANY
  // of this release's resolved plans at all -- a different claim from an
  // execution record that explicitly recorded 'No Run' for it. Collapsing
  // the two would tell someone reading a release sign-off "this was
  // checked and didn't run" when the truth is "this was never attempted
  // here" -- so it gets its own, differently-worded sentinel rather than
  // reusing the vocabulary's own 'No Run'.
  const NOT_EXECUTED_IN_RELEASE = 'Not run in this release';
  const attachLatestStatus = (tc) => ({
    ...tc,
    latestStatus: latestStatusByCaseId.get(tc.TestCaseId) || NOT_EXECUTED_IN_RELEASE
  });
  const linkedTestCasesWithStatus = linkedTestCases.map(attachLatestStatus);
  const derivedTestCasesWithStatus = derivedTestCases.map(attachLatestStatus);

  let executed = 0;
  let passed = 0;
  let failed = 0;
  let blocked = 0;
  relevantExecutions.forEach((execution) => {
    (execution.TestCases || []).forEach((tc) => {
      const status = (tc.TestStatus || '').toLowerCase();
      if (!isExecuted(status)) {
        return;
      }
      executed += 1;
      if (status === 'pass') {
        passed += 1;
      } else if (status === 'fail') {
        failed += 1;
      } else if (status === 'blocked') {
        blocked += 1;
      }
    });
  });

  return {
    release: {
      releaseId: release.releaseId,
      name: release.name,
      status: release.status,
      targetDate: release.targetDate
    },
    // R5 — every count below ships with what it was counted OUT OF, so a
    // release with nothing linked reads as "0 of 0 counted, nothing linked
    // yet", never as a bare, indistinguishable-from-perfect "0".
    links: {
      // Raw rows this lens looked at, BEFORE collapsing the client's
      // forward/reverse double-write into one counterpart per logical
      // link -- a mirrored pair contributes 2 here and 1 to
      // distinctCounterparts below; that gap is expected, not a bug.
      rawLinkRowsSeen: srcLinks.length + destLinks.length,
      distinctCounterparts: counterparts.size,
      resolvedCount,
      unresolvedCount,
      ignoredOtherModuleCount,
      // R4's denominator rule applied to the case -> requirement hop's own
      // unscoped fetch (see the comment above `allLinksTruncated`): true
      // when the link collection has more rows than this lens fetched, in
      // which case a derived requirement past that cutoff may be missing
      // and not merely absent. `note` is only set alongside `true`, same
      // "this figure has a caveat" shape `executions.note` below uses for
      // the executed-count case.
      derivationTruncated: allLinksTruncated,
      note: allLinksTruncated
        ? 'more link rows exist than this lens fetched (over 10000); a derived requirement reachable only through a link row past that cutoff may be missing'
        : undefined
    },
    // R2: `derivedCount`/`derived` are new SIBLING keys -- `linkedCount`/
    // `linked` keep meaning exactly what they meant before this task
    // (explicit links only; ReleaseDetail.tsx and the report cache read
    // them and must not see their meaning shift).
    requirements: {
      linkedCount: linkedRequirements.length,
      linked: linkedRequirements,
      derivedCount: derivedRequirements.length,
      derived: derivedRequirements
    },
    testCases: {
      linkedCount: linkedTestCases.length,
      linked: linkedTestCasesWithStatus,
      derivedCount: derivedTestCases.length,
      derived: derivedTestCasesWithStatus
    },
    // R3 — no derivedCount/derived key here, deliberately, in any form. A
    // defect linked to a derived requirement may be from any release or
    // any year (that requirement link carries no release/version context
    // of its own); inheriting it would over-report with total confidence.
    // The honest alternative -- "raised from an execution of one of this
    // release's plans" -- has no data behind it (Defect carries no
    // execution/run/plan/case reference at all). Defects enter a release
    // by an explicit link, and by nothing else.
    defects: {
      linkedCount: linkedDefects.length,
      byStatus: {
        categories: defectStatusCategories,
        series: [{ id: 'count', label: 'Defects', data: defectStatusCategories.map((c) => defectStatusCounts.get(c)) }]
      },
      linked: linkedDefects
    },
    testPlans: {
      configuredCount: configuredPlanIds.length,
      linkedCount: resolvedPlans.length,
      unresolvedCount: configuredPlanIds.length - resolvedPlans.length,
      linked: resolvedPlans.map((p) => ({ _id: String(p._id), TestPlanId: p.TestPlanId }))
    },
    executions: {
      executed,
      passed,
      failed,
      blocked,
      passRatePercent: executed > 0 ? Math.round((passed / executed) * 10000) / 100 : null,
      note: executed === 0 ? 'no executed test cases found in this release\'s linked test plans' : undefined
    }
  };
}

module.exports = { computeReleaseLens };
