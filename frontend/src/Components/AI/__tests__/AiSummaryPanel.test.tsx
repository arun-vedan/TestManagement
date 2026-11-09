import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material';
import theme from '../../../Theme/theme';
import { AiSummaryPanel } from '../AiSummaryPanel';
import * as aiApi from '../../../api/aiApi';
import { SummarizeReportResult } from '../../../api/aiApi';

// WP-053 -- proves: nothing is called on mount (generation is user-
// initiated, same GR-8 posture as AiLintPanel), a grounded result renders
// the AI-generated label+timestamp with no warning, an UNGROUNDED result
// renders the grounding warning AND visibly marks the flagged figure
// (never silently -- see AiSummaryPanel.tsx's header comment), a stale
// result renders the staleness banner, regenerating replaces the shown
// result, and Download never calls the API (client-side export only).

jest.mock('../../../api/aiApi');
const mockedSummarize = aiApi.summarizeReport as jest.Mock;

const renderPanel = (props: Partial<React.ComponentProps<typeof AiSummaryPanel>> = {}) =>
    render(
        <ThemeProvider theme={theme}>
            <AiSummaryPanel scope="release" releaseId="REL-1" {...props} />
        </ThemeProvider>
    );

const groundedResult: SummarizeReportResult = {
    scope: 'release',
    releaseId: 'REL-1',
    markdown: '## What changed\n- Coverage is 0% (0 of 5 tested).\n- There are 3 open defects.',
    generatedBy: 'ai',
    generatedAt: '2026-08-28T10:00:00.000Z',
    model: 'mock-echo-1',
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    latencyMs: 5,
    grounding: { grounded: true, citedCount: 2, groundedCount: 2, ungroundedFigures: [], rule: 'exact-or-rounding' },
    stale: false,
    staleReports: [],
    sourceReports: [{ reportType: 'coverage', computedAt: '2026-08-28T10:00:00.000Z', stale: false }],
};

const ungroundedResult: SummarizeReportResult = {
    ...groundedResult,
    markdown: '## Notable failures\nThere are **[UNVERIFIED FIGURE: 63]** open defects this period.',
    grounding: {
        grounded: false,
        citedCount: 3,
        groundedCount: 2,
        ungroundedFigures: [{ raw: '63', kind: 'number' }],
        rule: 'exact-or-rounding',
    },
};

const staleResult: SummarizeReportResult = {
    ...groundedResult,
    stale: true,
    staleReports: ['coverage'],
};

