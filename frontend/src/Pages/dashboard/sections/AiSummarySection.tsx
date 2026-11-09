import { Stack, Typography } from '@mui/material';
import { AiSummaryPanel } from '../../../Components/AI/AiSummaryPanel';
import { AiAvailable } from '../../../Components/AI/AiAvailable';

// WP-053 -- "AI summary" on the Dashboard. Manager/admin tier only, same
// gate as TestManagerSection/QaExecSection (Pages/dashboard/index.tsx's own
// role-mapping comment: an executive narrative over project-wide status is
// squarely in the same tier as those two, and WP-022 has no separate
// role to gate it more narrowly).
//
// scope="timerange" (30 days, the same default reportingService's own
// pass-rate-trend route uses) -- the Dashboard has no single release/plan
// in view, so a rolling recent-activity narrative is the natural project-
// wide scope here; the release-scoped variant lives on the release's own
// workbench detail view instead (workbench/detail/modules/ReleaseDetail.tsx's
// Details tab, WP-F18b Task 4 -- previously Pages/releases.tsx's own Manage
// Release dialog, before that page was retired).
export function AiSummarySection() {
    // The heading goes too: an "AI summary" title over nothing would be worse
    // than no section while AI is off for this deployment.
    return (
        <AiAvailable>
            <Stack spacing={2}>
                <Typography variant="h6" component="h2" color="primary">
                    AI summary
                </Typography>
                <AiSummaryPanel scope="timerange" days={30} title="Executive summary (last 30 days)" />
            </Stack>
        </AiAvailable>
    );
}

export default AiSummarySection;
