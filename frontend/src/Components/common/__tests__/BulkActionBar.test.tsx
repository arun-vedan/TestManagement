import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material';
import theme from '../../../Theme/theme';
import { BulkActionBar, BulkActionConfig } from '../BulkActionBar';
import { BulkPolicyError } from '../../../api/bulkApi';

// WP-043 — the bulk-action confirmation is the one deliberate design
// exception in this WP (see BulkActionBar.tsx's header comment). Proves:
// nothing renders with an empty selection, the confirm dialog states the
// exact count/action and the "all or nothing" policy in its own text
// (matching what bulkApi.ts's responses carry), the configured run()
// function is called with the right ids/value only after explicit
// confirmation (never on the toolbar click alone), a 422 BulkPolicyError
// surfaces its message in the dialog without closing it, and Cancel calls
// nothing.

const renderBar = (props: Partial<React.ComponentProps<typeof BulkActionBar>> = {}) => {
    const defaultProps: React.ComponentProps<typeof BulkActionBar> = {
        selectedIds: ['a', 'b', 'c'],
        actions: [],
        onCleared: jest.fn(),
        onSuccess: jest.fn()
    };
    return render(
        <ThemeProvider theme={theme}>
            <BulkActionBar {...defaultProps} {...props} />
        </ThemeProvider>
    );
};

describe('BulkActionBar (WP-043)', () => {
    it('renders nothing when there is no selection', () => {
        const { container } = renderBar({ selectedIds: [] });
        expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing when there are no permitted actions (e.g. a viewer)', () => {
        const { container } = renderBar({ actions: [] });
        expect(container).toBeEmptyDOMElement();
    });

    it('shows the selected count and one button per action', () => {
        const actions: BulkActionConfig[] = [
            { kind: 'assign', label: 'Assign', valueLabel: 'Assign to', run: jest.fn() },
            { kind: 'delete', label: 'Delete', run: jest.fn() }
        ];
        renderBar({ actions });
        expect(screen.getByText('3 selected')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Assign' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    });

    it('the confirm dialog states the exact count, action, and "all or nothing" policy -- and does not call run() until confirmed', async () => {
        const run = jest.fn().mockResolvedValue({ success: true, policy: 'all-or-nothing', updated: 3 });
        const onSuccess = jest.fn();
        const onCleared = jest.fn();
        renderBar({ actions: [{ kind: 'assign', label: 'Assign', valueLabel: 'Assign to', run }], onSuccess, onCleared });

        fireEvent.click(screen.getByRole('button', { name: 'Assign' }));

        const dialog = await screen.findByRole('dialog');
        expect(dialog).toHaveTextContent('3 items');
        expect(dialog).toHaveTextContent('all or nothing');
        expect(run).not.toHaveBeenCalled();

        fireEvent.change(screen.getByLabelText('Assign to'), { target: { value: 'alice' } });
        fireEvent.click(screen.getByRole('button', { name: 'Confirm assign' }));

        await waitFor(() => expect(run).toHaveBeenCalledWith(['a', 'b', 'c'], 'alice'));
        await waitFor(() => expect(onSuccess).toHaveBeenCalledWith('assign', { success: true, policy: 'all-or-nothing', updated: 3 }));
        expect(onCleared).toHaveBeenCalled();
    });

    it('Cancel closes the dialog without calling run()', async () => {
        const run = jest.fn();
        renderBar({ actions: [{ kind: 'delete', label: 'Delete', run }] });

        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
        await screen.findByRole('dialog');
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(run).not.toHaveBeenCalled();
    });

    it('surfaces a BulkPolicyError message in the dialog and keeps it open (does not silently clear selection)', async () => {
        const run = jest.fn().mockRejectedValue(new BulkPolicyError('2 of 3 item(s) were not found; nothing was changed'));
        const onCleared = jest.fn();
        renderBar({ actions: [{ kind: 'delete', label: 'Delete', run }], onCleared });

        fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
        await screen.findByRole('dialog');
        fireEvent.click(screen.getByRole('button', { name: /Confirm delete/i }));

        await screen.findByText(/2 of 3 item\(s\) were not found; nothing was changed/);
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(onCleared).not.toHaveBeenCalled();
    });
});
