import React, { useState } from 'react';
import {
    Accordion,
    AccordionDetails,
    AccordionSummary,
    Box,
    Button,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    Menu,
    MenuItem,
    Stack,
    Typography
} from '@mui/material';
import HistoryIcon from '@mui/icons-material/History';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import {
    updateTestCaseStatus,
    getTestCaseVersions,
    updateRequirementStatus,
    getRequirementVersions
} from '../../api/apiCalls';
import { StatusChip, LIFECYCLE_STATUS_COLORS } from '../common/StatusChip';
import { EmptyState } from '../common/EmptyState';

// Sprint 2.1 governance UI. Backend enforces which status transitions are
// legal (draft/review/approved/deprecated/archived) — this component doesn't
// duplicate that rule graph, it just offers every other status as a menu
// action and surfaces whatever error the API returns if the chosen
// transition isn't valid, matching the backend-is-source-of-truth pattern
// already used elsewhere in this app (e.g. field validation errors).

const LIFECYCLE_STATUSES = ['draft', 'review', 'approved', 'deprecated', 'archived'] as const;

type EntityType = 'testcase' | 'requirement';

// WP-F02 -- the shape both getTestCaseVersions and getRequirementVersions
// already return. Declared locally rather than in a new api module: the
// two fetchers live in api/apiCalls.tsx and already have this one caller,
// and an earlier attempt at this package created a parallel typed module
// exporting the same two names, which was reverted (e4a12af).
//
// `snapshot` is the WHOLE prior document, Mongo bookkeeping included, so
// it stays index-signature typed and is read through an allow-list below.
interface EntityVersion {
    _id: string;
    /** The version the entity held BEFORE the edit this snapshot records. */
    version: number;
    createdAt: string;
    snapshot: Record<string, unknown>;
}

// The snapshot is a whole document, so this renders an allow-list rather
// than iterating its keys. `__v`, `_id`, `parentId` and `id` are plumbing;
// `dynamicFields` has no display; `updatedBy` is a raw Keycloak subject
// UUID rather than a name (the same trap assignedTo hit in WP-F01), so
// showing it would be a readability regression. TestSteps is summarised as
// a count -- that alone makes a dropped-steps edit visible, which is the
// concrete case this package exists for.
const SNAPSHOT_FIELDS: { key: string; label: string }[] = [
    { key: 'TestCaseSummary', label: 'Summary' },
    { key: 'requirementSummary', label: 'Summary' },
    { key: 'TestCaseDescription', label: 'Description' },
    { key: 'description', label: 'Description' },
    { key: 'acceptanceCriteria', label: 'Acceptance criteria' },
    { key: 'status', label: 'Status' },
];

function snapshotRows(snapshot: Record<string, unknown>): { label: string; value: string }[] {
    const rows = SNAPSHOT_FIELDS
        .map((f) => ({ label: f.label, value: snapshot[f.key] }))
        .filter((r) => typeof r.value === 'string' && r.value.trim() !== '')
        .map((r) => ({ label: r.label, value: r.value as string }));

    const steps = snapshot.TestSteps;
    if (Array.isArray(steps)) {
        rows.push({ label: 'Steps', value: `${steps.length} step${steps.length === 1 ? '' : 's'}` });
    }
    return rows;
}

interface LifecycleStatusProps {
    entityId: string;
    entityIdLabel?: string; // e.g. TC-3 or Req-2, shown in the version history dialog title
    status: string;
    entityType: EntityType;
    onStatusChanged: (newStatus: string) => void;
    onError: (message: string, severity: string) => void;
}

