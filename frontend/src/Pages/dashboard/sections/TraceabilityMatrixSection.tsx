import { useState } from 'react';
import { Alert, Box, Button, Grid, Paper, Skeleton, Stack, Typography } from '@mui/material';
import { DataGrid, GridColDef, GridSortCellParams, GridToolbarQuickFilter } from '@mui/x-data-grid';
import DownloadIcon from '@mui/icons-material/Download';
import { EmptyState } from '../../../Components/common/EmptyState';
import { StaleBanner } from '../StaleBanner';
import { ReportState } from '../useReportState';
import { CoverageData, DonutSlice, TraceabilityData, TraceabilityRow, TraceabilitySegment } from '../../../api/reportApi';
import { ExportColumn, MAX_EXPORT_ROWS, buildExportFilename, downloadCsv, rowsToCsv } from '../../../api/exportApi';
import { getCurrentProjectId } from '../../../currentProject';
import { isUnresolvedDefectStatus } from '../../../Components/common/defectStatusRules';

// WP-F13 Task 3 -- the requirement traceability matrix on screen, plus its
// CSV export. Tasks 1/2 built the numbers this renders (a corrected
// requirement-coverage figure and the per-requirement rows behind it); this
// section is the first place either becomes visible to a user.
//
// WP-F23 Task 2 -- the matrix at scale. The on-screen table used to be a
// plain <Table> with `rows.map(...)` and, inside every row, TWO MORE
// `.map`s (one over `row.testCases`, one over `row.defects`) -- readable at
// a handful of requirements, an unreadable wall at 200+ (this task's own
// brief: ~800 nested items in one pass for 200 requirements averaging four
// cases each). The on-screen half now renders inside DataGrid (already a
// dependency, `TestPlanDetail.tsx`/`ReleaseDetail.tsx` are this WP's own
// precedent), client-side paged at 25/50/100 -- the payload already arrives
// whole (traceability.js computes and ships every row in one response), so
// paging the RENDER costs nothing and needs no endpoint change (R3).
//
// Two SEPARATE report states feed this section on purpose:
//   - `coverage` (Task 1, already fetched by usePersonaReports for the
//     dashboard's own coverage donut) backs the four-segment summary. Its
//     `breakdown.data` is rendered VERBATIM -- id/label/value straight from
//     computeCoverage -- never recomputed from `traceability`'s rows. R3:
//     the matrix and the summary are decided by the same backend function;
//     this component's job is to display that agreement, not to recreate
//     it by counting rows itself (which could silently drift from the real
//     rule the next time classifyRequirementSegment changes).
//   - `traceability` (Task 2) backs the row grid and the CSV export.
// The two can be in different loading/error/stale states at the same
// moment (independent cache entries, independent dependency calls), so
// each half of this section renders its own loading/error/unavailable/
// stale handling rather than gating on one combined state.
export interface TraceabilityMatrixSectionProps {
    coverage: ReportState<CoverageData>;
    traceability: ReportState<TraceabilityData>;
}

// Fix round 1 (coordinator review, WP-F13) -- this used to be a standalone
// SEGMENT_LABELS constant duplicating the four strings computeCoverage
// already sends in `coverage.data.breakdown.data`. That's a real R3 risk:
// two lists of the same four strings agree only until someone edits one of
// them. This component ALREADY receives that array as a prop, so the
// row-level lookup is now built FROM it instead -- the row's Segment cell
// and the summary tile it corresponds to render the literally same string
// object, not two copies that happen to match today. Falls back to the
// raw segment id only when `breakdown` isn't available yet (coverage
// still loading/erroring/unavailable) -- never to an invented label.
function buildSegmentLabelLookup(breakdown: DonutSlice[] | undefined): (segment: string) => string {
    const byId = new Map((breakdown ?? []).map((slice): [string, string] => [slice.id, slice.label]));
    return (segment: string) => byId.get(segment) ?? segment;
}

// R2/R6 -- the CSV keeps listing every case's own latest status verbatim,
// one per case (never folded into a single "N passed" figure), so a reader
// opening the file can see exactly which case is the outlier. This is
// unaffected by the on-screen cell's move to a compact summary below: the
// export's job is the full detail, the screen's job (at scale) is now a
// summary with detail behind an affordance -- the two are allowed to say
// the same facts in different shapes, not the same shape.
function formatTestCases(row: TraceabilityRow): string {
    if (row.testCases.length === 0) {
        return 'No tests linked';
    }
    return row.testCases.map((tc) => `${tc.TestCaseId}: ${tc.status}`).join('; ');
}

