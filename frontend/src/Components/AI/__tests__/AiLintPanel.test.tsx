import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material';
import theme from '../../../Theme/theme';
import { AiLintPanel } from '../AiLintPanel';
import * as aiApi from '../../../api/aiApi';

// WP-052 -- proves: nothing is called on mount, findings render with their
// AI-suggested rewrite clearly labelled, Apply calls applyLintFinding (and
// surfaces a server-side rejection, e.g. the lifecycle-gate 409, rather than
// hiding it), and Dismiss is purely local (never calls the API -- lint
// findings have no stable persisted identity, see AiLintPanel.tsx's header
// comment for why that's a deliberately different decision from duplicate
// detection's persisted dismissal).

jest.mock('../../../api/aiApi');
const mockedLint = aiApi.lintRequirement as jest.Mock;
const mockedApply = aiApi.applyLintFinding as jest.Mock;

const renderPanel = (onApplied = jest.fn()) =>
    render(
        <ThemeProvider theme={theme}>
            <AiLintPanel open onClose={jest.fn()} requirementId="req-1" onApplied={onApplied} />
        </ThemeProvider>
    );

const oneFinding = {
    requirementId: 'req-1',
    reqId: 'Req-1',
    status: 'draft',
    findings: [
        {
            type: 'vague-quantifier',
            description: '"some" is vague',
            excerpt: 'some',
            suggestedRewrite: 'a specific number of',
        },
    ],
};

describe('AiLintPanel (WP-052)', () => {
    beforeEach(() => {
        mockedLint.mockReset();
        mockedApply.mockReset();
    });

    it('calls nothing on mount -- linting only happens after the human clicks "Lint this requirement"', () => {
        renderPanel();
        expect(mockedLint).not.toHaveBeenCalled();
    });

    it('renders a finding with its current text and AI-suggested rewrite both visible', async () => {
        mockedLint.mockResolvedValueOnce(oneFinding);
        renderPanel();

        fireEvent.click(screen.getByRole('button', { name: /lint this requirement/i }));

        await screen.findByText('some');
        expect(mockedLint).toHaveBeenCalledWith('req-1');
        expect(screen.getByText('a specific number of')).toBeInTheDocument();
    });

    it('Apply calls applyLintFinding with the excerpt/rewrite and reports success', async () => {
        mockedLint.mockResolvedValueOnce(oneFinding);
        mockedApply.mockResolvedValueOnce({ requirementDescription: '{"ops":[{"insert":"x\\n"}]}' });
        const onApplied = jest.fn();
        renderPanel(onApplied);

        fireEvent.click(screen.getByRole('button', { name: /lint this requirement/i }));
        await screen.findByText('some');

        fireEvent.click(screen.getByRole('button', { name: /^apply$/i }));

        await screen.findByText(/applied to the requirement/i);
        expect(mockedApply).toHaveBeenCalledWith('req-1', 'some', 'a specific number of');
        expect(onApplied).toHaveBeenCalledWith({ requirementDescription: '{"ops":[{"insert":"x\\n"}]}' });
    });

    it('Apply surfaces a server-side rejection (e.g. lifecycle gate 409) instead of hiding it', async () => {
        mockedLint.mockResolvedValueOnce({ ...oneFinding, status: 'approved' });
        mockedApply.mockRejectedValueOnce({
            response: { status: 409, data: { error: "Cannot apply an AI suggestion to a requirement in status 'approved'" } },
        });
        renderPanel();

        fireEvent.click(screen.getByRole('button', { name: /lint this requirement/i }));
        await screen.findByText('some');
        // Apply is NOT hidden/disabled by client-side status -- it's still clickable.
        const applyButton = screen.getByRole('button', { name: /^apply$/i });
        expect(applyButton).toBeEnabled();

        fireEvent.click(applyButton);

        await screen.findByText(/status 'approved'/i);
    });

    it('Dismiss removes the finding locally WITHOUT calling any API', async () => {
        mockedLint.mockResolvedValueOnce(oneFinding);
        renderPanel();

        fireEvent.click(screen.getByRole('button', { name: /lint this requirement/i }));
        await screen.findByText('some');

        fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));

        await waitFor(() => expect(screen.queryByText('some')).not.toBeInTheDocument());
        expect(mockedApply).not.toHaveBeenCalled();
    });

    it('shows an empty state when no findings are returned', async () => {
        mockedLint.mockResolvedValueOnce({ ...oneFinding, findings: [] });
        renderPanel();

        fireEvent.click(screen.getByRole('button', { name: /lint this requirement/i }));

        await screen.findByText(/no ambiguity issues found/i);
    });
});
