import { Grid, Stack, Typography } from '@mui/material';
import { BarChart, DonutChart, StatTile } from '../../../Components/charts';
import { defectsBySeverityLink, releasesNeedingAttentionLink } from '../dashboardLinks';
import { DrilldownLink } from '../DrilldownLink';
import { StaleBanner } from '../StaleBanner';
import { ReportState } from '../useReportState';
import { DefectSummaryData, PlanProgressData, ReleaseReadinessData } from '../../../api/reportApi';

// WP-041 — "Release & quality", gated to manager/admin (same tier as
// TestManagerSection -- see Pages/dashboard/index.tsx's role-mapping
// comment: WP-022 has no separate "QA Manager"/"exec" role, so both
// sections gate on the same two roles and a manager simply sees both
// stacked on one page).
//
// "Defect trend" (per the WP brief's persona list) is served here as
// defect-summary's `byAge` distribution -- WP-040 computes no
// count-over-time series for defects (only pass-rate-trend does, and
// that's test-execution data, not defect data), so "how long has this
// project's defect backlog been sitting" (age buckets) is the closest
// live trend-shaped signal WP-040 actually exposes. Stated here and in
// EXECUTION_LOG.md's WP-041 report as a deliberate interpretation, not
// silently presented as literally "defects created per day".
export interface QaExecSectionProps {
    releaseReadiness: ReportState<ReleaseReadinessData>;
    defectSummary: ReportState<DefectSummaryData>;
    planProgress: ReportState<PlanProgressData>;
}

export function QaExecSection({ releaseReadiness, defectSummary, planProgress }: QaExecSectionProps) {
    const releases = releaseReadiness.data?.releases ?? [];
    const notReady = releases.filter((r) => r.overall === 'red');
    const releaseEmptyMessage = releaseReadiness.isUnavailable
        ? 'Release readiness isn’t available yet for this project — check back shortly.'
        : 'No releases tracked yet. Create one to start monitoring readiness.';

    const severitySlices = defectSummary.isUnavailable ? [] : defectSummary.data?.bySeverity.data ?? [];
    const topSeverity = [...severitySlices].sort((a, b) => b.value - a.value)[0];
    const defectEmptyMessage = defectSummary.isUnavailable
        ? 'Defect summary isn’t available yet for this project — check back shortly.'
        : 'No defects logged yet — nothing to summarize.';

    // AGE_BUCKETS' 4 category labels are always emitted by
    // services/defectSummary.js even with zero defects (every bucket's
    // count is just 0) -- BarChart's own isEmpty only checks
    // categories/series LENGTH, so 4 always-zero bars would slip through
    // as "not empty" and render as literal zeros-soup. Forced empty here
    // instead, based on the report's own `total`, so the true-empty case
    // gets the guided EmptyState rather than a meaningless flat chart.
    const defectTotal = defectSummary.data?.total ?? 0;
    const byAgeCategories = defectSummary.isUnavailable || defectTotal === 0 ? [] : defectSummary.data?.byAge.categories ?? [];
    const byAgeSeries = defectSummary.isUnavailable || defectTotal === 0 ? [] : defectSummary.data?.byAge.series ?? [];

    const noPlans = !planProgress.data || planProgress.data.categories.length === 0;
    const plansWithBlocked =
        planProgress.isUnavailable || noPlans
            ? null
            : planProgress.data!.categories.filter((_, i) => {
                  const blocked = planProgress.data!.series.find((s) => s.id === 'blocked');
                  return (blocked?.data[i] ?? 0) > 0;
              }).length;

    return (
        <Stack spacing={2}>
            {/* WP-046 — component="h2": see Pages/dashboard/index.tsx's
                comment on its own component="h1" fix. */}
            <Typography variant="h6" component="h2" color="primary">
                Release &amp; quality
            </Typography>

            <Grid container spacing={2}>
                <Grid item xs={12} md={4}>
                    <StaleBanner
                        stale={releaseReadiness.stale}
                        staleReason={releaseReadiness.staleReason}
                        computedAt={releaseReadiness.computedAt}
                    />
                    <DonutChart
                        title="Release readiness"
                        data={releaseReadiness.isUnavailable ? [] : releaseReadiness.data?.rollup.data ?? []}
                        loading={releaseReadiness.isLoading}
                        error={releaseReadiness.errorMessage}
                        emptyMessage={releaseEmptyMessage}
                    />
                    {!releaseReadiness.isLoading && !releaseReadiness.errorMessage && releases.length > 0 && (
                        notReady.length > 0 ? (
                            <DrilldownLink to={releasesNeedingAttentionLink(notReady.map((r) => r.releaseId))}>
                                {notReady.length} release{notReady.length === 1 ? '' : 's'} need attention →
                            </DrilldownLink>
                        ) : (
                            <Typography variant="body2" color="success.main" sx={{ mt: 0.5 }}>
                                All tracked releases are green.
                            </Typography>
                        )
                    )}
                </Grid>

                <Grid item xs={12} md={4}>
                    <StaleBanner stale={defectSummary.stale} staleReason={defectSummary.staleReason} computedAt={defectSummary.computedAt} />
                    <DonutChart
                        title="Defects by severity"
                        data={severitySlices}
                        loading={defectSummary.isLoading}
                        error={defectSummary.errorMessage}
                        emptyMessage={defectEmptyMessage}
                    />
                    {topSeverity && !defectSummary.isLoading && !defectSummary.errorMessage && (
                        <DrilldownLink to={defectsBySeverityLink(topSeverity.label)}>View {topSeverity.label} defects →</DrilldownLink>
                    )}
                </Grid>

                <Grid item xs={12} md={4}>
                    <StatTile
                        label="Plans with blocked cases"
                        value={plansWithBlocked}
                        loading={planProgress.isLoading}
                        error={planProgress.errorMessage}
                        positiveIsGood={false}
                        emptyMessage={planProgress.isUnavailable ? 'Not available yet for this project.' : 'No plans are currently blocked.'}
                    />
                </Grid>
            </Grid>

            <BarChart
                title="Defect age"
                description="How long this project's defects (open and closed) have existed, bucketed by age"
                categories={byAgeCategories}
                series={byAgeSeries}
                loading={defectSummary.isLoading}
                error={defectSummary.errorMessage}
                emptyMessage={defectEmptyMessage}
                height={240}
            />
        </Stack>
    );
}

export default QaExecSection;
