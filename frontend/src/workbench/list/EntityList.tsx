import { useMemo, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Box, Button, Chip, Stack, Typography } from '@mui/material';
import { DataGrid, GridPaginationModel, GridRenderCellParams, GridSortModel } from '@mui/x-data-grid';
import keycloak from '../../keycloak';
import usePermissions from '../../Hooks/usePermissions';
import { EmptyState } from '../../Components/common/EmptyState';
import { ViewSwitcher } from '../../Components/common/ViewSwitcher';
import { BulkActionBar, BulkActionKind } from '../../Components/common/BulkActionBar';
import { SavedView, resolveViewQueryParams } from '../../api/savedViewApi';
import { BulkResponse } from '../../api/bulkApi';
import { ModuleId, MODULE_LABELS } from '../modules';
import { moduleListConfigs, renderTagsCell } from './entityListConfigs';

// WP-074 Steps 5/7/8 — <EntityList>, the module-parameterised absorption of
// Components/entityGrid/TestCaseGridSection.tsx (saved views + bulk ops)
// into the workbench, mounted live via SourcePanel's `list` panel mode.
// `TestCaseGridSection.tsx` and its host page `Pages/testcases.tsx` were
// retired in this same WP (Step 8) now that <EntityList> reproduces their
// behaviour for module 1. WP-077 Step 2 retired `DefectGridSection.tsx`
// and its host page `Pages/defects.tsx` the same way once <EntityList>
// reproduced their behaviour for module 5 too (see entityListConfigs.ts's
// header comment on why only modules 1/5 have a config).
//
// Module 1 (test cases) and module 5 (defects) reproduce those two
// components' behaviour exactly, just reading columns/fetcher/bulk-action
// wiring from entityListConfigs.ts's registry instead of hardcoding a
// single entity. Every other module renders an explicit "not available"
// EmptyState and issues NO network call at all -- the underlying
// page-fetch/bulk endpoints genuinely don't exist yet for them.

export interface EntityListProps {
    module: ModuleId;
}

