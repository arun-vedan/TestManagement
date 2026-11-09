import { Fragment, ReactNode, useState } from 'react';
import { Alert, Box, Button, Chip, CircularProgress, Divider, Stack, Typography } from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import RefreshIcon from '@mui/icons-material/Refresh';
import DownloadIcon from '@mui/icons-material/Download';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { SummarizeReportResult, SummarizeReportScope, summarizeReport } from '../../api/aiApi';

// WP-053 -- "AI summary" panel. One component, reused on the Dashboard
// (scope="timerange") and the release page's Manage Release dialog
// (scope="release", releaseId=<that release>) -- per the WP brief's
// "surfaced as AI summary panels on the dashboard and release page".
//
// GR-8: advisory, dismissible, mutates nothing. Generation is USER-
// INITIATED (a button, never auto-fired on mount) -- unlike a WP-040
// report, this costs a real provider call and a daily-rate-limit unit, so
// firing it unprompted on every page visit would be wasteful; the user
// decides when they want a narrative.
//
// THE GROUNDING SIGNAL IS THE POINT (see backend/aiService/lib/
// groundingCheck.js's header comment): whenever the server reports
// `grounding.grounded === false`, this panel renders an unmissable
// error-level banner AND transforms every inline "**[UNVERIFIED
// FIGURE: ...]**" marker the server already wrapped the offending number
// in (see renderMarkdown below) into a highlighted, clearly-labelled chip
// -- there is no code path here that can drop that signal on the floor,
// matching the API's own "never silently drop a violation" contract.
//
// MARKDOWN: no markdown library added (design direction: "no new UI
// dependencies... render plain text and say so, or do it with what's
// already available"). renderMarkdown below is a small, deliberately
// narrow line-based renderer for exactly the shapes the backend's system
// prompt asks the model to produce (## headings, "- " bullets, **bold**
// spans) -- it builds React elements directly (never
// dangerouslySetInnerHTML), so there is no HTML-injection surface even
// though the text is model-generated.

const UNVERIFIED_MARK_RE = /^\[UNVERIFIED FIGURE: (.+)\]$/;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
    const parts = text.split(/(\*\*.*?\*\*)/g).filter((p) => p !== '');
    return parts.map((part, i) => {
        const key = `${keyPrefix}-${i}`;
        if (part.startsWith('**') && part.endsWith('**')) {
            const inner = part.slice(2, -2);
            const unverified = UNVERIFIED_MARK_RE.exec(inner);
            if (unverified) {
                return (
                    <Box
                        key={key}
                        component="span"
                        data-testid="unverified-figure"
                        sx={{
                            bgcolor: 'error.main',
                            color: 'error.contrastText',
                            px: 0.75,
                            py: 0.1,
                            borderRadius: 0.75,
                            fontWeight: 700,
                            whiteSpace: 'nowrap',
                        }}
                    >
                        ⚠ unverified: {unverified[1]}
                    </Box>
                );
            }
            return (
                <Box key={key} component="strong">
                    {inner}
                </Box>
            );
        }
        return <Fragment key={key}>{part}</Fragment>;
    });
}

function renderMarkdown(markdown: string): ReactNode {
    const lines = markdown.split('\n');
    return (
        <Stack spacing={0.5}>
            {lines.map((line, i) => {
                const key = `line-${i}`;
                if (line.startsWith('## ')) {
                    // component="div", not a real <h*> tag -- these are the
                    // model's own markdown section labels ("What changed",
                    // "Risks", ...), not part of this page's real document
                    // heading structure (see the title Typography's comment
                    // above for the same reasoning).
                    return (
                        <Typography key={key} variant="subtitle1" component="div" fontWeight={600} mt={i === 0 ? 0 : 1.5}>
                            {line.slice(3)}
                        </Typography>
                    );
                }
                if (line.startsWith('- ')) {
                    return (
                        <Typography key={key} variant="body2" component="li" sx={{ ml: 2.5 }}>
                            {renderInline(line.slice(2), key)}
                        </Typography>
                    );
                }
                if (line.trim() === '') {
                    return null;
                }
                return (
                    <Typography key={key} variant="body2">
                        {renderInline(line, key)}
                    </Typography>
                );
            })}
        </Stack>
    );
}

export interface AiSummaryPanelProps {
    scope: SummarizeReportScope;
    releaseId?: string;
    planId?: string;
    days?: number;
    /** Panel heading -- defaults to "AI summary". */
    title?: string;
}

