import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material';
import { axe } from 'jest-axe';
import theme from '../../../Theme/theme';
import { DatasetBindControl } from '../DatasetBindControl';
import { Dataset, TestCaseParameters, getDataset, getTestCaseParameters, listDatasets } from '../../../api/datasetApi';

// setupTests.ts extends `expect` with jest-axe's toHaveNoViolations()
// globally -- no local expect.extend() needed here.
//
// WP-F07a Task 4 -- axe coverage for the bind control, following the same
// "prove the real control mounted first" discipline as
// SharedStepPicker.a11y.test.tsx and DatasetManagerDialog.a11y.test.tsx:
// WP-F05's own a11y suite went vacuous by running axe over a control that
// never actually rendered its interactive element, and passed review
// before anyone noticed. The first test below exists solely to make that
// guarantee explicit and independently checkable for every state this
// control can be in.
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

function renderControl(datasetId: string | null = null) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={queryClient}>
            <ThemeProvider theme={theme}>
                <DatasetBindControl
                    projectId={7}
                    testCaseId="tc-mongo-1"
                    datasetId={datasetId}
                    canWrite
                    onBind={jest.fn()}
                    previewRowIndex={null}
                    onPreviewRowChange={jest.fn()}
                />
            </ThemeProvider>
        </QueryClientProvider>
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    mockListDatasets.mockResolvedValue([dataset()]);
    mockGetDataset.mockResolvedValue(dataset());
    mockGetTestCaseParameters.mockResolvedValue(parameters());
});

// THE non-vacuity guard: fails if the Dataset select is ever removed,
// renamed past this query, or fails to mount (e.g. silently gated closed
// for a draft with no testCaseId). A failure here means the axe
// assertions below it were about to run against a control that was never
// actually on the page.
test('non-vacuity guard: the control actually mounts the Dataset select', async () => {
    renderControl();
    expect(await screen.findByRole('combobox', { name: /^dataset$/i })).toBeInTheDocument();
});

test('the unbound state (just the Dataset select) is axe-clean', async () => {
    const { container } = renderControl();
    expect(await screen.findByRole('combobox', { name: /^dataset$/i })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
});

test('the bound state, with the preview-row select also mounted, is axe-clean', async () => {
    const { container } = renderControl('d1');
    expect(await screen.findByRole('combobox', { name: /^dataset$/i })).toBeInTheDocument();
    expect(await screen.findByRole('combobox', { name: /preview row/i })).toBeInTheDocument();
    await waitFor(() => expect(mockGetDataset).toHaveBeenCalled());

    expect(await axe(container)).toHaveNoViolations();
});

test('the dataset dropdown open with its options listed is axe-clean', async () => {
    const { container } = renderControl();
    const combo = await screen.findByRole('combobox', { name: /^dataset$/i });
    fireEvent.mouseDown(combo);
    expect(await screen.findByRole('option', { name: /DS-1/i })).toBeInTheDocument();

    expect(await axe(container)).toHaveNoViolations();
});

test('a missing-placeholder error alert is axe-clean', async () => {
    mockGetTestCaseParameters.mockResolvedValue(parameters({ placeholders: ['role', 'env'], missing: ['env'] }));
    const { container } = renderControl('d1');
    // Fix round 1 -- a bound dataset also renders the execution-caveat
    // disclosure (its own `role="alert"`, MUI's default; "alert" carries no
    // accessible name from content per the accname spec, so a `{name:}`
    // role filter can't disambiguate either), so this is located by its own
    // `data-testid` instead of a bare role query.
    expect(await screen.findByTestId('dataset-missing-placeholders-alert')).toHaveTextContent('{{env}}');

    expect(await axe(container)).toHaveNoViolations();
});
