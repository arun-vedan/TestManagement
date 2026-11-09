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
    Tooltip,
    Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import LinkIcon from '@mui/icons-material/Link';
import BlockIcon from '@mui/icons-material/Block';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { EmptyState } from '../common/EmptyState';
import { DuplicateScoreChip } from './DuplicateScoreChip';
import {
    checkDuplicateTestCase,
    dismissDuplicate,
    linkAsDuplicate,
    DuplicateCandidate,
} from '../../api/aiApi';

// WP-052 -- duplicate-detection panel for the test case create/edit form
// (TabContent.tsx, selectedModule === 1). GR-8: advisory only -- nothing is
// written until the user explicitly clicks "Link as duplicate" (creates a
// real 'duplicates'-typed link through linkIssueService's own API, see
// api/aiApi.ts#linkAsDuplicate) or "Not a duplicate" (persists a dismissal
// through aiService's own bookkeeping, see
// backend/aiService/models/DismissedDuplicate.js for the persistence
// decision -- it survives reopening this panel later).
//
// CREATE VS EDIT: `testCaseId` (the business key, e.g. "TC-5") is undefined
// for a not-yet-saved test case -- the check still runs (so a duplicate is
// caught BEFORE the user finishes creating one), but "Link as duplicate"
// is disabled until the test case has been saved, since there is no id yet
// for the link's source side.

interface CandidateState extends DuplicateCandidate {
    status: 'pending' | 'linking' | 'linked' | 'dismissing' | 'dismissed' | 'error';
    error?: string;
}

export interface AiDuplicateCheckDrawerProps {
    open: boolean;
    onClose: () => void;
    testCaseId?: string; // business key, e.g. "TC-5" -- undefined if not yet saved
    TestCaseSummary: string;
    TestCaseDescription?: string;
    parentId?: number;
    /** Called once after a "Link as duplicate" succeeds, so the caller can refresh links/coverage. */
    onLinked?: () => void;
}

