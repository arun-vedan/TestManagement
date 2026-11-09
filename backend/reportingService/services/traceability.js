const { requestWithRetry } = require('@srckube/service-core');
const {
  REQUIREMENT_SERVICE,
  TESTREPO_SERVICE,
  LINK_ISSUE_SERVICE,
  TEST_PLAN_EXECUTION_SERVICE,
  DEFECT_SERVICE,
  ISTATUS_SERVICE
} = require('./serviceUrls');
const { buildLinkedCaseIdsByReq, resolveExecutionSets, classifyRequirementSegment } = require('./coverage');

// WP-F13 Task 2 -- the traceability matrix: one row per requirement in the
// caller's project, carrying its linked test cases (each with its latest
// execution status), its linked defects, its test count (R4, an indicator
// never a score), and its segment.
//
// R3 -- the segment on every row here and the four counts Task 1's
// computeCoverage reports are decided by the exact same function
// (classifyRequirementSegment), fed the exact same link traversal
// (buildLinkedCaseIdsByReq) and the exact same opt-in-to-success status
// resolution (resolveExecutionSets), all imported from ./coverage rather
// than reimplemented here. A matrix row and the summary tile it backs can
// therefore never quietly disagree about which segment a requirement is
// in -- see coverage.js's own module.exports comment for why two copies
// was the thing R3 was written to rule out.
//
// R5 -- same automation seam as coverage.js: TestExecution.TestCases[]'s
// `source` field (manual vs CI-posted, WP-033) is never read or filtered
// on anywhere in this file. When automated results are bound, they land as
// rows in the same execution records this already reads and simply start
// appearing in a case's latest-status column -- no shape change, no
// special-casing added here to "support" them.

// linkIssueService's module ids for the three entity types this traversal
// cares about (same numbering coverage.js/releaseLens.js both use).
const MODULE = { TEST_CASE: 1, REQUIREMENT: 2, DEFECT: 5 };
// WP-141's external-issue module id (linkIssueService/utils/externalLink.js).
const EXTERNAL_MODULE = 100;

// defectService's `Status` field stores EITHER the istatus numeric id (as a
// Number or a String) OR the istatus name -- copied verbatim from
// defectSummary.js/releaseLens.js (both already carry this exact function
// for the identical reason: no shared library home exists today for this
// one dependency pair's status-resolution quirk).
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

// Premise 2 -- defects link to BOTH requirements (module 5<->2) AND test
// cases (module 5<->1); a requirement's defect list must union both edges
// without double-counting a defect reachable through both (live data has
// exactly this shape: Req-1 is linked directly to Bug-1 AND Req-1's own
// linked case TC-1 is separately linked to Bug-1). Built in one pass over
// the whole link collection (same batch-not-per-requirement reasoning
// buildLinkedCaseIdsByReq's own comment gives), checking BOTH
// sourceId/destinationId sides of every row for BOTH edges (premise 3:
// bidirectionality is a client-side double write, never a backend
// guarantee).
//
// R7 is preserved by construction, not by an extra check: this function
// only ever recognises a REQUIREMENT<->DEFECT or TEST_CASE<->DEFECT module
// pairing, so it can never be tricked into treating a 1<->1 (case<->case)
// row as anything -- that module pairing simply never matches either
// branch below.
function buildDefectIdsByReq(links, reqIdSet, caseIdSet, defectIdSet, linkedCaseIdsByReq) {
  const reqDefectIds = new Map(); // reqId -> Set<defectId>, the direct 5<->2 edge
  const caseDefectIds = new Map(); // TestCaseId -> Set<defectId>, the 5<->1 edge

  links.forEach((l) => {
    if (l.srcModule === MODULE.REQUIREMENT && l.destinationModule === MODULE.DEFECT) {
      addEdge(reqDefectIds, l.sourceId, l.destinationId, reqIdSet, defectIdSet);
    } else if (l.destinationModule === MODULE.REQUIREMENT && l.srcModule === MODULE.DEFECT) {
      addEdge(reqDefectIds, l.destinationId, l.sourceId, reqIdSet, defectIdSet);
    }

    if (l.srcModule === MODULE.TEST_CASE && l.destinationModule === MODULE.DEFECT) {
      addEdge(caseDefectIds, l.sourceId, l.destinationId, caseIdSet, defectIdSet);
    } else if (l.destinationModule === MODULE.TEST_CASE && l.srcModule === MODULE.DEFECT) {
      addEdge(caseDefectIds, l.destinationId, l.sourceId, caseIdSet, defectIdSet);
    }
  });

  // Union the two edges per requirement, via a Set -- a defect reachable
  // through BOTH the direct requirement edge and one of the requirement's
  // own linked cases collapses to a single membership, never two.
  const defectIdsByReq = new Map();
  reqIdSet.forEach((reqId) => {
    const combined = new Set(reqDefectIds.get(reqId) || []);
    const linkedCaseIds = linkedCaseIdsByReq.get(reqId);
    if (linkedCaseIds) {
      linkedCaseIds.forEach((caseId) => {
        const viaCase = caseDefectIds.get(caseId);
        if (viaCase) {
          viaCase.forEach((defectId) => combined.add(defectId));
        }
      });
    }
    if (combined.size > 0) {
      defectIdsByReq.set(reqId, combined);
    }
  });
  return defectIdsByReq;
}