function formatDefects(row: TraceabilityRow): string {
    if (row.defects.length === 0) {
        return 'None';
    }
    return row.defects.map((d) => `${d.defectId}: ${d.Status} (${d.Severity})`).join('; ');
}

// CSV flattening choice: ONE ROW PER REQUIREMENT, with the nested
// test-case/defect lists joined into single cells (semicolon-separated
// "id: status" pairs), rather than exploding into one row per
// requirement-x-test-case pair.
//
// Reasoning: this report's unit of audit is the REQUIREMENT -- Test Count,
// segment, and the on-screen grid's own row are all per-requirement, and
// R6's denominator ("N of M requirements") only means anything if a row IN
// the file corresponds to a row on screen. A reader opening this in a
// spreadsheet for an audit wants "how many requirements are in each
// segment" and "which requirement is thin or failing" to be a plain row
// count and column filter -- a requirement-x-case explosion would make
// "how many requirements does this file cover" require re-deriving a
// distinct-reqId count, and would repeat a requirement's segment and
// defect list on every one of its case rows: an easy place for a
// spreadsheet SUM or COUNT to silently double-count. One row per
// requirement keeps the export's row count, testCount, and segment
// identical to what the grid already shows for that same requirement.
//
// R4 -- this ALWAYS builds from the full `rows` array the component was
// handed, never from anything DataGrid itself tracks (its own
// paginationModel, its own sorted/filtered row order). DataGrid's built-in
// export exports the currently DISPLAYED page; that is exactly the trap
// this rule exists to avoid, so this file never reaches for it.
//
// Pure, DOM-free truncation rule -- extracted so its exact boundary (the
// off-by-one at MAX_EXPORT_ROWS itself) and message wording can be unit
// tested directly, without needing a live render of thousands of grid
// rows to exercise it (see __tests__/traceabilityMatrixSection.test.tsx).
// Returns `null` when nothing needs saying (rowCount <= MAX_EXPORT_ROWS) --
// "no notice" IS the silent-cutting failure mode this exists to prevent
// when rowCount is small, so the null case is exactly as load-bearing as
// the non-null one.
export function truncationNotice(rowCount: number): string | null {
    if (rowCount <= MAX_EXPORT_ROWS) {
        return null;
    }
    return `This project has ${rowCount} requirements; the CSV export is limited to the first ${MAX_EXPORT_ROWS}.`;
}

// A factory, not a static array, because the Segment column's labelling
// now depends on the CURRENT `coverage` prop (see buildSegmentLabelLookup
// above) -- built fresh per render from whatever `coverage.data.breakdown.
// data` currently holds, so the CSV's Segment text can never drift from
// the summary tile's.
function buildTraceabilityColumns(segmentLabelFor: (segment: string) => string): ExportColumn<TraceabilityRow>[] {
    return [
        { header: 'Requirement ID', getValue: (r) => r.reqId },
        { header: 'Requirement Summary', getValue: (r) => r.requirementSummary },
        { header: 'Test Count', getValue: (r) => r.testCount },
        { header: 'Test Cases (id: status)', getValue: (r) => formatTestCases(r) },
        { header: 'Defects (id: status (severity))', getValue: (r) => formatDefects(r) },
        { header: 'Segment', getValue: (r) => segmentLabelFor(r.segment) },
    ];
}

// R2's default sort for this grid: broken first, then unverified, then
// untested, then passing rows last -- "a reader opening the matrix should
// land on what is broken, then what is unverified, then what is untested;
// passing rows last, because they need nothing" (this task's own brief).
// A plain id sort would scatter a dozen failing requirements across a
// dozen pages and answer nothing -- sorting IS the feature here, not
// decoration.
const SEGMENT_PRIORITY: Record<TraceabilitySegment, number> = {
    executedFailing: 0,
    notFullyVerified: 1,
    noTestsLinked: 2,
    executedPassing: 3,
};

