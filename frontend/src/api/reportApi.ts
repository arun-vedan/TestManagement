import axiosPrivate from './axios';

// WP-041 — reportingService (WP-040) client. A *new* module, per the
// established convention (releaseApi.ts, testPlanApi.ts, linkApi.ts,
// apiKeyApi.ts, notificationApi.ts) — never apiCalls.tsx.
//
// Project scope: every reportingService route requires an X-Project-Id
// header (WP-021 convention, same as releaseApi.ts). Unlike releaseApi.ts,
// this module does NOT set its own PROJECT_SCOPE_HEADERS constant --
// api/axios.tsx's request interceptor already attaches
// `X-Project-Id: CURRENT_PROJECT_ID` to every request that doesn't set its
// own (see currentProject.ts), and every call here deliberately leaves that
// default in place so a future real project-switcher (that file's own
// TODO) only has to change one place, not every API module.
//
// Response shape: every GET here returns the exact envelope
// controllers/reports.js's getOrCompute() builds --
// {success, projectId, reportType, computedAt, stale, staleReason?, data}.
// `data`'s own shape is documented per report below; WP-040 shaped every
// one of them to match the chart primitives in
// Components/charts/*.tsx literally (see that WP's EXECUTION_LOG.md entry,
// "The WP-042 chart contract"), so a caller can usually spread `data.<key>`
// straight onto a chart component with no reshaping.

export interface DonutSlice {
  id: string;
  label: string;
  value: number;
}

export interface ReportBarSeries {
  id: string;
  label: string;
  data: number[];
}

export interface ReportTrendSeries {
  id: string;
  label: string;
  data: (number | null)[];
}

export interface ReportEnvelope<T> {
  success: boolean;
  projectId: number;
  reportType: string;
  computedAt: string;
  // A materialized cache entry the compute couldn't refresh just now
  // (a dependency call failed) is still served -- labeled, never silently
  // presented as current. See controllers/reports.js's getOrCompute()
  // header comment for the full fail-closed/serve-stale policy.
  stale: boolean;
  staleReason?: string;
  data: T;
}

// WP-F13 Task 1 — R2: four mutually exclusive, exhaustive segments replace
// the old single `value` percent (removed -- it was a fixed-at-0%
// percentage of a definition that was wrong by construction, see
// backend/reportingService/services/coverage.js's header comment). Every
// requirement is in exactly one of these four; they sum to `total`.
export interface CoverageSegments {
  noTestsLinked: number;
  notFullyVerified: number;
  executedFailing: number;
  executedPassing: number;
}

export interface CoverageData {
  label: string;
  total: number;
  // The linkage headline (R6): `tested`/`untested` are still "has at least
  // one linked case" / "has none" -- now derived from `segments` itself
  // (tested = total - segments.noTestsLinked), never computed separately.
  tested: number;
  untested: number;
  segments: CoverageSegments;
  // Present only when `total` is 0 -- R6's "reports zeros AND says so".
  note?: string;
  breakdown: { data: DonutSlice[] };
}

export interface PassRateTrendData {
  xLabels: string[];
  series: ReportTrendSeries[];
  // WP-103: the backend no longer emits this. It used to be set (with
  // xLabels/series both empty) for any project other than the Default one,
  // because reportingService believed testPlanExecutionService had no
  // per-project scoping. That was false -- TestPlan/TestExecution both carry
  // a required, indexed projectId and every route there mounts
  // requireProjectScope() -- so the guard was deleted and every project now
  // gets its own real numbers. Kept optional (not removed) so the dashboard's
  // existing `note || 'No test executions recorded in this period.'`
  // fallbacks keep compiling and simply render the honest empty state; those
  // now-unreachable branches are a candidate cleanup WP, not this one's.
  note?: string;
}

export interface DefectSummaryData {
  total: number;
  byStatus: { categories: string[]; series: ReportBarSeries[] };
  bySeverity: { data: DonutSlice[] };
  byAge: { categories: string[]; series: ReportBarSeries[] };
}

export interface PlanProgressData {
  categories: string[]; // TestPlanId, e.g. "PLN-5"
  series: ReportBarSeries[]; // executed / passed / blocked
  note?: string; // see PassRateTrendData.note
}

export interface ReleaseSummary {
  releaseId: string;
  status: string;
  overall: 'green' | 'red';
  passed: boolean;
  ruleCount: number;
}

export interface ReleaseReadinessData {
  total: number;
  rollup: { data: DonutSlice[] }; // green / red counts
  releases: ReleaseSummary[];
}

export interface WorkloadData {
  categories: string[]; // raw Keycloak `sub` ids -- see services/workload.js's
  // header comment: no display-name join exists yet, a known WP-040 gap.
  series: ReportBarSeries[]; // assigned / completed
  note?: string; // see PassRateTrendData.note
}

