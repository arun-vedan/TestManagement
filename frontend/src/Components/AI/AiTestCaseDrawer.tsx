import { useState } from 'react';
import {
    Alert,
    Box,
    Button,
    Checkbox,
    Chip,
    CircularProgress,
    Divider,
    Drawer,
    IconButton,
    MenuItem,
    Select,
    Stack,
    TextField,
    Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import { EmptyState } from '../common/EmptyState';
import { AiGeneratedBadge } from './AiGeneratedBadge';
import {
    acceptCandidate,
    generateTestCases,
    TestCaseCandidate,
    TestCaseCandidateStep,
} from '../../api/aiApi';

// WP-051 -- the review drawer on the requirement page. GR-8's whole point:
// generation is advisory/draft-only and NOTHING here is persisted until the
// human clicks "Accept selected" below, at which point each kept candidate
// goes through acceptCandidate() (api/aiApi.ts) -> testRepoService's/
// linkIssueService's own normal, already-governed APIs. Unchecked
// candidates are simply never sent anywhere -- that IS the reject flow,
// there is nothing to "undo" because nothing was ever created for them.

interface DraftCandidate extends TestCaseCandidate {
    keep: boolean;
    status: 'pending' | 'accepting' | 'accepted' | 'error';
    error?: string;
}

const emptyStep = (): TestCaseCandidateStep => ({ testStep: '', Expected: '' });

const toDraft = (c: TestCaseCandidate): DraftCandidate => ({
    ...c,
    TestSteps: c.TestSteps.length ? c.TestSteps.map((s) => ({ ...s })) : [emptyStep()],
    keep: true,
    status: 'pending',
});

export interface AiTestCaseDrawerProps {
    open: boolean;
    onClose: () => void;
    requirementId: string; // Mongo _id
    reqId: string; // business key, e.g. "Req-4"
    requirementSummary?: string;
    /** Called once after "Accept selected" finishes, if at least one candidate was accepted -- lets the caller refresh coverage/links. */
    onAccepted?: () => void;
}

export const AiTestCaseDrawer = ({
    open,
    onClose,
    requirementId,
    reqId,
    requirementSummary,
    onAccepted,
}: AiTestCaseDrawerProps) => {
    const [count, setCount] = useState(3);
    const [style, setStyle] = useState('');
    const [generating, setGenerating] = useState(false);
    const [generateError, setGenerateError] = useState('');
    const [candidates, setCandidates] = useState<DraftCandidate[]>([]);
    const [meta, setMeta] = useState<{ droppedCandidates: number; exemplarCount: number } | null>(null);
    const [accepting, setAccepting] = useState(false);
    const [summary, setSummary] = useState('');

    const handleGenerate = async () => {
        setGenerating(true);
        setGenerateError('');
        setSummary('');
        try {
            const result = await generateTestCases(requirementId, count, style || undefined);
            setCandidates(result.candidates.map(toDraft));
            setMeta({ droppedCandidates: result.meta.droppedCandidates, exemplarCount: result.meta.exemplarCount });
        } catch (err: any) {
            setGenerateError(
                err?.response?.data?.error ||
                    'Unable to generate test cases right now. Please try again shortly.'
            );
        } finally {
            setGenerating(false);
        }
    };

    const updateCandidate = (index: number, patch: Partial<DraftCandidate>) => {
        setCandidates((prev) => prev.map((c, i) => (i === index ? { ...c, ...patch } : c)));
    };

    const updateStep = (candidateIndex: number, stepIndex: number, patch: Partial<TestCaseCandidateStep>) => {
        setCandidates((prev) =>
            prev.map((c, i) => {
                if (i !== candidateIndex) return c;
                const TestSteps = c.TestSteps.map((s, si) => (si === stepIndex ? { ...s, ...patch } : s));
                return { ...c, TestSteps };
            })
        );
    };

    const addStep = (candidateIndex: number) => {
        setCandidates((prev) =>
            prev.map((c, i) => (i === candidateIndex ? { ...c, TestSteps: [...c.TestSteps, emptyStep()] } : c))
        );
    };

    const removeStep = (candidateIndex: number, stepIndex: number) => {
        setCandidates((prev) =>
            prev.map((c, i) =>
                i === candidateIndex ? { ...c, TestSteps: c.TestSteps.filter((_, si) => si !== stepIndex) } : c
            )
        );
    };

    const handleAcceptSelected = async () => {
        setAccepting(true);
        setSummary('');
        let acceptedCount = 0;
        let failedCount = 0;

        for (let i = 0; i < candidates.length; i += 1) {
            const candidate = candidates[i];
            if (!candidate.keep || candidate.status === 'accepted') continue;

            updateCandidate(i, { status: 'accepting' });
            try {
                // eslint-disable-next-line no-await-in-loop
                await acceptCandidate(
                    { reqId, requirementSummary },
                    {
                        TestCaseSummary: candidate.TestCaseSummary,
                        description: candidate.description,
                        preconditions: candidate.preconditions,
                        TestSteps: candidate.TestSteps.filter((s) => s.testStep.trim() && s.Expected.trim()),
                    }
                );
                updateCandidate(i, { status: 'accepted' });
                acceptedCount += 1;
            } catch (err: any) {
                updateCandidate(i, {
                    status: 'error',
                    error: err?.response?.data?.error || 'Failed to create this test case',
                });
                failedCount += 1;
            }
        }

        setAccepting(false);
        if (acceptedCount > 0) {
            setSummary(
                `${acceptedCount} test case${acceptedCount === 1 ? '' : 's'} created as draft.` +
                    (failedCount > 0 ? ` ${failedCount} failed -- see below.` : '')
            );
            onAccepted?.();
        } else if (failedCount > 0) {
            setSummary(`${failedCount} candidate${failedCount === 1 ? '' : 's'} failed to save -- see below.`);
        }
    };

    const anyKeptPending = candidates.some((c) => c.keep && c.status !== 'accepted');

    return (
        <Drawer anchor="right" open={open} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', sm: 520 } } }}>
            <Box p={2} display="flex" flexDirection="column" height="100%">
                <Box display="flex" alignItems="center" justifyContent="space-between" mb={1}>
                    <Stack direction="row" alignItems="center" spacing={1}>
                        <AutoAwesomeIcon color="secondary" />
                        <Typography variant="h6">Generate test cases with AI</Typography>
                    </Stack>
                    <IconButton onClick={onClose} aria-label="Close">
                        <CloseIcon />
                    </IconButton>
                </Box>
                <Typography variant="body2" color="text.secondary" mb={2}>
                    Drafts are advisory only -- nothing is saved until you review, edit if needed, and accept below.
                </Typography>

                <Stack direction="row" spacing={2} alignItems="center" mb={2}>
                    <Select
                        size="small"
                        value={count}
                        onChange={(e) => setCount(Number(e.target.value))}
                        inputProps={{ 'aria-label': 'Number of candidates' }}
                    >
                        {[1, 2, 3, 4, 5].map((n) => (
                            <MenuItem key={n} value={n}>
                                {n} candidate{n === 1 ? '' : 's'}
                            </MenuItem>
                        ))}
                    </Select>
                    <TextField
                        size="small"
                        fullWidth
                        placeholder="Optional style hint (e.g. BDD, concise)"
                        label="Style"
                        value={style}
                        onChange={(e) => setStyle(e.target.value)}
                    />
                    <Button variant="contained" onClick={handleGenerate} disabled={generating}>
                        {generating ? <CircularProgress size={20} /> : 'Generate'}
                    </Button>
                </Stack>

                {generateError && (
                    <Alert severity="error" sx={{ mb: 2 }}>
                        {generateError}
                    </Alert>
                )}
                {summary && (
                    <Alert severity={summary.includes('failed') ? 'warning' : 'success'} sx={{ mb: 2 }}>
                        {summary}
                    </Alert>
                )}
                {meta && meta.droppedCandidates > 0 && (
                    <Alert severity="info" sx={{ mb: 2 }}>
                        {meta.droppedCandidates} candidate{meta.droppedCandidates === 1 ? '' : 's'} the model
                        returned could not be validated and {meta.droppedCandidates === 1 ? 'was' : 'were'} dropped
                        automatically.
                    </Alert>
                )}

                <Box flex={1} sx={{ overflowY: 'auto' }}>
                    {!generating && candidates.length === 0 && (
                        <EmptyState message="No candidates yet -- click Generate to draft test cases from this requirement." />
                    )}

                    <Stack spacing={2}>
                        {candidates.map((candidate, index) => (
                            <Box
                                key={index}
                                sx={{
                                    border: 1,
                                    borderColor: 'divider',
                                    borderRadius: 1,
                                    p: 1.5,
                                    opacity: candidate.status === 'accepted' ? 0.7 : 1,
                                }}
                            >
                                <Stack direction="row" alignItems="center" justifyContent="space-between">
                                    <Stack direction="row" alignItems="center" spacing={1}>
                                        <Checkbox
                                            checked={candidate.keep}
                                            disabled={candidate.status === 'accepted' || accepting}
                                            onChange={(e) => updateCandidate(index, { keep: e.target.checked })}
                                            inputProps={{ 'aria-label': `Keep candidate ${index + 1}` }}
                                        />
                                        <AiGeneratedBadge />
                                    </Stack>
                                    {candidate.status === 'accepted' && (
                                        <Chip
                                            icon={<CheckCircleIcon />}
                                            color="success"
                                            size="small"
                                            label="Added as draft"
                                        />
                                    )}
                                    {candidate.status === 'accepting' && <CircularProgress size={18} />}
                                </Stack>

                                <TextField
                                    label="Summary"
                                    fullWidth
                                    size="small"
                                    sx={{ mt: 1 }}
                                    value={candidate.TestCaseSummary}
                                    disabled={candidate.status === 'accepted'}
                                    onChange={(e) => updateCandidate(index, { TestCaseSummary: e.target.value })}
                                />
                                <TextField
                                    label="Description"
                                    fullWidth
                                    multiline
                                    minRows={2}
                                    size="small"
                                    sx={{ mt: 1 }}
                                    value={candidate.description || ''}
                                    disabled={candidate.status === 'accepted'}
                                    onChange={(e) => updateCandidate(index, { description: e.target.value })}
                                />
                                <TextField
                                    label="Preconditions (optional)"
                                    fullWidth
                                    size="small"
                                    sx={{ mt: 1 }}
                                    value={candidate.preconditions || ''}
                                    disabled={candidate.status === 'accepted'}
                                    onChange={(e) => updateCandidate(index, { preconditions: e.target.value })}
                                />

                                <Typography variant="subtitle2" sx={{ mt: 1.5, mb: 0.5 }}>
                                    Steps
                                </Typography>
                                <Stack spacing={1}>
                                    {candidate.TestSteps.map((step, stepIndex) => (
                                        <Stack key={stepIndex} direction="row" spacing={1} alignItems="flex-start">
                                            <TextField
                                                label="Step"
                                                size="small"
                                                fullWidth
                                                value={step.testStep}
                                                disabled={candidate.status === 'accepted'}
                                                onChange={(e) =>
                                                    updateStep(index, stepIndex, { testStep: e.target.value })
                                                }
                                            />
                                            <TextField
                                                label="Expected"
                                                size="small"
                                                fullWidth
                                                value={step.Expected}
                                                disabled={candidate.status === 'accepted'}
                                                onChange={(e) =>
                                                    updateStep(index, stepIndex, { Expected: e.target.value })
                                                }
                                            />
                                            <IconButton
                                                size="small"
                                                aria-label={`Remove step ${stepIndex + 1}`}
                                                disabled={candidate.status === 'accepted' || candidate.TestSteps.length <= 1}
                                                onClick={() => removeStep(index, stepIndex)}
                                            >
                                                <DeleteIcon fontSize="small" />
                                            </IconButton>
                                        </Stack>
                                    ))}
                                </Stack>
                                <Button
                                    size="small"
                                    startIcon={<AddIcon />}
                                    disabled={candidate.status === 'accepted'}
                                    onClick={() => addStep(index)}
                                    sx={{ mt: 1 }}
                                >
                                    Add step
                                </Button>

                                {candidate.status === 'error' && (
                                    <Alert severity="error" sx={{ mt: 1 }}>
                                        {candidate.error}
                                    </Alert>
                                )}
                            </Box>
                        ))}
                    </Stack>
                </Box>

                {candidates.length > 0 && (
                    <Box mt={2}>
                        <Divider sx={{ mb: 2 }} />
                        <Stack direction="row" spacing={1} justifyContent="flex-end">
                            <Button onClick={onClose}>Close</Button>
                            <Button
                                variant="contained"
                                onClick={handleAcceptSelected}
                                disabled={accepting || !anyKeptPending}
                            >
                                {accepting ? <CircularProgress size={20} /> : 'Accept selected'}
                            </Button>
                        </Stack>
                    </Box>
                )}
            </Box>
        </Drawer>
    );
};

export default AiTestCaseDrawer;