// Exported so the ranking itself (not just its effect on a live grid) can
// be unit tested directly, and so a segment id this map has never seen
// (there should be none -- TraceabilitySegment is a closed union -- but a
// payload is not the type checker) sorts FIRST rather than throwing or,
// worse, sorting last.
//
// Fix round (final review) -- this used to fall back to
// `Object.keys(SEGMENT_PRIORITY).length` (4), i.e. LAST, behind even
// `executedPassing` (3). `TraceabilitySegment` is a hand-written union over
// untyped backend JSON, so `tsc` staying quiet proves nothing about what a
// live payload can contain: the moment `coverage.js`'s `SEGMENTS` gains a
// fifth value, every row in it would silently sort onto the grid's last
// page, behind every passing row -- exactly the "failures scattered across
// pages" outcome R2 exists to prevent, and a direct violation of this
// package's own standing rule that an unrecognised value must never be
// ranked as benign.
//
// -1, not "the middle" like this file's sibling `testCaseWorstRank` (or
// `ReleaseDetail.tsx`'s `testCaseExecutionRank`): those rank an
// unrecognised per-CASE execution *status* in the middle because "not yet
// verified" is itself a specific, safe reading of an unknown status. A
// segment is different -- it is the backend's own bucket ASSIGNMENT for a
// requirement, and a bucket this frontend has never seen means the
// contract between the two has drifted, not that the requirement is
// merely "unverified". That is worth surfacing ahead of even a KNOWN
// failure, not slotted between two known buckets whose meaning is still
// understood.
export function segmentPriorityRank(segment: TraceabilitySegment): number {
    return SEGMENT_PRIORITY[segment] ?? -1;
}

function compareSegmentPriority(
    v1: TraceabilitySegment,
    v2: TraceabilitySegment,
    p1: GridSortCellParams<TraceabilitySegment>,
    p2: GridSortCellParams<TraceabilitySegment>,
): number {
    const r1 = segmentPriorityRank(v1);
    const r2 = segmentPriorityRank(v2);
    if (r1 !== r2) {
        return r1 - r2;
    }
    return String(p1.id).localeCompare(String(p2.id));
}

// The per-cell summary's own "worst status" ranking for a requirement's
// test cases: a Fail outranks everything (worst), an unrecognised status
// (live data already has 'InProgress', outside the documented Pass/Fail/
// No Run vocabulary) counts as "not yet verified" rather than silently as
// a pass, and only the literal string 'Pass' ranks as passing.
export function testCaseWorstRank(status: string): number {
    if (status === 'Fail') {
        return 0;
    }
    if (status === 'Pass') {
        return 2;
    }
    return 1;
}

// Compact per-cell summary: "N cases · M failing" when at least one case
// is failing, "N cases · M not yet verified" when none are failing but at
// least one is neither Pass nor Fail, "N cases · all passing" when every
// case is a Pass, and the same "No tests linked" text the grid always
// used for a genuinely unlinked requirement (R6: that is a different claim
// than "0 failing", never collapsed into one).
export function summarizeTestCases(testCases: TraceabilityRow['testCases']): string {
    if (testCases.length === 0) {
        return 'No tests linked';
    }
    const total = testCases.length;
    const caseWord = total === 1 ? 'case' : 'cases';
    const failing = testCases.filter((tc) => testCaseWorstRank(tc.status) === 0).length;
    if (failing > 0) {
        return `${total} ${caseWord} · ${failing} failing`;
    }
    const unverified = testCases.filter((tc) => testCaseWorstRank(tc.status) === 1).length;
    if (unverified > 0) {
        return `${total} ${caseWord} · ${unverified} not yet verified`;
    }
    return `${total} ${caseWord} · all passing`;
}

// Re-exported rather than redefined: the rule itself now lives in
// Components/common/defectStatusRules.ts, so this view and the release
// lens can no longer disagree about whether a defect is still open.
export { isUnresolvedDefectStatus };

// Compact per-cell summary for defects, same shape as summarizeTestCases:
// counts plus the worst state (open outranks resolved).
export function summarizeDefects(defects: TraceabilityRow['defects']): string {
    if (defects.length === 0) {
        return 'None';
    }
    const total = defects.length;
    const defectWord = total === 1 ? 'defect' : 'defects';
    const open = defects.filter((d) => isUnresolvedDefectStatus(d.Status)).length;
    if (open > 0) {
        return `${total} ${defectWord} · ${open} open`;
    }
    return `${total} ${defectWord} · all resolved`;
}