describe('AiSummaryPanel (WP-053)', () => {
    beforeEach(() => {
        mockedSummarize.mockReset();
    });

    it('calls nothing on mount -- generation only happens after the human clicks the button', () => {
        renderPanel();
        expect(mockedSummarize).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: /generate ai summary/i })).toBeInTheDocument();
    });

    it('passes scope/releaseId/planId/days through to summarizeReport()', async () => {
        mockedSummarize.mockResolvedValueOnce(groundedResult);
        renderPanel({ scope: 'timerange', releaseId: undefined, days: 7 });

        fireEvent.click(screen.getByRole('button', { name: /generate ai summary/i }));

        await waitFor(() => expect(mockedSummarize).toHaveBeenCalledWith('timerange', { releaseId: undefined, planId: undefined, days: 7 }));
    });

    it('a grounded result renders the AI-generated label+timestamp and the markdown, with no warning', async () => {
        mockedSummarize.mockResolvedValueOnce(groundedResult);
        renderPanel();

        fireEvent.click(screen.getByRole('button', { name: /generate ai summary/i }));

        await screen.findByTestId('ai-generated-label');
        expect(screen.getByText(/what changed/i)).toBeInTheDocument();
        expect(screen.getByText(/3 open defects/i)).toBeInTheDocument();
        expect(screen.queryByTestId('ai-summary-grounding-warning')).not.toBeInTheDocument();
        expect(screen.queryByTestId('ai-summary-stale-banner')).not.toBeInTheDocument();
        // The button becomes "Regenerate" once a result exists.
        expect(screen.getByRole('button', { name: /regenerate/i })).toBeInTheDocument();
    });

    it('an UNGROUNDED result renders an unmissable warning AND visibly marks the flagged figure -- never silently', async () => {
        mockedSummarize.mockResolvedValueOnce(ungroundedResult);
        renderPanel();

        fireEvent.click(screen.getByRole('button', { name: /generate ai summary/i }));

        await screen.findByTestId('ai-summary-grounding-warning');
        expect(screen.getByTestId('ai-summary-grounding-warning')).toHaveTextContent(/1 figure/i);
        const marked = screen.getByTestId('unverified-figure');
        expect(marked).toHaveTextContent('63');
        // The raw markdown marker syntax itself must never leak to the reader as literal text.
        expect(screen.queryByText(/\*\*\[UNVERIFIED FIGURE/)).not.toBeInTheDocument();
    });

    it('a stale result renders the staleness banner, naming which report was stale', async () => {
        mockedSummarize.mockResolvedValueOnce(staleResult);
        renderPanel();

        fireEvent.click(screen.getByRole('button', { name: /generate ai summary/i }));

        await screen.findByTestId('ai-summary-stale-banner');
        expect(screen.getByTestId('ai-summary-stale-banner')).toHaveTextContent(/coverage/i);
    });

    it('Regenerate replaces the shown result with a fresh call', async () => {
        mockedSummarize.mockResolvedValueOnce(groundedResult);
        renderPanel();
        fireEvent.click(screen.getByRole('button', { name: /generate ai summary/i }));
        await screen.findByTestId('ai-generated-label');

        const updated: SummarizeReportResult = {
            ...groundedResult,
            generatedAt: '2026-08-29T10:00:00.000Z',
            markdown: '## What changed\n- There are 4 open defects now.',
        };
        mockedSummarize.mockResolvedValueOnce(updated);
        fireEvent.click(screen.getByRole('button', { name: /regenerate/i }));

        await screen.findByText(/4 open defects now/i);
        expect(mockedSummarize).toHaveBeenCalledTimes(2);
    });

    it('surfaces a server-side error (e.g. 503 provider-unavailable) rather than a blank panel', async () => {
        mockedSummarize.mockRejectedValueOnce({
            response: { status: 503, data: { error: 'AI is currently unavailable; please try again later' } },
        });
        renderPanel();

        fireEvent.click(screen.getByRole('button', { name: /generate ai summary/i }));

        await screen.findByText(/currently unavailable/i);
    });

    it('Dismiss hides the panel locally WITHOUT calling any API, and can be shown again', async () => {
        renderPanel();
        fireEvent.click(screen.getByRole('button', { name: /^dismiss$/i }));

        await waitFor(() => expect(screen.queryByTestId('ai-summary-panel')).not.toBeInTheDocument());
        expect(mockedSummarize).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: /show ai summary/i }));
        expect(screen.getByTestId('ai-summary-panel')).toBeInTheDocument();
    });

    it('Download never calls the API -- it is a client-side export of the already-fetched result', async () => {
        mockedSummarize.mockResolvedValueOnce(groundedResult);
        renderPanel();
        fireEvent.click(screen.getByRole('button', { name: /generate ai summary/i }));
        await screen.findByTestId('ai-generated-label');

        mockedSummarize.mockClear();
        const createObjectURL = jest.fn().mockReturnValue('blob:mock');
        const revokeObjectURL = jest.fn();
        (URL as any).createObjectURL = createObjectURL;
        (URL as any).revokeObjectURL = revokeObjectURL;

        fireEvent.click(screen.getByRole('button', { name: /^download$/i }));

        expect(mockedSummarize).not.toHaveBeenCalled();
        expect(createObjectURL).toHaveBeenCalled();
    });
});
