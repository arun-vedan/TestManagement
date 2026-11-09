import { Alert } from '@mui/material';

// WP-041 — labels a served-but-stale report (reportingService's
// serve-stale-on-recompute-failure branch, controllers/reports.js) rather
// than silently presenting an old number as current. `warning`, not
// `error`: the data IS real and was correct as of `computedAt`, just not
// refreshed just now -- a red error banner would overstate the problem.
export interface StaleBannerProps {
    stale: boolean;
    staleReason?: string;
    computedAt?: string;
}

export function StaleBanner({ stale, staleReason, computedAt }: StaleBannerProps) {
    if (!stale) {
        return null;
    }
    const computedAtText = computedAt ? new Date(computedAt).toLocaleString() : 'an earlier time';
    return (
        <Alert severity="warning" sx={{ mb: 1 }} data-testid="stale-banner">
            Showing cached data from {computedAtText} — a live refresh just failed
            {staleReason ? ` (${staleReason})` : ''}.
        </Alert>
    );
}

export default StaleBanner;
