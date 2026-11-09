import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material';
import { axe } from 'jest-axe';
import theme from '../../../Theme/theme';
import { TraceabilityMatrixSection } from '../sections/TraceabilityMatrixSection';
import { ReportState } from '../useReportState';
import { CoverageData, TraceabilityData, TraceabilityRow } from '../../../api/reportApi';
import { expectNoUnexpectedAxeViolations } from '../../../testUtils/a11y';

// WP-F13 Task 3 / WP-F23 Task 2 -- a11y coverage for the traceability
// matrix, same posture as dashboard.a11y.test.tsx: real, unmocked
// application code (StaleBanner, EmptyState, MUI/@mui/x-data-grid), axe-
// checked in each state a live report can actually produce.
//
// The non-vacuity guard this file's own header line promises: a grid that
// silently failed to mount (e.g. an early return before the <DataGrid>, or
// a `rows` prop that resolved to zero items because the wrong field was
// read) could still be axe-clean -- an empty grid has no accessibility
// violations to find. `findByTestId('traceability-grid')` PLUS asserting
// the exact number of DOM row roles present (header + N data rows) is what
// rules that out: it fails loudly if the grid never mounted, or mounted
// with the wrong row count, well before axe ever gets a say.

beforeEach(() => {
    // jsdom has no window.matchMedia; MUI's various hooks (and DataGrid
    // itself) probe it on mount (same stub as sections.test.tsx /
    // dashboard.a11y.test.tsx).
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

// @mui/x-data-grid virtualizes rows based on the container's MEASURED
// width/height -- both are 0 in jsdom, so without this only the header row
// ever appears regardless of row count. Same test-only escape hatch
// ReleaseDetail.test.tsx's own `gridTestTheme` uses (WP-F23 Task 1):
// production code never sets `disableVirtualization` anywhere.
const gridTestTheme = createTheme(theme, {
    components: {
        MuiDataGrid: {
            defaultProps: {
                disableVirtualization: true,
            },
        },
    },
});

const withTheme = (ui: React.ReactElement) => <ThemeProvider theme={gridTestTheme}>{ui}</ThemeProvider>;

function reportState<T>(overrides: Partial<ReportState<T>> = {}): ReportState<T> {
    return {
        data: undefined,
        isLoading: false,
        isUnavailable: false,
        errorMessage: null,
        stale: false,
        staleReason: undefined,
        computedAt: undefined,
        ...overrides,
    };
}

const coverage = reportState<CoverageData>({
    data: {
        label: 'Requirement coverage',
        total: 4,
        tested: 3,
        untested: 1,
        segments: { noTestsLinked: 1, notFullyVerified: 1, executedFailing: 1, executedPassing: 1 },
        breakdown: {
            data: [
                { id: 'noTestsLinked', label: 'No tests linked', value: 1 },
                { id: 'notFullyVerified', label: 'Tests linked, not fully verified', value: 1 },
                { id: 'executedFailing', label: 'Executed, failing', value: 1 },
                { id: 'executedPassing', label: 'Executed, all passing', value: 1 },
            ],
        },
    },
});

const rows: TraceabilityRow[] = [
    { reqId: 'Req-1', requirementSummary: 'A', testCases: [{ TestCaseId: 'TC-1', status: 'Pass' }], testCount: 1, defects: [], segment: 'executedPassing' },
    { reqId: 'Req-2', requirementSummary: 'B', testCases: [{ TestCaseId: 'TC-2', status: 'Fail' }], testCount: 1, defects: [{ defectId: 'Bug-1', summary: 'x', Status: 'Open', Severity: 'High' }], segment: 'executedFailing' },
    { reqId: 'Req-3', requirementSummary: 'C', testCases: [], testCount: 0, defects: [], segment: 'noTestsLinked' },
    { reqId: 'Req-4', requirementSummary: 'D', testCases: [{ TestCaseId: 'TC-3', status: 'InProgress' }], testCount: 1, defects: [], segment: 'notFullyVerified' },
];

const traceability = reportState<TraceabilityData>({
    data: { label: 'Requirement traceability', total: rows.length, rows, note: undefined },
});

describe('TraceabilityMatrixSection a11y', () => {
    it('axe clean with a populated matrix, and the grid genuinely mounted with every row', async () => {
        const { container } = render(withTheme(<TraceabilityMatrixSection coverage={coverage} traceability={traceability} />));

        // Non-vacuity guard: the grid exists AND has exactly 4 data rows
        // (5 DOM rows: 1 header + 4 data) the fixture defines -- not zero,
        // not a subset.
        const grid = await screen.findByTestId('traceability-grid');
        await waitFor(() => {
            expect(within(grid).getAllByRole('row')).toHaveLength(5);
        });

        // Same accepted DataGrid exception as ReleaseDetail.a11y.test.tsx's
        // own (testUtils/a11y.ts's header comment) -- @mui/x-data-grid@6.20.4
        // renders its pagination footer as a direct child of role="grid",
        // which axe's aria-required-children rule flags on every DataGrid in
        // this app, unrelated to anything added by this task. Every OTHER
        // violation still fails this test.
        expectNoUnexpectedAxeViolations(await axe(container));
    });

    it('axe clean with a detail panel expanded', async () => {
        const { container } = render(withTheme(<TraceabilityMatrixSection coverage={coverage} traceability={traceability} />));
        const grid = await screen.findByTestId('traceability-grid');
        await waitFor(() => {
            expect(within(grid).getAllByRole('row')).toHaveLength(5);
        });

        fireEvent.click(screen.getByTestId('traceability-row-Req-2-detail-toggle'));
        await screen.findByTestId('traceability-detail-panel-Req-2');

        expectNoUnexpectedAxeViolations(await axe(container));
    });

    it('axe clean for the true-empty (zero requirements) state', async () => {
        const emptyCoverage = reportState<CoverageData>({
            data: {
                label: 'Requirement coverage',
                total: 0,
                tested: 0,
                untested: 0,
                segments: { noTestsLinked: 0, notFullyVerified: 0, executedFailing: 0, executedPassing: 0 },
                note: 'no requirements defined in this project yet',
                breakdown: { data: [] },
            },
        });
        const emptyTraceability = reportState<TraceabilityData>({
            data: { label: 'Requirement traceability', total: 0, rows: [], note: 'no requirements defined in this project yet' },
        });
        const { container } = render(
            withTheme(<TraceabilityMatrixSection coverage={emptyCoverage} traceability={emptyTraceability} />)
        );
        await screen.findByTestId('traceability-empty');
        expect(screen.queryByTestId('traceability-grid')).not.toBeInTheDocument();
        expect(await axe(container)).toHaveNoViolations();
    });
});