export const AiDuplicateCheckDrawer = ({
    open,
    onClose,
    testCaseId,
    TestCaseSummary,
    TestCaseDescription,
    parentId,
    onLinked,
}: AiDuplicateCheckDrawerProps) => {
    const [checking, setChecking] = useState(false);
    const [checkError, setCheckError] = useState('');
    const [candidates, setCandidates] = useState<CandidateState[]>([]);
    const [checked, setChecked] = useState(false);
    const [threshold, setThreshold] = useState<number | null>(null);

    const handleCheck = async () => {
        setChecking(true);
        setCheckError('');
        try {
            const result = await checkDuplicateTestCase({
                testCaseId,
                TestCaseSummary,
                TestCaseDescription,
                parentId,
            });
            setCandidates(result.candidates.map((c) => ({ ...c, status: 'pending' })));
            setThreshold(result.threshold);
            setChecked(true);
        } catch (err: any) {
            setCheckError(
                err?.response?.data?.error || 'Unable to check for duplicates right now. Please try again shortly.'
            );
        } finally {
            setChecking(false);
        }
    };

    const updateCandidate = (testCaseIdToUpdate: string, patch: Partial<CandidateState>) => {
        setCandidates((prev) => prev.map((c) => (c.testCaseId === testCaseIdToUpdate ? { ...c, ...patch } : c)));
    };

    const handleLink = async (candidate: CandidateState) => {
        if (!testCaseId) return;
        updateCandidate(candidate.testCaseId, { status: 'linking' });
        try {
            await linkAsDuplicate(
                { testCaseId, summary: TestCaseSummary },
                { testCaseId: candidate.testCaseId, summary: candidate.TestCaseSummary }
            );
            updateCandidate(candidate.testCaseId, { status: 'linked' });
            onLinked?.();
        } catch (err: any) {
            updateCandidate(candidate.testCaseId, {
                status: 'error',
                error: err?.response?.data?.error || 'Failed to create the link',
            });
        }
    };

    const handleDismiss = async (candidate: CandidateState) => {
        if (!testCaseId) {
            // Not-yet-saved test case -- nothing stable to key a persisted
            // dismissal on, so just drop it from THIS view.
            setCandidates((prev) => prev.filter((c) => c.testCaseId !== candidate.testCaseId));
            return;
        }
        updateCandidate(candidate.testCaseId, { status: 'dismissing' });
        try {
            await dismissDuplicate(testCaseId, candidate.testCaseId);
            updateCandidate(candidate.testCaseId, { status: 'dismissed' });
        } catch (err: any) {
            updateCandidate(candidate.testCaseId, {
                status: 'error',
                error: err?.response?.data?.error || 'Failed to dismiss',
            });
        }
    };

    return (
        <Drawer anchor="right" open={open} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', sm: 480 } } }}>
            <Box p={2} display="flex" flexDirection="column" height="100%">
                <Box display="flex" alignItems="center" justifyContent="space-between" mb={1}>
                    <Stack direction="row" alignItems="center" spacing={1}>
                        <AutoAwesomeIcon color="secondary" />
                        <Typography variant="h6">Check for duplicates (AI)</Typography>
                    </Stack>
                    <IconButton onClick={onClose} aria-label="Close">
                        <CloseIcon />
                    </IconButton>
                </Box>
                <Typography variant="body2" color="text.secondary" mb={2}>
                    Advisory only -- AI-suggested matches from the same module. Nothing is linked or dismissed until
                    you click a button below.
                </Typography>

                <Button variant="contained" onClick={handleCheck} disabled={checking || !TestCaseSummary}>
                    {checking ? <CircularProgress size={20} /> : 'Check for duplicates'}
                </Button>

                {checkError && (
                    <Alert severity="error" sx={{ mt: 2 }}>
                        {checkError}
                    </Alert>
                )}

                {!testCaseId && (
                    <Alert severity="info" sx={{ mt: 2 }}>
                        This test case hasn't been saved yet -- you can still see possible duplicates, but linking
                        requires saving first.
                    </Alert>
                )}

                <Box flex={1} mt={2} sx={{ overflowY: 'auto' }}>
                    {checked && candidates.length === 0 && (
                        <EmptyState
                            message={`No likely duplicates found${threshold !== null ? ` (threshold ${threshold}%)` : ''}.`}
                        />
                    )}
                    <Stack spacing={1.5}>
                        {candidates
                            .filter((c) => c.status !== 'dismissed')
                            .map((candidate) => (
                                <Box key={candidate.testCaseId} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5 }}>
                                    <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={1}>
                                        <Box>
                                            <Typography variant="subtitle2">{candidate.testCaseId}</Typography>
                                            <Typography variant="body2">{candidate.TestCaseSummary}</Typography>
                                        </Box>
                                        <DuplicateScoreChip score={candidate.score} reason={candidate.reason} />
                                    </Stack>

                                    {candidate.status === 'linked' ? (
                                        <Alert icon={<CheckCircleIcon fontSize="inherit" />} severity="success" sx={{ mt: 1 }}>
                                            Linked as duplicate.
                                        </Alert>
                                    ) : (
                                        <Stack direction="row" spacing={1} mt={1}>
                                            <Tooltip title={testCaseId ? '' : 'Save this test case first to link it'}>
                                                <span>
                                                    <Button
                                                        size="small"
                                                        variant="contained"
                                                        startIcon={
                                                            candidate.status === 'linking' ? (
                                                                <CircularProgress size={14} color="inherit" />
                                                            ) : (
                                                                <LinkIcon fontSize="small" />
                                                            )
                                                        }
                                                        disabled={!testCaseId || candidate.status === 'linking'}
                                                        onClick={() => handleLink(candidate)}
                                                    >
                                                        Link as duplicate
                                                    </Button>
                                                </span>
                                            </Tooltip>
                                            <Button
                                                size="small"
                                                startIcon={
                                                    candidate.status === 'dismissing' ? (
                                                        <CircularProgress size={14} />
                                                    ) : (
                                                        <BlockIcon fontSize="small" />
                                                    )
                                                }
                                                disabled={candidate.status === 'dismissing'}
                                                onClick={() => handleDismiss(candidate)}
                                            >
                                                Not a duplicate
                                            </Button>
                                        </Stack>
                                    )}
                                    {candidate.status === 'error' && (
                                        <Alert severity="error" sx={{ mt: 1 }}>
                                            {candidate.error}
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

export default AiDuplicateCheckDrawer;
