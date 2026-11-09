import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider, createTheme } from '@mui/material';
import theme from '../../Theme/theme';
import Reports from '../reports';
import { usePersonaReports } from '../dashboard/usePersonaReports';

// WP-F13 Task 3 — proves reports.tsx actually WIRES the traceability
// section in (imports it, passes it `coverage`/`traceability`, and renders
// it alongside the two existing manager-tier sections), rather than the
// section existing as dead code nothing on the page ever mounts. Same
// mocking posture as dashboard.test.tsx: usePersonaReports is mocked so the
// scenario is deterministic and synchronous.
//
// Fix round (final review) -- this suite used to assert
// `traceability-table`/`traceability-row-Req-1`/`traceability-row-Req-2`,
// all three retired by WP-F23 Task 2 when the on-screen table became a
// DataGrid (`traceability-table` -> `traceability-grid`; the bare per-row
// testid -> DataGrid's own native `[data-id]`, with only the
// `-cases-summary`/`-defects-summary`/`-detail-toggle` SUFFIXED variants
// surviving). `getByTestId` is an exact match, so none of the three
// survived the retirement, and this file went red without anyone touching
// it. Repaired here, not just swapped: asserting `traceability-grid`
// ALONE would pass trivially (that wrapper renders unconditionally, before
// any row does) -- a wiring guard that passes with zero rows on screen
// proves nothing. This now also asserts actual per-row content sourced
// from the mocked `traceability.rows` payload, so the test can only pass
// if reports.tsx really threads that data down into a live DataGrid.

jest.mock('../../Components/Layout/MainLayout', () => ({
    __esModule: true,
    default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock('../dashboard/usePersonaReports', () => ({
    usePersonaReports: jest.fn(),
}));

const mockUsePersonaReports = usePersonaReports as jest.Mock;

beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: jest.fn().mockImplementation((query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: jest.fn(),
            removeListener: jest.fn(),
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
            dispatchEvent: jest.fn(),
        })),
    });
});

const LOADED = <T,>(reportData: T) => ({
    data: { computedAt: '2026-01-01T00:00:00Z', stale: false, data: reportData },
    isLoading: false,
    isError: false,
    error: undefined,
});
const EMPTY_QUERY_RESULT = { data: undefined, isLoading: false, isError: false, error: undefined };

// WP-F23 Task 1/2's own a11y suites
// (traceabilityMatrixSection.a11y.test.tsx, ReleaseDetail.a11y.test.tsx)
// both had to add this same override: MUI X DataGrid's column
// virtualization, given jsdom's zero client width, mounts only a leading
// window of columns/rows. Without it, a `[data-id]` row lookup finds
// nothing in jsdom regardless of what the component actually rendered --
// this is what makes the retired-testid repair below a genuine guard
// rather than a query that happens to always come back empty.
const gridTestTheme = createTheme(theme, {
    components: {
        MuiDataGrid: {
            defaultProps: {
                disableVirtualization: true,
            },
        },
    },
});

const renderReports = () =>
    render(
        <ThemeProvider theme={gridTestTheme}>
            <MemoryRouter>
                <Reports />
            </MemoryRouter>
        </ThemeProvider>
    );

// @mui/x-data-grid stamps every row with `data-id={id}` (this section's own
// grid sets `getRowId` to return `reqId` directly) -- there is no Testing
// Library query for an arbitrary DOM attribute, so this is the sanctioned
// escape hatch (same helper shape as ReleaseDetail.a11y.test.tsx's own
// `getGridRowById`), isolated to one place rather than disabled at every
// call site.
function getGridRowById(container: HTMLElement, id: string): HTMLElement {
    // eslint-disable-next-line testing-library/no-node-access, testing-library/no-container
    const row = container.querySelector(`[data-id="${id}"]`);
    if (!row) {
        throw new Error(`No grid row found with data-id="${id}"`);
    }
    return row as HTMLElement;
}

describe('Reports page — traceability wiring', () => {
    // BREAKS IF: the <TraceabilityMatrixSection .../> element is removed
    // from reports.tsx's JSX (the import staying unused) -- this section's
    // own heading and segment tile would then never appear on the page.
    //
    // Non-vacuity: this no longer stops at the grid wrapper existing --
    // it looks up BOTH mocked rows by DataGrid's own `[data-id]` and reads
    // their real cell content (the Requirement Id text, the compact test
    // case/defect summaries, the detail toggle), which can only be present
    // if reports.tsx actually passed the mocked `traceability.rows` payload
    // all the way down into a live, rendered grid -- not a grid that
    // mounted with zero rows.
    it('renders the traceability matrix section, fed by the same usePersonaReports hook as the other sections', () => {
        mockUsePersonaReports.mockReturnValue({
            coverage: LOADED({
                label: 'Requirement coverage',
                total: 2,
                tested: 1,
                untested: 1,
                segments: { noTestsLinked: 1, notFullyVerified: 0, executedFailing: 0, executedPassing: 1 },
                breakdown: {
                    data: [
                        { id: 'noTestsLinked', label: 'No tests linked', value: 1 },
                        { id: 'notFullyVerified', label: 'Tests linked, not fully verified', value: 0 },
                        { id: 'executedFailing', label: 'Executed, failing', value: 0 },
                        { id: 'executedPassing', label: 'Executed, all passing', value: 1 },
                    ],
                },
            }),
            passRateTrend: EMPTY_QUERY_RESULT,
            defectSummary: EMPTY_QUERY_RESULT,
            planProgress: EMPTY_QUERY_RESULT,
            releaseReadiness: EMPTY_QUERY_RESULT,
            workload: EMPTY_QUERY_RESULT,
            traceability: LOADED({
                label: 'Requirement traceability',
                total: 2,
                rows: [
                    { reqId: 'Req-1', requirementSummary: 'A', testCases: [{ TestCaseId: 'TC-1', status: 'Pass' }], testCount: 1, defects: [], segment: 'executedPassing' },
                    { reqId: 'Req-2', requirementSummary: 'B', testCases: [], testCount: 0, defects: [], segment: 'noTestsLinked' },
                ],
            }),
        });

        const { container } = renderReports();

        expect(screen.getByTestId('traceability-section')).toBeInTheDocument();
        expect(screen.getByTestId('traceability-grid')).toBeInTheDocument();
        expect(screen.getByTestId('traceability-segment-noTestsLinked')).toHaveTextContent('1');

        // The retired bare `traceability-row-Req-1`/`traceability-row-Req-2`
        // testids no longer exist anywhere in the product -- DataGrid's own
        // `[data-id]` is the real, current row identity, and both rows are
        // located by it here.
        const req1Row = getGridRowById(container, 'Req-1');
        expect(req1Row).toHaveTextContent('Req-1');
        expect(within(req1Row).getByTestId('traceability-row-Req-1-cases-summary')).toHaveTextContent('1 case · all passing');
        expect(within(req1Row).getByTestId('traceability-row-Req-1-defects-summary')).toHaveTextContent('None');
        expect(within(req1Row).getByTestId('traceability-row-Req-1-detail-toggle')).toBeInTheDocument();

        const req2Row = getGridRowById(container, 'Req-2');
        expect(req2Row).toHaveTextContent('Req-2');
        expect(within(req2Row).getByTestId('traceability-row-Req-2-cases-summary')).toHaveTextContent('No tests linked');
        expect(within(req2Row).getByTestId('traceability-row-Req-2-defects-summary')).toHaveTextContent('None');
        expect(within(req2Row).getByTestId('traceability-row-Req-2-detail-toggle')).toBeInTheDocument();
    });
});