// Premise 4's scoping rule, applied here exactly like buildLinkedCaseIdsByReq
// already applies it to requirement/case ids: an endpoint id absent from
// this project's own (already project-scoped) entity list is silently
// dropped -- deleted, or belonging to a different project.
function addEdge(byKey, keyId, otherId, keyIdSet, otherIdSet) {
  if (!keyIdSet.has(keyId) || !otherIdSet.has(otherId)) {
    return;
  }
  const set = byKey.get(keyId) || new Set();
  set.add(otherId);
  byKey.set(keyId, set);
}

async function computeTraceability(projectId, headers) {
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
  if (!DEFECT_SERVICE) {
    throw new Error('defectService is not configured');
  }
  if (!ISTATUS_SERVICE) {
    throw new Error('istatusService is not configured');
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

  const [reqResp, tcResp, linkResp, execResp, defectsResp, statusResp] = await Promise.all([
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
    // Unfiltered -- premise 3, same "fetch everything, filter client-side"
    // pattern coverage.js/releaseLens.js already use against this same
    // unscoped dependency.
    requestWithRetry({
      method: 'get',
      url: `http://${LINK_ISSUE_SERVICE}/api/v1/linkIssue`,
      params: { limit: 10000 },
      headers: linkHeaders
    }),
    // R5 -- every execution, unfiltered by `source`.
    requestWithRetry({
      method: 'get',
      url: `http://${TEST_PLAN_EXECUTION_SERVICE}/api/v1/testexecution`,
      params: { limit: 10000 },
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
    })
  ]);

  const requirements = (reqResp.data && reqResp.data.data) || [];
  const testCases = (tcResp.data && tcResp.data.data) || [];
  const links = (linkResp.data && linkResp.data.data) || [];
  const executions = (execResp.data && execResp.data.data) || [];
  const defects = (defectsResp.data && defectsResp.data.data) || [];
  const statusList = (statusResp.data && statusResp.data.data) || [];

  // Premise 4 -- every id set below is built from an already project-scoped
  // list (requirementService/testRepoService/defectService all sit behind
  // requireProjectScope() since WP-021), so any link naming an id outside
  // these sets (deleted, or belonging to a different project) is silently
  // dropped by buildLinkedCaseIdsByReq/buildDefectIdsByReq -- never
  // produces a row entry, exactly the "a link to a deleted case does not
  // produce a row entry" and "a requirement in another project is absent"
  // behaviors this task's tests require.
  const reqIdSet = new Set(requirements.map((r) => r.reqId));
  const caseIdSet = new Set(testCases.map((tc) => tc.TestCaseId));
  const defectIdSet = new Set(defects.map((d) => d.defectId));

  const testCasesById = new Map(testCases.map((tc) => [tc.TestCaseId, tc]));
  const defectsById = new Map(defects.map((d) => [d.defectId, d]));

  // R3 -- the SAME traversal/resolution Task 1's computeCoverage calls,
  // imported rather than reimplemented.
  const linkedCaseIdsByReq = buildLinkedCaseIdsByReq(links, reqIdSet, caseIdSet);
  const { passingCaseIds, failingCaseIds, latestStatusByCaseId } = resolveExecutionSets(executions, caseIdSet);
  const defectIdsByReq = buildDefectIdsByReq(links, reqIdSet, caseIdSet, defectIdSet, linkedCaseIdsByReq);

  // WP-144 — carry external (Jira) links into the matrix, so the chain reaches
  // past this product's own boundary.
  //
  // Reached BOTH ways, exactly as defects are: a Jira issue may be linked
  // straight to a requirement, or to one of the test cases covering it. A
  // matrix showing only the direct edge would miss the common case -- a bug
  // filed against a failing test, which is how most Jira issues arrive.
  //
  // Display fields come from the link's own cached `external` subdocument,
  // NOT from a call to Jira. Deliberate: this report already fans out to six
  // services, and making it also depend on an external system being up would
  // mean a Jira outage blanks the matrix. A stale summary beats no row -- the
  // same argument this service's own cache already makes.
  const externalByReq = new Map();
  const addExternal = (reqId, link) => {
    if (!reqId || !link.external || !link.external.key) return;
    if (!externalByReq.has(reqId)) externalByReq.set(reqId, new Map());
    // Keyed by issue key, so an issue reachable through both edges appears once.
    externalByReq.get(reqId).set(link.external.key, link);
  };
  links.forEach((l) => {
    if (l.destinationModule !== EXTERNAL_MODULE) return;
    if (l.srcModule === MODULE.REQUIREMENT && reqIdSet.has(l.sourceId)) {
      addExternal(l.sourceId, l);
    } else if (l.srcModule === MODULE.TEST_CASE && caseIdSet.has(l.sourceId)) {
      linkedCaseIdsByReq.forEach((caseIds, reqId) => {
        if (caseIds.has(l.sourceId)) addExternal(reqId, l);
      });
    }
  });

  const rows = requirements.map((r) => {
    const linkedCaseIds = linkedCaseIdsByReq.get(r.reqId);
    const testCaseRows = linkedCaseIds
      ? Array.from(linkedCaseIds).map((caseId) => {
          const tc = testCasesById.get(caseId);
          return {
            TestCaseId: caseId,
            TestCaseSummary: tc ? tc.TestCaseSummary : undefined,
            // R6-adjacent: a linked case with no execution record AT ALL
            // (never run, not even a 'No Run' entry) displays as 'No Run'
            // rather than a bare undefined/null a reader could mistake for
            // an error -- consistent with the vocabulary this data already
            // uses for "never actually run".
            status: latestStatusByCaseId.get(caseId) || 'No Run'
          };
        })
      : [];

    const defectIds = defectIdsByReq.get(r.reqId);
    const defectRows = defectIds
      ? Array.from(defectIds).map((defectId) => {
          const d = defectsById.get(defectId);
          return {
            defectId,
            summary: d ? d.summary : undefined,
            Status: d ? resolveStatusName(d.Status, statusList) : 'Unknown',
            Severity: d && d.Severity ? d.Severity : 'Unspecified'
          };
        })
      : [];

    const externalMap = externalByReq.get(r.reqId);
    const externalRows = externalMap
      ? Array.from(externalMap.values()).map((l) => {
          const e = l.external || {};
          return {
            provider: e.provider,
            key: e.key,
            summary: e.summary || null,
            status: e.status || null,
            statusCategory: e.statusCategory || null,
            assigneeDisplayName: e.assigneeDisplayName || null,
            // Lets a row say "deleted in Jira" rather than rendering blank,
            // without this report calling Jira itself.
            missing: Boolean(e.missing),
            fetchedAt: e.fetchedAt || null
          };
        })
      : [];

    return {
      reqId: r.reqId,
      requirementSummary: r.requirementSummary,
      testCases: testCaseRows,
      // R4 -- an indicator, never a score: a plain count, rendered as a
      // count by whatever consumes this, no percentage/grade/threshold
      // colour implied here or downstream.
      testCount: testCaseRows.length,
      defects: defectRows,
      externalIssues: externalRows,
      externalCount: externalRows.length,
      // R3's guard, applied per row: classifyRequirementSegment is the
      // exact function Task 1's computeCoverage calls per requirement to
      // build its segment counts.
      segment: classifyRequirementSegment(linkedCaseIds, passingCaseIds, failingCaseIds)
    };
  });

  return {
    label: 'Requirement traceability',
    total: rows.length,
    rows,
    // R6 -- a project with zero requirements reads as zero rows AND says
    // so, same posture as coverage.js's own `note` for the identical case.
    note: rows.length === 0 ? 'no requirements defined in this project yet' : undefined
  };
}

module.exports = { computeTraceability, buildDefectIdsByReq };
