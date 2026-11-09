import axiosPrivate from './axios';
import { getCurrentProjectId } from '../currentProject';

// WP-025: Release / Environment / QualityGate entities. A *new* module, per
// the pattern WP-011/WP-014/WP-020 established (linkApi.ts, testPlanApi.ts,
// projectApi.ts) — apiCalls.tsx is off-limits (WP-015 is rewriting it
// wholesale). Backed by releaseService's new /api/v1/releases and
// /api/v1/environments routes (see backend/releaseService and the Kong
// routes added in srckube-kong/kong.yml's new "releaseService" service).
//
// Project scope: every releaseService route requires an X-Project-Id header
// (WP-021 convention, enforced there from birth per the WP-025 dispatch
// brief). WP-044: the route (/projects/:projectId/releases) is now the
// source of truth -- see currentProject.ts's header comment. Computed at
// call time (a function, not a module-load-time constant) so a project
// switch mid-session is picked up by the very next call.
const projectScopeHeaders = () => ({ 'X-Project-Id': String(getCurrentProjectId()) });

export const RELEASE_STATUSES = ['planned', 'in-progress', 'frozen', 'released', 'cancelled'] as const;
export type ReleaseStatus = typeof RELEASE_STATUSES[number];

export const GATE_TYPES = ['minPassRate', 'maxOpenDefects'] as const;
export type GateType = typeof GATE_TYPES[number];

export interface QualityGateRule {
    type: GateType;
    threshold: number;
    /** maxOpenDefects only — omit/empty to count every severity. */
    severity?: string;
}

export interface Release {
    _id: string;
    id: number;
    releaseId: string; // 'REL-n'
    name: string;
    projectId: number;
    targetDate?: string;
    status: ReleaseStatus;
    linkedTestPlanIds: string[];
    notes?: string;
    qualityGates: QualityGateRule[];
    // WP-F24 Task 1 (fix round 1) -- a project's configured module-6 field
    // values (fieldsService definitions, backend/releaseService/models/
    // Release.js's own `dynamicFields`), same convention as Requirement's
    // own `dynamicFields` (api/apiCalls.tsx). Values only; the field
    // *definitions* (name/type/label) come from getFields(6), never from
    // here.
    dynamicFields?: Record<string, unknown>;
    createdBy?: string;
    updatedBy?: string;
    createdAt?: string;
    updatedAt?: string;
}

export interface Environment {
    _id: string;
    id: number;
    name: string;
    projectId: number;
    description?: string;
    url?: string;
    createdBy?: string;
    updatedBy?: string;
}

export interface GateRuleResult {
    type: GateType;
    threshold: number;
    severity?: string | null;
    actual: number;
    passed: boolean;
    details?: Record<string, any>;
}

export interface GateStatus {
    releaseId: string;
    status: ReleaseStatus;
    overall: 'green' | 'red';
    passed: boolean;
    rules: GateRuleResult[];
}

const RELEASE_BASE = '/api/v1/releases';
const ENVIRONMENT_BASE = '/api/v1/environments';

export const getReleases = async (): Promise<Release[]> => {
    const resp = await axiosPrivate.get(RELEASE_BASE, { headers: projectScopeHeaders(), params: { sort: '-createdAt', limit: 1000 } });
    return resp.data.data;
};

export const getRelease = async (id: string): Promise<Release> => {
    const resp = await axiosPrivate.get(`${RELEASE_BASE}/${id}`, { headers: projectScopeHeaders() });
    return resp.data.data;
};

// createdBy/updatedBy/projectId are derived server-side (releaseService
// controllers/releases.js#createRelease) — not part of this payload.
export const createRelease = async (payload: {
    name: string;
    targetDate?: string;
    notes?: string;
    linkedTestPlanIds?: string[];
    qualityGates?: QualityGateRule[];
}): Promise<Release> => {
    const resp = await axiosPrivate.post(RELEASE_BASE, payload, { headers: projectScopeHeaders() });
    return resp.data.data;
};

export const updateRelease = async (
    id: string,
    // WP-F24 Task 1 (fix round 1) -- 'dynamicFields' added so a configured
    // field's PATCH (ReleaseDetail.tsx's commitField) can actually reach
    // the one schema path the backend now persists it under.
    payload: Partial<Pick<Release, 'name' | 'targetDate' | 'status' | 'notes' | 'qualityGates' | 'dynamicFields'>>
): Promise<Release> => {
    const resp = await axiosPrivate.put(`${RELEASE_BASE}/${id}`, payload, { headers: projectScopeHeaders() });
    return resp.data.data;
};

export const deleteRelease = async (id: string): Promise<void> => {
    await axiosPrivate.delete(`${RELEASE_BASE}/${id}`, { headers: projectScopeHeaders() });
};

export const linkTestPlan = async (releaseId: string, testPlanId: string): Promise<Release> => {
    const resp = await axiosPrivate.post(`${RELEASE_BASE}/${releaseId}/plans`, { testPlanId }, { headers: projectScopeHeaders() });
    return resp.data.data;
};

export const unlinkTestPlan = async (releaseId: string, testPlanId: string): Promise<Release> => {
    const resp = await axiosPrivate.delete(`${RELEASE_BASE}/${releaseId}/plans/${testPlanId}`, { headers: projectScopeHeaders() });
    return resp.data.data;
};

export const getGateStatus = async (releaseId: string): Promise<GateStatus> => {
    const resp = await axiosPrivate.get(`${RELEASE_BASE}/${releaseId}/gate-status`, { headers: projectScopeHeaders() });
    return resp.data.data;
};

export const getEnvironments = async (): Promise<Environment[]> => {
    const resp = await axiosPrivate.get(ENVIRONMENT_BASE, { headers: projectScopeHeaders(), params: { limit: 1000 } });
    return resp.data.data;
};

export const createEnvironment = async (payload: { name: string; description?: string; url?: string }): Promise<Environment> => {
    const resp = await axiosPrivate.post(ENVIRONMENT_BASE, payload, { headers: projectScopeHeaders() });
    return resp.data.data;
};

// WP-F18b Task 1 — the backend route (routes/environments.js) has always
// mounted PUT/DELETE with the correct authorize('write')/authorize('delete')
// gates; only the client was missing these two. See
// Components/settings/EnvironmentsPanel.tsx for the only caller.
export const updateEnvironment = async (
    id: string,
    payload: Partial<Pick<Environment, 'name' | 'description' | 'url'>>
): Promise<Environment> => {
    const resp = await axiosPrivate.put(`${ENVIRONMENT_BASE}/${id}`, payload, { headers: projectScopeHeaders() });
    return resp.data.data;
};

export const deleteEnvironment = async (id: string): Promise<void> => {
    await axiosPrivate.delete(`${ENVIRONMENT_BASE}/${id}`, { headers: projectScopeHeaders() });
};
