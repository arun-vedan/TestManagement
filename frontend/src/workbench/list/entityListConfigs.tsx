import { Box, Button, Chip } from '@mui/material';
import { GridColDef, GridRenderCellParams, GridSortModel } from '@mui/x-data-grid';
import { ModuleId } from '../modules';
import { useWorkbench } from '../WorkbenchStoreProvider';
import { StatusChip, LIFECYCLE_STATUS_COLORS } from '../../Components/common/StatusChip';
import { BulkActionConfig } from '../../Components/common/BulkActionBar';
import { SavedViewEntityType } from '../../api/savedViewApi';
import {
    EntityPage,
    FetchPageParams,
    fetchTestCasesPage,
    fetchDefectsPage,
    fetchRequirementsPage,
    fetchTestPlansPage,
    fetchTestExecutionsPage
} from '../../api/entityGridApi';
import { getReleases, Release } from '../../api/releaseApi';
import {
    bulkAssignTestCases,
    bulkUpdateTestCaseStatus,
    bulkDeleteTestCases,
    bulkAssignDefects,
    bulkDeleteDefects,
    bulkUpdateRequirementStatus,
    bulkDeleteRequirements,
    bulkDeleteTestPlans,
    bulkAssignTestRuns,
    bulkDeleteTestRuns
} from '../../api/bulkApi';

// WP-074 Step 5 — module-config registry `<EntityList>` reads from. Each
// entry is EVERYTHING `<EntityList>` needs to reproduce one module's grid
// section (columns, the page fetcher, saved-view wiring, and which bulk
// actions the backend genuinely supports) without `<EntityList>` itself
// knowing anything module-specific.
//
// HONEST COVERAGE, not a stub per module: only two backends existed behind
// api/entityGridApi.ts (fetchTestCasesPage -> /api/v1/testrepo,
// fetchDefectsPage -> /api/v1/defects) and api/bulkApi.ts has no bulk
// status-change for defects (see that module's own header comment --
// istatusservice graph validation per item was judged out of scope there).
// (WP-F15/F18 Task 1 later added module 6, releases, below -- see that
// module's own header comment for why its `fetchPage` isn't one of the
// entityGridApi.ts fetchers this paragraph describes.)
// So module 1 (test cases) reproduces Components/entityGrid/
// TestCaseGridSection.tsx's behaviour exactly (that component and its host
// page, Pages/testcases.tsx, were retired in this same WP once <EntityList>
// took over module 1's live route), module 5 (defects) mirrored
// Components/entityGrid/DefectGridSection.tsx exactly (assign + delete, NO
// status bulk action) -- that component and its host page, Pages/defects.tsx,
// were likewise retired once <EntityList> took over module 5's live route
// (WP-077 Step 2).
//
// WP-074d — every remaining list module already paginates server-side
// (advancedResults, verified live through Kong with a real service token:
// requirement/testplan/testexecution/defects/testrepo all return
// {data, pagination:{next}} for ?page=1&limit=2). fetchRequirementsPage/
// fetchTestPlansPage/fetchTestExecutionsPage were added to
// api/entityGridApi.ts on that same generic fetchPage() contract, so
// modules 2 (requirements), 3 (test plans) and 4 (test runs) get real
// configs below.
//
// WP-F03c — api/bulkApi.ts now has real bulk endpoints for requirements
// and test plans/test runs too (Tasks 1/2 of that WP, verified live), so
// modules 2/3/4's `buildBulkActions` are filled in below, same as
// modules 1/5. The asymmetry across modules is the data model's, not a
// gap: requirements have no `assignedTo` (status + delete only), TestPlan
// has neither `status` nor `assignedTo` (delete only), and TestExecution
// has no lifecycle `status` field (assign + delete only) -- see each
// config's own comment. `<EntityList>` already degrades cleanly for an
// empty actions array: `checkboxSelection={bulkActions.length > 0}` hides
// the selection column, and `BulkActionBar` renders `null` when
// `actions.length === 0`; that path still exists for module 6 below, so
// no code change was needed in `<EntityList>` itself for this WP either.
//
// Module 6 (releases) DOES have an entry now -- added by WP-F15/F18, which
// gave releases the list and detail views every other module already had.
// It is the one config that does not use entityGridApi's shared
// `fetchPage`: releaseService's list route has no advancedResults, so there
// is no server-side page/limit/sort contract to call. See releaseConfig's
// own adapter below and the reasoning beside it.