// Stable module-scope component (not created inline per render) so
// DataGrid's `slots.toolbar` identity does not change on every render --
// wraps the library's own quick-filter search box with a data-testid,
// since GridToolbarQuickFilter renders no testid of its own (same shape
// ReleaseDetail.tsx's own per-grid quickfilter toolbars use).
function TraceabilityQuickFilterToolbar(): JSX.Element {
    return (
        <Box data-testid="traceability-quickfilter" sx={{ p: 1 }}>
            <GridToolbarQuickFilter />
        </Box>
    );
}

// Columns are built fresh per render (like buildTraceabilityColumns above)
// because the Segment column's label and the Details column's expanded
// state both depend on values that change across renders -- not because
// GridColDef objects are expensive to build for a few hundred rows.
function buildTraceabilityGridColumns(
    segmentLabelFor: (segment: string) => string,
    expandedReqId: string | null,
    onToggleDetail: (reqId: string) => void,
): GridColDef<TraceabilityRow>[] {
    return [
        { field: 'reqId', headerName: 'Requirement Id', flex: 0.8 },
        {
            field: 'requirementSummary',
            headerName: 'Summary',
            flex: 1.6,
            valueGetter: (params) => params.row.requirementSummary || '—',
        },
        {
            // F13's R4 still binds here: a plain count, no percentage, no
            // grade, no threshold colouring. Adequacy is deliberately not
            // measured (tracked separately as F22) and this column must
            // never become mistakable for it.
            field: 'testCount',
            headerName: 'Test count',
            type: 'number',
            flex: 0.6,
        },
        {
            field: 'testCasesSummary',
            headerName: 'Test cases',
            flex: 1.5,
            valueGetter: (params) => summarizeTestCases(params.row.testCases),
            renderCell: (params) => (
                <Typography variant="body2" data-testid={`traceability-row-${params.row.reqId}-cases-summary`}>
                    {params.value}
                </Typography>
            ),
        },
        {
            field: 'defectsSummary',
            headerName: 'Defects',
            flex: 1.3,
            valueGetter: (params) => summarizeDefects(params.row.defects),
            renderCell: (params) => (
                <Typography variant="body2" data-testid={`traceability-row-${params.row.reqId}-defects-summary`}>
                    {params.value}
                </Typography>
            ),
        },
        {
            // Sorted (default and on click) by segmentPriorityRank on the
            // RAW segment id, never by the rendered label text -- so this
            // column's order can never depend on which backend wording
            // happens to be in `coverage.data.breakdown.data` this render.
            field: 'segment',
            headerName: 'Segment',
            flex: 1.2,
            valueGetter: (params) => params.row.segment,
            sortComparator: compareSegmentPriority,
            renderCell: (params) => <span>{segmentLabelFor(params.value)}</span>,
        },
        {
            field: 'details',
            headerName: 'Details',
            flex: 0.8,
            sortable: false,
            filterable: false,
            renderCell: (params) => {
                const expanded = expandedReqId === params.row.reqId;
                return (
                    <Button
                        size="small"
                        onClick={() => onToggleDetail(params.row.reqId)}
                        aria-expanded={expanded}
                        data-testid={`traceability-row-${params.row.reqId}-detail-toggle`}
                    >
                        {expanded ? 'Hide details' : 'View details'}
                    </Button>
                );
            },
        },
    ];
}

interface TraceabilityRowDetailProps {
    row: TraceabilityRow;
}

