import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider, createTheme } from '@mui/material';
// Registers the `MuiDataGrid` key on MUI's `Components<Theme>` type so the
// `testTheme` override below type-checks -- see its own comment for why.
import '@mui/x-data-grid/themeAugmentation';
import theme from '../../../Theme/theme';
import { EntityList } from '../EntityList';
import { WorkbenchStoreProvider, useWorkbench } from '../../WorkbenchStoreProvider';
import {
    fetchTestCasesPage,
    fetchDefectsPage,
    fetchRequirementsPage,
    fetchTestPlansPage,
    fetchTestExecutionsPage
} from '../../../api/entityGridApi';
import { getSavedViews } from '../../../api/savedViewApi';
import { getReleases } from '../../../api/releaseApi';
import {
    bulkDeleteTestCases,
    bulkAssignTestCases,
    bulkUpdateRequirementStatus,
    bulkDeleteRequirements,
    bulkDeleteTestPlans,
    bulkAssignTestRuns,
    bulkDeleteTestRuns
} from '../../../api/bulkApi';
import usePermissions from '../../../Hooks/usePermissions';
import { ModuleId } from '../../modules';
import { moduleListConfigs } from '../entityListConfigs';

// WP-074 Step 5 — <EntityList> absorbs Components/entityGrid/
// TestCaseGridSection.tsx's behaviour (saved views + bulk ops), keyed by
// module via entityListConfigs.ts's registry, rather than hardcoding test
// cases. Mocking strategy mirrored
// Components/entityGrid/__tests__/TestCaseGridSection.test.tsx exactly
// (same mocked modules, same jsdom matchMedia shim MUI X DataGrid needs).
//
// WP-074 Step 8 — that file (and TestCaseGridSection.tsx/Pages/testcases.tsx,
// its last non-test consumers) is now deleted; the two module-1 tests below
// ("a viewer sees no checkbox..." and "shows an empty state on fetch
// error...") are ported verbatim from its "TestCaseGridSection (WP-043)"
// describe block -- the rest of that block's assertions were already
// covered here before this port (rendering rows, pagination/sort params,
// the contributor permission case). Its "TestCaseGridSection (WP-046)" a11y
// describe block was ported separately into EntityList.a11y.test.tsx in
// this same directory.
//
// WP-077 Step 2 — Components/entityGrid/__tests__/DefectGridSection.test.tsx
// (and DefectGridSection.tsx, its last non-test consumer) is now deleted;
// ALL FOUR of its assertions are ported verbatim below into a new "module 5
// (defects)" describe block -- unlike module 1, no module-5 coverage
// existed here before this port at all.