export const LIFECYCLE_STATUSES = ['draft', 'review', 'approved', 'deprecated', 'archived'];

export interface EntityListBulkContext {
    canWrite: boolean;
    canDelete: boolean;
}

export interface EntityListConfig<TRow = any> {
    /** Plural display label, e.g. "Test cases" / "Defects", used in the section heading and messages. */
    entityLabelPlural: string;
    /** Singular display label used in success/notice copy, e.g. "test case" / "defect". */
    entityLabelSingular: string;
    /**
     * The saved-view vocabulary this module's views are stored under.
     * Omitted (not fabricated) when the backend's SavedView schema has no
     * enum member for this module -- see testPlanConfig's comment below.
     * `<EntityList>` skips rendering <ViewSwitcher> entirely when absent.
     */
    savedViewEntityType?: SavedViewEntityType;
    /** Server-side paginated/sorted list fetcher -- must be a REAL existing endpoint, never fabricated. */
    fetchPage: (params: FetchPageParams) => Promise<EntityPage<TRow>>;
    columns: GridColDef[];
    getRowId: (row: TRow) => string;
    defaultSortModel: GridSortModel;
    /** Only the bulk operations the backend genuinely exposes for this module. */
    buildBulkActions: (ctx: EntityListBulkContext) => BulkActionConfig[];
    loadErrorMessage: string;
    noRowsMessage: string;
}

// WP-F05c -- the tags column, shared by all five configs so a tag looks and
// behaves identically everywhere. Defined once rather than per config: the
// five-route coverage comment in this file already records what happens
// when the same thing is written out five times and drifts.
//
// WP-F05e (review fix) -- the click now lives on the Chip itself, not in a
// DataGrid onCellClick in EntityList.tsx. Two reasons this is better than
// the original cell-level handler:
//
// 1. Accessibility (Fix 4). A `cursor: pointer` sx with no onClick reaching
//    <Chip> never becomes a real control -- MUI only upgrades Chip to a
//    ButtonBase (role="button", tabIndex, Enter/Space handling) when it is
//    given an onClick. A keyboard or screen-reader user could not use the
//    feature at all before this.
// 2. Row-selection safety (Fix 1). MUI X's GridRow publishes its own
//    'rowClick' event from a plain React onClick on the row's root element
//    (see node_modules/@mui/x-data-grid/components/GridRow.js's
//    `publishClick`), and row SELECTION is wired off *that* event, not off
//    GridCell's 'cellClick' -- gated only on the field not being the
//    checkbox/detail-panel/reorder/actions column, which 'tags' isn't. A
//    plain onCellClick handler in EntityList (the original approach here)
//    would have needed to set `event.defaultMuiPrevented = true` to reach
//    forward and suppress that later rowClick subscriber. Attaching onClick
//    directly to the Chip and calling `event.stopPropagation()` in it is
//    simpler and stronger: React's synthetic dispatch never even reaches
//    GridCell's or GridRow's onClick handlers for that click, so neither
//    'cellClick' nor 'rowClick' is ever published, and the row can never be
//    armed for bulk selection by a tag click.
//
// `renderTagsCell` takes the click callback as a parameter rather than
// closing over anything, because these column definitions are static
// values with no access to EntityList's filter state; EntityList.tsx
// re-derives its `columns` from `config.columns`, replacing just this
// field's `renderCell` with one bound to its own `setTagFilter`. The base
// `tagsColumn` below (used un-wired, e.g. by this file's own describe-block
// tests) renders inert, non-clickable chips -- `cursor: pointer` is only
// shown once a click handler is actually wired, so the cursor never
// promises interactivity the chip doesn't have.
//
// Placed LAST, not earlier: EntityList.test.tsx records the WP-F03 lesson
// that, with checkboxSelection on, MUI's column virtualization at jsdom's
// zero client width mounts only a leading window of columns, so a column
// further right could not be asserted on there before disableVirtualization
// was wired in for tests (WP-F05e Fix 2) -- placing it last kept that
// constraint from displacing any of the columns that already existed.
export function renderTagsCell(params: GridRenderCellParams, onTagClick?: (tag: string) => void) {
    const tags: string[] = Array.isArray(params.row.tags) ? params.row.tags : [];
    if (tags.length === 0) return <span>—</span>;
    return (
        <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'nowrap', overflow: 'hidden' }}>
            {tags.map((t) => (
                <Chip
                    key={t}
                    label={t}
                    size="small"
                    data-tag={t}
                    sx={{ cursor: onTagClick ? 'pointer' : 'default' }}
                    onClick={
                        onTagClick
                            ? (event) => {
                                  // See the header comment above -- this is what keeps a tag
                                  // click from ever reaching DataGrid's row-selection wiring.
                                  event.stopPropagation();
                                  onTagClick(t);
                              }
                            : undefined
                    }
                />
            ))}
        </Box>
    );
}

