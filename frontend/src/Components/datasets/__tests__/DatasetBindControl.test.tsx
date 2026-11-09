import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material';
import theme from '../../../Theme/theme';
import { DatasetBindControl } from '../DatasetBindControl';
import { Dataset, TestCaseParameters, getDataset, getTestCaseParameters, listDatasets } from '../../../api/datasetApi';

// WP-F07a Task 4 -- the bind side of the dataset feature: pick ONE dataset
// for this test case, and (once bound) pick a row to preview. Every
// network call is mocked, same convention as SharedStepPicker.test.tsx.
//
// R3 (the whole task): `onBind` must only ever be called with a bare
// datasetId string or null -- proven below by asserting the exact argument
// each call receives, never anything shaped like step text.
jest.mock('../../../api/datasetApi', () => ({
    listDatasets: jest.fn(),
    getDataset: jest.fn(),
    createDataset: jest.fn(),
    updateDataset: jest.fn(),
    deleteDataset: jest.fn(),
    getDatasetUsage: jest.fn(),
    getTestCaseParameters: jest.fn()
}));

const mockListDatasets = listDatasets as jest.Mock;
const mockGetDataset = getDataset as jest.Mock;
const mockGetTestCaseParameters = getTestCaseParameters as jest.Mock;

function dataset(overrides: Partial<Dataset> = {}): Dataset {
    return {
        _id: 'd1',
        id: 1,
        DatasetId: 'DS-1',
        projectId: 7,
        title: 'Login roles',
        columns: ['role'],
        rows: [['admin'], ['viewer']],
        ...overrides
    };
}

function parameters(overrides: Partial<TestCaseParameters> = {}): TestCaseParameters {
    return { placeholders: ['role'], columns: ['role'], missing: [], unused: [], ...overrides };
}

function renderControl(props: Partial<React.ComponentProps<typeof DatasetBindControl>> = {}) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onBind = jest.fn();
    const onPreviewRowChange = jest.fn();
    const utils = render(
        <QueryClientProvider client={queryClient}>
            <ThemeProvider theme={theme}>
                <DatasetBindControl
                    projectId={7}
                    testCaseId="tc-mongo-1"
                    datasetId={null}
                    canWrite
                    onBind={onBind}
                    previewRowIndex={null}
                    onPreviewRowChange={onPreviewRowChange}
                    {...props}
                />
            </ThemeProvider>
        </QueryClientProvider>
    );
    return { ...utils, onBind, onPreviewRowChange };
}

// MUI's Select renders its real listbox trigger as role="combobox";
// getByLabelText instead returns the hidden native input, which does not
// open the menu on mouseDown -- same lesson TestCaseDetail.parameterised
// .test.tsx's own selectPreviewRow() helper documents.
async function chooseOption(comboName: RegExp, optionName: RegExp) {
    const combo = await screen.findByRole('combobox', { name: comboName });
    fireEvent.mouseDown(combo);
    const option = await screen.findByRole('option', { name: optionName });
    fireEvent.click(option);
}

beforeEach(() => {
    jest.clearAllMocks();
    mockListDatasets.mockResolvedValue([dataset(), dataset({ _id: 'd2', DatasetId: 'DS-2', title: 'Checkout amounts', columns: ['amount'], rows: [] })]);
    mockGetDataset.mockResolvedValue(dataset());
    mockGetTestCaseParameters.mockResolvedValue(parameters());
});

test('renders nothing for a draft (no testCaseId yet) -- there is nothing to bind a dataset to', () => {
    const { container } = renderControl({ testCaseId: undefined });
    expect(container).toBeEmptyDOMElement();
});

test('lists datasets from the library in the bind dropdown', async () => {
    renderControl();
    const combo = await screen.findByRole('combobox', { name: /^dataset$/i });
    fireEvent.mouseDown(combo);
    expect(await screen.findByRole('option', { name: /DS-1.*Login roles/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /DS-2.*Checkout amounts/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /no dataset bound/i })).toBeInTheDocument();
});

test('choosing a dataset calls onBind with its bare id, not an object or step text', async () => {
    const { onBind } = renderControl();
    await chooseOption(/^dataset$/i, /DS-1.*Login roles/);
    expect(onBind).toHaveBeenCalledWith('d1');
    expect(onBind).toHaveBeenCalledTimes(1);
});

test('choosing "No dataset bound" calls onBind with null (unbind)', async () => {
    const { onBind } = renderControl({ datasetId: 'd1' });
    await chooseOption(/^dataset$/i, /no dataset bound/i);
    expect(onBind).toHaveBeenCalledWith(null);
});