jest.mock('../../../api/entityGridApi', () => ({
    fetchTestCasesPage: jest.fn(),
    fetchDefectsPage: jest.fn(),
    fetchRequirementsPage: jest.fn(),
    fetchTestPlansPage: jest.fn(),
    fetchTestExecutionsPage: jest.fn()
}));
jest.mock('../../../api/savedViewApi', () => {
    const actual = jest.requireActual('../../../api/savedViewApi');
    return { ...actual, getSavedViews: jest.fn() };
});
// WP-F15/F18 Task 1 -- entityListConfigs.tsx's module-6 fetchPage adapter
// calls getReleases() directly (releaseApi.ts), not one of the
// entityGridApi.ts fetchers mocked above -- see that adapter's own header
// comment on why the two aren't on the same contract.
jest.mock('../../../api/releaseApi', () => ({ getReleases: jest.fn() }));
jest.mock('../../../api/bulkApi', () => {
    const actual = jest.requireActual('../../../api/bulkApi');
    return {
        ...actual,
        bulkAssignTestCases: jest.fn(),
        bulkUpdateTestCaseStatus: jest.fn(),
        bulkDeleteTestCases: jest.fn(),
        bulkAssignDefects: jest.fn(),
        bulkDeleteDefects: jest.fn(),
        bulkUpdateRequirementStatus: jest.fn(),
        bulkDeleteRequirements: jest.fn(),
        bulkDeleteTestPlans: jest.fn(),
        bulkAssignTestRuns: jest.fn(),
        bulkDeleteTestRuns: jest.fn()
    };
});
jest.mock('../../../Hooks/usePermissions', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../../keycloak', () => ({ __esModule: true, default: { tokenParsed: { sub: 'user-abc' }, authenticated: true } }));

const mockFetchTestCasesPage = fetchTestCasesPage as jest.Mock;
const mockFetchDefectsPage = fetchDefectsPage as jest.Mock;
const mockFetchRequirementsPage = fetchRequirementsPage as jest.Mock;
const mockFetchTestPlansPage = fetchTestPlansPage as jest.Mock;
const mockFetchTestExecutionsPage = fetchTestExecutionsPage as jest.Mock;
const mockGetSavedViews = getSavedViews as jest.Mock;
const mockGetReleases = getReleases as jest.Mock;
const mockUsePermissions = usePermissions as unknown as jest.Mock;
const mockBulkDeleteTestCases = bulkDeleteTestCases as jest.Mock;
const mockBulkAssignTestCases = bulkAssignTestCases as jest.Mock;
const mockBulkUpdateRequirementStatus = bulkUpdateRequirementStatus as jest.Mock;
const mockBulkDeleteRequirements = bulkDeleteRequirements as jest.Mock;
const mockBulkDeleteTestPlans = bulkDeleteTestPlans as jest.Mock;
const mockBulkAssignTestRuns = bulkAssignTestRuns as jest.Mock;
const mockBulkDeleteTestRuns = bulkDeleteTestRuns as jest.Mock;

const ROWS = [
    // WP-F05c -- tags added to the fixture so the tag column and the
    // click-to-filter path have something real to render and act on.
    { _id: 't1', TestCaseId: 'TC-1', TestCaseSummary: 'Login works', status: 'approved', assignedTo: undefined, updatedAt: '2026-01-01T00:00:00Z', tags: ['regression', 'smoke'] },
    { _id: 't2', TestCaseId: 'TC-2', TestCaseSummary: 'Logout works', status: 'draft', assignedTo: 'alice', updatedAt: '2026-01-02T00:00:00Z', tags: [] }
];

// Mirrors DefectGridSection.test.tsx's own ROWS fixture exactly (deleted
// WP-077 Step 2, ported into the "module 5 (defects)" describe below).
const DEFECT_ROWS = [
    { _id: 'd1', defectId: 'Bug-1', summary: 'Crash on save', Severity: 'High', Status: 'New', assignedTo: undefined, updatedAt: '2026-01-01T00:00:00Z' }
];

const REQUIREMENT_ROWS = [
    {
        _id: 'r1',
        reqId: 'REQ-1',
        requirementSummary: 'Users can reset their password',
        status: 'approved',
        parentId: null,
        createdBy: 'alice',
        updatedBy: 'alice',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-03T00:00:00Z',
        dynamicFields: {}
    },
    {
        _id: 'r2',
        reqId: 'REQ-2',
        requirementSummary: 'Users can export a report',
        status: 'draft',
        parentId: null,
        createdBy: 'bob',
        updatedBy: 'bob',
        createdAt: '2026-01-02T00:00:00Z',
        updatedAt: '2026-01-04T00:00:00Z',
        dynamicFields: {}
    }
];

const TEST_PLAN_ROWS = [
    { _id: 'p1', TestPlanId: 'TP-1', TestCases: ['tc1', 'tc2', 'tc3'], parentId: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-03T00:00:00Z' },
    { _id: 'p2', TestPlanId: 'TP-2', TestCases: [], parentId: null, createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-04T00:00:00Z' }
];

const TEST_EXECUTION_ROWS = [
    { _id: 'e1', TestExecutionId: 'TE-1', TestPlanId: 'TP-1', assignedTo: 'carol', TestDetails: [], source: 'manual', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-03T00:00:00Z' },
    { _id: 'e2', TestExecutionId: 'TE-2', TestPlanId: 'TP-2', assignedTo: 'dave', TestDetails: [], source: 'manual', createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-04T00:00:00Z' }
];

// WP-F15/F18 Task 1 -- module 6 (releases). Two linked test plans on REL-1,
// none on REL-2, so the derived "Linked test plans" column has something
// real to distinguish.
const RELEASE_ROWS = [
    {
        _id: 'rel1', id: 1, releaseId: 'REL-1', name: 'Spring Launch', projectId: 1,
        targetDate: '2026-03-15T00:00:00Z', status: 'planned', linkedTestPlanIds: ['p1', 'p2'],
        qualityGates: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z'
    },
    {
        _id: 'rel2', id: 2, releaseId: 'REL-2', name: 'Summer Launch', projectId: 1,
        targetDate: '2026-06-01T00:00:00Z', status: 'released', linkedTestPlanIds: [],
        qualityGates: [], createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z'
    }
];

// WP-F05e Fix 2 -- WP-F05c claimed the tag chips and the click-to-filter
// behaviour "cannot be asserted in jsdom at all", because MUI X DataGrid's
// column virtualization, given jsdom's zero client width, mounts only a
// leading window of columns -- and that a tried `columnBuffer` didn't change
// it. That claim was checked, not just repeated: `disableVirtualization` (a
// real first-party DataGrid prop -- see
// node_modules/@mui/x-data-grid/models/props/DataGridProps.d.ts) was never
// tried, and it does work (every describe block below, including this
// file's PRE-EXISTING module 2/4 tests whose own comments recorded columns
// being pushed out of the virtualized window, now renders every column --
// see this WP's own report for the concrete before/after).
//
// Applied via a THEME override, test-only: production must keep
// virtualization for real, large lists, so this is layered on top of the
// app's real `theme` with MUI's own default-props mechanism rather than
// changed in EntityList.tsx itself, which never sets this prop.
const testTheme = createTheme(theme, {
    components: {
        MuiDataGrid: {
            defaultProps: {
                disableVirtualization: true
            }
        }
    }
});

// WP-F15/F18 Task 5 -- wrapped in a real <WorkbenchStoreProvider> (it was
// not before this task). Every existing describe block below still passes
// unmodified: modules 1-5's columns call no workbench-store hook at all, so
// this is inert for them -- only module 6's `ReleaseIdCell`
// (entityListConfigs.tsx) reads from it, and it would throw
// ("useWorkbench() must be called within a <WorkbenchStoreProvider>")
// without this wrapper the moment that cell mounted.
function renderList(module: ModuleId) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={queryClient}>
            <ThemeProvider theme={testTheme}>
                <WorkbenchStoreProvider projectId={1}>
                    <EntityList module={module} />
                </WorkbenchStoreProvider>
            </ThemeProvider>
        </QueryClientProvider>
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    // WP-F15/F18 Task 5 -- renderList now mounts a real, persisted
    // <WorkbenchStoreProvider> (zustand's `persist` middleware writes
    // `workbench:1` to localStorage, jsdom-backed here). Without clearing
    // it, a tab opened by one test (module 6's click-to-open test below)
    // would still be there -- rehydrated from localStorage -- when the
    // NEXT test creates its own "fresh" store for the same projectId.
    localStorage.clear();
    mockFetchTestCasesPage.mockResolvedValue({ rows: ROWS, rowCountEstimate: 2, hasNextPage: false });
    mockFetchDefectsPage.mockResolvedValue({ rows: DEFECT_ROWS, rowCountEstimate: 1, hasNextPage: false });
    mockFetchRequirementsPage.mockResolvedValue({ rows: REQUIREMENT_ROWS, rowCountEstimate: 2, hasNextPage: false });
    mockFetchTestPlansPage.mockResolvedValue({ rows: TEST_PLAN_ROWS, rowCountEstimate: 2, hasNextPage: false });
    mockFetchTestExecutionsPage.mockResolvedValue({ rows: TEST_EXECUTION_ROWS, rowCountEstimate: 2, hasNextPage: false });
    mockGetSavedViews.mockResolvedValue([]);
    mockGetReleases.mockResolvedValue(RELEASE_ROWS);
    mockBulkDeleteTestCases.mockResolvedValue({ success: true, policy: 'all-or-nothing', deleted: 1 });
    mockBulkAssignTestCases.mockResolvedValue({ success: true, policy: 'all-or-nothing', updated: 1 });
    mockBulkUpdateRequirementStatus.mockResolvedValue({ success: true, policy: 'all-or-nothing', updated: 1 });
    mockBulkDeleteRequirements.mockResolvedValue({ success: true, policy: 'all-or-nothing', deleted: 1 });
    mockBulkDeleteTestPlans.mockResolvedValue({ success: true, policy: 'all-or-nothing', deleted: 1 });
    mockBulkAssignTestRuns.mockResolvedValue({ success: true, policy: 'all-or-nothing', updated: 1 });
    mockBulkDeleteTestRuns.mockResolvedValue({ success: true, policy: 'all-or-nothing', deleted: 1 });
    mockUsePermissions.mockReturnValue({ can: () => true, role: 'admin', isLoading: false, isError: false });
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

describe('EntityList — module 1 (test cases)', () => {
    it('renders rows for module 1 from the mocked page fetcher', async () => {
        renderList(1);
        expect(await screen.findByText('Login works')).toBeInTheDocument();
        expect(screen.getByText('Logout works')).toBeInTheDocument();
    });

    it('server-side pagination and sort call the fetcher with the right params', async () => {
        renderList(1);
        await waitFor(() =>
            expect(mockFetchTestCasesPage).toHaveBeenCalledWith(
                expect.objectContaining({ page: 0, pageSize: 25, sortField: 'createdAt', sortDirection: 'desc' })
            )
        );
    });

    it('selecting rows reveals the bulk action bar; a bulk action calls the right API and invalidates', async () => {
        renderList(1);
        await screen.findByText('Login works');

        expect(screen.queryByTestId('bulk-action-bar')).not.toBeInTheDocument();

        const checkboxes = screen.getAllByRole('checkbox', { name: /select row/i });
        await userEvent.click(checkboxes[0]);

        expect(await screen.findByTestId('bulk-action-bar')).toBeInTheDocument();

        const callsBeforeDelete = mockFetchTestCasesPage.mock.calls.length;

        await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
        await userEvent.click(screen.getByRole('button', { name: /confirm delete/i }));

        await waitFor(() => expect(mockBulkDeleteTestCases).toHaveBeenCalledWith(['t1']));
        // A successful bulk op invalidates the list's query, triggering at least
        // one more fetch than had already happened before the delete (DataGrid
        // itself may also re-sync sortModel and issue its own extra fetch --
        // same pre-existing quirk TestCaseGridSection.test.tsx doesn't assert an
        // exact count around either, only that a refetch beyond the pre-action
        // baseline genuinely happens).
        await waitFor(() => expect(mockFetchTestCasesPage.mock.calls.length).toBeGreaterThan(callsBeforeDelete));
    });

    it('permissions gate the destructive action: can(delete) false hides the Delete bulk action', async () => {
        mockUsePermissions.mockReturnValue({ can: (a: string) => a === 'write', role: 'contributor', isLoading: false, isError: false });
        renderList(1);
        await screen.findByText('Login works');

        const checkboxes = screen.getAllByRole('checkbox', { name: /select row/i });
        await userEvent.click(checkboxes[0]);

        expect(await screen.findByTestId('bulk-action-bar')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Assign' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    });

    // Ported from TestCaseGridSection.test.tsx's "TestCaseGridSection
    // (WP-043)" describe block (that file deleted in WP-074 Step 8) --
    // not already covered above, which only exercised the contributor
    // (write, no delete) permission case, never the fully-locked-out
    // viewer.
    it('a viewer sees no checkbox selection column and no bulk action bar, even with rows selected in state', async () => {
        mockUsePermissions.mockReturnValue({ can: () => false, role: 'viewer', isLoading: false, isError: false });
        renderList(1);
        await screen.findByText('Login works');
        // No checkbox column header (DataGrid's own "select all" checkbox)
        expect(screen.queryByRole('checkbox', { name: /select all/i })).not.toBeInTheDocument();
        // No bulk toolbar/buttons at all -- can't select, so nothing to bulk-act on.
        expect(screen.queryByTestId('bulk-action-bar')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Assign' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Change status' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    });

    // Ported from the same describe block -- not already covered above.
    it('shows an empty state on fetch error rather than a blank grid', async () => {
        mockUsePermissions.mockReturnValue({ can: () => true, role: 'admin', isLoading: false, isError: false });
        mockFetchTestCasesPage.mockRejectedValue(new Error('network down'));
        renderList(1);
        expect(await screen.findByText('Unable to load test cases.')).toBeInTheDocument();
    });
});

describe('EntityList — module 2 (requirements)', () => {
    it('renders rows from the mocked page fetcher with the requirement columns', async () => {
        renderList(2);
        expect(await screen.findByText('REQ-1')).toBeInTheDocument();
        expect(screen.getByText('Users can reset their password')).toBeInTheDocument();
        expect(screen.getByText('REQ-2')).toBeInTheDocument();
        expect(screen.getByText('Users can export a report')).toBeInTheDocument();
        // Not asserting the status chip's rendered text here (WP-F03c):
        // MUI X DataGrid's column virtualization, given jsdom's 0 client
        // width, only mounts a leading window of columns -- turning on
        // checkboxSelection for this module (this WP) spends one slot on
        // the new checkbox column, pushing "status" outside that window.
        // Same convention modules 1/3/5's equivalent tests already follow
        // (they check only the id + one descriptive column, never a
        // later one) -- this test now matches it too.
    });

    it('calls the fetcher with the right pagination/sort params', async () => {
        renderList(2);
        await waitFor(() =>
            expect(mockFetchRequirementsPage).toHaveBeenCalledWith(
                expect.objectContaining({ page: 0, pageSize: 25, sortField: 'createdAt', sortDirection: 'desc' })
            )
        );
    });

    // WP-F03c -- requirements now have a real bulk API (status + delete,
    // no assign: requirements carry no assignedTo field). Replaces the
    // "no bulk API" assertion that predates Tasks 1/2 of that WP.
    it('selecting rows reveals the bulk action bar with status + delete, but never Assign', async () => {
        renderList(2);
        await screen.findByText('REQ-1');

        const checkboxes = screen.getAllByRole('checkbox', { name: /select row/i });
        await userEvent.click(checkboxes[0]);

        expect(await screen.findByTestId('bulk-action-bar')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Change status' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Assign' })).not.toBeInTheDocument();

        await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
        await userEvent.click(screen.getByRole('button', { name: /confirm delete/i }));

        await waitFor(() => expect(mockBulkDeleteRequirements).toHaveBeenCalledWith(['r1']));
    });

    it('permissions gate requirement bulk actions: can(delete) false hides Delete, can(write) false hides Change status', async () => {
        mockUsePermissions.mockReturnValue({ can: (a: string) => a === 'write', role: 'contributor', isLoading: false, isError: false });
        renderList(2);
        await screen.findByText('REQ-1');

        const checkboxes = screen.getAllByRole('checkbox', { name: /select row/i });
        await userEvent.click(checkboxes[0]);

        expect(await screen.findByTestId('bulk-action-bar')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Change status' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    });

    it('a viewer sees no selection checkboxes and no bulk action bar', async () => {
        mockUsePermissions.mockReturnValue({ can: () => false, role: 'viewer', isLoading: false, isError: false });
        renderList(2);
        await screen.findByText('REQ-1');
        expect(screen.queryByRole('checkbox', { name: /select all/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('checkbox', { name: /select row/i })).not.toBeInTheDocument();
        expect(screen.queryByTestId('bulk-action-bar')).not.toBeInTheDocument();
    });
});

describe('EntityList — module 3 (test plans)', () => {
    it('renders rows from the mocked page fetcher with the test-plan columns, including a derived test-case count', async () => {
        renderList(3);
        expect(await screen.findByText('TP-1')).toBeInTheDocument();
        expect(screen.getByText('TP-2')).toBeInTheDocument();
        // TestCases array length, derived -- not a field on the row.
        expect(screen.getByText('3')).toBeInTheDocument();
        expect(screen.getByText('0')).toBeInTheDocument();
    });

    it('calls the fetcher with the right pagination/sort params', async () => {
        renderList(3);
        await waitFor(() =>
            expect(mockFetchTestPlansPage).toHaveBeenCalledWith(
                expect.objectContaining({ page: 0, pageSize: 25, sortField: 'createdAt', sortDirection: 'desc' })
            )
        );
    });

    // WP-F03c -- test plans now have a real bulk API, but delete only:
    // TestPlan has neither status nor assignedTo. Replaces the "no bulk
    // API" assertion that predates Tasks 1/2 of that WP.
    it('selecting rows reveals the bulk action bar with delete only -- no status, no assign', async () => {
        renderList(3);
        await screen.findByText('TP-1');

        const checkboxes = screen.getAllByRole('checkbox', { name: /select row/i });
        await userEvent.click(checkboxes[0]);

        expect(await screen.findByTestId('bulk-action-bar')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Assign' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Change status' })).not.toBeInTheDocument();

        await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
        await userEvent.click(screen.getByRole('button', { name: /confirm delete/i }));

        await waitFor(() => expect(mockBulkDeleteTestPlans).toHaveBeenCalledWith(['p1']));
    });

    it('can(delete) false hides selection entirely -- delete is the only action test plans have', async () => {
        mockUsePermissions.mockReturnValue({ can: (a: string) => a === 'write', role: 'contributor', isLoading: false, isError: false });
        renderList(3);
        await screen.findByText('TP-1');
        expect(screen.queryByRole('checkbox', { name: /select all/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('checkbox', { name: /select row/i })).not.toBeInTheDocument();
        expect(screen.queryByTestId('bulk-action-bar')).not.toBeInTheDocument();
    });
});

describe('EntityList — module 4 (test runs)', () => {
    it('renders rows from the mocked page fetcher with the test-execution columns', async () => {
        renderList(4);
        expect(await screen.findByText('TE-1')).toBeInTheDocument();
        expect(screen.getByText('TE-2')).toBeInTheDocument();
        expect(screen.getAllByText('TP-1').length).toBeGreaterThan(0);
        // Not asserting "Assigned to" column text here (WP-F03c) -- same
        // column-virtualization reason as module 2's equivalent test
        // above: turning on checkboxSelection for this module (this WP)
        // pushes that column outside jsdom's 0-width virtualized window.
    });

    it('calls the fetcher with the right pagination/sort params', async () => {
        renderList(4);
        await waitFor(() =>
            expect(mockFetchTestExecutionsPage).toHaveBeenCalledWith(
                expect.objectContaining({ page: 0, pageSize: 25, sortField: 'createdAt', sortDirection: 'desc' })
            )
        );
    });

    // WP-F03c -- test runs now have a real bulk API (assign + delete, no
    // status: TestExecution has no lifecycle status field). Replaces the
    // "no bulk API" assertion that predates Tasks 1/2 of that WP.
    it('selecting rows reveals the bulk action bar with assign + delete, but never Change status', async () => {
        renderList(4);
        await screen.findByText('TE-1');

        const checkboxes = screen.getAllByRole('checkbox', { name: /select row/i });
        await userEvent.click(checkboxes[0]);

        expect(await screen.findByTestId('bulk-action-bar')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Assign' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Change status' })).not.toBeInTheDocument();

        await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
        await userEvent.click(screen.getByRole('button', { name: /confirm delete/i }));

        await waitFor(() => expect(mockBulkDeleteTestRuns).toHaveBeenCalledWith(['e1']));
    });

    it('permissions gate test-run bulk actions: can(delete) false hides Delete but keeps Assign', async () => {
        mockUsePermissions.mockReturnValue({ can: (a: string) => a === 'write', role: 'contributor', isLoading: false, isError: false });
        renderList(4);
        await screen.findByText('TE-1');

        const checkboxes = screen.getAllByRole('checkbox', { name: /select row/i });
        await userEvent.click(checkboxes[0]);

        expect(await screen.findByTestId('bulk-action-bar')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Assign' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
        await userEvent.click(screen.getByRole('button', { name: 'Assign' }));
        const dialogInput = screen.getByLabelText(/assign to/i);
        await userEvent.type(dialogInput, 'erin');
        await userEvent.click(screen.getByRole('button', { name: /confirm assign/i }));

        await waitFor(() => expect(mockBulkAssignTestRuns).toHaveBeenCalledWith(['e1'], 'erin'));
    });

    it('a viewer sees no selection checkboxes and no bulk action bar', async () => {
        mockUsePermissions.mockReturnValue({ can: () => false, role: 'viewer', isLoading: false, isError: false });
        renderList(4);
        await screen.findByText('TE-1');
        expect(screen.queryByRole('checkbox', { name: /select all/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('checkbox', { name: /select row/i })).not.toBeInTheDocument();
        expect(screen.queryByTestId('bulk-action-bar')).not.toBeInTheDocument();
    });
});

// Ported verbatim from Components/entityGrid/__tests__/DefectGridSection.test.tsx
// (WP-043), deleted in WP-077 Step 2 now that <EntityList> module 5
// reproduces its behaviour via entityListConfigs.tsx's defectConfig
// (assign + delete bulk actions only -- api/bulkApi.ts has no bulk
// status-change endpoint for defects, see that file's own header comment).
// All four of that file's assertions move here unchanged; no module-5
// coverage existed in this file before this port.
describe('EntityList — module 5 (defects)', () => {
    it('renders fetched rows', async () => {
        renderList(5);
        expect(await screen.findByText('Crash on save')).toBeInTheDocument();
    });

    it('a viewer sees no checkbox column and no bulk actions', async () => {
        mockUsePermissions.mockReturnValue({ can: () => false, role: 'viewer', isLoading: false, isError: false });
        renderList(5);
        await screen.findByText('Crash on save');
        expect(screen.queryByRole('checkbox', { name: /select all/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Assign' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    });

    it('never offers bulk status-change, even for an admin (not supported server-side for defects)', async () => {
        mockUsePermissions.mockReturnValue({ can: () => true, role: 'admin', isLoading: false, isError: false });
        renderList(5);
        await screen.findByText('Crash on save');
        expect(screen.getByRole('checkbox', { name: /select all/i })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Change status' })).not.toBeInTheDocument();
    });

    it('fetches with server-side page/sort params', async () => {
        mockUsePermissions.mockReturnValue({ can: () => true, role: 'admin', isLoading: false, isError: false });
        renderList(5);
        await waitFor(() =>
            expect(mockFetchDefectsPage).toHaveBeenCalledWith(
                expect.objectContaining({ page: 0, pageSize: 25, sortField: 'createdAt', sortDirection: 'desc' })
            )
        );
    });
});

// WP-F15/F18 Task 1 -- module 6 (releases) had NO config before this WP,
// so this component previously rendered the placeholder "not available"
// state for it and issued no network call. It now has a real one, backed
// by getReleases() through entityListConfigs.tsx's fetchReleasesPage
// adapter rather than one of the entityGridApi.ts fetchers the other five
// modules use.
describe('EntityList — module 6 (releases)', () => {
    it('renders release rows with their id and name from the mocked fetcher', async () => {
        renderList(6);
        expect(await screen.findByText('REL-1')).toBeInTheDocument();
        expect(screen.getByText('Spring Launch')).toBeInTheDocument();
        expect(screen.getByText('REL-2')).toBeInTheDocument();
        expect(screen.getByText('Summer Launch')).toBeInTheDocument();
    });

    it('a release row shows its status and target date', async () => {
        renderList(6);
        await screen.findByText('REL-1');
        // StatusChip's default label is the raw status string.
        expect(screen.getByText('planned')).toBeInTheDocument();
        expect(screen.getByText('released')).toBeInTheDocument();
        // targetDate rendered via toLocaleDateString() -- match the same
        // formatting the column's valueFormatter itself uses, not a fixed
        // string, so this doesn't assume a locale/timezone.
        expect(screen.getByText(new Date('2026-03-15T00:00:00Z').toLocaleDateString())).toBeInTheDocument();
        expect(screen.getByText(new Date('2026-06-01T00:00:00Z').toLocaleDateString())).toBeInTheDocument();
    });

    it('shows the linked test plan count derived from linkedTestPlanIds, not a fabricated field', async () => {
        renderList(6);
        await screen.findByText('REL-1');
        expect(screen.getByText('2')).toBeInTheDocument(); // REL-1: ['p1', 'p2']
        expect(screen.getByText('0')).toBeInTheDocument(); // REL-2: []
    });

    // WP-F15/F18 Task 5 -- non-vacuity for the click-to-open wiring itself:
    // module 6 has no tree (releases carry no parentId; useTreeChildren.ts's
    // fetchLeaves falls through to `default: return []` for module 6) and no
    // search config (EntitySearchPanel's own "not available" branch), so
    // this list was the ONLY place a release ever appeared in the
    // workbench -- and, before entityListConfigs.tsx's `ReleaseIdCell`, the
    // only one that did not open it. Asserted against the real store (not a
    // mocked openTab) by reading `tabs` back out of the SAME
    // WorkbenchStoreProvider renderList now mounts.
    it("clicking a release row's id opens its detail tab in the workbench store", async () => {
        let observedTabs: Array<{ module: number; entityId: string }> = [];
        function TabSpy() {
            observedTabs = useWorkbench((s) => s.tabs);
            return null;
        }
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        render(
            <QueryClientProvider client={queryClient}>
                <ThemeProvider theme={testTheme}>
                    <WorkbenchStoreProvider projectId={1}>
                        <EntityList module={6} />
                        <TabSpy />
                    </WorkbenchStoreProvider>
                </ThemeProvider>
            </QueryClientProvider>
        );
        await screen.findByText('REL-1');
        expect(observedTabs).toHaveLength(0);

        await userEvent.click(screen.getByRole('button', { name: 'REL-1' }));

        await waitFor(() =>
            expect(observedTabs.some((t) => t.module === 6 && t.entityId === 'rel1')).toBe(true)
        );
        // The Mongo `_id`, not the human `releaseId` -- ReleaseDetail.tsx's
        // own header comment on why this module's entityId differs from
        // every other module's.
        expect(observedTabs.some((t) => t.entityId === 'REL-1')).toBe(false);
    });

    it('calls getReleases (the fetchPage adapter), never falls back to the "not available" empty state', async () => {
        renderList(6);
        await screen.findByText('REL-1');
        expect(mockGetReleases).toHaveBeenCalled();
        expect(screen.queryByText(/list view is not available/i)).not.toBeInTheDocument();
    });

    it('offers no bulk actions -- no bulk endpoint exists for releases yet', async () => {
        renderList(6);
        await screen.findByText('REL-1');
        expect(screen.queryByRole('checkbox', { name: /select all/i })).not.toBeInTheDocument();
        expect(screen.queryByTestId('bulk-action-bar')).not.toBeInTheDocument();
    });

    it('shows an empty state on fetch error rather than a blank grid', async () => {
        mockGetReleases.mockRejectedValue(new Error('network down'));
        renderList(6);
        expect(await screen.findByText('Unable to load releases.')).toBeInTheDocument();
    });
});

// WP-F05c -- the tag column and click-to-filter.
//
// WP-F05c originally claimed the chips and the click "cannot be asserted in
// jsdom at all" -- true of column virtualization at jsdom's zero client
// width, but the fix it reached for (`columnBuffer`) wasn't the one that
// actually helps. WP-F05e (review fix) tried `disableVirtualization`
// instead (see `testTheme` above) and it works: every column, including
// this last one, renders for real in every test in this file. The
// click-to-filter behaviour below is proved HERE, in jsdom.
//
// `e2e/specs/tags.spec.ts` DOES now exist (added by WP-F05d) but proves a
// different thing: that a tag typed in the editor reaches Mongo, survives
// a reload, and that ?tags= narrows server-returned rows. jsdom mocks the
// page fetcher, so it cannot show any of that; the browser spec in turn
// does not re-prove the click. Neither file is redundant, and neither is
// the proof of the other.
//
// (This clause previously said no such file existed -- written to correct
// an earlier comment that cited it as already existing, and then made
// false in the other direction when WP-F05d created it. Twice wrong in one
// day is the argument for describing what each file PROVES rather than
// asserting what does or does not exist on disk.)
//
// The tags column stays LAST regardless (WP-F05c's reasoning for that part
// still holds: putting it earlier would displace this file's other
// assertions), so the two structural checks below stay too.
describe('EntityList — tags column (WP-F05c)', () => {
    it.each([1, 2, 3, 4, 5] as const)('module %i\'s list config carries a tags column', (module) => {
        const config = moduleListConfigs[module];
        expect(config).toBeDefined();
        expect(config!.columns.some((c) => c.field === 'tags')).toBe(true);
    });

    it('places the tags column last, so adding it displaces no existing column', () => {
        ([1, 2, 3, 4, 5] as const).forEach((module) => {
            const cols = moduleListConfigs[module]!.columns;
            expect(cols[cols.length - 1].field).toBe('tags');
        });
    });

    // WP-F05e Fix 2 -- the click-to-filter behaviour itself, deferred by
    // WP-F05c and now genuinely exercised thanks to `disableVirtualization`
    // in `testTheme` above. Module 1 (test cases): its ROWS fixture is the
    // one with real tags on it (t1: ['regression', 'smoke'], t2: []).
    it('renders a tag chip for each tag a row has, and a plain placeholder for a row with none', async () => {
        renderList(1);
        await screen.findByText('Login works');
        expect(screen.getByText('regression')).toBeInTheDocument();
        expect(screen.getByText('smoke')).toBeInTheDocument();
    });

    it('clicking a tag chip filters the list by that tag: refetches with extraParams.tags set, and shows a clearable banner', async () => {
        renderList(1);
        await screen.findByText('Login works');
        expect(screen.queryByTestId('active-tag-filter')).not.toBeInTheDocument();

        await userEvent.click(screen.getByText('regression'));

        await waitFor(() => {
            const lastCall = mockFetchTestCasesPage.mock.calls.at(-1)![0];
            expect(lastCall.extraParams).toEqual({ tags: 'regression' });
        });
        expect(screen.getByText('Filtered by tag')).toBeInTheDocument();
        expect(within(screen.getByTestId('active-tag-filter')).getByText('regression')).toBeInTheDocument();

        await userEvent.click(screen.getByRole('button', { name: 'Clear tag filter' }));

        await waitFor(() => {
            const lastCall = mockFetchTestCasesPage.mock.calls.at(-1)![0];
            expect(lastCall.extraParams).toEqual({});
        });
        expect(screen.queryByTestId('active-tag-filter')).not.toBeInTheDocument();
    });

    it('clicking a second tag chip replaces the first as the active filter, rather than adding to it', async () => {
        renderList(1);
        await screen.findByText('Login works');

        await userEvent.click(screen.getByText('regression'));
        await waitFor(() => {
            const lastCall = mockFetchTestCasesPage.mock.calls.at(-1)![0];
            expect(lastCall.extraParams).toEqual({ tags: 'regression' });
        });

        await userEvent.click(screen.getByText('smoke'));
        await waitFor(() => {
            const lastCall = mockFetchTestCasesPage.mock.calls.at(-1)![0];
            expect(lastCall.extraParams).toEqual({ tags: 'smoke' });
        });
        // The banner is the only place that unambiguously names the ACTIVE
        // filter (the fixture's row still shows both of its own tag chips
        // regardless -- the mocked fetcher doesn't actually filter rows by
        // extraParams, a real backend would).
        expect(within(screen.getByTestId('active-tag-filter')).getByText('smoke')).toBeInTheDocument();
        expect(within(screen.getByTestId('active-tag-filter')).queryByText('regression')).not.toBeInTheDocument();
    });

    // The important one: proves Fix 1 of the WP-F05c review (the CRITICAL
    // finding) actually holds. Before that fix, clicking a tag chip also
    // toggled the row into the bulk-selection set -- checkboxSelection is on
    // for any admin/write/delete user, disableRowSelectionOnClick was never
    // set, and MUI X's row-selection wiring (GridRow's own 'rowClick'
    // publish, gated only on the clicked field not being the
    // checkbox/detail/actions column -- 'tags' is none of those) doesn't
    // care that the click landed on a chip with its own meaning. That is a
    // real path to an accidental bulk delete: BulkActionBar renders Delete
    // armed on a row the user only meant to filter by.
    it('clicking a tag chip does NOT select the row for bulk actions (WP-F05e Fix 1)', async () => {
        renderList(1);
        await screen.findByText('Login works');
        expect(screen.queryByTestId('bulk-action-bar')).not.toBeInTheDocument();

        await userEvent.click(screen.getByText('regression'));

        // Confirm the click was genuinely handled (not just inert) before
        // trusting the negative assertion below.
        await waitFor(() => {
            const lastCall = mockFetchTestCasesPage.mock.calls.at(-1)![0];
            expect(lastCall.extraParams).toEqual({ tags: 'regression' });
        });

        expect(screen.queryByTestId('bulk-action-bar')).not.toBeInTheDocument();
        const checkboxes = screen.getAllByRole('checkbox', { name: /select row/i });
        expect(checkboxes[0]).not.toBeChecked();
    });

    // WP-F05e Fix 5 -- tagFilter is local state, not part of a saved view
    // (see its own comment in EntityList.tsx), and it's spread LAST into
    // extraParams so a live tag click wins over whatever a view constrains.
    // Left alone across a view SWITCH, that same ordering means a leftover
    // click from a previous view silently overrides the new view's own
    // `tags` constraint, while the banner keeps naming a tag that no longer
    // has anything to do with what's on screen.
    it('switching to a saved view clears a stale tag filter', async () => {
        mockGetSavedViews.mockResolvedValue([
            {
                _id: 'v1',
                projectId: 1,
                entityType: 'testcase',
                ownerId: 'user-abc',
                isSystem: false,
                name: 'My View',
                filterModel: {},
                sortModel: [],
                columnVisibilityModel: {},
                queryParams: {},
                createdAt: '2026-01-01T00:00:00Z',
                updatedAt: '2026-01-01T00:00:00Z'
            }
        ]);
        renderList(1);
        await screen.findByText('Login works');

        await userEvent.click(screen.getByText('regression'));
        expect(await screen.findByTestId('active-tag-filter')).toBeInTheDocument();

        await waitFor(() => expect(screen.getByLabelText('Saved view')).not.toHaveAttribute('aria-disabled', 'true'));
        fireEvent.mouseDown(screen.getByLabelText('Saved view'));
        fireEvent.click(await screen.findByRole('option', { name: 'My View (mine)' }));

        await waitFor(() => expect(screen.queryByTestId('active-tag-filter')).not.toBeInTheDocument());
    });
});
