import axiosPrivate from './axios';

// WP-043 — paginated list fetchers for the DataGrid list sections. Originally
// backed Pages/testcases/TestCaseGridSection.tsx and Pages/defects/
// DefectGridSection.tsx; fetchTestCasesPage now backs the workbench's
// <EntityList> (WP-074, src/workbench/list/entityListConfigs.tsx) instead,
// TestCaseGridSection.tsx having been retired in that same WP.
// fetchDefectsPage now backs <EntityList> the same way (WP-077 Step 2),
// DefectGridSection.tsx/Pages/defects.tsx having been retired in that WP.
// A *new* module (apiCalls.tsx is off-limits, WP-015/WP-025 precedent) —
// apiCalls.tsx's existing getTcList/getDefectList strip the response down
// to `.data.data`, discarding advancedResults' `pagination` envelope this
// grid needs to know whether a next page exists.
//
// SERVER-SIDE PAGINATION, HONEST LIMITATION: advancedResults() (backend/
// shared/service-core/middleware/advancedResults.js) returns
// `{count, pagination:{next?,prev?}, data}` -- `count` is just the current
// page's length, and there is NO total-row-count field at all. Extending
// that shared middleware (used by all 17 services) to add one was judged
// too broad a change for this WP. So `rowCount` below is an ESTIMATE
// (`page*pageSize + data.length + (has-next ? 1 : 0)`), not an exact
// total -- MUI X DataGrid's server-pagination footer will undercount by
// up to one page's worth until the last page is reached, but pagination
// itself (each page change issues a fresh, real, project-scoped, sorted,
// filtered server request) is genuinely server-side, not a client-side
// slice of one big fetch.
//
// SERVER-SIDE SORT: the `sort` query param passed straight to
// advancedResults (`-field` for desc, `field` for asc).
//
// SERVER-SIDE FILTER: NOT the DataGrid's own per-column filter UI (that
// maps DataGrid operators like "contains"/"isAnyOf" onto Mongo query
// syntax, which advancedResults' flat query-string contract doesn't
// support without a broader change) -- filtering here means a saved
// view's already-resolved `queryParams` (savedViewApi.ts), spread directly
// into the query string. See BulkEntityGrid-using pages' own header
// comments for the fuller reasoning and the explicit scope decision this
// follows.

export interface EntityPage<T> {
    rows: T[];
    /** Estimated, see header comment -- not an exact total. */
    rowCountEstimate: number;
    hasNextPage: boolean;
}

export interface FetchPageParams {
    page: number; // 0-indexed (DataGrid convention)
    pageSize: number;
    sortField?: string;
    sortDirection?: 'asc' | 'desc';
    extraParams?: Record<string, string>;
}

function buildQuery({ page, pageSize, sortField, sortDirection, extraParams }: FetchPageParams): string {
    const params = new URLSearchParams();
    params.set('page', String(page + 1)); // advancedResults is 1-indexed
    params.set('limit', String(pageSize));
    if (sortField) {
        params.set('sort', sortDirection === 'desc' ? `-${sortField}` : sortField);
    }
    for (const [key, val] of Object.entries(extraParams || {})) {
        if (val !== undefined && val !== '') {
            params.set(key, val);
        }
    }
    return params.toString();
}

async function fetchPage<T>(basePath: string, params: FetchPageParams): Promise<EntityPage<T>> {
    const resp = await axiosPrivate.get(`${basePath}?${buildQuery(params)}`);
    const body = resp.data as { data: T[]; pagination?: { next?: unknown } };
    const rows = body.data || [];
    const hasNextPage = Boolean(body.pagination && body.pagination.next);
    return {
        rows,
        rowCountEstimate: params.page * params.pageSize + rows.length + (hasNextPage ? 1 : 0),
        hasNextPage
    };
}

export const fetchTestCasesPage = (params: FetchPageParams) => fetchPage('/api/v1/testrepo', params);
export const fetchDefectsPage = (params: FetchPageParams) => fetchPage('/api/v1/defects', params);

// WP-074d — same generic fetchPage()/advancedResults contract, just three
// more basePaths. Verified live through Kong (?page=1&limit=2) before this
// WP started: all three return {data, pagination:{next}} exactly like
// testrepo/defects above.
export const fetchRequirementsPage = (params: FetchPageParams) => fetchPage('/api/v1/requirement', params);
export const fetchTestPlansPage = (params: FetchPageParams) => fetchPage('/api/v1/testplan', params);
export const fetchTestExecutionsPage = (params: FetchPageParams) => fetchPage('/api/v1/testexecution', params);
