import { useQuery } from '@tanstack/react-query';
import {
    getCoverage,
    getDefectSummary,
    getPassRateTrend,
    getPlanProgress,
    getReleaseReadiness,
    getTraceability,
    getWorkload,
} from '../../api/reportApi';
import { getCurrentProjectId } from '../../currentProject';

// WP-041 — fetches the WP-040 reports once for the whole dashboard
// page (not per-widget) so persona sections that share a report -- e.g.
// Test Manager's and QA Manager/Exec's plan-progress-derived widgets --
// hit react-query's cache instead of issuing duplicate requests.
//
// Refetch behavior: deliberately NO per-query override of the app's shared
// defaults (queryClient.ts: staleTime 30s, refetchOnWindowFocus/
// refetchOnReconnect false, retry 1) and no refetchInterval polling.
// Reasoning: this dashboard is a summary landing page, not a live
// monitoring view -- reportingService's own cache freshness window
// (REPORT_STALE_MS, 5 minutes by default) means a tighter client poll
// would mostly just re-request the same cached number anyway. 30s is
// exactly the same tradeoff the rest of the app already made (queryClient.ts's
// own comment): a quick tab-away-and-back within the dashboard doesn't
// re-fetch, but a real revisit (new mount, >30s later) does. Six endpoints
// firing on every window focus would be a real, avoidable request burst
// with no benefit for numbers that only actually change every few minutes.
// Fix round 1 (coordinator review, WP-F13 Task 3) -- `includeTraceability`
// defaults to false so a caller that doesn't ask for it (Dashboard,
// index.tsx, which renders no TraceabilityMatrixSection) never triggers
// computeTraceability's six-service fan-out as a side effect of just
// visiting that page. Only reports.tsx (which DOES render that section)
// opts in with `{ includeTraceability: true }`. This is an `enabled` flag
// on the shared hook, not a dedicated parallel hook, because it fits this
// hook's existing "one query per report, keyed by project id" shape with a
// one-line change, and it generalises: the pre-existing (out-of-scope)
// case of reports.tsx fetching `workload` and never using it could be
// fixed later the exact same way -- an `includeWorkload` option here,
// defaulting to true to preserve Dashboard's own need, with reports.tsx
// passing `false`.
export interface UsePersonaReportsOptions {
    includeTraceability?: boolean;
}

export function usePersonaReports({ includeTraceability = false }: UsePersonaReportsOptions = {}) {
    // WP-044: every key includes the current project id. Reports.tsx (the
    // new /projects/:projectId/reports page) and Dashboard both call this
    // hook, and Layouts/ProjectRouteLayout.tsx remounts the whole subtree
    // on a project switch -- but a bare remount alone isn't enough to stop
    // react-query from instantly serving the *previous* project's cached
    // envelope under an unchanged key (queryClient.ts's staleTime is 30s,
    // so a same-key remount inside that window wouldn't even trigger a
    // background refetch). Scoping the key by project makes each project's
    // reports their own cache entry, so switching is a cache miss (fresh
    // fetch, correct data from the first render) rather than a stale hit.
    const projectId = getCurrentProjectId();
    const coverage = useQuery({ queryKey: ['report', 'coverage', projectId], queryFn: () => getCoverage() });
    const passRateTrend = useQuery({ queryKey: ['report', 'pass-rate-trend', 30, projectId], queryFn: () => getPassRateTrend(30) });
    const defectSummary = useQuery({ queryKey: ['report', 'defect-summary', projectId], queryFn: () => getDefectSummary() });
    const planProgress = useQuery({ queryKey: ['report', 'plan-progress', projectId], queryFn: () => getPlanProgress() });
    const releaseReadiness = useQuery({ queryKey: ['report', 'release-readiness', projectId], queryFn: () => getReleaseReadiness() });
    const workload = useQuery({ queryKey: ['report', 'workload', projectId], queryFn: () => getWorkload() });
    // WP-F13 Task 3 -- the traceability matrix (Pages/reports.tsx's
    // TraceabilityMatrixSection). Fetched here, alongside the other six,
    // rather than a parallel hook -- same "once per page, shared through
    // react-query's cache" reasoning as every report above. `enabled` is
    // this option, not a bare `true`: only a caller that passes
    // `includeTraceability: true` (reports.tsx) actually fires the
    // request; Dashboard's plain `usePersonaReports()` leaves it disabled.
    const traceability = useQuery({
        queryKey: ['report', 'traceability', projectId],
        queryFn: () => getTraceability(),
        enabled: includeTraceability,
    });

    return { coverage, passRateTrend, defectSummary, planProgress, releaseReadiness, workload, traceability };
}

export default usePersonaReports;
