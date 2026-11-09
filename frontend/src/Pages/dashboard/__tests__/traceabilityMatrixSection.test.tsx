import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { ThemeProvider, createTheme } from '@mui/material';
import theme from '../../../Theme/theme';
import {
    TraceabilityMatrixSection,
    buildSegmentLabelLookup,
    buildTraceabilityColumns,
    formatDefects,
    formatTestCases,
    isUnresolvedDefectStatus,
    segmentPriorityRank,
    summarizeDefects,
    summarizeTestCases,
    testCaseWorstRank,
    truncationNotice,
} from '../sections/TraceabilityMatrixSection';
import { MAX_EXPORT_ROWS, rowsToCsv } from '../../../api/exportApi';
import { ReportState } from '../useReportState';
import { CoverageData, DonutSlice, TraceabilityData, TraceabilityRow, TraceabilitySegment } from '../../../api/reportApi';

// WP-F23 Task 2's own R4 test needs to observe what the component actually
// hands `downloadCsv`, without a real browser download firing in jsdom.
// Everything else from exportApi is the REAL module (rowsToCsv,
// MAX_EXPORT_ROWS, buildExportFilename) -- only downloadCsv is replaced, so
// the component under test still runs its real CSV-building code path.
jest.mock('../../../api/exportApi', () => ({
    ...jest.requireActual('../../../api/exportApi'),
    downloadCsv: jest.fn(),
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { downloadCsv } = jest.requireMock('../../../api/exportApi') as { downloadCsv: jest.Mock };

// The "real" four labels computeCoverage sends today -- used wherever a
// test needs a plausible breakdown array but isn't itself testing label
// wording. Kept distinct from the `SEGMENT_LABELS`-shaped constant this
// suite used to import from the component (fix round 1 removed that
// constant entirely): this is test-fixture data, not a second copy of
// production label strings the component depends on.
const STANDARD_BREAKDOWN: DonutSlice[] = [
    { id: 'noTestsLinked', label: 'No tests linked', value: 0 },
    { id: 'notFullyVerified', label: 'Tests linked, not fully verified', value: 0 },
    { id: 'executedFailing', label: 'Executed, failing', value: 0 },
    { id: 'executedPassing', label: 'Executed, all passing', value: 0 },
];

// WP-F13 Task 3 / WP-F23 Task 2 -- direct, props-driven tests of the
// traceability matrix section (same posture as sections.test.tsx's own
// header comment: a ReportState<T> is built by hand for every state a live
// report can produce, rather than mocking react-query). `coverage` backs
// the four-segment summary; `traceability` backs the row grid + CSV
// export -- see the component's own header comment for why they're two
// separate props instead of one merged shape.

// @mui/x-data-grid virtualizes rows based on the container's MEASURED
// width/height -- both are 0 in jsdom (no real layout engine), so without
// this, only the header row (and sometimes nothing) ever appears in the
// DOM regardless of how many rows are passed in. Same test-only escape
// hatch ReleaseDetail.test.tsx's own `gridTestTheme` uses (WP-F23 Task 1):
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

function coverageWith(segments: CoverageData['segments'], total: number): ReportState<CoverageData> {
    return reportState<CoverageData>({
        data: {
            label: 'Requirement coverage',
            total,
            tested: total - segments.noTestsLinked,
            untested: segments.noTestsLinked,
            segments,
            breakdown: {
                data: [
                    { id: 'noTestsLinked', label: 'No tests linked', value: segments.noTestsLinked },
                    { id: 'notFullyVerified', label: 'Tests linked, not fully verified', value: segments.notFullyVerified },
                    { id: 'executedFailing', label: 'Executed, failing', value: segments.executedFailing },
                    { id: 'executedPassing', label: 'Executed, all passing', value: segments.executedPassing },
                ],
            },
        },
    });
}

function traceabilityWith(rows: TraceabilityRow[], total = rows.length): ReportState<TraceabilityData> {
    return reportState<TraceabilityData>({
        data: { label: 'Requirement traceability', total, rows, note: total === 0 ? 'no requirements defined in this project yet' : undefined },
    });
}

const emptyCoverage = () => coverageWith({ noTestsLinked: 0, notFullyVerified: 0, executedFailing: 0, executedPassing: 0 }, 0);

// Same shape as ReleaseDetail.test.tsx's own helper (WP-F23 Task 1) --
// `@mui/x-data-grid` stamps every row's DOM node with `data-id="<rowId>"`
// (our own `getRowId={(row) => row.reqId}`), so a specific row is found by
// that native attribute rather than a bespoke per-row data-testid.
function getGridRowById(container: HTMLElement, id: string): HTMLElement {
    // eslint-disable-next-line testing-library/no-node-access, testing-library/no-container
    const row = container.querySelector(`[data-id="${id}"]`);
    if (!row) {
        throw new Error(`No grid row found with data-id="${id}"`);
    }
    return row as HTMLElement;
}

function makeRows(n: number): TraceabilityRow[] {
    return Array.from({ length: n }, (_, i) => {
        const num = String(i + 1).padStart(3, '0');
        return {
            reqId: `REQ-${num}`,
            requirementSummary: `Requirement ${num}`,
            testCases: [{ TestCaseId: `TC-${num}`, status: 'Pass' }],
            testCount: 1,
            defects: [],
            segment: 'executedPassing' as const,
        };
    });
}

beforeEach(() => {
    downloadCsv.mockClear();
});

describe('TraceabilityMatrixSection', () => {
    // BREAKS IF: the "of {total} requirement(s)" caption is deleted from a
    // segment tile (single line removed) -- the denominator text this test
    // queries for would no longer be in the document. Also non-vacuous
    // against a hardcoded-counts regression: these values (7/1/6/2/16) are
    // deliberately not all-zero and not equal to each other, so a
    // component that rendered a fixed placeholder object instead of
    // `coverage.data.breakdown.data` would fail every assertion below, not
    // pass by coincidence.
    it('renders the four segments as four labelled facts, each with its own denominator', () => {
        const coverage = coverageWith({ noTestsLinked: 7, notFullyVerified: 1, executedFailing: 6, executedPassing: 2 }, 16);
        const traceability = traceabilityWith([]);
        render(withTheme(<TraceabilityMatrixSection coverage={coverage} traceability={traceability} />));

        const noTests = screen.getByTestId('traceability-segment-noTestsLinked');
        expect(within(noTests).getByText('7')).toBeInTheDocument();
        expect(within(noTests).getByText('No tests linked')).toBeInTheDocument();
        expect(within(noTests).getByText(/of 16 requirements/)).toBeInTheDocument();

        const notFully = screen.getByTestId('traceability-segment-notFullyVerified');
        expect(within(notFully).getByText('1')).toBeInTheDocument();
        expect(within(notFully).getByText('Tests linked, not fully verified')).toBeInTheDocument();

        const failing = screen.getByTestId('traceability-segment-executedFailing');
        expect(within(failing).getByText('6')).toBeInTheDocument();
        expect(within(failing).getByText('Executed, failing')).toBeInTheDocument();

        const passing = screen.getByTestId('traceability-segment-executedPassing');
        expect(within(passing).getByText('2')).toBeInTheDocument();
        expect(within(passing).getByText('Executed, all passing')).toBeInTheDocument();
    });

    // BREAKS IF: `total === 0` branch is bypassed (e.g. changed to `false`)
    // -- the grid would then render with zero rows instead of this honest
    // empty state, and the export button/segment note text would be gone.
    it('renders an honest empty state for a project with no requirements, not a bare empty grid', () => {
        render(
            withTheme(
                <TraceabilityMatrixSection coverage={emptyCoverage()} traceability={traceabilityWith([], 0)} />
            )
        );
        expect(screen.getByTestId('traceability-empty')).toHaveTextContent(/no requirements defined in this project yet/i);
        expect(screen.queryByTestId('traceability-grid')).not.toBeInTheDocument();
        expect(screen.queryByTestId('traceability-export-button')).not.toBeInTheDocument();
    });

    describe('at scale (WP-F23 Task 2)', () => {
        // Non-vacuity (this task's own brief): React renders every child on
        // a fresh mount, so merely finding REQ-001 on screen would pass
        // even against a broken, unpaged implementation that rendered all
        // 60 rows. What actually distinguishes "paged" from "not paged" is
        // the TOTAL row count in the DOM -- DataGrid's own header row plus
        // exactly one row per rendered item.
        //
        // Single-line break: bumping `pageSize: 25` to `pageSize: 100` in
        // the DataGrid's `initialState` (TraceabilityMatrixSection.tsx)
        // makes this assert 61 rows, not 26, and REQ-060 would be found.
        it('60 requirements render one page of 25 in the grid, and state the true total (R1/R3)', async () => {
            const rows = makeRows(60);
            render(withTheme(<TraceabilityMatrixSection coverage={emptyCoverage()} traceability={traceabilityWith(rows)} />));

            expect(screen.getByText('60 requirements')).toBeInTheDocument();

            const grid = screen.getByTestId('traceability-grid');
            await waitFor(() => {
                expect(within(grid).getAllByRole('row')).toHaveLength(26);
            });
            expect(within(grid).getByText('REQ-001')).toBeInTheDocument();
            expect(within(grid).queryByText('REQ-060')).not.toBeInTheDocument();
        });

        // R2 -- a failing row must outrank a passing one with NO user
        // interaction. Deliberately reverse-alphabetical vs. the desired
        // order (Req-A is passing, Req-Z is failing): a fallback to plain
        // id/array order would put Req-A first, which is exactly the
        // regression this ordering is chosen to catch.
        //
        // Single-line break: swapping SEGMENT_PRIORITY's `executedFailing:
        // 0` for `executedFailing: 3` (or removing the `sorting: {...}`
        // initialState entry) inverts this order.
        it('sorts a failing row above a passing row by default, without the user touching the sort (R2)', async () => {
            const rows: TraceabilityRow[] = [
                { reqId: 'Req-A-passing', testCases: [{ TestCaseId: 'TC-1', status: 'Pass' }], testCount: 1, defects: [], segment: 'executedPassing' },
                { reqId: 'Req-Z-failing', testCases: [{ TestCaseId: 'TC-2', status: 'Fail' }], testCount: 1, defects: [], segment: 'executedFailing' },
            ];
            render(withTheme(<TraceabilityMatrixSection coverage={emptyCoverage()} traceability={traceabilityWith(rows)} />));

            const grid = screen.getByTestId('traceability-grid');
            await waitFor(() => expect(within(grid).getAllByRole('row')).toHaveLength(3));

            const dataRows = within(grid).getAllByRole('row').slice(1);
            expect(within(dataRows[0]).getByText('Req-Z-failing')).toBeInTheDocument();
            expect(within(dataRows[1]).getByText('Req-A-passing')).toBeInTheDocument();
        });

        // R2's exact ordering, end to end: executedFailing, then
        // notFullyVerified, then noTestsLinked, then executedPassing --
        // stated verbatim by this task's brief. Fixture order is the
        // REVERSE of the required order, so array-order fallback is
        // distinguishable from the real default sort.
        //
        // Single-line break: transposing any two values in
        // SEGMENT_PRIORITY (e.g. swapping `noTestsLinked: 2` and
        // `notFullyVerified: 1`) changes this exact sequence.
        it('defaults to executedFailing, then notFullyVerified, then noTestsLinked, then executedPassing (R2)', async () => {
            const rows: TraceabilityRow[] = [
                { reqId: 'Req-Passing', testCases: [], testCount: 0, defects: [], segment: 'executedPassing' },
                { reqId: 'Req-NoTests', testCases: [], testCount: 0, defects: [], segment: 'noTestsLinked' },
                { reqId: 'Req-NotFully', testCases: [], testCount: 0, defects: [], segment: 'notFullyVerified' },
                { reqId: 'Req-Failing', testCases: [], testCount: 0, defects: [], segment: 'executedFailing' },
            ];
            render(withTheme(<TraceabilityMatrixSection coverage={emptyCoverage()} traceability={traceabilityWith(rows)} />));

            const grid = screen.getByTestId('traceability-grid');
            await waitFor(() => expect(within(grid).getAllByRole('row')).toHaveLength(5));

            const dataRows = within(grid).getAllByRole('row').slice(1);
            expect(within(dataRows[0]).getByText('Req-Failing')).toBeInTheDocument();
            expect(within(dataRows[1]).getByText('Req-NotFully')).toBeInTheDocument();
            expect(within(dataRows[2]).getByText('Req-NoTests')).toBeInTheDocument();
            expect(within(dataRows[3]).getByText('Req-Passing')).toBeInTheDocument();
        });

        // BREAKS IF: `segmentPriorityRank` stops being STRICTLY increasing
        // in this order (e.g. `noTestsLinked` and `executedPassing` tie).
        it('segmentPriorityRank ranks executedFailing < notFullyVerified < noTestsLinked < executedPassing', () => {
            expect(segmentPriorityRank('executedFailing')).toBeLessThan(segmentPriorityRank('notFullyVerified'));
            expect(segmentPriorityRank('notFullyVerified')).toBeLessThan(segmentPriorityRank('noTestsLinked'));
            expect(segmentPriorityRank('noTestsLinked')).toBeLessThan(segmentPriorityRank('executedPassing'));
        });

        // BREAKS IF: the `?? -1` fallback in `segmentPriorityRank` is
        // changed back to `?? Object.keys(SEGMENT_PRIORITY).length` (or any
        // other value >= executedFailing's own rank) -- an unrecognised
        // segment would then sort at or behind a KNOWN failing row, or dead
        // last behind every passing row, instead of ahead of all of them.
        // 'totallyUnknownSegment' is grepped to appear nowhere else in the
        // codebase (not a real TraceabilitySegment value), standing in for
        // a fifth backend segment this frontend's hand-written union has
        // never seen -- exactly the drift TraceabilitySegment being a type
        // over untyped JSON cannot catch at compile time.
        it('segmentPriorityRank ranks an unrecognised segment ahead of executedFailing (never as benign as executedPassing)', () => {
            const unknownRank = segmentPriorityRank('totallyUnknownSegment' as TraceabilitySegment);
            expect(unknownRank).toBeLessThan(segmentPriorityRank('executedFailing'));
            expect(unknownRank).toBeLessThan(segmentPriorityRank('executedPassing'));
        });

        describe('compact per-cell summaries', () => {
            // BREAKS IF: the default `return 1;` branch is changed to
            // `return 2;` (or anything tying/beating 'Pass') -- an
            // unrecognised status would then rank as passing rather than
            // "not yet verified" (R2/R6).
            it('testCaseWorstRank ranks Fail worst, an unrecognised status in the middle, Pass best', () => {
                expect(testCaseWorstRank('Fail')).toBeLessThan(testCaseWorstRank('InProgress'));
                expect(testCaseWorstRank('InProgress')).toBeLessThan(testCaseWorstRank('Pass'));
            });

            // BREAKS IF: `testCaseWorstRank`'s 'Fail' branch is changed from
            // `return 0;` to `return 2;` (tying/beating 'Pass') -- the
            // failing case would then no longer count toward `failing`,
            // and this fixture (1 fail among 4) would misreport as "4
            // cases · all passing".
            it('summarizeTestCases states the count and how many are failing when any are', () => {
                const testCases = [
                    { TestCaseId: 'TC-1', status: 'Pass' },
                    { TestCaseId: 'TC-2', status: 'Fail' },
                    { TestCaseId: 'TC-3', status: 'Pass' },
                    { TestCaseId: 'TC-4', status: 'Pass' },
                ];
                expect(summarizeTestCases(testCases)).toBe('4 cases · 1 failing');
            });

            // BREAKS IF: the `unverified` branch's rank check is changed
            // from `=== 1` to `=== 2` -- an unrecognised status ('InProgress')
            // would then never be counted, misreporting "2 cases · all
            // passing" for a case that was never actually verified (R2/R6:
            // an unrecognised status must never read as if it passed).
            it('summarizeTestCases states "not yet verified" when nothing fails but something is unrecognised', () => {
                const testCases = [
                    { TestCaseId: 'TC-1', status: 'Pass' },
                    { TestCaseId: 'TC-2', status: 'InProgress' },
                ];
                expect(summarizeTestCases(testCases)).toBe('2 cases · 1 not yet verified');
            });

            // BREAKS IF: the final `all passing` return is changed to
            // include a stray "0 failing" instead.
            it('summarizeTestCases states "all passing" when every case is a Pass', () => {
                const testCases = [
                    { TestCaseId: 'TC-1', status: 'Pass' },
                    { TestCaseId: 'TC-2', status: 'Pass' },
                ];
                expect(summarizeTestCases(testCases)).toBe('2 cases · all passing');
            });

            // R6 -- "No test cases linked" and "0 failing" are different
            // claims. BREAKS IF: the `testCases.length === 0` guard is
            // removed, producing "0 cases · all passing" instead.
            it('summarizeTestCases reads "No tests linked" for zero cases, never "0 failing" (R6)', () => {
                expect(summarizeTestCases([])).toBe('No tests linked');
            });

            it('summarizeDefects states the count and how many are open', () => {
                const defects = [
                    { defectId: 'Bug-1', Status: 'Closed', Severity: 'Low' },
                    { defectId: 'Bug-2', Status: 'Open', Severity: 'High' },
                ];
                expect(summarizeDefects(defects)).toBe('2 defects · 1 open');
            });

            it('summarizeDefects states "all resolved" when every defect is closed', () => {
                expect(summarizeDefects([{ defectId: 'Bug-1', Status: 'Closed', Severity: 'Low' }])).toBe('1 defect · all resolved');
            });

            it('summarizeDefects reads "None" for zero defects', () => {
                expect(summarizeDefects([])).toBe('None');
            });

            it('isUnresolvedDefectStatus matches "closed" case-insensitively and treats anything else as open', () => {
                expect(isUnresolvedDefectStatus('Closed')).toBe(false);
                expect(isUnresolvedDefectStatus('CLOSED')).toBe(false);
                expect(isUnresolvedDefectStatus('Open')).toBe(true);
                expect(isUnresolvedDefectStatus('Retest')).toBe(true);
            });

            // Render-level wiring check: the GRID CELL actually shows the
            // compact summary, and never falls back to listing every case
            // (the old, pre-scale behaviour this task replaced).
            //
            // Single-line break: changing the `testCasesSummary` column's
            // `valueGetter` from `summarizeTestCases(params.row.testCases)`
            // to `formatTestCases(params.row)` in
            // TraceabilityMatrixSection.tsx.
            it('renders the compact test-case summary in the grid cell, not a per-case listing', async () => {
                const rows: TraceabilityRow[] = [{
                    reqId: 'Req-1',
                    requirementSummary: 'Login works',
                    testCases: [
                        { TestCaseId: 'TC-1', status: 'Pass' },
                        { TestCaseId: 'TC-2', status: 'Fail' },
                    ],
                    testCount: 2,
                    defects: [],
                    segment: 'executedFailing',
                }];
                render(withTheme(<TraceabilityMatrixSection coverage={emptyCoverage()} traceability={traceabilityWith(rows)} />));
                const grid = screen.getByTestId('traceability-grid');
                await waitFor(() => expect(within(grid).getAllByRole('row')).toHaveLength(2));

                expect(screen.getByTestId('traceability-row-Req-1-cases-summary')).toHaveTextContent('2 cases · 1 failing');
                expect(screen.queryByText('TC-1: Pass')).not.toBeInTheDocument();
                expect(screen.queryByText('TC-2: Fail')).not.toBeInTheDocument();
            });

            // BREAKS IF: the `row.testCases.length === 0` guard on
            // `summarizeTestCases` (or its wiring into the grid column) is
            // removed -- the cell would then show a percentage-shaped or
            // aggregated figure instead of the honest "No tests linked".
            it('renders a requirement with no linked cases as "No tests linked" in the compact cell, never a 0% figure (R6)', async () => {
                const rows: TraceabilityRow[] = [
                    { reqId: 'Req-9', requirementSummary: 'Unlinked requirement', testCases: [], testCount: 0, defects: [], segment: 'noTestsLinked' },
                ];
                render(withTheme(<TraceabilityMatrixSection coverage={emptyCoverage()} traceability={traceabilityWith(rows)} />));
                const grid = screen.getByTestId('traceability-grid');
                await waitFor(() => expect(within(grid).getAllByRole('row')).toHaveLength(2));

                const summaryCell = screen.getByTestId('traceability-row-Req-9-cases-summary');
                expect(summaryCell).toHaveTextContent('No tests linked');
                expect(summaryCell).not.toHaveTextContent('%');
            });

            // F13's R4, still binding: a plain count. Adequacy (F22) is
            // deliberately not measured here.
            //
            // Single-line break: adding a `valueFormatter: (params) =>
            // `${params.value}%`` line to the testCount column.
            it('keeps the Test count column a plain count, with no percentage or grade (F13 R4)', async () => {
                const rows: TraceabilityRow[] = [
                    { reqId: 'Req-9', requirementSummary: 'x', testCases: [], testCount: 0, defects: [], segment: 'noTestsLinked' },
                ];
                render(withTheme(<TraceabilityMatrixSection coverage={emptyCoverage()} traceability={traceabilityWith(rows)} />));
                const grid = screen.getByTestId('traceability-grid');
                await waitFor(() => expect(within(grid).getAllByRole('row')).toHaveLength(2));

                const row = getGridRowById(grid, 'Req-9');
                expect(row).toHaveTextContent('0');
                expect(row).not.toHaveTextContent('%');
            });
        });

        describe('detail affordance', () => {
            // R1 -- the full case/defect lists this task moved out of the
            // grid cell are reachable behind a per-row toggle, closed by
            // default, and can be closed again.
            //
            // Single-line break: deleting the `{expandedRow &&
            // <TraceabilityRowDetail row={expandedRow} />}` line in
            // TraceabilityMatrixSection.tsx leaves the toggle with nothing
            // to reveal.
            it('reveals the full test case and defect lists behind "View details", and hides them again on toggle', async () => {
                const rows: TraceabilityRow[] = [{
                    reqId: 'Req-1',
                    requirementSummary: 'Login works',
                    testCases: [
                        { TestCaseId: 'TC-1', status: 'Pass' },
                        { TestCaseId: 'TC-2', status: 'Fail' },
                    ],
                    testCount: 2,
                    defects: [{ defectId: 'Bug-1', summary: 'Login broken', Status: 'Open', Severity: 'High' }],
                    segment: 'executedFailing',
                }];
                render(withTheme(<TraceabilityMatrixSection coverage={emptyCoverage()} traceability={traceabilityWith(rows)} />));
                const grid = screen.getByTestId('traceability-grid');
                await waitFor(() => expect(within(grid).getAllByRole('row')).toHaveLength(2));

                expect(screen.queryByTestId('traceability-detail-panel-Req-1')).not.toBeInTheDocument();

                fireEvent.click(screen.getByTestId('traceability-row-Req-1-detail-toggle'));

                const panel = await screen.findByTestId('traceability-detail-panel-Req-1');
                expect(within(panel).getByText('TC-1: Pass')).toBeInTheDocument();
                expect(within(panel).getByText('TC-2: Fail')).toBeInTheDocument();
                expect(within(panel).getByText('Bug-1: Open (High)')).toBeInTheDocument();

                fireEvent.click(screen.getByTestId('traceability-row-Req-1-detail-toggle'));
                expect(screen.queryByTestId('traceability-detail-panel-Req-1')).not.toBeInTheDocument();
            });
        });

        // R4 -- the single most important test in this file, per this
        // task's own brief: DataGrid's own export mechanism exports the
        // DISPLAYED page, and a silently-25-of-60 audit CSV looks exactly
        // like a correct one. This proves the export path never reaches
        // for that.
        //
        // Single-line break (the exact probe this task's brief names):
        // changing `handleExport`'s `const exportRows = ...` to read a
        // paged subset (e.g. `rows.slice(0, 25)`) instead of the full
        // `rows` array -- see this task's report for the physical
        // edit-run-revert evidence.
        it('grid shows one page of 25 while the exported CSV carries all 60 rows (R4)', async () => {
            const rows = makeRows(60);
            render(withTheme(<TraceabilityMatrixSection coverage={emptyCoverage()} traceability={traceabilityWith(rows)} />));

            const grid = screen.getByTestId('traceability-grid');
            await waitFor(() => {
                expect(within(grid).getAllByRole('row')).toHaveLength(26);
            });

            fireEvent.click(screen.getByTestId('traceability-export-button'));

            expect(downloadCsv).toHaveBeenCalledTimes(1);
            const [csvContent] = downloadCsv.mock.calls[0];
            const lines = (csvContent as string).trim().split('\r\n');
            expect(lines).toHaveLength(61); // header + 60 requirements, not header + 25
        });
    });

    describe('CSV export shape', () => {
        const rows: TraceabilityRow[] = [
            {
                reqId: 'Req-1',
                requirementSummary: 'Login works',
                testCases: [
                    { TestCaseId: 'TC-1', status: 'Pass' },
                    { TestCaseId: 'TC-2', status: 'Fail' },
                ],
                testCount: 2,
                defects: [{ defectId: 'Bug-1', summary: 'Login broken', Status: 'Open', Severity: 'High' }],
                segment: 'executedFailing',
            },
            {
                reqId: 'Req-2',
                requirementSummary: 'Logout works',
                testCases: [],
                testCount: 0,
                defects: [],
                segment: 'noTestsLinked',
            },
        ];

        // BREAKS IF: `buildTraceabilityColumns` is changed to emit one row
        // per test case instead of per requirement (e.g. by flat-mapping
        // `row.testCases` into separate CSV rows) -- the line count
        // asserted below (header + 2, one per requirement) would then be
        // header + 3 (one per requirement-case pair), and Req-2's own
        // 0-testCount row would either vanish or be duplicated. This is
        // also the direct proof that the CSV's OWN per-case detail (R2/R6)
        // survives the on-screen cell's move to a compact summary --
        // `formatTestCases`/`formatDefects` are untouched by this task.
        it('produces exactly one CSV row per requirement, with the full per-case/defect detail regardless of the on-screen cell', () => {
            const columns = buildTraceabilityColumns(buildSegmentLabelLookup(STANDARD_BREAKDOWN));
            const csv = rowsToCsv(columns, rows);
            const lines = csv.trim().split('\r\n');
            expect(lines).toHaveLength(3); // header + 2 requirements, not 3 (which a per-case explosion would produce)

            expect(lines[1]).toBe('Req-1,Login works,2,TC-1: Pass; TC-2: Fail,Bug-1: Open (High),"Executed, failing"');
            expect(lines[2]).toBe('Req-2,Logout works,0,No tests linked,None,No tests linked');
        });

        it('formats an unlinked requirement’s cases/defects the same way the on-screen empty cells read', () => {
            expect(formatTestCases(rows[1])).toBe('No tests linked');
            expect(formatDefects(rows[1])).toBe('None');
            expect(buildSegmentLabelLookup(STANDARD_BREAKDOWN)(rows[1].segment)).toBe('No tests linked');
        });

        // Fix round 1 (coordinator review, WP-F13) -- the row's Segment
        // cell used to come from a standalone SEGMENT_LABELS constant that
        // happened to match computeCoverage's own wording. That's exactly
        // the kind of agreement that decays silently: this fixture
        // deliberately gives the backend a DIFFERENT wording than that old
        // constant ever had ('Executed, all passing (backend wording)') to
        // prove the row cell now reads it from `coverage.data.breakdown.
        // data`, not from a parallel list.
        //
        // BREAKS IF: `buildSegmentLabelLookup` is reverted to a standalone
        // SEGMENT_LABELS map instead of building from the `breakdown`
        // argument -- the row's Segment cell would then show 'Executed, all
        // passing' (the old constant's wording) instead of this fixture's
        // 'Executed, all passing (backend wording)'.
        it('renders the row Segment cell with the EXACT label the matching summary tile shows, not a separately-maintained constant', async () => {
            const customLabel = 'Executed, all passing (backend wording)';
            const coverage = reportState<CoverageData>({
                data: {
                    label: 'Requirement coverage',
                    total: 1,
                    tested: 1,
                    untested: 0,
                    segments: { noTestsLinked: 0, notFullyVerified: 0, executedFailing: 0, executedPassing: 1 },
                    breakdown: {
                        data: [
                            { id: 'noTestsLinked', label: 'No tests linked', value: 0 },
                            { id: 'notFullyVerified', label: 'Tests linked, not fully verified', value: 0 },
                            { id: 'executedFailing', label: 'Executed, failing', value: 0 },
                            { id: 'executedPassing', label: customLabel, value: 1 },
                        ],
                    },
                },
            });
            const passingRow: TraceabilityRow[] = [
                { reqId: 'Req-5', testCases: [{ TestCaseId: 'TC-9', status: 'Pass' }], testCount: 1, defects: [], segment: 'executedPassing' },
            ];
            render(withTheme(<TraceabilityMatrixSection coverage={coverage} traceability={traceabilityWith(passingRow)} />));

            const tile = screen.getByTestId('traceability-segment-executedPassing');
            expect(within(tile).getByText(customLabel)).toBeInTheDocument();

            const grid = screen.getByTestId('traceability-grid');
            await waitFor(() => expect(within(grid).getAllByRole('row')).toHaveLength(2));
            expect(within(grid).getByText(customLabel)).toBeInTheDocument();
        });
    });

    describe('export truncation notice', () => {
        // `truncationNotice` is a pure, DOM-free function extracted from the
        // component specifically so its exact boundary can be unit tested
        // without rendering 5000+ real grid rows in jsdom (this repo's own
        // jsdom-suite performance note) just to exceed the real
        // MAX_EXPORT_ROWS ceiling.
        //
        // BREAKS IF: the `rowCount <= MAX_EXPORT_ROWS` guard is changed to
        // `<` (off-by-one -- a project with EXACTLY MAX_EXPORT_ROWS
        // requirements would then wrongly claim truncation), or the
        // function is made to always return null (silently cutting the
        // export with no on-screen warning at all).
        it('says nothing at or under the export ceiling, and names the real count once over it', () => {
            expect(truncationNotice(MAX_EXPORT_ROWS)).toBeNull();
            expect(truncationNotice(MAX_EXPORT_ROWS + 1)).toBe(
                `This project has ${MAX_EXPORT_ROWS + 1} requirements; the CSV export is limited to the first ${MAX_EXPORT_ROWS}.`
            );
        });

        // Render-level wiring check, kept at a small (cheap) row count: a
        // project well under the ceiling must show NO truncation notice at
        // all -- proving the component actually calls `truncationNotice`
        // (and doesn't, say, unconditionally render the alert) without
        // needing a live render past the real 5000-row threshold to prove
        // the opposite direction (already covered by the pure test above).
        it('shows no truncation notice when the project is well under the export ceiling', () => {
            const fewRows: TraceabilityRow[] = [
                { reqId: 'Req-1', testCases: [], testCount: 0, defects: [], segment: 'noTestsLinked' },
            ];
            render(
                withTheme(
                    <TraceabilityMatrixSection coverage={emptyCoverage()} traceability={traceabilityWith(fewRows)} />
                )
            );
            expect(screen.queryByTestId('traceability-export-truncated-notice')).not.toBeInTheDocument();
        });
    });
});
