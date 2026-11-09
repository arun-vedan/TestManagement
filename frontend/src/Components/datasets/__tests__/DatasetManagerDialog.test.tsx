import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material';
import theme from '../../../Theme/theme';
import { DatasetManagerDialog } from '../DatasetManagerDialog';
import { Dataset, createDataset, deleteDataset, listDatasets, updateDataset } from '../../../api/datasetApi';
import usePermissions from '../../../Hooks/usePermissions';

// WP-F07a Task 4 -- the dataset library's own CRUD surface, following
// SharedStepManagerDialog.test.tsx (WP-F06 Task 5) closely: same
// create/edit/delete coverage shape, same 409-with-usage-payload
// assertion, same permission-gating split (write for create/edit, delete
// for delete, a contributor has the former but not the latter).
//
// Deliberately NOT `{ ...jest.requireActual(...), ... }` -- requireActual
// here would run datasetApi.ts for real, pulling in axios.tsx ->
// src/keycloak.js -> the ESM-only `keycloak-js` package, which Jest's
// default transform cannot parse. Same reasoning as
// SharedStepManagerDialog.test.tsx's own header comment, confirmed by the
// same FieldsPanel.test.tsx failure that comment cites.
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
const mockCreateDataset = createDataset as jest.Mock;
const mockUpdateDataset = updateDataset as jest.Mock;
const mockDeleteDataset = deleteDataset as jest.Mock;
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

const DATASETS: Dataset[] = [dataset(), dataset({ _id: 'd3', id: 3, DatasetId: 'DS-3', title: 'Checkout amounts', columns: ['amount'], rows: [] })];

function renderManager() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onClose = jest.fn();
    const utils = render(
        <QueryClientProvider client={queryClient}>
            <ThemeProvider theme={theme}>
                <DatasetManagerDialog projectId={7} open onClose={onClose} />
            </ThemeProvider>
        </QueryClientProvider>
    );
    return { ...utils, onClose };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockUsePermissions.mockReturnValue({ role: 'admin', isLoading: false, isError: false, can: () => true });
    mockListDatasets.mockResolvedValue(DATASETS);
});

test('lists datasets from the library', async () => {
    renderManager();
    expect(await screen.findByText(/Login roles/)).toBeInTheDocument();
    expect(screen.getByText(/Checkout amounts/)).toBeInTheDocument();
});

