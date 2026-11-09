import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider, createTheme } from '@mui/material';
import { axe } from 'jest-axe';
import theme from '../../../Theme/theme';
import { EntityList } from '../EntityList';
import { expectNoUnexpectedAxeViolations } from '../../../testUtils/a11y';
import { fetchTestCasesPage } from '../../../api/entityGridApi';
import { getSavedViews } from '../../../api/savedViewApi';
import usePermissions from '../../../Hooks/usePermissions';

// WP-074 Step 8 — ported from the deleted Components/entityGrid/__tests__/
// TestCaseGridSection.test.tsx's "TestCaseGridSection (WP-046)" describe
// block, now that TestCaseGridSection.tsx itself (and its host page,
// Pages/testcases.tsx) are retired in favour of <EntityList> module 1.
// Same two cases, same mocking strategy as EntityList.test.tsx (which
// already ported that file's WP-043 RBAC/bulk-ops block) -- only the axe
// assertions move here, kept separate from the functional test file per
// this repo's existing *.a11y.test.tsx convention.

jest.mock('../../../api/entityGridApi', () => ({ fetchTestCasesPage: jest.fn(), fetchDefectsPage: jest.fn() }));
jest.mock('../../../api/savedViewApi', () => {
    const actual = jest.requireActual('../../../api/savedViewApi');
    return { ...actual, getSavedViews: jest.fn() };
});
jest.mock('../../../Hooks/usePermissions', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../../keycloak', () => ({ __esModule: true, default: { tokenParsed: { sub: 'user-abc' }, authenticated: true } }));

const mockFetchPage = fetchTestCasesPage as jest.Mock;
const mockGetSavedViews = getSavedViews as jest.Mock;
const mockUsePermissions = usePermissions as unknown as jest.Mock;

// WP-F05d -- these rows carry `tags` so the axe pass actually MOUNTS the
// tag chip. Before this the fixture had no tags and this suite used the
// plain theme, so the interactive chip WP-F05e introduced was never in the
// DOM: the suite passed while exercising none of the changed markup. A
// scoped re-review caught that "still axe-clean" was true and meaningless.
const ROWS = [
    { _id: 't1', TestCaseId: 'TC-1', TestCaseSummary: 'Login works', status: 'approved', assignedTo: undefined, updatedAt: '2026-01-01T00:00:00Z', tags: ['regression', 'smoke'] },
    { _id: 't2', TestCaseId: 'TC-2', TestCaseSummary: 'Logout works', status: 'draft', assignedTo: 'alice', updatedAt: '2026-01-02T00:00:00Z', tags: [] }
];

// WP-F05d -- same test-only override EntityList.test.tsx uses. At jsdom's
// zero client width the DataGrid mounts only a leading window of columns,
// so the tags column (deliberately last) would never render and axe would
// never see the chip. Test-only: production keeps virtualization.
const a11yTheme = createTheme(theme, {
    components: { MuiDataGrid: { defaultProps: { disableVirtualization: true } } }
} as Parameters<typeof createTheme>[1]);

function renderList() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={queryClient}>
            <ThemeProvider theme={a11yTheme}>
                <EntityList module={1} />
            </ThemeProvider>
        </QueryClientProvider>
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    mockFetchPage.mockResolvedValue({ rows: ROWS, rowCountEstimate: 2, hasNextPage: false });
    mockGetSavedViews.mockResolvedValue([]);
    // jsdom has no window.matchMedia -- MUI X DataGrid touches it.
    Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: jest.fn().mockImplementation((query: string) => ({
            matches: false,
            media: query,
            addListener: jest.fn(),
            removeListener: jest.fn(),
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
            dispatchEvent: jest.fn()
        }))
    });
});

describe('EntityList — module 1 (test cases) accessibility (WP-046, ported)', () => {
    // WP-046 — this DataGrid section IS "Test cases (list view)" (the
    // "test repo list" target page's own heading, originally on
    // Pages/testcases.tsx, now rendered by the workbench's SourcePanel).
    // Checks axe end to end, including MUI X DataGrid's own generated
    // markup (StatusChip cells, the pagination footer), not just
    // application-code changes -- see testUtils/a11y.ts for the one
    // accepted, documented exception this needs (a DataGrid footer quirk
    // in the pinned @mui/x-data-grid version, confirmed unrelated to any
    // app code).
    it('axe clean (beyond the documented DataGrid exception) with rows, the StatusChip column, and bulk controls all rendered', async () => {
        mockUsePermissions.mockReturnValue({ can: () => true, role: 'admin', isLoading: false, isError: false });
        const { container } = renderList();
        await screen.findByText('Login works');
        expectNoUnexpectedAxeViolations(await axe(container));
    });

    // WP-F05d -- guards the guard. The point of giving the fixture tags was
    // to make axe SEE the interactive chip; if the column stopped mounting
    // (virtualization override lost, column dropped, chip made
    // non-interactive) the axe test above would go back to passing while
    // exercising nothing, exactly as it did before. This fails loudly then.
    it('actually mounts the interactive tag chip, so the axe pass above means something', async () => {
        mockUsePermissions.mockReturnValue({ can: () => true, role: 'admin', isLoading: false, isError: false });
        renderList();
        expect(await screen.findByText('TC-1')).toBeInTheDocument();
        expect(await screen.findByRole('button', { name: 'regression' })).toBeInTheDocument();
    });

    it('axe clean in the empty/error state', async () => {
        mockUsePermissions.mockReturnValue({ can: () => true, role: 'admin', isLoading: false, isError: false });
        mockFetchPage.mockRejectedValue(new Error('network down'));
        const { container } = renderList();
        await screen.findByText('Unable to load test cases.');
        expectNoUnexpectedAxeViolations(await axe(container));
    });
});
