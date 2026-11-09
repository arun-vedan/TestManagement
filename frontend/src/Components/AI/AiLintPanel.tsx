import { useState } from 'react';
import {
    Alert,
    Box,
    Button,
    Chip,
    CircularProgress,
    Divider,
    Drawer,
    IconButton,
    Stack,
    Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import CheckIcon from '@mui/icons-material/Check';
import BlockIcon from '@mui/icons-material/Block';
import { EmptyState } from '../common/EmptyState';
import { lintRequirement, applyLintFinding, LintFinding } from '../../api/aiApi';

// WP-052 -- requirement ambiguity linting panel (TabContent.tsx,
// selectedModule === 2). GR-8: advisory only -- findings are read-only
// until the user clicks Apply, which is the one write this panel makes,
// and even that is SERVER-SIDE lifecycle-gated (draft/review only,
// rejected 409 on approved -- see backend/aiService/controllers/ai.js
// #applyLintFinding). This panel does not hide/disable Apply just because
// the local `status` looks wrong -- it always tries, and shows whatever the
// server says, since the server is the actual authority and the status
// shown here could be stale.
//
// "Dismiss" here is TRANSIENT (local UI state only, not persisted
// server-side), unlike duplicate detection's dismissal -- deliberately
// different decision, recorded here rather than left ambiguous: a lint
// finding has no stable identity beyond one lint call (re-running lint
// regenerates the same findings fresh from the current text, there is no
// per-finding id to persist a dismissal against), so dismissing here just
// hides it for the rest of this panel session.

const FINDING_TYPE_LABELS: Record<string, string> = {
    'vague-quantifier': 'Vague quantifier',
    'untestable-phrasing': 'Untestable phrasing',
    'missing-acceptance-criteria': 'Missing acceptance criteria',
    other: 'Ambiguity',
};

interface FindingState extends LintFinding {
    key: string;
    status: 'pending' | 'applying' | 'applied' | 'dismissed' | 'error';
    error?: string;
}

export interface AiLintPanelProps {
    open: boolean;
    onClose: () => void;
    requirementId: string; // Mongo _id
    /** Called with the updated requirement (from requirementService's own response) after a successful Apply. */
    onApplied?: (updatedRequirement: any) => void;
}

export const AiLintPanel = ({ open, onClose, requirementId, onApplied }: AiLintPanelProps) => {
    const [linting, setLinting] = useState(false);
    const [lintError, setLintError] = useState('');
    const [findings, setFindings] = useState<FindingState[]>([]);
    const [linted, setLinted] = useState(false);
    const [requirementStatus, setRequirementStatus] = useState('');

    const handleLint = async () => {
        setLinting(true);
        setLintError('');
        try {
            const result = await lintRequirement(requirementId);
            setFindings(result.findings.map((f, i) => ({ ...f, key: `${i}-${f.excerpt}`, status: 'pending' })));
            setRequirementStatus(result.status);
            setLinted(true);
        } catch (err: any) {
            setLintError(err?.response?.data?.error || 'Unable to lint this requirement right now. Please try again shortly.');
        } finally {
            setLinting(false);
        }
    };

    const updateFinding = (key: string, patch: Partial<FindingState>) => {
        setFindings((prev) => prev.map((f) => (f.key === key ? { ...f, ...patch } : f)));
    };

    const handleApply = async (finding: FindingState) => {
        updateFinding(finding.key, { status: 'applying' });
        try {
            const updated = await applyLintFinding(requirementId, finding.excerpt, finding.suggestedRewrite);
            updateFinding(finding.key, { status: 'applied' });
            onApplied?.(updated);
        } catch (err: any) {
            updateFinding(finding.key, {
                status: 'error',
                error: err?.response?.data?.error || 'Failed to apply this suggestion',
            });
        }
    };

    const handleDismiss = (finding: FindingState) => {
        updateFinding(finding.key, { status: 'dismissed' });
    };

    return (
        <Drawer anchor="right" open={open} onClose={onClose} PaperProps={{ sx: { width: { xs: '100%', sm: 520 } } }}>
            <Box p={2} display="flex" flexDirection="column" height="100%">
                <Box display="flex" alignItems="center" justifyContent="space-between" mb={1}>
                    <Stack direction="row" alignItems="center" spacing={1}>
                        <AutoAwesomeIcon color="secondary" />
                        <Typography variant="h6">Lint requirement (AI)</Typography>
                    </Stack>
                    <IconButton onClick={onClose} aria-label="Close">
                        <CloseIcon />
                    </IconButton>
                </Box>
                <Typography variant="body2" color="text.secondary" mb={2}>
                    AI-suggested rewrites for vague or untestable phrasing. Advisory only -- nothing changes until you
                    click Apply on a specific suggestion below.
                </Typography>

                <Button variant="contained" onClick={handleLint} disabled={linting}>
                    {linting ? <CircularProgress size={20} /> : 'Lint this requirement'}
                </Button>

                {lintError && (
                    <Alert severity="error" sx={{ mt: 2 }}>
                        {lintError}
                    </Alert>
                )}
                {linted && requirementStatus && !['draft', 'review'].includes(requirementStatus) && (
                    <Alert severity="warning" sx={{ mt: 2 }}>
                        This requirement is <b>{requirementStatus}</b> -- applying a suggestion will be rejected
                        until it's moved back to draft or review.
                    </Alert>
                )}

                <Box flex={1} mt={2} sx={{ overflowY: 'auto' }}>
                    {linted && findings.length === 0 && (
                        <EmptyState message="No ambiguity issues found." />
                    )}
                    <Stack spacing={1.5}>
                        {findings
                            .filter((f) => f.status !== 'dismissed')
                            .map((finding) => (
                                <Box key={finding.key} sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5 }}>
                                    <Stack direction="row" alignItems="center" spacing={1} mb={0.5}>
                                        <Chip
                                            icon={<AutoAwesomeIcon />}
                                            label={FINDING_TYPE_LABELS[finding.type] || finding.type}
                                            color="secondary"
                                            size="small"
                                        />
                                    </Stack>
                                    <Typography variant="body2" mb={1}>
                                        {finding.description}
                                    </Typography>
                                    <Typography variant="caption" color="text.secondary">
                                        Current:
                                    </Typography>
                                    <Typography variant="body2" sx={{ textDecoration: 'line-through', mb: 0.5 }}>
                                        {finding.excerpt}
                                    </Typography>
                                    <Typography variant="caption" color="text.secondary">
                                        AI-suggested rewrite:
                                    </Typography>
                                    <Typography variant="body2" sx={{ fontWeight: 600, mb: 1 }}>
                                        {finding.suggestedRewrite}
                                    </Typography>

                                    {finding.status === 'applied' ? (
                                        <Alert icon={<CheckIcon fontSize="inherit" />} severity="success">
                                            Applied to the requirement.
                                        </Alert>
                                    ) : (
                                        <Stack direction="row" spacing={1}>
                                            <Button
                                                size="small"
                                                variant="contained"
                                                startIcon={
                                                    finding.status === 'applying' ? (
                                                        <CircularProgress size={14} color="inherit" />
                                                    ) : (
                                                        <CheckIcon fontSize="small" />
                                                    )
                                                }
                                                disabled={finding.status === 'applying'}
                                                onClick={() => handleApply(finding)}
                                            >
                                                Apply
                                            </Button>
                                            <Button
                                                size="small"
                                                startIcon={<BlockIcon fontSize="small" />}
                                                disabled={finding.status === 'applying'}
                                                onClick={() => handleDismiss(finding)}
                                            >
                                                Dismiss
                                            </Button>
                                        </Stack>
                                    )}
                                    {finding.status === 'error' && (
                                        <Alert severity="error" sx={{ mt: 1 }}>
                                            {finding.error}
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

export default AiLintPanel;
