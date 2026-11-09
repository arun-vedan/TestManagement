import { Alert, Box, Stack, Typography } from '@mui/material';
import MainLayout from '../Components/Layout/MainLayout';
import { usePersonaReports } from './dashboard/usePersonaReports';
import { useReportState } from './dashboard/useReportState';
import { TestManagerSection } from './dashboard/sections/TestManagerSection';
import { QaExecSection } from './dashboard/sections/QaExecSection';
import { TraceabilityMatrixSection } from './dashboard/sections/TraceabilityMatrixSection';

// WP-044 — /projects/:projectId/reports. The WP's required route list
// (dashboard, requirements, testrepo, testplan, testexecution, defects,
// releases, reports, settings) names "reports" as its own destination
// distinct from "dashboard", but no prior WP ever built a standalone
// reports page -- WP-041's persona dashboard (Pages/dashboard/index.tsx)
// already surfaces every WP-040 report, role-gated into "My work" /
// "Plan & progress" / "Release & quality" sections.
//
// Rather than duplicate that logic or leave "reports" as a dead route,
// this page reuses the two manager-tier sections directly (same
// components, same hooks, same react-query cache keys -- WP-044 added no
// new report-fetching code; WP-F13 Task 3 later added exactly one, the
// traceability matrix below, to the SAME shared usePersonaReports hook
// rather than a parallel fetch) as an ungated cross-project reporting view:
// every project member can open it, not just manager/admin (Dashboard
// hides these behind a role check because they're framed there as *that
// persona's* dashboard; here they're framed as "the reports", which any
// viewer plausibly wants to read even without write access -- the
// underlying data is already read-only). The real authorization boundary
// is unchanged either way: reportingService's own read gate, same as
// every other report consumer (see usePersonaReports.ts / useReportState.ts
// for the shared fetch/loading/stale/unavailable handling this reuses
// unmodified).
//
// This page is the ONLY caller that passes `{ includeTraceability: true }`
// to usePersonaReports -- Dashboard's own call stays a bare
// `usePersonaReports()`, so visiting Dashboard never fires
// computeTraceability's six-service fan-out for a section it doesn't
// render (fix round 1, coordinator review: see usePersonaReports.ts's own
// comment on that option).
//
// "My work" (TesterSection, workload-based) is deliberately NOT included
// here -- it's inherently personal ("my assigned/failed tests"), which
// belongs on the personal dashboard, not a project-wide reports page.
export default function Reports() {
    const reports = usePersonaReports({ includeTraceability: true });
    const coverage = useReportState(reports.coverage);
    const passRateTrend = useReportState(reports.passRateTrend);
    const defectSummary = useReportState(reports.defectSummary);
    const planProgress = useReportState(reports.planProgress);
    const releaseReadiness = useReportState(reports.releaseReadiness);
    const traceability = useReportState(reports.traceability);

    return (
        <MainLayout>
            <Box mt={'8vh'}>
                <Stack spacing={4} pb={4}>
                    <Typography variant="h5" color="primary">
                        Reports
                    </Typography>
                    <Alert severity="info" variant="outlined">
                        The same live reporting data as the Dashboard's management sections, open to every project
                        member.
                    </Alert>
                    <TestManagerSection coverage={coverage} planProgress={planProgress} passRateTrend={passRateTrend} />
                    <QaExecSection releaseReadiness={releaseReadiness} defectSummary={defectSummary} planProgress={planProgress} />
                    {/* WP-F13 Task 3 — the requirement traceability matrix:
                        Task 1's corrected coverage figure and Task 2's
                        per-requirement rows behind it, both on screen, plus
                        a CSV export. Lives here (not Dashboard) because a
                        row-per-requirement matrix is a reporting/audit view,
                        not a dashboard-tile summary. */}
                    <TraceabilityMatrixSection coverage={coverage} traceability={traceability} />
                </Stack>
            </Box>
        </MainLayout>
    );
}