export const tagsColumn: GridColDef = {
    field: 'tags',
    headerName: 'Tags',
    flex: 1,
    sortable: false,
    renderCell: (params) => renderTagsCell(params)
};

const testCaseConfig: EntityListConfig = {
    entityLabelPlural: 'Test cases',
    entityLabelSingular: 'test case',
    savedViewEntityType: 'testcase',
    fetchPage: fetchTestCasesPage,
    getRowId: (row: any) => row._id,
    defaultSortModel: [{ field: 'createdAt', sort: 'desc' }],
    columns: [
        { field: 'TestCaseId', headerName: 'ID', flex: 0.6 },
        { field: 'TestCaseSummary', headerName: 'Summary', flex: 1.6 },
        {
            field: 'status',
            headerName: 'Status',
            flex: 0.8,
            sortable: false,
            renderCell: (params) => <StatusChip status={params.row.status} colorMap={LIFECYCLE_STATUS_COLORS} />
        },
        { field: 'assignedTo', headerName: 'Assigned to', flex: 1, valueGetter: (params) => params.row.assignedTo || '—' },
        {
            field: 'updatedAt',
            headerName: 'Updated',
            flex: 1,
            valueFormatter: (params) => (params.value ? new Date(params.value as string).toLocaleString() : '—')
        },
        tagsColumn
    ],
    buildBulkActions: ({ canWrite, canDelete }) => {
        const actions: BulkActionConfig[] = [];
        if (canWrite) {
            actions.push({
                kind: 'assign',
                label: 'Assign',
                valueLabel: 'Assign to (user id)',
                run: (ids, value) => bulkAssignTestCases(ids, value as string)
            });
            actions.push({
                kind: 'status',
                label: 'Change status',
                valueLabel: 'New status',
                allowedValues: LIFECYCLE_STATUSES,
                run: (ids, value) => bulkUpdateTestCaseStatus(ids, value as string)
            });
        }
        if (canDelete) {
            actions.push({ kind: 'delete', label: 'Delete', run: (ids) => bulkDeleteTestCases(ids) });
        }
        return actions;
    },
    loadErrorMessage: 'Unable to load test cases.',
    noRowsMessage: 'No test cases match this view.'
};

const defectConfig: EntityListConfig = {
    entityLabelPlural: 'Defects',
    entityLabelSingular: 'defect',
    savedViewEntityType: 'defect',
    fetchPage: fetchDefectsPage,
    getRowId: (row: any) => row._id,
    defaultSortModel: [{ field: 'createdAt', sort: 'desc' }],
    columns: [
        { field: 'defectId', headerName: 'ID', flex: 0.6 },
        { field: 'summary', headerName: 'Summary', flex: 1.6, valueGetter: (params) => params.row.summary || '—' },
        {
            field: 'Severity',
            headerName: 'Severity',
            flex: 0.7,
            sortable: false,
            renderCell: (params) => (params.row.Severity ? <StatusChip status={params.row.Severity} /> : '—')
        },
        { field: 'Status', headerName: 'Status', flex: 0.7, valueGetter: (params) => String(params.row.Status ?? '—') },
        { field: 'assignedTo', headerName: 'Assigned to', flex: 1, valueGetter: (params) => params.row.assignedTo || '—' },
        {
            field: 'updatedAt',
            headerName: 'Updated',
            flex: 1,
            valueFormatter: (params) => (params.value ? new Date(params.value as string).toLocaleString() : '—')
        },
        tagsColumn
    ],
    buildBulkActions: ({ canWrite, canDelete }) => {
        // No bulk status-change for defects -- see api/bulkApi.ts's header
        // comment on why that endpoint doesn't exist. Assign + delete only.
        const actions: BulkActionConfig[] = [];
        if (canWrite) {
            actions.push({
                kind: 'assign',
                label: 'Assign',
                valueLabel: 'Assign to (user id)',
                run: (ids, value) => bulkAssignDefects(ids, value as string)
            });
        }
        if (canDelete) {
            actions.push({ kind: 'delete', label: 'Delete', run: (ids) => bulkDeleteDefects(ids) });
        }
        return actions;
    },
    loadErrorMessage: 'Unable to load defects.',
    noRowsMessage: 'No defects match this view.'
};

