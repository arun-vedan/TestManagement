import { Box, Grid, Stack, Typography } from '@mui/material';
import { BarChart, DonutChart, StatTile, TrendChart } from '../../../Components/charts';
import { blockedTestsLink, requirementsLink, testPlansLink } from '../dashboardLinks';
import { DrilldownLink } from '../DrilldownLink';
import { StaleBanner } from '../StaleBanner';
import { ReportState } from '../useReportState';
import { CoverageData, PassRateTrendData, PlanProgressData } from '../../../api/reportApi';

// WP-041 — "Plan & progress", gated to manager/admin (Pages/dashboard/
// index.tsx). Every widget here is bound directly to a WP-040 endpoint,
// spread onto the matching WP-042 chart component with no reshaping (see
// EXECUTION_LOG.md's WP-040 report, "The WP-042 chart contract" -- that's
// the whole point of the shapes it chose).
export interface TestManagerSectionProps {
    coverage: ReportState<CoverageData>;
    planProgress: ReportState<PlanProgressData>;
    passRateTrend: ReportState<PassRateTrendData>;
}

export function TestManagerSection({ coverage, planProgress, passRateTrend }: TestManagerSectionProps) {
    const coverageTotal = coverage.data?.total ?? 0;
    const coverageEmptyMessage = coverage.isUnavailable
        ? 'Coverage isn’t available yet for this project — check back shortly.'
        : 'No requirements defined yet — add requirements to start tracking coverage.';

    const blockedSeries = planProgress.data?.series.find((s) => s.id === 'blocked');
    const noPlans = !planProgress.data || planProgress.data.categories.length === 0;
    const blockedTotal = planProgress.isUnavailable || noPlans ? null : (blockedSeries?.data.reduce((a, b) => a + b, 0) ?? 0);
    const blockedEmptyMessage = planProgress.isUnavailable
        ? 'Plan progress isn’t available yet for this project — check back shortly.'
        : planProgress.data?.note
        ? planProgress.data.note
        : 'No test plans have execution activity yet.';

    const planProgressEmptyMessage = planProgress.isUnavailable
        ? 'Plan progress isn’t available yet for this project — check back shortly.'
        : planProgress.data?.note || 'No test plans have execution activity yet.';

    const trendEmptyMessage = passRateTrend.isUnavailable
        ? 'Pass-rate trend isn’t available yet for this project — check back shortly.'
        : passRateTrend.data?.note || 'No test executions recorded in this period.';

    return (
        <Stack spacing={2}>
            {/* WP-046 — component="h2": see Pages/dashboard/index.tsx's
                comment on its own component="h1" fix. */}
            <Typography variant="h6" component="h2" color="primary">
                Plan &amp; progress
            </Typography>

            <Grid container spacing={2}>
                <Grid item xs={12} md={4}>
                    <StaleBanner stale={coverage.stale} staleReason={coverage.staleReason} computedAt={coverage.computedAt} />
                    <DonutChart
                        title="Requirement coverage"
                        data={coverage.isUnavailable ? [] : coverage.data?.breakdown.data ?? []}
                        loading={coverage.isLoading}
                        error={coverage.errorMessage}
                        emptyMessage={coverageEmptyMessage}
                    />
                    {!coverage.isLoading && !coverage.errorMessage && !coverage.isUnavailable && coverageTotal > 0 && (
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                            {coverage.data?.tested ?? 0} of {coverageTotal} requirements have a linked test.
                        </Typography>
                    )}
                    <DrilldownLink to={requirementsLink()}>View requirements →</DrilldownLink>
                </Grid>

                <Grid item xs={12} md={4}>
                    <StatTile
                        label="Blocked tests"
                        value={blockedTotal}
                        loading={planProgress.isLoading}
                        error={planProgress.errorMessage}
                        positiveIsGood={false}
                        emptyMessage={blockedEmptyMessage}
                    />
                    <DrilldownLink to={blockedTestsLink()}>View blocked tests →</DrilldownLink>
                </Grid>

                <Grid item xs={12} md={4}>
                    <Box sx={{ height: '100%' }}>
                        <StaleBanner
                            stale={passRateTrend.stale}
                            staleReason={passRateTrend.staleReason}
                            computedAt={passRateTrend.computedAt}
                        />
                        <TrendChart
                            title="Pass rate (last 30 days)"
                            xLabels={passRateTrend.data?.xLabels ?? []}
                            series={passRateTrend.data?.series ?? []}
                            loading={passRateTrend.isLoading}
                            error={passRateTrend.errorMessage}
                            emptyMessage={trendEmptyMessage}
                            valueFormatter={(v) => `${v}%`}
                            height={220}
                        />
                    </Box>
                </Grid>
            </Grid>

            <StaleBanner stale={planProgress.stale} staleReason={planProgress.staleReason} computedAt={planProgress.computedAt} />
            <BarChart
                title="Plan progress"
                description="Executed / passed / blocked test cases per plan"
                categories={planProgress.data?.categories ?? []}
                series={planProgress.data?.series ?? []}
                loading={planProgress.isLoading}
                error={planProgress.errorMessage}
                emptyMessage={planProgressEmptyMessage}
                height={260}
            />
            {!planProgress.isLoading && !planProgress.errorMessage && !planProgress.isUnavailable && (
                <Typography variant="body2" color="text.secondary">
                    Counts include one result per data row for parameterised cases.
                </Typography>
            )}
            <DrilldownLink to={testPlansLink()}>View test plans →</DrilldownLink>
        </Stack>
    );
}

export default TestManagerSection;