// WP-F15/F18 Task 4/5 -- the release lens (backend/reportingService/
// services/releaseLens.js). Deliberately NOT a `ReportEnvelope<T>` like the
// six reports above: this is never written through getOrCompute/
// ReportCache (that cache's key is (projectId, reportType), one row per
// project -- a lens keyed by (projectId, releaseId) is a finer grain it was
// never built to hold), so its envelope has no `stale`/`staleReason` at
// all -- controllers/reports.js's getReleaseLens handler builds
// `{success, projectId, releaseId, computedAt, data}` directly, every call
// computed fresh. `data`'s shape mirrors computeReleaseLens's own return
// value exactly, R5 built into the type itself: every one of
// requirements/testCases/defects/testPlans below carries both `linkedCount`
// and the array it counted, never a bare number.
export interface ReleaseLensLinkedRequirement {
  reqId: string;
  requirementSummary?: string;
}

// WP-F23 Task 1, fix round 1 (R3 amended) -- `latestStatus` is this case's
// LATEST recorded execution status, scoped to executions of THIS release's
// OWN resolved test plans (backend/reportingService/services/releaseLens.js
// -- resolveExecutionSets(relevantExecutions, ...), reused from coverage.js
// rather than reimplemented). A case with no execution under any of this
// release's own plans reads as the literal string 'Not run in this
// release' -- a DIFFERENT claim from an execution that explicitly recorded
// 'No Run' -- never silently defaulted to 'No Run' or omitted. Every other
// value (including one this vocabulary has never seen, e.g. 'InProgress')
// is passed through verbatim; the backend does not normalize it.
export interface ReleaseLensLinkedTestCase {
  TestCaseId: string;
  TestCaseSummary?: string;
  latestStatus: string;
}

export interface ReleaseLensLinkedDefect {
  defectId: string;
  summary?: string;
  Status: string;
  Severity: string;
}

export interface ReleaseLensLinkedTestPlan {
  _id: string;
  TestPlanId: string;
}

// WP-F15b Task 1/2 -- derived membership. `via` is deliberately NOT a
// common `{type, id}` shape shared between the two: it names its own
// one-hop-up provenance. A derived test case's `via` lists the attached
// plans that contain it (a case can be in more than one); a derived
// requirement's `via` lists the derived cases that reach it. Both are
// arrays because that fan-in is real, not an implementation artifact.
export interface ReleaseLensDerivedTestCaseVia {
  _id: string;
  TestPlanId: string;
}

export interface ReleaseLensDerivedTestCase extends ReleaseLensLinkedTestCase {
  via: ReleaseLensDerivedTestCaseVia[];
}

export interface ReleaseLensDerivedRequirementVia {
  TestCaseId: string;
  TestCaseSummary?: string;
}

export interface ReleaseLensDerivedRequirement extends ReleaseLensLinkedRequirement {
  via: ReleaseLensDerivedRequirementVia[];
}

export interface ReleaseLensData {
  release: { releaseId: string; name: string; status: string; targetDate?: string };
  links: {
    rawLinkRowsSeen: number;
    distinctCounterparts: number;
    resolvedCount: number;
    unresolvedCount: number;
    ignoredOtherModuleCount: number;
    // Fix round (Finding 4) -- R4's denominator rule applied to the case ->
    // requirement derivation hop's own unscoped, 10000-row-capped link
    // fetch (releaseLens.js's own header comment on `allLinksTruncated`
    // explains why that one fetch, unlike every other in this lens, can
    // silently fall short). `true` means a derived requirement reachable
    // only through a link row past that cutoff may be missing from this
    // response; `note` explains it, unset when `false`.
    derivationTruncated: boolean;
    note?: string;
  };
  // R2 -- `derivedCount`/`derived` are SIBLING keys, not a merge into
  // `linkedCount`/`linked`. Those two keep meaning exactly what they meant
  // before this task: explicit links only. Collapsing the two would lose
  // the ability to tell a coverage gap (nothing derives) from a linking gap
  // (nothing was ever explicitly asserted) -- the whole reason R2 exists.
  requirements: {
    linkedCount: number;
    linked: ReleaseLensLinkedRequirement[];
    derivedCount: number;
    derived: ReleaseLensDerivedRequirement[];
  };
  testCases: {
    linkedCount: number;
    linked: ReleaseLensLinkedTestCase[];
    derivedCount: number;
    derived: ReleaseLensDerivedTestCase[];
  };
  // R3 -- deliberately no `derivedCount`/`derived` key here, in any form. A
  // defect linked to a derived requirement may be from any release or any
  // year; inheriting it would over-report with total confidence. Do not add
  // one, and do not build a UI affordance implying one is coming.
  defects: {
    linkedCount: number;
    byStatus: { categories: string[]; series: ReportBarSeries[] };
    linked: ReleaseLensLinkedDefect[];
  };
  testPlans: {
    configuredCount: number;
    linkedCount: number;
    unresolvedCount: number;
    linked: ReleaseLensLinkedTestPlan[];
  };
  executions: {
    executed: number;
    passed: number;
    failed: number;
    blocked: number;
    passRatePercent: number | null;
    note?: string;
  };
}

