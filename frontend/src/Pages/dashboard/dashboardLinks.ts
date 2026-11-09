// WP-041 — centralized drill-down link construction for the persona
// dashboard.
//
// Every route today is flat (/testexecution, /defects, /releases -- see
// App.tsx) and WP-044 is expected to re-platform all of them to
// /projects/:projectId/... . Every dashboard widget that links out builds
// its href through the functions below rather than hand-writing a path
// string, so that re-platform is a single edit to ROUTE_BASE (and, if the
// query-param vocabulary changes shape, to the builders below it) instead
// of a hunt through every widget component.
//
// The destination pages (originally Pages/testExecution.tsx and
// Pages/defects.tsx, now workbench/EntityDetail.tsx for both -- see the
// WP-076 GAP and its defects counterpart below) read the query params
// these functions emit -- wired in this same WP, see each file's own
// WP-041 comment. Params are a small, deliberate vocabulary (not a generic
// filter DSL):
//   testexecution: assignedTo, status ('fail'|'blocked'|'pass'|'norun')
//   defects:       assignedTo, open ('1'), severity
//   releases:      highlight (comma-separated releaseId list)
//
// WP-F18b Task 4 GAP (reported, not fixed here -- same shape as the
// WP-076 GAP just below, out of this task's scope): releases' own
// destination page (Pages/releases.tsx, which read `highlight` off
// useSearchParams) is retired; the project-scoped `releases` route now
// redirects into the workbench (App.tsx's WorkbenchModuleRedirect, which
// forwards location.search) and nothing there reads `highlight` --
// ReleaseDetail.tsx has no list view of its own, and entityListConfigs.tsx's
// releaseConfig has no filter wired to this param either. releasesNeedingAttentionLink's
// "release readiness" widget on the dashboard still builds a real
// `?highlight=REL-1,REL-3` URL; it now lands on the unfiltered release list
// instead of a highlighted/filtered one.
//
// WP-076 GAP (reported, not fixed here -- out of this WP's scope): the
// testexecution query string above is still emitted and still survives the
// redirect chain (App.tsx's WorkbenchModuleRedirect forwards
// location.search), landing on
// /projects/:id/workbench/testruns?assignedTo=...&status=.... Nothing in
// the workbench (EntityTree/TestRunDetail) reads those params, so
// myAssignedTestsLink/myFailedTestsLink/blockedTestsLink's "View all" deep
// links now land on the unfiltered full test-runs tree instead of the
// filtered list Pages/testExecution.tsx used to render via
// TestExecutionFilterPanel. The dashboard's own inline mini-panel
// (Pages/dashboard/sections/TesterSection.tsx) is unaffected -- it builds
// its own URLSearchParams in-process and never round-trips through this
// route.
//
// WP-077 (Defects, no equivalent gap): unlike testexecution above,
// EntityDetail.tsx renders DefectFilterPanel directly (before its module-5
// tab-dispatch branch) whenever `assignedTo`/`open`/`severity` are present
// and no tab is open, so myOpenDefectsLink/defectsBySeverityLink's "View
// all" deep links keep landing on the filtered list through the
// /projects/:id/defects -> WorkbenchModuleRedirect ->
// /projects/:id/workbench/defects chain. See
// workbench/__tests__/EntityDetail.test.tsx for both directions.
//
// WP-044: this is the single edit this file's own header comment
// predicted -- every route re-platformed onto /projects/:projectId/...
// Each ROUTE_BASE member is now a getter (not a plain string) reading
// getCurrentProjectId() -- the same route-driven singleton
// Layouts/ProjectRouteLayout.tsx writes on every project route mount --
// so every existing call site below and in every widget that imports
// ROUTE_BASE keeps working unchanged; only this module needed to change.
import { getCurrentProjectId } from '../../currentProject';

function projectPath(segment: string): string {
  return `/projects/${getCurrentProjectId()}/${segment}`;
}

export const ROUTE_BASE = {
  get testExecution(): string {
    return projectPath('testexecution');
  },
  get defects(): string {
    return projectPath('defects');
  },
  get releases(): string {
    return projectPath('releases');
  },
  get testPlan(): string {
    return projectPath('testplan');
  },
  get requirements(): string {
    return projectPath('requirements');
  },
};

// TestCases[].TestStatus's real stored casing (see backend/
// testPlanExecutionService/models/TestExecution.js's ExecutionTestCaseSchema
// and services/planProgress.js's isExecuted()) -- 'fail'/'blocked' etc. in
// a URL is nicer to read/type than 'No Run', but the destination page needs
// the exact stored string to filter on, so the mapping lives here, once.
export const EXECUTION_STATUS_FILTER_VALUES: Record<string, string> = {
  fail: 'Fail',
  pass: 'Pass',
  blocked: 'Blocked',
  norun: 'No Run',
};

function buildQuery(params: Record<string, string | undefined>): string {
  const usp = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '') {
      usp.set(key, value);
    }
  });
  const qs = usp.toString();
  return qs ? `?${qs}` : '';
}

/** Tester: "my assigned tests" -> every TestExecution assigned to me. */
export function myAssignedTestsLink(sub: string): string {
  return `${ROUTE_BASE.testExecution}${buildQuery({ assignedTo: sub })}`;
}

/** Tester: "my failed tests" -> my TestExecutions with at least one failed case. */
export function myFailedTestsLink(sub: string): string {
  return `${ROUTE_BASE.testExecution}${buildQuery({ assignedTo: sub, status: 'fail' })}`;
}

/** Test Manager: "blocked tests" -> every TestExecution (any assignee) with a blocked case. */
export function blockedTestsLink(): string {
  return `${ROUTE_BASE.testExecution}${buildQuery({ status: 'blocked' })}`;
}

/** Tester: "my open defects" -> defects assigned to me, excluding closed ones. */
export function myOpenDefectsLink(sub: string): string {
  return `${ROUTE_BASE.defects}${buildQuery({ assignedTo: sub, open: '1' })}`;
}

/** QA Manager: "defect trend" -> defects at a given severity (e.g. the largest bucket in bySeverity). */
export function defectsBySeverityLink(severity: string): string {
  return `${ROUTE_BASE.defects}${buildQuery({ severity })}`;
}

/**
 * QA Manager: "release readiness" -> the releases list. Built from data
 * the dashboard already has in hand (release-readiness's own `releases[]`),
 * not a second network call. The `highlight` param this emits is not
 * currently read anywhere after WP-F18b Task 4 (see this file's own GAP
 * comment above) -- the not-green releases are no longer actually
 * highlighted/filtered on landing, only linked to the unfiltered list.
 */
export function releasesNeedingAttentionLink(releaseIds: string[]): string {
  if (releaseIds.length === 0) {
    return ROUTE_BASE.releases;
  }
  return `${ROUTE_BASE.releases}${buildQuery({ highlight: releaseIds.join(',') })}`;
}

/** Plain, unfiltered links -- deliberately no query params. See EXECUTION_LOG.md's
 * WP-041 report for why coverage/plan-progress don't get a deep filter (the
 * Requirements and Test Plans destinations -- Pages/requirements.tsx and
 * Pages/testPlan.tsx at the time, since WP-075/WP-076 retired into the
 * workbench Requirements/Test Plans modules -- were folder-tree UIs, same
 * architecture as defects.tsx/testExecution.tsx were before WP-041, and
 * retrofitting a filtered view into them was judged out of that WP's scope --
 * a stated gap, not a silent one). */
export function testPlansLink(): string {
  return ROUTE_BASE.testPlan;
}

export function requirementsLink(): string {
  return ROUTE_BASE.requirements;
}