test('the bind dropdown is disabled without can(\'write\')', async () => {
    renderControl({ canWrite: false });
    const combo = await screen.findByRole('combobox', { name: /^dataset$/i });
    expect(combo).toHaveAttribute('aria-disabled', 'true');
});

test('once a dataset is bound, its rows populate the preview-row selector', async () => {
    renderControl({ datasetId: 'd1' });
    await waitFor(() => expect(mockGetDataset).toHaveBeenCalledWith('d1'));
    const combo = await screen.findByRole('combobox', { name: /preview row/i });
    await waitFor(() => expect(combo).not.toHaveAttribute('aria-disabled', 'true'));
    fireEvent.mouseDown(combo);
    expect(await screen.findByRole('option', { name: /row 1.*admin/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /row 2.*viewer/i })).toBeInTheDocument();
    // WP-F07b Task 4 -- this alert used to disclose that a run executed a
    // bound case once, with no per-row results (true under F07a, false
    // now that TestRunDetail renders one row per dataset row). Amended,
    // not removed: it still needs to say the preview-row picker above is
    // display-only and does not limit which rows actually run.
    expect(screen.getByTestId('dataset-execution-caveat')).toBeInTheDocument();
    expect(screen.getByTestId('dataset-execution-caveat')).toHaveTextContent(/one result row per row/i);
    expect(screen.getByTestId('dataset-execution-caveat')).not.toHaveTextContent(/not available yet/i);
});

test('no preview-row selector at all until a dataset is bound', () => {
    renderControl({ datasetId: null });
    expect(screen.queryByRole('combobox', { name: /preview row/i })).not.toBeInTheDocument();
});

test('choosing a row calls onPreviewRowChange with its numeric index', async () => {
    const { onPreviewRowChange } = renderControl({ datasetId: 'd1' });
    await waitFor(() => expect(mockGetDataset).toHaveBeenCalledWith('d1'));
    const combo = await screen.findByRole('combobox', { name: /preview row/i });
    await waitFor(() => expect(combo).not.toHaveAttribute('aria-disabled', 'true'));
    fireEvent.mouseDown(combo);
    fireEvent.click(await screen.findByRole('option', { name: /row 2.*viewer/i }));
    expect(onPreviewRowChange).toHaveBeenCalledWith(1);
});

test('clearing the preview row calls onPreviewRowChange with null, never an empty string', async () => {
    const { onPreviewRowChange } = renderControl({ datasetId: 'd1', previewRowIndex: 0 });
    await waitFor(() => expect(mockGetDataset).toHaveBeenCalledWith('d1'));
    const combo = await screen.findByRole('combobox', { name: /preview row/i });
    await waitFor(() => expect(combo).not.toHaveAttribute('aria-disabled', 'true'));
    fireEvent.mouseDown(combo);
    fireEvent.click(await screen.findByRole('option', { name: /no preview/i }));
    expect(onPreviewRowChange).toHaveBeenCalledWith(null);
});

// The error case this task's brief names explicitly: a placeholder with no
// matching column must be surfaced to the author, not swallowed.
test('surfaces a missing placeholder (no matching column) as an error', async () => {
    mockGetTestCaseParameters.mockResolvedValue(parameters({ placeholders: ['role', 'env'], missing: ['env'] }));
    renderControl({ datasetId: 'd1' });
    // Fix round 1 -- a bound dataset also renders the execution-caveat
    // disclosure (its own `role="alert"`, MUI's default; "alert" carries no
    // accessible name from content per the accname spec, so a `{name:}`
    // role filter can't disambiguate either), so this is located by its own
    // `data-testid` instead of a bare role query.
    const alert = await screen.findByTestId('dataset-missing-placeholders-alert');
    expect(alert).toHaveTextContent(/1 placeholder/i);
    expect(alert).toHaveTextContent('{{env}}');
});

test('does not show a missing-placeholder warning when every placeholder has a column', async () => {
    renderControl({ datasetId: 'd1' });
    await waitFor(() => expect(mockGetTestCaseParameters).toHaveBeenCalled());
    expect(screen.queryByText(/no matching column/i)).not.toBeInTheDocument();
});

test('surfaces an unused column as a lower-severity warning, not swallowed either', async () => {
    mockGetTestCaseParameters.mockResolvedValue(parameters({ columns: ['role', 'region'], unused: ['region'] }));
    renderControl({ datasetId: 'd1' });
    expect(await screen.findByText(/unused by any placeholder/i)).toBeInTheDocument();
});
