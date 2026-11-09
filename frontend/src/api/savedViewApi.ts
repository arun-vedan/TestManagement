import axiosPrivate from './axios';

// WP-043 — SavedView frontend client. A *new* module, same pattern as
// apiKeyApi.ts/testPlanApi.ts/linkApi.ts/releaseApi.ts/notificationApi.ts/
// reportApi.ts established (apiCalls.tsx is off-limits, WP-015/WP-025).
// Backed by backend/fieldsService's new /api/v1/savedviews routes (routes/
// savedView.js, controllers/savedView.js) -- see that controller's header
// comment for the home decision (fieldsService, not a not-yet-real
// "Catalog" service) and the id strategy (plain Mongo `_id`, never a
// read-then-write numeric id).
//
// X-Project-Id is added automatically by api/axios.tsx's request
// interceptor (currentProject.ts) for every call through axiosPrivate, so
// it isn't repeated explicitly here -- same as every other post-WP-022 API
// module except apiKeyApi.ts/releaseApi.ts, which predate that interceptor
// and still set it by hand.

export type SavedViewEntityType = 'testcase' | 'defect' | 'requirement' | 'testexecution';

// MUI X DataGrid's own shapes, round-tripped verbatim -- see
// models/savedView.js's header comment on filterModel/sortModel.
export interface GridFilterItem {
    field: string;
    operator: string;
    value?: unknown;
}
export interface GridFilterModel {
    items: GridFilterItem[];
    quickFilterValues?: string[];
}
export interface GridSortItem {
    field: string;
    sort: 'asc' | 'desc' | null;
}
export type GridSortModel = GridSortItem[];

export interface SavedView {
    _id: string;
    projectId: number;
    entityType: SavedViewEntityType;
    ownerId: string | null;
    isSystem: boolean;
    name: string;
    filterModel: GridFilterModel | Record<string, unknown>;
    sortModel: GridSortModel;
    columnVisibilityModel: Record<string, boolean>;
    /** Flat query-string params to send straight to the entity's list endpoint. */
    queryParams: Record<string, string>;
    createdBy?: string;
    updatedBy?: string;
    createdAt: string;
    updatedAt: string;
}

export interface CreateSavedViewPayload {
    entityType: SavedViewEntityType;
    name: string;
    filterModel?: GridFilterModel | Record<string, unknown>;
    sortModel?: GridSortModel;
    columnVisibilityModel?: Record<string, boolean>;
    queryParams?: Record<string, string>;
}

export interface UpdateSavedViewPayload {
    name?: string;
    filterModel?: GridFilterModel | Record<string, unknown>;
    sortModel?: GridSortModel;
    columnVisibilityModel?: Record<string, boolean>;
    queryParams?: Record<string, string>;
}

const SAVED_VIEW_BASE = '/api/v1/savedviews';

// The Keycloak-`sub` placeholder saved into the seeded "My failed tests"
// default view's queryParams.assignedTo (controllers/savedView.js,
// SELF_TOKEN). Resolved to the real current user's sub at apply-time by
// resolveViewQueryParams() below -- never sent to the backend literally.
const SELF_TOKEN = '$self';

export const getSavedViews = async (entityType: SavedViewEntityType): Promise<SavedView[]> => {
    const resp = await axiosPrivate.get(SAVED_VIEW_BASE, { params: { entityType } });
    return resp.data.data;
};

export const createSavedView = async (payload: CreateSavedViewPayload): Promise<SavedView> => {
    const resp = await axiosPrivate.post(SAVED_VIEW_BASE, payload);
    return resp.data.data;
};

export const updateSavedView = async (id: string, payload: UpdateSavedViewPayload): Promise<SavedView> => {
    const resp = await axiosPrivate.put(`${SAVED_VIEW_BASE}/${id}`, payload);
    return resp.data.data;
};

export const deleteSavedView = async (id: string): Promise<void> => {
    await axiosPrivate.delete(`${SAVED_VIEW_BASE}/${id}`);
};

// Substitutes the `$self` sentinel for the real current user's Keycloak
// `sub` before a saved view's queryParams are sent to an entity's list
// endpoint. Every other key passes through unchanged.
export const resolveViewQueryParams = (
    queryParams: Record<string, string>,
    currentUserSub: string | undefined
): Record<string, string> => {
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(queryParams || {})) {
        resolved[key] = value === SELF_TOKEN && currentUserSub ? currentUserSub : value;
    }
    return resolved;
};