const requirementConfig: EntityListConfig = {
    entityLabelPlural: 'Requirements',
    entityLabelSingular: 'requirement',
    savedViewEntityType: 'requirement',
    fetchPage: fetchRequirementsPage,
    getRowId: (row: any) => row._id,
    defaultSortModel: [{ field: 'createdAt', sort: 'desc' }],
    columns: [
        { field: 'reqId', headerName: 'ID', flex: 0.6 },
        { field: 'requirementSummary', headerName: 'Summary', flex: 1.8 },
        {
            field: 'status',
            headerName: 'Status',
            flex: 0.8,
            sortable: false,
            renderCell: (params) => <StatusChip status={params.row.status} colorMap={LIFECYCLE_STATUS_COLORS} />
        },
        {
            field: 'updatedAt',
            headerName: 'Updated',
            flex: 1,
            valueFormatter: (params) => (params.value ? new Date(params.value as string).toLocaleString() : '—')
        },
        tagsColumn
    ],
    // WP-F03c. No assign: requirements carry no assignedTo field (see
    // this module's columns above -- there's no "Assigned to" column
    // because there's no such field to render). Status + delete only.
    buildBulkActions: ({ canWrite, canDelete }) => {
        const actions: BulkActionConfig[] = [];
        if (canWrite) {
            actions.push({
                kind: 'status',
                label: 'Change status',
                valueLabel: 'New status',
                allowedValues: LIFECYCLE_STATUSES,
                run: (ids, value) => bulkUpdateRequirementStatus(ids, value as string)
            });
        }
        if (canDelete) {
            actions.push({ kind: 'delete', label: 'Delete', run: (ids) => bulkDeleteRequirements(ids) });
        }
        return actions;
    },
    loadErrorMessage: 'Unable to load requirements.',
    noRowsMessage: 'No requirements match this view.'
};

const testPlanConfig: EntityListConfig = {
    entityLabelPlural: 'Test Plans',
    entityLabelSingular: 'test plan',
    // No savedViewEntityType: backend/fieldsService/models/savedView.js's
    // SavedViewSchema.entityType is a closed Mongo enum
    // ['testcase','defect','requirement','testexecution'] -- 'testplan' is
    // not a member, and adding one is a backend schema change this
    // (frontend-only) WP may not make. Reusing 'testcase' here would
    // silently mix test-plan saved views into the real test-case
    // vocabulary, which is worse than having none -- so <EntityList> just
    // doesn't render the view switcher for this module.
    fetchPage: fetchTestPlansPage,
    getRowId: (row: any) => row._id,
    defaultSortModel: [{ field: 'createdAt', sort: 'desc' }],
    columns: [
        { field: 'TestPlanId', headerName: 'ID', flex: 0.7 },
        {
            // The live row shape has no name/summary field at all -- only
            // TestPlanId and a TestCases array. Do not fabricate a name
            // column; a derived count is the only honest second column.
            field: 'testCaseCount',
            headerName: 'Test cases',
            flex: 0.8,
            sortable: false,
            valueGetter: (params) => (Array.isArray(params.row.TestCases) ? params.row.TestCases.length : 0)
        },
        {
            field: 'updatedAt',
            headerName: 'Updated',
            flex: 1,
            valueFormatter: (params) => (params.value ? new Date(params.value as string).toLocaleString() : '—')
        },
        tagsColumn
    ],
    // WP-F03c. Delete only: TestPlan has neither status nor assignedTo
    // (see this module's columns above -- there's no field for either to
    // drive a status or assign action from).
    buildBulkActions: ({ canDelete }) => {
        const actions: BulkActionConfig[] = [];
        if (canDelete) {
            actions.push({ kind: 'delete', label: 'Delete', run: (ids) => bulkDeleteTestPlans(ids) });
        }
        return actions;
    },
    loadErrorMessage: 'Unable to load test plans.',
    noRowsMessage: 'No test plans match this view.'
};

