import { Alert, Box, Skeleton, Stack, Typography } from '@mui/material';
import MainLayout from '../../Components/Layout/MainLayout';
import { EmptyState } from '../../Components/common/EmptyState';
import { SampleDataCard } from './SampleDataCard';
import keycloak from '../../keycloak';
import { usePermissions } from '../../Hooks/usePermissions';
import { Role } from '../../permissions';
import { usePersonaReports } from './usePersonaReports';
import { useReportState } from './useReportState';
import { TesterSection } from './sections/TesterSection';
import { TestManagerSection } from './sections/TestManagerSection';
import { QaExecSection } from './sections/QaExecSection';
import { AiSummarySection } from './sections/AiSummarySection';

// WP-041 — role-aware persona dashboard. Replaces the previous static
// dashboard.tsx (four plain nav buttons). ONE page, sections gated by
// role -- not three separate apps/routes -- per the WP brief. Every
// widget's data source, empty-state design, and drill-down wiring is
// documented in its own section component; see EXECUTION_LOG.md's WP-041
// report for the full picture.
//
// Role -> section mapping (stated, not a 1:1 translation): WP-022's
// permission matrix (permissions.ts) has exactly four roles --
// admin/manager/contributor/viewer -- not the three personas ("Tester",
// "Test Manager", "QA Manager/Exec") the WP brief names. So:
//   - "My work" (Tester persona): shown to EVERY role, including viewer.
//     Anyone who is a project member can have test executions assigned to
//     them and benefits from seeing their own queue, regardless of write
//     permission.
//   - "Plan & progress" (Test Manager) and "Release & quality" (QA
//     Manager/Exec): manager + admin only. There is no separate "QA
//     Manager" role in WP-022's matrix to gate the second one more
//     narrowly, so both management-tier sections gate identically -- a
//     manager/admin sees both, stacked below "My work"; a
//     contributor/viewer sees only "My work".
const MANAGER_TIER_ROLES: Role[] = ['manager', 'admin'];

const Dashboard = () => {
    const { role, isLoading: roleLoading, isError: roleError } = usePermissions();
    // Same pattern usePermissions.tsx itself uses to read the signed-in
    // user's Keycloak subject -- see that hook's own header comment.
    const sub = (keycloak.tokenParsed as { sub?: string } | undefined)?.sub;

    const reports = usePersonaReports();
    const coverage = useReportState(reports.coverage);
    const passRateTrend = useReportState(reports.passRateTrend);
    const defectSummary = useReportState(reports.defectSummary);
    const planProgress = useReportState(reports.planProgress);
    const releaseReadiness = useReportState(reports.releaseReadiness);
    const workload = useReportState(reports.workload);

    const showManagerSections = Boolean(role && MANAGER_TIER_ROLES.includes(role));

    return (
        <MainLayout>
            <Box mt={'8vh'}>
                <Stack spacing={4} pb={4}>
                    {/* WP-046 — component="h1" keeps the visual "h5" size
                        (variant) but makes this the real, semantic top-level
                        heading FOR THIS PAGE'S OWN CONTENT. Each section
                        below is component="h2" for the same reason, and
                        every WP-042 chart's title defaults to h3 (see
                        ChartCard.tsx's own doc comment: "assumes the card
                        sits inside a page section (h2)") -- unchanged,
                        because THIS is the h2 that default was written for.
                        Before this fix these were h5/h6 (an arbitrary visual
                        choice unrelated to the real heading depth), which
                        skipped straight from a chart's h3 to the next
                        section's h6 -- a real axe heading-order violation
                        (skips h4/h5), confirmed by dashboard.a11y.test.tsx's
                        manager-role scenario. MainLayout (mocked in this
                        page's own tests -- see dashboard.a11y.test.tsx's
                        header comment) is out of this WP's scope; if it
                        renders its own h1 elsewhere, that's a MainLayout
                        concern, not this page's. */}
                    <Typography variant="h5" component="h1" color="primary">
                        Dashboard
                    </Typography>

                    {!sub ? (
                        <Alert severity="warning">Sign in to see your personalized dashboard.</Alert>
                    ) : roleLoading ? (
                        <Skeleton variant="rounded" height={160} data-testid="dashboard-role-loading" />
                    ) : roleError ? (
                        <Alert severity="error">
                            Unable to determine your role on this project right now. Some sections may be hidden until this
                            resolves.
                        </Alert>
                    ) : !role ? (
                        <EmptyState message="You are not a member of this project yet. Ask a project admin to add you to see dashboard data." />
                    ) : (
                        <>
                            {/* WP-133 — the one click from the empty state. Shown
                                only while the project genuinely has no
                                requirements: gated on the coverage report's own
                                total rather than a flag, so it cannot get stuck
                                visible on a project that already has content, and
                                deliberately NOT shown while coverage is loading or
                                unavailable (a timed-out report is not evidence that
                                a project is empty, and offering to fill one on that
                                basis could drop sample data into real work). */}
                            {!coverage.isLoading && !coverage.isUnavailable && (coverage.data?.total ?? 0) === 0 ? (
                                <SampleDataCard />
                            ) : null}
                            <TesterSection sub={sub} workload={workload} />
                            {showManagerSections && (
                                <>
                                    <TestManagerSection coverage={coverage} planProgress={planProgress} passRateTrend={passRateTrend} />
                                    <QaExecSection
                                        releaseReadiness={releaseReadiness}
                                        defectSummary={defectSummary}
                                        planProgress={planProgress}
                                    />
                                    <AiSummarySection />
                                </>
                            )}
                        </>
                    )}
                </Stack>
            </Box>
        </MainLayout>
    );
};

export default Dashboard;
