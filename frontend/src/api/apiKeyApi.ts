import axiosPrivate from './axios';
import { getCurrentProjectId } from '../currentProject';

// WP-032 — Per-project API keys (machine-to-machine auth), frontend client.
// A *new* module, per the pattern WP-011/WP-014/WP-020/WP-025 established
// (linkApi.ts, testPlanApi.ts, projectApi.ts, releaseApi.ts) — apiCalls.tsx
// is off-limits (WP-015 rewrote it wholesale, WP-025's own note repeats
// this). Backed by backend/userService's /api/v1/apikeys routes (see
// backend/userService/routes/apikeys.js and controllers/apikeys.js), which
// were built and orchestrator-verified end-to-end through Kong by the prior
// WP-032 agent -- this file only adds the missing frontend surface.
//
// Response shapes below are read directly off the committed controller
// (controllers/apikeys.js), not assumed:
//   POST   /api/v1/apikeys       -> { success, data: { keyId, projectId, scopes,
//                                      name, createdBy, createdAt, secret }, warning }
//   GET    /api/v1/apikeys       -> { success, count, data: ApiKey[] }
//                                    (each item is the Mongoose doc with
//                                    -hashedSecret projected out; no plaintext
//                                    secret ever appears here or anywhere again)
//   DELETE /api/v1/apikeys/:keyId -> { success, data: { keyId, revoked: true, revokedAt } }
//
// Management routes are mounted keycloak.protect() + requireProjectScopeLocal
// ('manage_project') only (see routes/apikeys.js's header comment) -- an API
// key itself can never call these, and only project admins/managers with
// manage_project can mint or revoke one. That matches this frontend's own
// usePermissions().can('manage_project') gate on the create/revoke controls,
// though the server-side check is the real boundary (WP-022 pattern).
//
// Project scope: every route requires X-Project-Id (WP-021 convention).
// WP-044: the route (/projects/:projectId/settings/apikeys) is now the
// source of truth -- see currentProject.ts's header comment. Computed at
// call time (a function, not a module-load-time constant) so a project
// switch mid-session is picked up by the very next call.
const projectScopeHeaders = () => ({ 'X-Project-Id': String(getCurrentProjectId()) });

// Mirrors backend/userService/models/ApiKey.js's ALLOWED_SCOPES exactly.
// Frontend copy, same reasoning as permissions.ts's mirror of the backend
// RBAC matrix -- no automatic sync, keep in lockstep by hand if it changes.
export const API_KEY_SCOPES = ['results:write', 'results:read', 'keys:admin'] as const;
export type ApiKeyScope = typeof API_KEY_SCOPES[number];

// A listed key. Never carries a secret or hashedSecret -- the controller's
// GET /api/v1/apikeys projects hashedSecret out at the DB layer
// (`.select('-hashedSecret')`), and the plaintext secret is never persisted
// anywhere to begin with.
export interface ApiKey {
    _id: string;
    keyId: string;
    projectId: number;
    scopes: ApiKeyScope[];
    name: string;
    createdBy: string;
    lastUsed: string | null;
    revoked: boolean;
    revokedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

// The one-time creation response. `secret` and `warning` exist ONLY on this
// response -- there is no other endpoint, ever, that can return the
// plaintext secret again (see controllers/apikeys.js createApiKey's header
// comment). Callers must show it once and must not stash it anywhere that
// outlives the moment (no state, no storage, no logging -- see
// Pages/apiKeys.tsx's handling).
export interface CreatedApiKey {
    keyId: string;
    projectId: number;
    scopes: ApiKeyScope[];
    name: string;
    createdBy: string;
    createdAt: string;
    /** Shown exactly once. Never logged, never persisted client-side beyond display. */
    secret: string;
}

export interface CreateApiKeyPayload {
    name?: string;
    scopes: ApiKeyScope[];
}

const API_KEY_BASE = '/api/v1/apikeys';

export const getApiKeys = async (): Promise<ApiKey[]> => {
    const resp = await axiosPrivate.get(API_KEY_BASE, { headers: projectScopeHeaders() });
    return resp.data.data;
};

// createdBy/projectId are derived server-side from the caller's Keycloak
// token and X-Project-Id (controllers/apikeys.js createApiKey) -- never
// part of this payload, mirroring the WP-020b body-trust fix.
export const createApiKey = async (payload: CreateApiKeyPayload): Promise<CreatedApiKey> => {
    const resp = await axiosPrivate.post(API_KEY_BASE, payload, { headers: projectScopeHeaders() });
    return resp.data.data;
};

export const revokeApiKey = async (keyId: string): Promise<void> => {
    await axiosPrivate.delete(`${API_KEY_BASE}/${keyId}`, { headers: projectScopeHeaders() });
};
