import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material';
import theme from '../../../Theme/theme';
import { ViewSwitcher } from '../ViewSwitcher';
import { getSavedViews, createSavedView, deleteSavedView, SavedView } from '../../../api/savedViewApi';

// WP-043 — proves the view-switcher lists system defaults + personal
// views, selecting one calls onSelect with the real SavedView object
// (not just an id), "Save current view" persists via a real API call
// (createSavedView) carrying the caller-supplied grid state, and deleting
// a personal view calls the delete API and (if it was selected) clears
// the selection back to "All".

jest.mock('../../../api/savedViewApi', () => {
    const actual = jest.requireActual('../../../api/savedViewApi');
    return {
        ...actual,
        getSavedViews: jest.fn(),
        createSavedView: jest.fn(),
        deleteSavedView: jest.fn()
    };
});

const mockGetSavedViews = getSavedViews as jest.Mock;
const mockCreateSavedView = createSavedView as jest.Mock;
const mockDeleteSavedView = deleteSavedView as jest.Mock;

const SYSTEM_VIEW: SavedView = {
    _id: 'sys-1',
    projectId: 1,
    entityType: 'defect',
    ownerId: null,
    isSystem: true,
    name: 'Critical defects',
    filterModel: {},
    sortModel: [],
    columnVisibilityModel: {},
    queryParams: { Severity: 'High' },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z'
};

const PERSONAL_VIEW: SavedView = {
    ...SYSTEM_VIEW,
    _id: 'mine-1',
    isSystem: false,
    ownerId: 'user-123',
    name: 'My review queue'
};

function renderSwitcher(props: Partial<React.ComponentProps<typeof ViewSwitcher>> = {}) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const defaultProps: React.ComponentProps<typeof ViewSwitcher> = {
        entityType: 'defect',
        selectedViewId: '',
        onSelect: jest.fn(),
        getCurrentViewState: () => ({ filterModel: {}, sortModel: [], columnVisibilityModel: {}, queryParams: {} }),
        canSave: true
    };
    return render(
        <QueryClientProvider client={queryClient}>
            <ThemeProvider theme={theme}>
                <ViewSwitcher {...defaultProps} {...props} />
            </ThemeProvider>
        </QueryClientProvider>
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetSavedViews.mockResolvedValue([SYSTEM_VIEW, PERSONAL_VIEW]);
});

// The Select is disabled while its saved-views query is loading
// (ViewSwitcher.tsx: `disabled={isLoading}`) -- waiting for the mock to
// have been CALLED isn't enough to know the resulting data has actually
// landed and re-rendered the (now enabled) control; wait for that
// directly before trying to open the menu.
async function waitForSelectReady() {
    await waitFor(() => expect(screen.getByLabelText('Saved view')).not.toHaveAttribute('aria-disabled', 'true'));
}

describe('ViewSwitcher (WP-043)', () => {
    it('lists "All" plus every system and personal view', async () => {
        renderSwitcher();
        await waitForSelectReady();
        fireEvent.mouseDown(screen.getByLabelText('Saved view'));
        expect(await screen.findByRole('option', { name: 'All (no saved view)' })).toBeInTheDocument();
        expect(screen.getByRole('option', { name: 'Critical defects' })).toBeInTheDocument();
        expect(screen.getByRole('option', { name: 'My review queue (mine)' })).toBeInTheDocument();
    });

    it('selecting a view calls onSelect with the real SavedView object', async () => {
        const onSelect = jest.fn();
        renderSwitcher({ onSelect });
        await waitForSelectReady();
        fireEvent.mouseDown(screen.getByLabelText('Saved view'));
        fireEvent.click(await screen.findByRole('option', { name: 'Critical defects' }));
        expect(onSelect).toHaveBeenCalledWith(SYSTEM_VIEW);
    });

    it('a viewer (canSave=false) sees no save/delete controls', async () => {
        renderSwitcher({ canSave: false, selectedViewId: 'mine-1' });
        await waitFor(() => expect(mockGetSavedViews).toHaveBeenCalled());
        expect(screen.queryByRole('button', { name: /save current view/i })).not.toBeInTheDocument();
    });

    it('"Save current view" persists via a real API call carrying the current grid state', async () => {
        mockCreateSavedView.mockResolvedValue({ ...PERSONAL_VIEW, _id: 'new-1', name: 'New saved view' });
        const onSelect = jest.fn();
        renderSwitcher({
            onSelect,
            getCurrentViewState: () => ({ filterModel: { items: [{ field: 'Severity', operator: 'equals', value: 'High' }] }, sortModel: [], columnVisibilityModel: {}, queryParams: { Severity: 'High' } })
        });
        await waitForSelectReady();

        fireEvent.click(screen.getByRole('button', { name: /save current view/i }));
        fireEvent.change(await screen.findByLabelText('View name'), { target: { value: 'New saved view' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        // TanStack Query's mutate() calls mutationFn with a second,
        // internal context argument (observed live: `{client: {}}`) that
        // the real createSavedView(payload) implementation never reads --
        // asserting on call[0][0] (the actual payload) rather than
        // toHaveBeenCalledWith(payload) (which requires exact arity)
        // avoids coupling this test to that internal.
        await waitFor(() => expect(mockCreateSavedView).toHaveBeenCalled());
        expect(mockCreateSavedView.mock.calls[0][0]).toEqual({
            entityType: 'defect',
            name: 'New saved view',
            filterModel: { items: [{ field: 'Severity', operator: 'equals', value: 'High' }] },
            sortModel: [],
            columnVisibilityModel: {},
            queryParams: { Severity: 'High' }
        });
        await waitFor(() => expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ _id: 'new-1' })));
    });

    it('deleting the currently-selected personal view clears the selection back to "All"', async () => {
        mockDeleteSavedView.mockResolvedValue(undefined);
        const onSelect = jest.fn();
        const confirmSpy = jest.spyOn(window, 'confirm').mockReturnValue(true);
        renderSwitcher({ selectedViewId: 'mine-1', onSelect });
        await waitForSelectReady();

        fireEvent.click(screen.getByRole('button', { name: /delete this saved view/i }));

        await waitFor(() => expect(mockDeleteSavedView).toHaveBeenCalled());
        expect(mockDeleteSavedView.mock.calls[0][0]).toBe('mine-1');
        await waitFor(() => expect(onSelect).toHaveBeenCalledWith(null));
        confirmSpy.mockRestore();
    });

    it('a system view cannot be deleted (no delete control for it)', async () => {
        renderSwitcher({ selectedViewId: 'sys-1' });
        await waitFor(() => expect(mockGetSavedViews).toHaveBeenCalled());
        expect(screen.queryByRole('button', { name: /delete this saved view/i })).not.toBeInTheDocument();
    });
});
