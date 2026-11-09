import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material';
import theme from '../../../Theme/theme';
import { AiTestCaseDrawer } from '../AiTestCaseDrawer';
import * as aiApi from '../../../api/aiApi';

// WP-051 -- the review drawer is where "generate -> edit -> accept" (the
// acceptance criterion) actually happens for a human. Proves: nothing is
// sent to acceptCandidate() until the human clicks "Accept selected"
// (generation alone calls nothing but generateTestCases), an inline edit to
// a candidate's summary is what actually gets sent on accept (not the
// original AI text), and unchecking a candidate ("reject") means
// acceptCandidate is never called for it at all -- there is nothing to roll
// back because nothing was ever attempted.

jest.mock('../../../api/aiApi');
const mockedGenerate = aiApi.generateTestCases as jest.Mock;
const mockedAccept = aiApi.acceptCandidate as jest.Mock;

const renderDrawer = (onAccepted = jest.fn()) =>
    render(
        <ThemeProvider theme={theme}>
            <AiTestCaseDrawer
                open
                onClose={jest.fn()}
                requirementId="req-mongo-id"
                reqId="Req-4"
                requirementSummary="Users can reset their password"
                onAccepted={onAccepted}
            />
        </ThemeProvider>
    );

const twoCandidates = {
    requirementId: 'req-mongo-id',
    reqId: 'Req-4',
    generatedBy: 'ai' as const,
    model: 'mock-echo-1',
    candidates: [
        {
            TestCaseSummary: 'AI candidate one',
            description: 'desc one',
            TestSteps: [{ testStep: 'Step A', Expected: 'Result A' }],
        },
        {
            TestCaseSummary: 'AI candidate two',
            description: 'desc two',
            TestSteps: [{ testStep: 'Step B', Expected: 'Result B' }],
        },
    ],
    meta: { requestedCount: 2, receivedCount: 2, droppedCandidates: 0, truncatedCount: 0, exemplarCount: 0 },
};

describe('AiTestCaseDrawer (WP-051)', () => {
    beforeEach(() => {
        mockedGenerate.mockReset();
        mockedAccept.mockReset();
    });

    it('calls nothing on mount -- generation only happens after the human clicks Generate', () => {
        renderDrawer();
        expect(mockedGenerate).not.toHaveBeenCalled();
        expect(mockedAccept).not.toHaveBeenCalled();
    });

    it('generate -> edit -> accept sends the EDITED text, not the original AI text, and only for kept candidates', async () => {
        mockedGenerate.mockResolvedValueOnce(twoCandidates);
        mockedAccept.mockResolvedValue({ _id: 'tc-1', TestCaseId: 'TC-1' });
        const onAccepted = jest.fn();

        renderDrawer(onAccepted);

        fireEvent.click(screen.getByRole('button', { name: /generate/i }));

        await screen.findByDisplayValue('AI candidate one');
        expect(screen.getByDisplayValue('AI candidate two')).toBeInTheDocument();

        // Human edits the first candidate's summary before accepting.
        fireEvent.change(screen.getByDisplayValue('AI candidate one'), {
            target: { value: 'AI candidate one (edited by human)' },
        });

        // Human rejects the second candidate by unchecking "keep".
        fireEvent.click(screen.getByLabelText('Keep candidate 2'));

        fireEvent.click(screen.getByRole('button', { name: /accept selected/i }));

        await waitFor(() => expect(mockedAccept).toHaveBeenCalledTimes(1));
        expect(mockedAccept).toHaveBeenCalledWith(
            { reqId: 'Req-4', requirementSummary: 'Users can reset their password' },
            expect.objectContaining({ TestCaseSummary: 'AI candidate one (edited by human)' })
        );
        // The rejected candidate is never sent anywhere -- nothing to roll
        // back, because nothing was ever attempted for it.
        expect(mockedAccept).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ TestCaseSummary: 'AI candidate two' })
        );

        await waitFor(() => expect(onAccepted).toHaveBeenCalledTimes(1));
        expect(screen.getByText(/1 test case created as draft/i)).toBeInTheDocument();
    });

    it('surfaces a per-candidate error and does not report success for a failed accept', async () => {
        mockedGenerate.mockResolvedValueOnce({
            ...twoCandidates,
            candidates: [twoCandidates.candidates[0]],
        });
        mockedAccept.mockRejectedValueOnce({ response: { data: { error: 'AI feature is disabled for this project' } } });

        renderDrawer();
        fireEvent.click(screen.getByRole('button', { name: /generate/i }));
        await screen.findByDisplayValue('AI candidate one');

        fireEvent.click(screen.getByRole('button', { name: /accept selected/i }));

        await screen.findByText('AI feature is disabled for this project');
        expect(screen.queryByText(/created as draft/i)).not.toBeInTheDocument();
    });
});
