import { fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material';
import { axe } from 'jest-axe';
import theme from '../../../Theme/theme';
import { DatasetManagerDialog } from '../DatasetManagerDialog';
import { Dataset, listDatasets } from '../../../api/datasetApi';
import usePermissions from '../../../Hooks/usePermissions';

// setupTests.ts extends `expect` with jest-axe's toHaveNoViolations()
// globally -- no local expect.extend() needed here.
//
// WP-F07a Task 4 -- axe coverage for the dataset library's CRUD dialog,
// following SharedStepManagerDialog.a11y.test.tsx's own split of
// functional vs a11y assertions, and its "table view / empty state /
// create dialog / delete confirmation" coverage shape.
//
// Same lesson as SharedStepManagerDialog.a11y.test.tsx's header comment:
// WP-F05's own a11y suite went vacuous by running axe over a dialog that
// never mounted its real interactive element. Every axe assertion below
// is preceded by a screen.find*/getBy* proving the actual control under
// test (New dataset / Edit / Delete / the columns-and-rows editor) is in
// the DOM first -- and the very first test in this file exists solely to
// make that guarantee explicit and independently checkable.
//
// No requireActual on datasetApi -- see DatasetManagerDialog.test.tsx's
// header comment for why: it would run the real module, which imports
// axios.tsx -> src/keycloak.js -> the ESM-only `keycloak-js` package,
// which Jest's default transform cannot parse.
jest.mock('../../../api/datasetApi', () => ({
    listDatasets: jest.fn(),
    getDataset: jest.fn(),
    createDataset: jest.fn(),
    updateDataset: jest.fn(),
    deleteDataset: jest.fn(),
    getDatasetUsage: jest.fn(),
    getTestCaseParameters: jest.fn()
}));
jest.mock('../../../Hooks/usePermissions', () => ({ __esModule: true, default: jest.fn() }));

const mockListDatasets = listDatasets as jest.Mock;
const mockUsePermissions = usePermissions as unknown as jest.Mock;

function dataset(overrides: Partial<Dataset> = {}): Dataset {
    return {
        _id: 'd1',
        id: 1,
        DatasetId: 'DS-1',
        projectId: 7,
        title: 'Login roles',
        description: 'Roles used to log in',
        columns: ['role'],
        rows: [['admin'], ['viewer']],
        ...overrides
    };
}

const DATASETS: Dataset[] = [dataset()];

function renderManager() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={queryClient}>
            <ThemeProvider theme={theme}>
                <DatasetManagerDialog projectId={7} open onClose={jest.fn()} />
            </ThemeProvider>
        </QueryClientProvider>
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    mockUsePermissions.mockReturnValue({ role: 'admin', isLoading: false, isError: false, can: () => true });
    mockListDatasets.mockResolvedValue(DATASETS);
});

// THE non-vacuity guard: fails if New/Edit/Delete are ever removed,
// renamed past these queries, or fail to mount (e.g. silently gated
// closed by a permission check). A failure here means the axe assertions
// below it were about to run against controls that were never actually on
// the page.
test('non-vacuity guard: the manager actually mounts New/Edit/Delete controls', async () => {
    renderManager();
    expect(await screen.findByRole('button', { name: /new dataset/i })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /edit login roles/i })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /delete login roles/i })).toBeInTheDocument();
});

test('the list view (with data and a mounted New button) is axe-clean', async () => {
    const { container } = renderManager();
    expect(await screen.findByRole('button', { name: /new dataset/i })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
});

test('the empty-library state is axe-clean', async () => {
    mockListDatasets.mockResolvedValue([]);
    const { container } = renderManager();
    expect(await screen.findByText(/no datasets defined/i)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
});

test('the create dialog, with its columns-and-rows editor mounted, is axe-clean', async () => {
    const { container } = renderManager();
    expect(await screen.findByRole('button', { name: /new dataset/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /new dataset/i }));
    const dialog = screen.getByRole('dialog', { name: /new dataset/i });
    expect(within(dialog).getByLabelText(/^column 1$/i)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: /add row/i }));
    expect(within(dialog).getByRole('button', { name: /remove row 1/i })).toBeInTheDocument();

    expect(await axe(container)).toHaveNoViolations();
});

test('the delete confirmation dialog is axe-clean', async () => {
    const { container } = renderManager();
    expect(await screen.findByRole('button', { name: /delete login roles/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /delete login roles/i }));
    expect(await screen.findByRole('dialog', { name: /delete login roles/i })).toBeInTheDocument();

    expect(await axe(container)).toHaveNoViolations();
});
