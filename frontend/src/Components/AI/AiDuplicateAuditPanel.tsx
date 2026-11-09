import { useState } from 'react';
import {
    Alert,
    Box,
    Button,
    CircularProgress,
    Divider,
    Drawer,
    IconButton,
    Stack,
    Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import LinkIcon from '@mui/icons-material/Link';
import BlockIcon from '@mui/icons-material/Block';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { EmptyState } from '../common/EmptyState';
import { DuplicateScoreChip } from './DuplicateScoreChip';
import { auditDuplicates, dismissDuplicate, linkAsDuplicate, DuplicatePair } from '../../api/aiApi';

// WP-052 -- bulk near-duplicate audit, the "audit endpoint" the WP brief
// requires a UI surface for (GR-4). Originally mounted at the test-case
// list page level (Pages/testcases.tsx, retired in WP-074's workbench
// cutover -- this component has no mount point today, pending a workbench
// home in a later WP), scoped to whichever module/folder is currently
// selected in the tree -- same parentId semantics AiDuplicateCheckDrawer
// and TabContent.tsx's own save flow use. Advisory only, same GR-8
// contract as that drawer: nothing is linked or dismissed until the user
// clicks a button.

interface PairState extends DuplicatePair {
    status: 'pending' | 'linking' | 'linked' | 'dismissing' | 'dismissed' | 'error';
    error?: string;
}

export interface AiDuplicateAuditPanelProps {
    open: boolean;
    onClose: () => void;
    /** Module/folder to scope the audit to; omit to scan the whole project. */
    parentId?: number;
    moduleLabel?: string;
    onLinked?: () => void;
}

export const AiDuplicateAuditPanel = ({ open, onClose, parentId, moduleLabel, onLinked }: AiDuplicateAuditPanelProps) => {
    const [running, setRunning] = useState(false);
    const [error, setError] = useState('');
    const [pairs, setPairs] = useState<PairState[]>([]);
    const [ran, setRan] = useState(false);
    const [meta, setMeta] = useState<{
        threshold: number;
        scannedCount: number;
        skippedGroupCount: number;
        failedComparisonCount: number;
    } | null>(null);

    const handleRun = async () => {
        setRunning(true);
        setError('');
        try {
            const result = await auditDuplicates(parentId);
            setPairs(result.pairs.map((p) => ({ ...p, status: 'pending' })));
            setMeta({
                threshold: result.threshold,
                scannedCount: result.scannedCount,
                skippedGroupCount: result.skippedGroupCount,
                failedComparisonCount: result.failedComparisonCount,
            });
            setRan(true);
        } catch (err: any) {
            setError(err?.response?.data?.error || 'Unable to run the duplicate audit right now. Please try again shortly.');
        } finally {
            setRunning(false);
        }
    };

    const pairKeyOf = (p: DuplicatePair) => `${p.aId}|${p.bId}`;

    const updatePair = (key: string, patch: Partial<PairState>) => {
        setPairs((prev) => prev.map((p) => (pairKeyOf(p) === key ? { ...p, ...patch } : p)));
    };

    const handleLink = async (pair: PairState) => {
        const key = pairKeyOf(pair);
        updatePair(key, { status: 'linking' });
        try {
            await linkAsDuplicate({ testCaseId: pair.aId, summary: pair.aSummary }, { testCaseId: pair.bId, summary: pair.bSummary });
            updatePair(key, { status: 'linked' });
            onLinked?.();
        } catch (err: any) {
            updatePair(key, { status: 'error', error: err?.response?.data?.error || 'Failed to create the link' });
        }
    };

    const handleDismiss = async (pair: PairState) => {
        const key = pairKeyOf(pair);
        updatePair(key, { status: 'dismissing' });
        try {
            await dismissDuplicate(pair.aId, pair.bId);
            updatePair(key, { status: 'dismissed' });
        } catch (err: any) {
            updatePair(key, { status: 'error', error: err?.response?.data?.error || 'Failed to dismiss' });
        }
    };

    return (
        <Drawer anchor="right" open={open} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', sm: 560 } } }}>
            <Box p={2} display="flex" flexDirection="column" height="100%">
                <Box display="flex" alignItems="center" justifyContent="space-between" mb={1}>
                    <Stack direction="row" alignItems="center" spacing={1}>
                        <AutoAwesomeIcon color="secondary" />
                        <Typography variant="h6">Audit duplicates (AI)</Typography>
                    </Stack>
                    <IconButton onClick={onClose} aria-label="Close">
                        <CloseIcon />
                    </IconButton>
                </Box>
                <Typography variant="body2" color="text.secondary" mb={2}>
                    Scans {moduleLabel ? `module "${moduleLabel}"` : 'the whole project'} for likely duplicate test
                    case pairs. Advisory only -- nothing is linked or dismissed until you click a button below.
                </Typography>

                <Button variant="contained" onClick={handleRun} disabled={running}>
                    {running ? <CircularProgress size={20} /> : 'Run audit'}
                </Button>

                {error && (
                    <Alert severity="error" sx={{ mt: 2 }}>
                        {error}
                    </Alert>
                )}
                {meta && (
                    <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                        Scanned {meta.scannedCount} test case{meta.scannedCount === 1 ? '' : 's'}, threshold {meta.threshold}%.
                        {meta.skippedGroupCount > 0
                            ? ` ${meta.skippedGroupCount} oversized module${meta.skippedGroupCount === 1 ? '' : 's'} skipped.`
                            : ''}
                    </Typography>
                )}
                {/* Some comparisons failing does not fail the whole request
                    (see api/aiApi.ts#AuditDuplicatesResult's comment) -- but
                    it must never look like a silent all-clear either, so
                    this is surfaced explicitly rather than only logged. */}
                {meta && meta.failedComparisonCount > 0 && (
                    <Alert severity="warning" sx={{ mt: 1 }}>
                        {meta.failedComparisonCount} comparison{meta.failedComparisonCount === 1 ? '' : 's'} failed and{' '}
                        {meta.failedComparisonCount === 1 ? "wasn't" : "weren't"} scanned -- this audit is partial, not
                        a confirmed all-clear for those test cases.
                    </Alert>
                )}

                <Box flex={1} mt={2} sx={{ overflowY: 'auto' }}>
                    {ran && pairs.length === 0 && <EmptyState message="No likely duplicate pairs found." />}
                    <Stack spacing={1.5}>
                        {pairs
                            .filter((p) => p.status !== 'dismissed')
                            .map((pair) => (
                                <Box key={pairKeyOf(pair)} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5 }}>
                                    <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={1}>
                                        <Box>
                                            <Typography variant="subtitle2">
                                                {pair.aId} &harr; {pair.bId}
                                            </Typography>
                                            <Typography variant="body2">{pair.aSummary}</Typography>
                                            <Typography variant="body2" color="text.secondary">
                                                {pair.bSummary}
                                            </Typography>
                                        </Box>
                                        <DuplicateScoreChip score={pair.score} reason={pair.reason} />
                                    </Stack>

                                    {pair.status === 'linked' ? (
                                        <Alert icon={<CheckCircleIcon fontSize="inherit" />} severity="success" sx={{ mt: 1 }}>
                                            Linked as duplicate.
                                        </Alert>
                                    ) : (
                                        <Stack direction="row" spacing={1} mt={1}>
                                            <Button
                                                size="small"
                                                variant="contained"
                                                startIcon={
                                                    pair.status === 'linking' ? (
                                                        <CircularProgress size={14} color="inherit" />
                                                    ) : (
                                                        <LinkIcon fontSize="small" />
                                                    )
                                                }
                                                disabled={pair.status === 'linking'}
                                                onClick={() => handleLink(pair)}
                                            >
                                                Link as duplicate
                                            </Button>
                                            <Button
                                                size="small"
                                                startIcon={
                                                    pair.status === 'dismissing' ? <CircularProgress size={14} /> : <BlockIcon fontSize="small" />
                                                }
                                                disabled={pair.status === 'dismissing'}
                                                onClick={() => handleDismiss(pair)}
                                            >
                                                Not a duplicate
                                            </Button>
                                        </Stack>
                                    )}
                                    {pair.status === 'error' && (
                                        <Alert severity="error" sx={{ mt: 1 }}>
                                            {pair.error}
                                        </Alert>
                                    )}
                                </Box>
                            ))}
                    </Stack>
                </Box>

                <Divider sx={{ my: 1 }} />
                <Button onClick={onClose}>Close</Button>
            </Box>
        </Drawer>
    );
};

export default AiDuplicateAuditPanel;