// R1: the detail panel is where the full case/defect lists this task moved
// OUT of the grid cell now live -- reachable by the "View details" toggle
// above, never open by default. One panel, keyed to whichever row was last
// toggled open, rendered below the grid (not inline as an extra grid row --
// `@mui/x-data-grid` at this package's pinned version is the Community
// edition, which has no per-row detail-panel API; that is Pro-only, and
// this task adds no new dependency and no upgrade).
function TraceabilityRowDetail({ row }: TraceabilityRowDetailProps): JSX.Element {
    return (
        <Paper variant="outlined" sx={{ p: 2, mt: 2 }} data-testid={`traceability-detail-panel-${row.reqId}`}>
            {/* `component="div"` -- `variant="subtitle2"` defaults to an
                <h6>, which would skip straight from this page's own <h2>
                ("Traceability") past h3/h4/h5 (axe's heading-order rule).
                This is a label for the panel below it, not a new document
                section, so it renders with no heading semantics at all. */}
            <Typography variant="subtitle2" component="div">
                {row.reqId}
                {row.requirementSummary ? ` — ${row.requirementSummary}` : ''}
            </Typography>

            <Typography variant="body2" sx={{ fontWeight: 600, mt: 1.5 }}>
                Test cases
            </Typography>
            {row.testCases.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                    No tests linked
                </Typography>
            ) : (
                <Stack spacing={0.5}>
                    {row.testCases.map((tc) => (
                        <Typography
                            key={tc.TestCaseId}
                            variant="body2"
                            data-testid={`traceability-detail-testcase-${tc.TestCaseId}`}
                        >
                            {tc.TestCaseId}: {tc.status}
                        </Typography>
                    ))}
                </Stack>
            )}

            <Typography variant="body2" sx={{ fontWeight: 600, mt: 1.5 }}>
                Defects
            </Typography>
            {row.defects.length === 0 ? (
                <Typography variant="body2" color="text.secondary">
                    None
                </Typography>
            ) : (
                <Stack spacing={0.5}>
                    {row.defects.map((d) => (
                        <Typography
                            key={d.defectId}
                            variant="body2"
                            data-testid={`traceability-detail-defect-${d.defectId}`}
                        >
                            {d.defectId}: {d.Status} ({d.Severity})
                        </Typography>
                    ))}
                </Stack>
            )}
        </Paper>
    );
}