export const AiSummaryPanel = ({ scope, releaseId, planId, days, title = 'AI summary' }: AiSummaryPanelProps) => {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [result, setResult] = useState<SummarizeReportResult | null>(null);
    const [dismissed, setDismissed] = useState(false);

    const handleGenerate = async () => {
        setLoading(true);
        setError('');
        try {
            const data = await summarizeReport(scope, { releaseId, planId, days });
            setResult(data);
            setDismissed(false);
        } catch (err: any) {
            setError(err?.response?.data?.error || 'Unable to generate an AI summary right now. Please try again shortly.');
        } finally {
            setLoading(false);
        }
    };

    const handleDownload = () => {
        if (!result) return;
        const header = [
            `AI-generated summary -- generated ${new Date(result.generatedAt).toLocaleString()}`,
            result.stale ? `NOTE: built from cached (stale) data -- ${result.staleReports.join(', ')}` : null,
            !result.grounding.grounded
                ? `WARNING: ${result.grounding.ungroundedFigures.length} figure(s) in this summary could not be verified against source data.`
                : null,
            '',
        ]
            .filter((l) => l !== null)
            .join('\n');
        const blob = new Blob([header + result.markdown], { type: 'text/markdown;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `ai-summary-${scope}-${releaseId || planId || 'project'}-${new Date().toISOString().slice(0, 10)}.md`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    if (dismissed) {
        return (
            <Button size="small" startIcon={<AutoAwesomeIcon />} onClick={() => setDismissed(false)}>
                Show AI summary
            </Button>
        );
    }

    return (
        <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 2 }} data-testid="ai-summary-panel">
            <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1} flexWrap="wrap">
                <Stack direction="row" alignItems="center" spacing={1}>
                    <AutoAwesomeIcon color="secondary" fontSize="small" />
                    {/* component="div" -- deliberately NOT a semantic heading tag.
                        This panel is embedded in two different page contexts (the
                        Dashboard's own AiSummarySection, which already supplies a
                        real "AI summary" <h2>, and the release page's Manage
                        Release dialog), and MUI's default variantMapping would
                        otherwise render subtitle1 as <h6> -- jumping straight from
                        whatever heading level the embedding page is at, an axe
                        heading-order violation (same class WP-046 fixed
                        elsewhere). The visible page heading belongs to the
                        embedding context, not to this reusable widget. */}
                    <Typography variant="subtitle1" component="div">
                        {title}
                    </Typography>
                    {result && (
                        <Chip
                            label={`AI-generated · ${new Date(result.generatedAt).toLocaleString()}`}
                            size="small"
                            color="secondary"
                            variant="outlined"
                            data-testid="ai-generated-label"
                        />
                    )}
                </Stack>
                <Stack direction="row" spacing={1}>
                    <Button
                        size="small"
                        variant={result ? 'outlined' : 'contained'}
                        startIcon={loading ? <CircularProgress size={14} color="inherit" /> : <RefreshIcon fontSize="small" />}
                        disabled={loading}
                        onClick={handleGenerate}
                    >
                        {result ? 'Regenerate' : 'Generate AI summary'}
                    </Button>
                    {result && (
                        <Button size="small" startIcon={<DownloadIcon fontSize="small" />} onClick={handleDownload}>
                            Download
                        </Button>
                    )}
                    <Button size="small" color="inherit" onClick={() => setDismissed(true)}>
                        Dismiss
                    </Button>
                </Stack>
            </Stack>

            {error && (
                <Alert severity="error" sx={{ mt: 1.5 }}>
                    {error}
                </Alert>
            )}

            {result && (
                <>
                    <Divider sx={{ my: 1.5 }} />

                    {result.stale && (
                        <Alert severity="warning" sx={{ mb: 1.5 }} data-testid="ai-summary-stale-banner">
                            This summary is built from cached data ({result.staleReports.join(', ')}) that could not
                            be refreshed just now -- it may not reflect the very latest state.
                        </Alert>
                    )}

                    {!result.grounding.grounded && (
                        <Alert severity="error" icon={<WarningAmberIcon />} sx={{ mb: 1.5 }} data-testid="ai-summary-grounding-warning">
                            {result.grounding.ungroundedFigures.length} figure
                            {result.grounding.ungroundedFigures.length === 1 ? '' : 's'} in this summary could not be
                            verified against the source data and{' '}
                            {result.grounding.ungroundedFigures.length === 1 ? 'is' : 'are'} marked below -- treat{' '}
                            {result.grounding.ungroundedFigures.length === 1 ? 'it' : 'them'} as unconfirmed.
                        </Alert>
                    )}

                    {renderMarkdown(result.markdown)}

                    <Typography variant="caption" color="text.secondary" display="block" mt={1.5}>
                        AI-generated, advisory only -- not saved anywhere until you export it. Every figure above is
                        drawn from live reporting data;{' '}
                        {result.grounding.grounded
                            ? `${result.grounding.groundedCount} of ${result.grounding.citedCount} cited figures verified.`
                            : `figures marked "unverified" could not be matched to that data.`}
                    </Typography>
                </>
            )}
        </Box>
    );
};

export default AiSummaryPanel;