export function EntityList({ module }: EntityListProps) {
    const config = moduleListConfigs[module];
    const queryClient = useQueryClient();
    const { can } = usePermissions();
    const canWrite = can('write');
    const canDelete = can('delete');
    const currentUserSub = (keycloak.tokenParsed as { sub?: string } | undefined)?.sub;

    const [selectedView, setSelectedView] = useState<SavedView | null>(null);
    const [paginationModel, setPaginationModel] = useState<GridPaginationModel>({ page: 0, pageSize: 25 });
    const [sortModel, setSortModel] = useState<GridSortModel>(config?.defaultSortModel ?? []);
    const [selectionModel, setSelectionModel] = useState<string[]>([]);
    const [notice, setNotice] = useState<{ severity: 'success' | 'error'; message: string } | null>(null);

    // WP-F05c -- a LOCAL tag filter, deliberately not a saved-view one.
    //
    // resolveViewQueryParams below already applies a saved view's own
    // queryParams, but this component hands getCurrentViewState a hardcoded
    // `queryParams: {}` (see the ViewSwitcher props further down), so a
    // filter can be APPLIED from a saved view and never CAPTURED into one.
    // That gap predates this WP and is recorded in the gap register rather
    // than fixed here; this state is a local filter that merges ON TOP of
    // whatever the selected view already constrains, so a user on a saved
    // view who clicks a tag keeps the view's constraints and adds theirs.
    //
    // One tag at a time: the server-side filter is a single scalar match
    // against the array (advancedResults copies ?tags= straight into the
    // Mongo filter), so two tags would need an $all/$in the query path does
    // not express. Clicking a second tag replaces the first, which is
    // honest; silently ignoring the second click would not be.
    const [tagFilter, setTagFilter] = useState<string | null>(null);

    const extraParams = useMemo(() => {
        const fromView = selectedView ? resolveViewQueryParams(selectedView.queryParams || {}, currentUserSub) : {};
        // Merged, not replaced -- the saved view's constraints and the local
        // tag filter both apply. The tag filter is spread last so a view that
        // itself constrains `tags` is overridden by the tag the user just
        // clicked, which is what a click should mean.
        return tagFilter ? { ...fromView, tags: tagFilter } : fromView;
    }, [selectedView, currentUserSub, tagFilter]);

    const queryKey = ['entityList', module, paginationModel, sortModel, extraParams];

    const { data, isLoading, isError } = useQuery({
        queryKey,
        queryFn: () => {
            // Never reached when `config` is undefined -- `enabled` below
            // is false in that case. The guard only keeps this typesafe.
            if (!config) {
                return Promise.reject(new Error(`No list config for module ${module}`));
            }
            return config.fetchPage({
                page: paginationModel.page,
                pageSize: paginationModel.pageSize,
                sortField: sortModel[0]?.field,
                sortDirection: sortModel[0]?.sort || undefined,
                extraParams
            });
        },
        enabled: Boolean(config),
        placeholderData: keepPreviousData
    });

    const rows = data?.rows || [];

    // WP-F05e Fix 1/4 -- config.columns is a static, shared definition (see
    // entityListConfigs.tsx's header comment on tagsColumn/renderTagsCell)
    // with no access to this component's tag-filter state. Re-derive the
    // columns actually handed to the grid, swapping the tags column's
    // renderCell for one bound to setTagFilter, so a tag click here is a
    // real onClick on the Chip itself -- not a DataGrid onCellClick that
    // would also have to fight the grid's own row-selection wiring.
    const columns = useMemo(
        () =>
            config
                ? config.columns.map((col) =>
                      col.field === 'tags' ? { ...col, renderCell: (params: GridRenderCellParams) => renderTagsCell(params, setTagFilter) } : col
                  )
                : [],
        [config]
    );

    const bulkActions = config ? config.buildBulkActions({ canWrite, canDelete }) : [];

    const refresh = () => queryClient.invalidateQueries({ queryKey: ['entityList', module] });

    const handleBulkSuccess = (kind: BulkActionKind, resp: BulkResponse<unknown>) => {
        const count = resp.updated ?? resp.deleted ?? 0;
        const label = config?.entityLabelSingular ?? 'item';
        setNotice({
            severity: 'success',
            message: `${kind === 'delete' ? 'Deleted' : 'Updated'} ${count} ${label}${count === 1 ? '' : 's'}.`
        });
        setSelectionModel([]);
        refresh();
    };

    if (!config) {
        return (
            <Box sx={{ mb: 3 }}>
                <EmptyState message={`List view is not available for ${MODULE_LABELS[module]} yet.`} />
            </Box>
        );
    }

    return (
        <Box sx={{ mb: 3 }}>
            {/* No "<Entities> (list view)" heading: the source panel's header
                already names the module and the toggle shows the mode. */}
            <Stack direction="row" justifyContent="flex-end" alignItems="center" flexWrap="wrap" gap={1} sx={{ mb: 1, px: 1, '&:empty': { display: 'none' } }}>
                {config.savedViewEntityType ? (
                    <ViewSwitcher
                        entityType={config.savedViewEntityType}
                        selectedViewId={selectedView?._id || ''}
                        onSelect={(view) => {
                            setSelectedView(view);
                            // WP-F05e Fix 5 -- a tag filter is local UI state layered on
                            // top of whatever view is selected (see tagFilter's own
                            // comment above). Left alone across a view switch, it would
                            // silently override that view's own `tags` constraint (it's
                            // spread last into extraParams, deliberately, so a live click
                            // wins over a stale one) while the "Filtered by tag" banner
                            // kept showing a tag from a view the user already left.
                            setTagFilter(null);
                            setPaginationModel((p) => ({ ...p, page: 0 }));
                        }}
                        getCurrentViewState={() => ({ filterModel: {}, sortModel, columnVisibilityModel: {}, queryParams: {} })}
                        canSave={canWrite}
                    />
                ) : null}
            </Stack>

            {notice ? (
                <Alert severity={notice.severity} onClose={() => setNotice(null)} sx={{ mb: 1 }}>
                    {notice.message}
                </Alert>
            ) : null}

            <BulkActionBar
                selectedIds={selectionModel}
                actions={bulkActions}
                onCleared={() => setSelectionModel([])}
                onSuccess={handleBulkSuccess}
            />

            {/* WP-F05c -- the active tag filter. Visible and clearable: a
                filter a user cannot see is a filter they will mistake for
                missing data. */}
            {tagFilter ? (
                <Box data-testid="active-tag-filter" sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                    <Typography variant="body2" color="text.secondary">
                        Filtered by tag
                    </Typography>
                    <Chip label={tagFilter} size="small" />
                    <Button size="small" onClick={() => setTagFilter(null)}>
                        Clear tag filter
                    </Button>
                </Box>
            ) : null}

            {isError ? (
                <EmptyState message={config.loadErrorMessage} />
            ) : (
                <Box sx={{ width: '100%' }}>
                    <DataGrid
                        autoHeight
                        checkboxSelection={bulkActions.length > 0}
                        disableColumnFilter
                        loading={isLoading}
                        rows={rows}
                        columns={columns}
                        getRowId={config.getRowId}
                        paginationMode="server"
                        sortingMode="server"
                        rowCount={data?.rowCountEstimate ?? 0}
                        paginationModel={paginationModel}
                        onPaginationModelChange={setPaginationModel}
                        pageSizeOptions={[25, 50, 100]}
                        sortModel={sortModel}
                        onSortModelChange={setSortModel}
                        rowSelectionModel={selectionModel}
                        onRowSelectionModelChange={(model) => setSelectionModel(model as string[])}
                        slots={{ noRowsOverlay: () => <EmptyState message={config.noRowsMessage} /> }}
                    />
                </Box>
            )}
        </Box>
    );
}

export default EntityList;