const testExecutionConfig: EntityListConfig = {
    entityLabelPlural: 'Test Runs',
    entityLabelSingular: 'test run',
    savedViewEntityType: 'testexecution',
    fetchPage: fetchTestExecutionsPage,
    getRowId: (row: any) => row._id,
    defaultSortModel: [{ field: 'createdAt', sort: 'desc' }],
    columns: [
        { field: 'TestExecutionId', headerName: 'ID', flex: 0.7 },
        { field: 'TestPlanId', headerName: 'Test plan', flex: 0.8 },
        { field: 'assignedTo', headerName: 'Assigned to', flex: 1, valueGetter: (params) => params.row.assignedTo || '—' },
        {
            field: 'updatedAt',
            headerName: 'Updated',
            flex: 1,
            valueFormatter: (params) => (params.value ? new Date(params.value as string).toLocaleString() : '—')
        },
        tagsColumn
    ],
    // WP-F03c. No status: TestExecution has no lifecycle status field
    // (see this module's columns above -- there's no status column to
    // drive a status action from). Assign + delete only.
    buildBulkActions: ({ canWrite, canDelete }) => {
        const actions: BulkActionConfig[] = [];
        if (canWrite) {
            actions.push({
                kind: 'assign',
                label: 'Assign',
                valueLabel: 'Assign to (user id)',
                run: (ids, value) => bulkAssignTestRuns(ids, value as string)
            });
        }
        if (canDelete) {
            actions.push({ kind: 'delete', label: 'Delete', run: (ids) => bulkDeleteTestRuns(ids) });
        }
        return actions;
    },
    loadErrorMessage: 'Unable to load test runs.',
    noRowsMessage: 'No test runs match this view.'
};

// WP-F15/F18 Task 1 -- module 6 (releases). `getReleases()` (api/
// releaseApi.ts) is NOT on the same contract as the five fetchers above:
// it takes no page/sort params at all and returns a flat `Release[]`,
// already fetched in one call capped at 1000 rows and sorted server-side
// by `-createdAt` only (see that function's own query params). There is no
// `fetchReleasesPage` in api/entityGridApi.ts because releaseService's
// route was never verified to support advancedResults' page/limit/sort
// contract the way requirement/testplan/testexecution/defects/testrepo
// were (WP-074d's header comment above) -- reusing that shared fetcher
// would be fabricating support that was never confirmed to exist.
//
// This adapter reproduces the `FetchPageParams -> EntityPage<T>` shape
// `<EntityList>` needs by paging and sorting the already-fetched flat
// array CLIENT-side. Honest tradeoff, not a hidden one: pagination and
// column-header sort here operate on however much of the (capped-at-1000)
// release list the one unpaginated call already returned, not on a full
// server-side dataset the way modules 1-5 get. A project with more than
// 1000 releases would silently lose the rest -- a real gap, but
// getReleases() gives nothing more to build on without a releaseService
// change, which is out of scope for this frontend-only task.
function fetchReleasesPage(params: FetchPageParams): Promise<EntityPage<Release>> {
    return getReleases().then((all) => {
        const rows = [...all];
        if (params.sortField) {
            const field = params.sortField as keyof Release;
            const dir = params.sortDirection === 'desc' ? -1 : 1;
            rows.sort((a, b) => {
                const av = a[field];
                const bv = b[field];
                if (av === bv) return 0;
                return (av as any) > (bv as any) ? dir : -dir;
            });
        }
        const start = params.page * params.pageSize;
        const pageRows = rows.slice(start, start + params.pageSize);
        return {
            rows: pageRows,
            // Not an estimate here, unlike the five configs above --
            // getReleases() already returns every row (up to its own
            // 1000-row cap) in one call, so the true count of what was
            // fetched is already known, not guessed at from a `next` flag.
            rowCountEstimate: rows.length,
            hasNextPage: start + params.pageSize < rows.length
        };
    });
}

