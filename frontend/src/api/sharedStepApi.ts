import axiosPrivate from './axios';

// WP-F06 Task 4 -- the shared-step library CRUD surface. New, isolated
// module, same convention as fieldsApi.ts/linkApi.ts/tagApi.ts: apiCalls.tsx
// is off-limits for new call sites (see those files' own header comments),
// so this reimplements nothing from it and adds no dependency on it.
//
// Backed by backend/testRepoService's /api/v1/sharedstep routes
// (routes/sharedStep.js), mounted at that exact path by server.js -- NOT
// under a nested /api/v1/testrepo/sharedstep, and NOT reachable without the
// leading /api/v1 (axiosPrivate's baseURL, ./axios.tsx's BASE_URL, is just
// the gateway host; every sibling module here spells the full /api/v1/...
// path itself, e.g. fieldsApi.ts's FIELDS_BASE). Secured end-to-end by the
// same keycloak.protect() -> requireProjectScope() -> authorize() chain as
// every other testRepoService route; X-Project-Id is added automatically by
// axiosPrivate's request interceptor, so no per-call header wiring is
// needed here either.

// backend/testRepoService/models/SharedStep.js's authoritative shape.
export interface SharedStepEntry {
  testStep: string;
  Expected: string;
}

export interface SharedStep {
  _id: string;
  id: number;
  SharedStepId: string;
  projectId: number;
  title: string;
  description?: string;
  steps: SharedStepEntry[];
  createdBy?: string;
  updatedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SharedStepPayload {
  title: string;
  description?: string;
  steps: SharedStepEntry[];
}

// The single source of truth for "which test cases reference this shared
// step" -- same shape controllers/sharedStep.js's findUsage() returns from
// both the usage route and a refused (409) delete.
export interface SharedStepUsage {
  count: number;
  testCases: Array<{ TestCaseId: string; TestCaseSummary?: string }>;
}

const SHARED_STEP_BASE = '/api/v1/sharedstep';

export const listSharedSteps = async (): Promise<SharedStep[]> => {
  const resp = await axiosPrivate.get(SHARED_STEP_BASE);
  return resp.data.data;
};

export const getSharedStep = async (id: string): Promise<SharedStep> => {
  const resp = await axiosPrivate.get(`${SHARED_STEP_BASE}/${id}`);
  return resp.data.data;
};

export const createSharedStep = async (body: SharedStepPayload): Promise<SharedStep> => {
  const resp = await axiosPrivate.post(SHARED_STEP_BASE, body);
  return resp.data.data;
};

export const updateSharedStep = async (id: string, body: SharedStepPayload): Promise<SharedStep> => {
  const resp = await axiosPrivate.put(`${SHARED_STEP_BASE}/${id}`, body);
  return resp.data.data;
};

// Deliberately no try/catch here. A shared step still referenced by a test
// case comes back as HTTP 409 with
// `{ success: false, error, data: { count, testCases } }`
// (controllers/sharedStep.js's deleteSharedStep) -- axios rejects on any
// non-2xx status, and the rejected error's `error.response.data` already
// *is* that whole body untouched. Catching and rethrowing a generic Error
// here would strip `data` (the usage payload a caller needs to tell the
// user what's blocking the delete) down to a string message, same mistake
// this module must not repeat. Callers read `err?.response?.data?.error`
// for the message and `err?.response?.data?.data` for the usage list --
// the same `err?.response?.data?.error` convention every other mutation
// error handler in this app already uses (e.g. FieldsPanel.tsx,
// ProjectMembersPanel.tsx, linkissue.tsx).
export const deleteSharedStep = async (id: string): Promise<void> => {
  await axiosPrivate.delete(`${SHARED_STEP_BASE}/${id}`);
};

export const getSharedStepUsage = async (id: string): Promise<SharedStepUsage> => {
  const resp = await axiosPrivate.get(`${SHARED_STEP_BASE}/${id}/usage`);
  return resp.data.data;
};
