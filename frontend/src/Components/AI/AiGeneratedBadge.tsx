import { Chip, Tooltip } from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';

// WP-051 -- the one deliberate visual exception this WP's design direction
// calls out (precedent: WP-032's show-secret-once dialog, WP-045's import
// preview, WP-043's bulk confirm): GR-8 requires a user always know what
// came from a model, so this can't be just another muted StatusChip lookup
// -- it needs its own unmistakable color/icon, not a hash-picked chip color
// that happens to collide with something else on the page.
//
// THE BADGE RULE (recorded here, not just in code comments elsewhere --
// backend/testRepoService/models/testrepo.js's generatedBy field and
// controllers/testrepo.js#updateTestCase implement it):
//   Shown while the test case's `generatedBy` field is 'ai'.
//   Cleared the FIRST TIME a human edits any CONTENT field (summary,
//   description, or steps) through the normal test-case edit flow.
//   Metadata-only changes (assignee, status/lifecycle transitions) do
//   NOT clear it -- editing who owns a test case or approving it isn't
//   the same claim as "a human rewrote what this test case says".
// The tooltip below states this rule explicitly, in the same words in the
// UI as in this comment, so it isn't just a code-only contract.
export const AI_GENERATED_BADGE_RULE =
    'This test case was drafted by AI. The badge disappears the first time you edit its summary, description, or steps -- assigning it or changing its status does not.';

export interface AiGeneratedBadgeProps {
    size?: 'small' | 'medium';
}

export const AiGeneratedBadge = ({ size = 'small' }: AiGeneratedBadgeProps) => (
    <Tooltip title={AI_GENERATED_BADGE_RULE}>
        <Chip
            icon={<AutoAwesomeIcon />}
            label="AI-generated"
            size={size}
            // Explicit aria-label (not left to Tooltip alone, which only
            // exposes its title via aria-describedby once opened/hovered):
            // the full rule must be discoverable by assistive tech without
            // requiring a hover/focus interaction first.
            aria-label={AI_GENERATED_BADGE_RULE}
            sx={{
                bgcolor: 'secondary.main',
                color: 'secondary.contrastText',
                fontWeight: 600,
                '& .MuiChip-icon': { color: 'secondary.contrastText' },
            }}
        />
    </Tooltip>
);

export default AiGeneratedBadge;