export const LifecycleStatus = ({
    entityId,
    entityIdLabel,
    status,
    entityType,
    onStatusChanged,
    onError
}: LifecycleStatusProps) => {
    const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);
    const [updating, setUpdating] = useState(false);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [historyLoading, setHistoryLoading] = useState(false);
    const [versions, setVersions] = useState<EntityVersion[]>([]);

    const updateStatusFn = entityType === 'testcase' ? updateTestCaseStatus : updateRequirementStatus;
    const getVersionsFn = entityType === 'testcase' ? getTestCaseVersions : getRequirementVersions;

    const handleStatusChange = async (nextStatus: string) => {
        setMenuAnchor(null);
        setUpdating(true);
        try {
            const result = await updateStatusFn(entityId, nextStatus);
            onStatusChanged(result.data.status);
        } catch (err: any) {
            onError(err?.response?.data?.error || 'Unable to change status', 'error');
        } finally {
            setUpdating(false);
        }
    };

    const handleOpenHistory = async () => {
        setHistoryOpen(true);
        setHistoryLoading(true);
        try {
            setVersions(await getVersionsFn(entityId));
        } catch (err: any) {
            onError(err?.response?.data?.error || 'Unable to load version history', 'error');
        } finally {
            setHistoryLoading(false);
        }
    };

    return (
        <Box display="flex" alignItems="center" gap={1}>
            <StatusChip status={status} colorMap={LIFECYCLE_STATUS_COLORS} />

            <Button
                size="small"
                variant="outlined"
                disabled={updating}
                endIcon={updating ? <CircularProgress size={14} /> : <ArrowDropDownIcon />}
                onClick={(e) => setMenuAnchor(e.currentTarget)}
            >
                Change status
            </Button>
            <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
                {LIFECYCLE_STATUSES.filter((s) => s !== status).map((s) => (
                    <MenuItem key={s} onClick={() => handleStatusChange(s)}>
                        {s}
                    </MenuItem>
                ))}
            </Menu>

            <Button size="small" startIcon={<HistoryIcon />} onClick={handleOpenHistory}>
                History
            </Button>

            <Dialog open={historyOpen} onClose={() => setHistoryOpen(false)} maxWidth="sm" fullWidth>
                <DialogTitle>Version history{entityIdLabel ? ` — ${entityIdLabel}` : ''}</DialogTitle>
                <DialogContent>
                    {historyLoading && (
                        <Box display="flex" justifyContent="center" p={3}>
                            <CircularProgress size={28} />
                        </Box>
                    )}
                    {!historyLoading && versions.length === 0 && (
                        <EmptyState message="No prior versions yet — this entity hasn't been edited since versioning was introduced." />
                    )}
                    {!historyLoading && versions.length > 0 && (
                        <Box>
                            {versions.map((v) => {
                                const rows = snapshotRows(v.snapshot);
                                return (
                                    // TransitionProps.unmountOnExit: MUI's Collapse keeps
                                    // AccordionDetails mounted (just visually collapsed) by
                                    // default, which would put every version's content in the
                                    // DOM at once -- unmounting on collapse keeps the content
                                    // truly behind the expander, as it was designed to be.
                                    <Accordion key={v._id} disableGutters TransitionProps={{ unmountOnExit: true }}>
                                        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                                            <Typography variant="subtitle2" sx={{ mr: 2 }}>{`Version ${v.version}`}</Typography>
                                            <Typography variant="body2" color="text.secondary">
                                                {new Date(v.createdAt).toLocaleString()}
                                            </Typography>
                                        </AccordionSummary>
                                        <AccordionDetails>
                                            {rows.length === 0 ? (
                                                <Typography variant="body2" color="text.secondary">
                                                    This version recorded no displayable fields.
                                                </Typography>
                                            ) : (
                                                <Stack spacing={1}>
                                                    {rows.map((r) => (
                                                        <Box key={r.label}>
                                                            <Typography variant="caption" color="text.secondary">{r.label}</Typography>
                                                            <Typography variant="body2">{r.value}</Typography>
                                                        </Box>
                                                    ))}
                                                </Stack>
                                            )}
                                        </AccordionDetails>
                                    </Accordion>
                                );
                            })}
                        </Box>
                    )}
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setHistoryOpen(false)}>Close</Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
};