test('creates a dataset with a column and a row from the dialog', async () => {
    mockCreateDataset.mockResolvedValue(dataset({ _id: 'd9', id: 9, DatasetId: 'DS-9', title: 'New dataset' }));
    renderManager();
    expect(await screen.findByText(/Login roles/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /new dataset/i }));
    const dialog = screen.getByRole('dialog', { name: /new dataset/i });
    fireEvent.change(within(dialog).getByLabelText(/^title$/i), { target: { value: 'New dataset' } });
    fireEvent.change(within(dialog).getByLabelText(/^column 1$/i), { target: { value: 'env' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /add row/i }));
    fireEvent.change(within(dialog).getByLabelText(/row 1, env/i), { target: { value: 'prod' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(mockCreateDataset).toHaveBeenCalled());
    expect(mockCreateDataset.mock.calls[0][0]).toEqual(
        expect.objectContaining({
            title: 'New dataset',
            columns: ['env'],
            rows: [['prod']]
        })
    );
});

// A column add/remove keeps every row's length in lockstep -- Dataset.js's
// own ragged-row guard would otherwise reject exactly this shape on save.
test('adding a column appends an empty value slot to every existing row, not a ragged one', async () => {
    mockCreateDataset.mockResolvedValue(dataset());
    renderManager();
    expect(await screen.findByText(/Login roles/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /new dataset/i }));
    const dialog = screen.getByRole('dialog', { name: /new dataset/i });
    fireEvent.change(within(dialog).getByLabelText(/^title$/i), { target: { value: 'Roles' } });
    fireEvent.change(within(dialog).getByLabelText(/^column 1$/i), { target: { value: 'role' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /add row/i }));
    fireEvent.change(within(dialog).getByLabelText(/row 1, role/i), { target: { value: 'admin' } });

    fireEvent.click(within(dialog).getByRole('button', { name: /add column/i }));
    fireEvent.change(within(dialog).getByLabelText(/^column 2$/i), { target: { value: 'env' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(mockCreateDataset).toHaveBeenCalled());
    expect(mockCreateDataset.mock.calls[0][0]).toEqual(
        expect.objectContaining({
            columns: ['role', 'env'],
            rows: [['admin', '']]
        })
    );
});

test('editing a dataset and saving calls updateDataset with its id', async () => {
    mockUpdateDataset.mockResolvedValue(dataset({ title: 'Login roles v2' }));
    renderManager();
    expect(await screen.findByText(/Login roles/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /edit login roles/i }));
    const dialog = screen.getByRole('dialog', { name: /edit dataset/i });
    fireEvent.change(within(dialog).getByLabelText(/^title$/i), { target: { value: 'Login roles v2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));

    await waitFor(() =>
        expect(mockUpdateDataset).toHaveBeenCalledWith('d1', expect.objectContaining({ title: 'Login roles v2' }))
    );
});

test('create/edit controls are hidden without can(\'write\')', async () => {
    mockUsePermissions.mockReturnValue({ role: 'viewer', isLoading: false, isError: false, can: (a: string) => a === 'read' });
    renderManager();

    expect(await screen.findByText(/Login roles/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new dataset/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit login roles/i })).not.toBeInTheDocument();
});

test('the delete control is hidden without can(\'delete\'), even when write is allowed (a contributor)', async () => {
    mockUsePermissions.mockReturnValue({
        role: 'contributor',
        isLoading: false,
        isError: false,
        can: (a: string) => a === 'read' || a === 'write'
    });
    renderManager();

    expect(await screen.findByText(/Login roles/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit login roles/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete login roles/i })).not.toBeInTheDocument();
});

test('a successful delete calls deleteDataset with its id and closes the confirmation', async () => {
    mockDeleteDataset.mockResolvedValue(undefined);
    renderManager();
    expect(await screen.findByText(/Checkout amounts/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /delete checkout amounts/i }));
    const confirmDialog = await screen.findByRole('dialog', { name: /delete checkout amounts/i });
    fireEvent.click(within(confirmDialog).getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(mockDeleteDataset).toHaveBeenCalledWith('d3'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /delete checkout amounts/i })).not.toBeInTheDocument());
});

// The test that matters most, per this WP's own brief: a dataset still
// bound to a test case is refused with HTTP 409 and a
// `{ error, data: { count, testCases } }` body (api/datasetApi.ts's
// deleteDataset header comment, controllers/dataset.js's deleteDataset).
// Swallowing that down to a generic "delete failed" would throw away the
// one thing the backend went out of its way to compute -- WHICH test
// cases are in the way.
test('shows which test cases are blocking a delete when the server refuses', async () => {
    mockDeleteDataset.mockRejectedValue({
        response: {
            status: 409,
            data: {
                error: 'DS-3 is used by 2 test case(s) and cannot be deleted',
                data: { count: 2, testCases: [{ TestCaseId: 'TC-1' }, { TestCaseId: 'TC-9' }] }
            }
        }
    });
    renderManager();
    expect(await screen.findByText(/Checkout amounts/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /delete checkout amounts/i }));
    const confirmDialog = await screen.findByRole('dialog', { name: /delete checkout amounts/i });
    fireEvent.click(within(confirmDialog).getByRole('button', { name: /^delete$/i }));

    expect(await screen.findByText(/TC-1/)).toBeInTheDocument();
    expect(await screen.findByText(/TC-9/)).toBeInTheDocument();
    expect(await screen.findByText(/used by 2 test case/i)).toBeInTheDocument();
    // A refused delete is not treated as a success -- the confirmation
    // dialog stays open so the user can see why, instead of silently
    // closing as if nothing happened.
    expect(screen.getByRole('dialog', { name: /delete checkout amounts/i })).toBeInTheDocument();
});
