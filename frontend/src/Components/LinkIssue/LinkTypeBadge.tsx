import React, { useState } from 'react';
import { Box, CircularProgress, IconButton, Menu, MenuItem } from '@mui/material';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import { StatusChip } from '../common/StatusChip';
import { LINK_TYPES, LINK_TYPE_COLORS, LinkType, updateLinkType, findLink } from '../../api/linkApi';
import { useCoverage } from '../../Hooks/queries/useCoverage';
import { getCurrentProjectId } from '../../currentProject';

// WP-011: renders a link's typed relationship (tests/blocks/duplicates/
// relates-to) as a StatusChip plus a "change type" menu, mirroring the
// StatusChip + Menu pattern governance/LifecycleStatus.tsx already
// established for entity status. Distinct from that component (different
// vocabulary, different backend, different entity) but deliberately the
// same interaction shape so the app doesn't grow a second visual language
// for "chip you can click to change".

interface LinkTypeBadgeProps {
    linkMongoId: string;
    linkType: LinkType;
    sourceId: string;
    destinationId: string;
    onChanged: (newType: LinkType) => void;
    onError: (message: string) => void;
}

export const LinkTypeBadge: React.FC<LinkTypeBadgeProps> = ({
    linkMongoId,
    linkType,
    sourceId,
    destinationId,
    onChanged,
    onError,
}) => {
    const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);
    const [updating, setUpdating] = useState(false);
    // WP-078 -- migrated off Context/CoverageContext.tsx to the
    // react-query replacement (Hooks/queries/useCoverage.ts); `invalidate`
    // is the direct swap-in for the old `refreshUntested`.
    const { invalidate: invalidateCoverage } = useCoverage(getCurrentProjectId());

    const handleChange = async (nextType: LinkType) => {
        setMenuAnchor(null);
        setUpdating(true);
        try {
            await updateLinkType(linkMongoId, nextType);

            // Best-effort: every link is created as a pair of documents, one
            // per direction (see linkissue.tsx's linkIssuesHandle). Keep the
            // reciprocal doc's type in sync too, so viewing this link from
            // the other entity's tab shows the same type instead of a stale
            // one. Not fatal if this half fails -- the primary update (and
            // the coverage flag it drives for the entity currently being
            // viewed) has already landed.
            try {
                const reciprocal = await findLink(destinationId, sourceId);
                if (reciprocal && reciprocal._id !== linkMongoId) {
                    await updateLinkType(reciprocal._id, nextType);
                }
            } catch (reciprocalErr) {
                console.error('Unable to sync reciprocal link type', reciprocalErr);
            }

            onChanged(nextType);
            await invalidateCoverage();
        } catch (err: any) {
            onError(err?.response?.data?.error || 'Unable to change link type');
        } finally {
            setUpdating(false);
        }
    };

    return (
        <Box display="flex" alignItems="center" gap={0.5}>
            <StatusChip status={linkType} colorMap={LINK_TYPE_COLORS} />
            <IconButton
                size="small"
                aria-label="Change link type"
                disabled={updating}
                onClick={(e) => setMenuAnchor(e.currentTarget)}
            >
                {updating ? <CircularProgress size={14} /> : <ArrowDropDownIcon fontSize="small" />}
            </IconButton>
            <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
                {LINK_TYPES.filter((t) => t !== linkType).map((t) => (
                    <MenuItem key={t} onClick={() => handleChange(t)}>
                        {t}
                    </MenuItem>
                ))}
            </Menu>
        </Box>
    );
};

export default LinkTypeBadge;
