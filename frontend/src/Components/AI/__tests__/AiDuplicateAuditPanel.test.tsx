import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material';
import theme from '../../../Theme/theme';
import { AiDuplicateAuditPanel } from '../AiDuplicateAuditPanel';
import * as aiApi from '../../../api/aiApi';

// WP-052 -- the bulk-audit UI surface (GR-4). Proves: nothing runs on
// mount, a flagged pair renders both sides with the "AI similarity" score,
// Link/Dismiss call the real APIs, and parentId is forwarded so the audit
// is scoped to the module the caller opened it for.

jest.mock('../../../api/aiApi');
const mockedAudit = aiApi.auditDuplicates as jest.Mock;
const mockedLink = aiApi.linkAsDuplicate as jest.Mock;
const mockedDismiss = aiApi.dismissDuplicate as jest.Mock;

const renderPanel = (props: Partial<React.ComponentProps<typeof AiDuplicateAuditPanel>> = {}) =>
    render(
        <ThemeProvider theme={theme}>
            <AiDuplicateAuditPanel open onClose={jest.fn()} parentId={5} moduleLabel="Login" {...props} />
        </ThemeProvider>
    );

const onePair = {
    pairs: [{ aId: 'TC-1', aSummary: 'User can log in', bId: 'TC-2', bSummary: 'User is able to login', score: 73, reason: 'x' }],
    threshold: 55,
    scannedCount: 2,
    moduleGroupCount: 1,
    skippedGroupCount: 0,
    failedComparisonCount: 0,
};

describe('AiDuplicateAuditPanel (WP-052)', () => {
    beforeEach(() => {
        mockedAudit.mockReset();
        mockedLink.mockReset();
        mockedDismiss.mockReset();
    });

    it('calls nothing on mount -- auditing only happens after the human clicks "Run audit"', () => {
        renderPanel();
        expect(mockedAudit).not.toHaveBeenCalled();
    });

    it('runs the audit scoped to the given parentId and renders a flagged pair', async () => {
        mockedAudit.mockResolvedValueOnce(onePair);
        renderPanel();

        fireEvent.click(screen.getByRole('button', { name: /run audit/i }));

        await screen.findByText(/AI similarity: 73%/);
        expect(mockedAudit).toHaveBeenCalledWith(5);
        expect(screen.getByText('User can log in')).toBeInTheDocument();
        expect(screen.getByText('User is able to login')).toBeInTheDocument();
    });

    it('audits the whole project when parentId is omitted', async () => {
        mockedAudit.mockResolvedValueOnce({ ...onePair, pairs: [] });
        renderPanel({ parentId: undefined, moduleLabel: undefined });

        fireEvent.click(screen.getByRole('button', { name: /run audit/i }));

        await waitFor(() => expect(mockedAudit).toHaveBeenCalledWith(undefined));
        expect(screen.getByText(/the whole project/i)).toBeInTheDocument();
    });

    it('Link as duplicate calls linkAsDuplicate with both sides of the pair', async () => {
        mockedAudit.mockResolvedValueOnce(onePair);
        mockedLink.mockResolvedValueOnce(undefined);
        const onLinked = jest.fn();
        renderPanel({ onLinked });

        fireEvent.click(screen.getByRole('button', { name: /run audit/i }));
        await screen.findByText(/AI similarity: 73%/);

        fireEvent.click(screen.getByRole('button', { name: /link as duplicate/i }));

        await screen.findByText(/linked as duplicate/i);
        expect(mockedLink).toHaveBeenCalledWith(
            { testCaseId: 'TC-1', summary: 'User can log in' },
            { testCaseId: 'TC-2', summary: 'User is able to login' }
        );
        expect(onLinked).toHaveBeenCalled();
    });

    it('Not a duplicate calls dismissDuplicate and removes the pair from view', async () => {
        mockedAudit.mockResolvedValueOnce(onePair);
        mockedDismiss.mockResolvedValueOnce({ pairKey: 'TC-1|TC-2', dismissed: true });
        renderPanel();

        fireEvent.click(screen.getByRole('button', { name: /run audit/i }));
        await screen.findByText(/AI similarity: 73%/);

        fireEvent.click(screen.getByRole('button', { name: /not a duplicate/i }));

        await waitFor(() => expect(screen.queryByText(/AI similarity: 73%/)).not.toBeInTheDocument());
        expect(mockedDismiss).toHaveBeenCalledWith('TC-1', 'TC-2');
    });

    it('shows an empty state when no pairs are flagged', async () => {
        mockedAudit.mockResolvedValueOnce({ ...onePair, pairs: [] });
        renderPanel();

        fireEvent.click(screen.getByRole('button', { name: /run audit/i }));

        await screen.findByText(/no likely duplicate pairs found/i);
    });

    it('surfaces a partial-failure warning rather than letting a 200 with some failed comparisons look like a confirmed all-clear', async () => {
        mockedAudit.mockResolvedValueOnce({ ...onePair, failedComparisonCount: 3 });
        renderPanel();

        fireEvent.click(screen.getByRole('button', { name: /run audit/i }));

        await screen.findByText(/3 comparisons failed/i);
        expect(screen.getByText(/not a confirmed all-clear/i)).toBeInTheDocument();
    });
});
