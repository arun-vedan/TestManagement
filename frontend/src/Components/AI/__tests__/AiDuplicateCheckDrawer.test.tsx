import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material';
import theme from '../../../Theme/theme';
import { AiDuplicateCheckDrawer } from '../AiDuplicateCheckDrawer';
import * as aiApi from '../../../api/aiApi';

// WP-052 -- proves: nothing is called on mount (GR-8, advisory-only), a
// candidate's score is rendered with the "AI similarity" label (unmistakable
// AI-suggested labelling), "Link as duplicate" is disabled for a not-yet-
// saved test case (no testCaseId) but still shows candidates, and Link/
// Dismiss each call the real API exactly once per click.

jest.mock('../../../api/aiApi');
const mockedCheck = aiApi.checkDuplicateTestCase as jest.Mock;
const mockedLink = aiApi.linkAsDuplicate as jest.Mock;
const mockedDismiss = aiApi.dismissDuplicate as jest.Mock;

const renderDrawer = (props: Partial<React.ComponentProps<typeof AiDuplicateCheckDrawer>> = {}) =>
    render(
        <ThemeProvider theme={theme}>
            <AiDuplicateCheckDrawer
                open
                onClose={jest.fn()}
                testCaseId="TC-1"
                TestCaseSummary="User can log in"
                TestCaseDescription="desc"
                parentId={5}
                {...props}
            />
        </ThemeProvider>
    );

const oneCandidate = {
    candidates: [{ testCaseId: 'TC-2', TestCaseSummary: 'User is able to login', score: 73, reason: 'word overlap' }],
    threshold: 55,
    scannedCount: 1,
};

describe('AiDuplicateCheckDrawer (WP-052)', () => {
    beforeEach(() => {
        mockedCheck.mockReset();
        mockedLink.mockReset();
        mockedDismiss.mockReset();
    });

    it('calls nothing on mount -- checking only happens after the human clicks "Check for duplicates"', () => {
        renderDrawer();
        expect(mockedCheck).not.toHaveBeenCalled();
    });

    it('renders a flagged candidate with an "AI similarity" labelled score after Check', async () => {
        mockedCheck.mockResolvedValueOnce(oneCandidate);
        renderDrawer();

        fireEvent.click(screen.getByRole('button', { name: /check for duplicates/i }));

        await screen.findByText('TC-2');
        expect(mockedCheck).toHaveBeenCalledWith({
            testCaseId: 'TC-1',
            TestCaseSummary: 'User can log in',
            TestCaseDescription: 'desc',
            parentId: 5,
        });
        expect(screen.getByText(/AI similarity: 73%/)).toBeInTheDocument();
    });

    it('disables "Link as duplicate" when the test case has not been saved yet (no testCaseId)', async () => {
        mockedCheck.mockResolvedValueOnce(oneCandidate);
        renderDrawer({ testCaseId: undefined });

        fireEvent.click(screen.getByRole('button', { name: /check for duplicates/i }));
        await screen.findByText('TC-2');

        expect(screen.getByRole('button', { name: /link as duplicate/i })).toBeDisabled();
        expect(screen.getByText(/hasn't been saved yet/i)).toBeInTheDocument();
    });

    it('clicking "Link as duplicate" calls linkAsDuplicate with both sides and shows Linked', async () => {
        mockedCheck.mockResolvedValueOnce(oneCandidate);
        mockedLink.mockResolvedValueOnce(undefined);
        renderDrawer();

        fireEvent.click(screen.getByRole('button', { name: /check for duplicates/i }));
        await screen.findByText('TC-2');

        fireEvent.click(screen.getByRole('button', { name: /link as duplicate/i }));

        await screen.findByText(/linked as duplicate/i);
        expect(mockedLink).toHaveBeenCalledWith(
            { testCaseId: 'TC-1', summary: 'User can log in' },
            { testCaseId: 'TC-2', summary: 'User is able to login' }
        );
    });

    it('clicking "Not a duplicate" calls dismissDuplicate and removes the candidate from view', async () => {
        mockedCheck.mockResolvedValueOnce(oneCandidate);
        mockedDismiss.mockResolvedValueOnce({ pairKey: 'TC-1|TC-2', dismissed: true });
        renderDrawer();

        fireEvent.click(screen.getByRole('button', { name: /check for duplicates/i }));
        await screen.findByText('TC-2');

        fireEvent.click(screen.getByRole('button', { name: /not a duplicate/i }));

        await waitFor(() => expect(screen.queryByText('TC-2')).not.toBeInTheDocument());
        expect(mockedDismiss).toHaveBeenCalledWith('TC-1', 'TC-2');
    });

    it('shows an empty state when no candidates are flagged', async () => {
        mockedCheck.mockResolvedValueOnce({ candidates: [], threshold: 55, scannedCount: 2 });
        renderDrawer();

        fireEvent.click(screen.getByRole('button', { name: /check for duplicates/i }));

        await screen.findByText(/no likely duplicates found/i);
    });
});