export interface ReleaseLensEnvelope {
  success: boolean;
  projectId: number;
  releaseId: string;
  computedAt: string;
  data: ReleaseLensData;
}

// WP-F13 Task 2/3 -- the requirement traceability matrix
// (backend/reportingService/services/traceability.js). One row per
// requirement, carrying its linked test cases (each with its own LATEST
// execution status), its linked defects, a plain test COUNT (R4: an
// indicator of thinness, never a score -- no percentage/grade/colour scale
// implied anywhere downstream), and `segment` -- decided by the exact same
// function (classifyRequirementSegment) that decides CoverageData's own
// segment counts above (R3), so a row's segment and the coverage tile's
// counts can never quietly disagree. Callers must never recompute
// `segment` (or the coverage summary) from these rows -- render exactly
// what arrives.
export interface TraceabilityTestCase {
  TestCaseId: string;
  TestCaseSummary?: string;
  // The case's LATEST execution status, VERBATIM. Live data contains
  // values outside Pass/Fail/No Run (e.g. 'InProgress') -- render whatever
  // string arrives; never map an unrecognised value to a default, and
  // never render one as if it were a pass (R2/R6).
  status: string;
}

export interface TraceabilityDefect {
  defectId: string;
  summary?: string;
  Status: string;
  Severity: string;
}

// The exact four segment ids classifyRequirementSegment can return --
// mirrors CoverageSegments' own four keys above.
export type TraceabilitySegment = 'noTestsLinked' | 'notFullyVerified' | 'executedFailing' | 'executedPassing';

export interface TraceabilityRow {
  reqId: string;
  requirementSummary?: string;
  testCases: TraceabilityTestCase[];
  // R4 -- a plain count, rendered as a count by whatever consumes this.
  testCount: number;
  defects: TraceabilityDefect[];
  segment: TraceabilitySegment;
}

export interface TraceabilityData {
  label: string;
  total: number;
  rows: TraceabilityRow[];
  // Present only when `total` is 0 -- R6's "reports zeros AND says so".
  note?: string;
}

const REPORTS_BASE = '/api/v1/reports';

// `releaseId` is the release's HUMAN id ('REL-n'), not its Mongo `_id` --
// the query param computeReleaseLens's own header comment documents, and
// the one every other function in this module also takes a Mongo id for
// (getCoverage etc. take none at all; this is the exception). Callers
// holding only the Mongo `_id` (e.g. ReleaseDetail.tsx, whose `entityId`
// IS the `_id`) must pass `values.releaseId`, never `entityId` itself.
export const getReleaseLens = async (releaseId: string): Promise<ReleaseLensEnvelope> => {
  const resp = await axiosPrivate.get(`${REPORTS_BASE}/release-lens`, { params: { releaseId } });
  return resp.data;
};

export const getCoverage = async (): Promise<ReportEnvelope<CoverageData>> => {
  const resp = await axiosPrivate.get(`${REPORTS_BASE}/coverage`);
  return resp.data;
};

export const getPassRateTrend = async (days = 30): Promise<ReportEnvelope<PassRateTrendData>> => {
  const resp = await axiosPrivate.get(`${REPORTS_BASE}/pass-rate-trend`, { params: { days } });
  return resp.data;
};

export const getDefectSummary = async (): Promise<ReportEnvelope<DefectSummaryData>> => {
  const resp = await axiosPrivate.get(`${REPORTS_BASE}/defect-summary`);
  return resp.data;
};

export const getPlanProgress = async (): Promise<ReportEnvelope<PlanProgressData>> => {
  const resp = await axiosPrivate.get(`${REPORTS_BASE}/plan-progress`);
  return resp.data;
};

export const getReleaseReadiness = async (): Promise<ReportEnvelope<ReleaseReadinessData>> => {
  const resp = await axiosPrivate.get(`${REPORTS_BASE}/release-readiness`);
  return resp.data;
};

export const getWorkload = async (): Promise<ReportEnvelope<WorkloadData>> => {
  const resp = await axiosPrivate.get(`${REPORTS_BASE}/workload`);
  return resp.data;
};

export const getTraceability = async (): Promise<ReportEnvelope<TraceabilityData>> => {
  const resp = await axiosPrivate.get(`${REPORTS_BASE}/traceability`);
  return resp.data;
};

// A report GET 503s ONLY when there is no cache entry yet AND the live
// compute failed (getOrCompute's fail-closed branch) -- "nothing honest to
// serve", distinct from a plain network/auth/server error. Widgets use this
// to show a distinct "not available yet" state instead of a generic error
// banner (WP-041 acceptance: "handle 503 distinctly from an error").
export const isReportUnavailable = (error: unknown): boolean => {
  const status = (error as { response?: { status?: number } } | undefined)?.response?.status;
  return status === 503;
};

export const reportErrorMessage = (error: unknown): string => {
  const message = (error as { response?: { data?: { error?: string } } } | undefined)?.response?.data?.error;
  return message || 'Unable to load this report.';
};