// WP-F15/F18 Task 5 -- module 6 originally had neither a tree (releases
// carry no `parentId`/folder membership, and useTreeChildren.ts's
// fetchLeaves had no module-6 case, so EntityTree stayed empty -- fixed
// 2026-11-06: releases now list at the tree root, keyed by the same _id
// this cell opens) nor a search
// config (entitySearchConfigs.ts's own module-6 gap, EntitySearchPanel's
// "not available" branch). Task 1's list view was, until this cell existed,
// the only place a release ever appeared in the workbench AND the only one
// with no way to open it: EntityList.tsx wires no onRowClick/onCellClick
// for any module, so the row this column belongs to did nothing when
// clicked. Rather than wiring a click generically into EntityList.tsx
// itself (touching a component five OTHER modules' detail views already
// reach via their own tree, and its own test file, for no gain to them),
// this column's own renderCell returns a small button-shaped cell that
// calls the workbench store DIRECTLY -- valid because a `renderCell`
// return value is an ordinary React node, so a component placed there
// mounts (and may call hooks) exactly like any other child in the tree.
// `entityId` is the release's Mongo `_id`, not `releaseId` -- the same
// convention ReleaseDetail.tsx's own header comment documents and
// EntityDetail.tsx already dispatches on for module 6.
function ReleaseIdCell({ params }: { params: GridRenderCellParams }): JSX.Element {
    const openTab = useWorkbench((s) => s.openTab);
    const setSelection = useWorkbench((s) => s.setSelection);
    const row = params.row as { _id: string; releaseId?: string };
    const label = row.releaseId || row._id;
    return (
        <Button
            size="small"
            variant="text"
            sx={{ textTransform: 'none', minWidth: 0, p: 0, justifyContent: 'flex-start' }}
            onClick={(event) => {
                // Same stopPropagation discipline renderTagsCell's own header
                // comment documents -- without it this click would also
                // publish DataGrid's 'rowClick'/row-selection wiring, which
                // this module deliberately has none of (releaseConfig has no
                // bulk actions, so `checkboxSelection` is already off, but a
                // future bulk action must not silently re-arm selection on
                // every id click).
                event.stopPropagation();
                setSelection(6, row._id);
                openTab({ module: 6, entityId: row._id, title: label });
            }}
        >
            {label}
        </Button>
    );
}

const releaseConfig: EntityListConfig = {
    entityLabelPlural: 'Releases',
    entityLabelSingular: 'release',
    // No savedViewEntityType: SavedViewSchema.entityType's Mongo enum (see
    // testPlanConfig's own comment above) has no 'release' member either.
    fetchPage: fetchReleasesPage,
    getRowId: (row: any) => row._id,
    defaultSortModel: [{ field: 'createdAt', sort: 'desc' }],
    columns: [
        { field: 'releaseId', headerName: 'ID', flex: 0.6, renderCell: (params) => <ReleaseIdCell params={params} /> },
        { field: 'name', headerName: 'Name', flex: 1.6 },
        {
            // No colorMap: release status (planned/in-progress/frozen/
            // released/cancelled) is its own vocabulary, not the
            // draft/review/approved/deprecated/archived lifecycle
            // LIFECYCLE_STATUS_COLORS was built for -- same reasoning as
            // defectConfig's Severity column above, which also renders an
            // unmapped StatusChip rather than reusing that colorMap.
            field: 'status',
            headerName: 'Status',
            flex: 0.8,
            sortable: false,
            renderCell: (params) => <StatusChip status={params.row.status} />
        },
        {
            field: 'targetDate',
            headerName: 'Target date',
            flex: 0.9,
            valueFormatter: (params) => (params.value ? new Date(params.value as string).toLocaleDateString() : '—')
        },
        {
            // Derived from linkedTestPlanIds, not a field of its own --
            // same call testPlanConfig's testCaseCount column above makes
            // for TestPlan.TestCases.
            field: 'linkedTestPlanCount',
            headerName: 'Linked test plans',
            flex: 0.9,
            sortable: false,
            valueGetter: (params) => (Array.isArray(params.row.linkedTestPlanIds) ? params.row.linkedTestPlanIds.length : 0)
        }
        // No tagsColumn: the Release model (backend/releaseService/models/
        // Release.js) carries no `tags` field, so there is nothing honest
        // to render in it -- the shared placement rule (tagsColumn last)
        // only applies to configs that actually have tags.
    ],
    // No bulk actions: neither api/releaseApi.ts nor api/bulkApi.ts
    // exposes a bulk endpoint for releases. BulkActionBar already renders
    // null and <EntityList> already hides the selection column when
    // `actions.length === 0` (see the WP-074d comment above on that path
    // already existing for this exact module before this WP filled it in).
    buildBulkActions: () => [],
    loadErrorMessage: 'Unable to load releases.',
    noRowsMessage: 'No releases match this view.'
};

export const moduleListConfigs: Record<ModuleId, EntityListConfig | undefined> = {
    1: testCaseConfig,
    2: requirementConfig,
    3: testPlanConfig,
    4: testExecutionConfig,
    5: defectConfig,
    6: releaseConfig
};

export default moduleListConfigs;