export function TraceabilityMatrixSection({ coverage, traceability }: TraceabilityMatrixSectionProps) {
    const total = traceability.data?.total ?? 0;
    const rows = traceability.data?.rows ?? [];
    // R1 -- exactly one detail panel open at a time, closed by default.
    // Independent of DataGrid's own paging/sorting/filtering state, so
    // switching pages never silently closes or relocates an open panel for
    // a row that is still (or is no longer) on the visible page.
    const [expandedReqId, setExpandedReqId] = useState<string | null>(null);
    const toggleDetail = (reqId: string) => setExpandedReqId((current) => (current === reqId ? null : reqId));
    const expandedRow = expandedReqId ? rows.find((r) => r.reqId === expandedReqId) ?? null : null;

    // Truncation is an export-only concern -- the on-screen grid always
    // renders every row `total` says exists (never capped, only PAGED --
    // every row is still reachable via the pager), matching R6's "every
    // figure keeps its denominator": the grid's own row count is never
    // silently capped. Only the downloaded file, which mirrors
    // exportApi.ts's MAX_EXPORT_ROWS ceiling every other export in this app
    // already respects, can be shorter than `rows.length` -- and when it
    // is, this section says so on screen rather than handing back a
    // silently short file.
    const exportNotice = truncationNotice(rows.length);
    // Fix round 1 (WP-F13) -- built from the CURRENT coverage payload every
    // render (see buildSegmentLabelLookup's own comment), so this section's
    // own Segment column and its summary tiles can never show two
    // different strings for the same segment.
    const segmentLabelFor = buildSegmentLabelLookup(coverage.data?.breakdown.data);
    const columns = buildTraceabilityColumns(segmentLabelFor);
    const gridColumns = buildTraceabilityGridColumns(segmentLabelFor, expandedReqId, toggleDetail);

    // R4 -- built from `rows`, the full array this component was handed,
    // every time. Never from DataGrid's own apiRef/state (its current
    // page, sort, or quick-filter), which would silently shrink an audit
    // export to whatever happens to be on screen.
    const handleExport = () => {
        const exportRows = exportNotice ? rows.slice(0, MAX_EXPORT_ROWS) : rows;
        const csv = rowsToCsv(columns, exportRows);
        downloadCsv(csv, buildExportFilename('traceability', getCurrentProjectId()));
    };

    return (
        <Stack spacing={2} data-testid="traceability-section">
            {/* WP-046 convention (see TestManagerSection.tsx): component="h2"
                for a persona/report section heading. */}
            <Typography variant="h6" component="h2" color="primary">
                Traceability
            </Typography>

            {/* R2 -- four mutually exclusive, exhaustive segments as four
                separate facts, never collapsed into one percentage. R6 --
                each fact keeps its own denominator (`of N requirements`)
                rather than standing alone as a bare count a reader has to
                guess the base of. */}
            <StaleBanner stale={coverage.stale} staleReason={coverage.staleReason} computedAt={coverage.computedAt} />
            {coverage.isLoading ? (
                <Skeleton variant="rounded" height={96} />
            ) : coverage.errorMessage ? (
                <Alert severity="error">{coverage.errorMessage}</Alert>
            ) : coverage.isUnavailable ? (
                <EmptyState message="Coverage isn’t available yet for this project — check back shortly." />
            ) : (
                <Grid container spacing={2} data-testid="traceability-segments">
                    {(coverage.data?.breakdown.data ?? []).map((slice) => (
                        <Grid item xs={12} sm={6} md={3} key={slice.id}>
                            <Paper
                                variant="outlined"
                                data-testid={`traceability-segment-${slice.id}`}
                                sx={{ p: 2 }}
                            >
                                <Typography variant="h5" component="p" sx={{ fontWeight: 600 }}>
                                    {slice.value}
                                </Typography>
                                <Typography variant="body2" color="text.secondary">
                                    {slice.label}
                                </Typography>
                                <Typography variant="caption" color="text.secondary">
                                    of {coverage.data?.total ?? 0} requirement{(coverage.data?.total ?? 0) === 1 ? '' : 's'}
                                </Typography>
                            </Paper>
                        </Grid>
                    ))}
                </Grid>
            )}

            <StaleBanner
                stale={traceability.stale}
                staleReason={traceability.staleReason}
                computedAt={traceability.computedAt}
            />

            {traceability.isLoading ? (
                <Skeleton variant="rounded" height={240} />
            ) : traceability.errorMessage ? (
                <Alert severity="error">{traceability.errorMessage}</Alert>
            ) : traceability.isUnavailable ? (
                <EmptyState message="Traceability isn’t available yet for this project — check back shortly." />
            ) : total === 0 ? (
                // R6 -- a project with zero requirements says so honestly
                // (the backend's own `note`), never a bare empty table a
                // reader could mistake for "still loading" or an error.
                <div data-testid="traceability-empty">
                    <EmptyState
                        message={
                            traceability.data?.note ||
                            'No requirements defined yet — add requirements to start tracing coverage.'
                        }
                    />
                </div>
            ) : (
                <>
                    <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
                        <Typography variant="body2" color="text.secondary">
                            {total} requirement{total === 1 ? '' : 's'}
                        </Typography>
                        <Button
                            variant="outlined"
                            size="small"
                            startIcon={<DownloadIcon />}
                            onClick={handleExport}
                            data-testid="traceability-export-button"
                        >
                            Export CSV
                        </Button>
                    </Stack>
                    {exportNotice && (
                        <Alert severity="warning" data-testid="traceability-export-truncated-notice">
                            {exportNotice}
                        </Alert>
                    )}
                    {/* Wide-content-scrolls-in-its-own-container (this WP's
                        own layout constraint): the wrapping Box's overflowX
                        keeps a wide grid scrollable within itself, never
                        widening the page body. */}
                    <Box data-testid="traceability-grid" sx={{ width: '100%', maxWidth: '100%', overflowX: 'auto' }}>
                        <DataGrid
                            autoHeight
                            rows={rows}
                            columns={gridColumns}
                            getRowId={(row) => row.reqId}
                            aria-label="Requirement traceability"
                            initialState={{
                                pagination: { paginationModel: { page: 0, pageSize: 25 } },
                                sorting: { sortModel: [{ field: 'segment', sort: 'asc' }] },
                            }}
                            pageSizeOptions={[25, 50, 100]}
                            slots={{ toolbar: TraceabilityQuickFilterToolbar }}
                        />
                    </Box>
                    {expandedRow && <TraceabilityRowDetail row={expandedRow} />}
                </>
            )}
        </Stack>
    );
}

export default TraceabilityMatrixSection;

// Exported for direct, DOM-free unit testing of the CSV shape and the
// grid's own sort/summary rules (see
// __tests__/traceabilityMatrixSection.test.tsx) -- asserting the export
// mirrors the grid's own numbers without having to click a button that
// triggers a real browser download in jsdom, and asserting the ranking
// rules without needing a live DataGrid render for every case.
export {
    buildTraceabilityColumns,
    buildSegmentLabelLookup,
    formatTestCases,
    formatDefects,
};
