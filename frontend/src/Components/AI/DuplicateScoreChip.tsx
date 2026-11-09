import { Chip, Tooltip } from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';

// WP-052 -- shared score chip for both the single-test-case duplicate check
// (AiDuplicateCheckDrawer) and the bulk audit panel (AiDuplicateAuditPanel).
//
// GR-8's unmistakable-labelling requirement, same design precedent as
// AiGeneratedBadge.tsx (WP-051): a duplicate score is a coarse, mock/
// vendor-produced similarity estimate, not a fact about the two test cases
// -- the label says "AI similarity", not just a bare percentage, so it can
// never be mistaken for a computed/verified metric the product itself
// guarantees.
export interface DuplicateScoreChipProps {
    score: number;
    reason?: string;
}

export const DuplicateScoreChip = ({ score, reason }: DuplicateScoreChipProps) => {
    const color = score >= 80 ? 'error' : score >= 65 ? 'warning' : 'info';
    const label = `AI similarity: ${score}%`;
    return (
        <Tooltip title={reason ? `${label} -- ${reason}` : label}>
            <Chip icon={<AutoAwesomeIcon />} label={label} color={color} size="small" aria-label={label} />
        </Tooltip>
    );
};

export default DuplicateScoreChip;
