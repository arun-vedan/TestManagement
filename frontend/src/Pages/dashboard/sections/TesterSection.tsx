import { Alert, Grid, Stack, Typography } from '@mui/material';
import { StatTile } from '../../../Components/charts';
import { TestExecutionFilterPanel } from '../../../Components/dashboardDrilldown/TestExecutionFilterPanel';
import { DefectFilterPanel } from '../../../Components/dashboardDrilldown/DefectFilterPanel';
import { myAssignedTestsLink, myFailedTestsLink, myOpenDefectsLink } from '../dashboardLinks';
import { DrilldownLink } from '../DrilldownLink';
import { StaleBanner } from '../StaleBanner';
import { ReportState } from '../useReportState';
import { WorkloadData } from '../../../api/reportApi';

// WP-041 — "My work": visible to every project role (see Pages/dashboard/
// index.tsx's role-gating comment for why this section, unlike the other
// two, isn't restricted to manager/admin) -- anyone with test executions
// assigned to them benefits from seeing their own queue, regardless of
// their write permissions on the project.
//
// "Assigned"/"Completed" are WP-040's own `workload` report, matched to
// the current user's row by Keycloak `sub` (workload's categories are raw
// subs -- see reportApi.ts's WorkloadData comment, a stated WP-040 gap).
// "My failed tests"/"My open defects" are NOT WP-040 data -- reportingService
// has no per-user list endpoint, only project-wide aggregates -- so these
// two reuse the same live, filtered panels wired into the real destination
// pages (Components/dashboardDrilldown/*), fetched directly against
// testPlanExecutionService/defectService. Documented as a deliberate,
// stated exception in EXECUTION_LOG.md's WP-041 report, not a silent
// substitution.
export interface TesterSectionProps {
    sub: string;
    workload: ReportState<WorkloadData>;
}

export function TesterSection({ sub, workload }: TesterSectionProps) {
    const rowIndex = workload.data?.categories.findIndex((c) => c === sub);
    const hasRow = typeof rowIndex === 'number' && rowIndex >= 0;
    const assignedSeries = workload.data?.series.find((s) => s.id === 'assigned');
    const completedSeries = workload.data?.series.find((s) => s.id === 'completed');
    const assignedValue = hasRow && assignedSeries ? assignedSeries.data[rowIndex as number] : null;
    const completedValue = hasRow && completedSeries ? completedSeries.data[rowIndex as number] : null;

    const assignedEmptyMessage = workload.isUnavailable
        ? 'Workload metrics aren’t available yet for this project — check back shortly.'
        : 'No tests assigned to you yet in this project.';

    return (
        <Stack spacing={2}>
            {/* WP-046 — component="h2", matching Pages/dashboard/index.tsx's
                own component="h1" fix: see that file's comment. Keeps the
                visual "h6" size but makes this the real h2 each WP-042
                chart's default h3 title is documented to nest under. */}
            <Typography variant="h6" component="h2" color="primary">
                My work
            </Typography>
            <StaleBanner stale={workload.stale} staleReason={workload.staleReason} computedAt={workload.computedAt} />
            {workload.data?.note && !workload.isLoading && (
                <Alert severity="info" data-testid="workload-scope-note">
                    {workload.data.note}
                </Alert>
            )}

            <Grid container spacing={2}>
                <Grid item xs={12} sm={6} md={3}>
                    <StatTile
                        label="Assigned to you"
                        value={workload.isUnavailable ? null : assignedValue}
                        loading={workload.isLoading}
                        error={workload.errorMessage}
                        emptyMessage={assignedEmptyMessage}
                    />
                    <DrilldownLink to={myAssignedTestsLink(sub)}>View assigned tests →</DrilldownLink>
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                    <StatTile
                        label="Completed by you"
                        value={workload.isUnavailable ? null : completedValue}
                        loading={workload.isLoading}
                        error={workload.errorMessage}
                        emptyMessage="Nothing completed yet."
                    />
                </Grid>
            </Grid>

            <TestExecutionFilterPanel
                searchParams={new URLSearchParams({ assignedTo: sub, status: 'fail' })}
                title="My failed tests"
                viewAllHref={myFailedTestsLink(sub)}
            />
            <DefectFilterPanel
                searchParams={new URLSearchParams({ assignedTo: sub, open: '1' })}
                title="My open defects"
                viewAllHref={myOpenDefectsLink(sub)}
            />
        </Stack>
    );
}

export default TesterSection;
