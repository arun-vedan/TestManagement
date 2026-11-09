import axiosPrivate from './axios';

// WP-F07a Task 4 -- the dataset library's CRUD surface, the authoring half
// of parameterised test cases. Same convention as sharedStepApi.ts
// (fieldsApi.ts/linkApi.ts/tagApi.ts before it): apiCalls.tsx is off-limits
// for new call sites, so this is its own isolated module. There is no
// `serviceApi()` helper anywhere in frontend/src -- that name only exists
// in the Playwright test harness -- so every call below goes through
// axiosPrivate with the full `/api/v1/dataset` path, exactly like
// sharedStepApi.ts does for `/api/v1/sharedstep`.
//
// Backed by backend/testRepoService's /api/v1/dataset routes
// (routes/dataset.js), mounted at that exact path by server.js. Secured
// end-to-end by the same keycloak.protect() -> requireProjectScope() ->
// authorize() chain as every other testRepoService route; X-Project-Id is
// added automatically by axiosPrivate's request interceptor, so no
// per-call header wiring is needed here either.

// backend/testRepoService/models/Dataset.js's authoritative shape.
export interface Dataset {
  _id: string;
  id: number;
  DatasetId: string;
  projectId: number;
  title: string;
  description?: string;
  columns: string[];
  rows: string[][];
  createdBy?: string;
  updatedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface DatasetPayload {
  title: string;
  description?: string;
  columns: string[];
  rows: string[][];
}

// The single source of truth for "which test cases reference this
// dataset" -- same shape controllers/dataset.js's findUsage() returns from
// both the usage route and a refused (409) delete.
export interface DatasetUsage {
  count: number;
  testCases: Array<{ TestCaseId: string; TestCaseSummary?: string }>;
}

// controllers/testrepo.js's getTestCaseParameters response shape.
// `missing` = placeholders with no matching column on the bound dataset
// (the error case an author must fix). `unused` = columns nothing
// references (a warning at most, never blocks anything).
export interface TestCaseParameters {
  placeholders: string[];
  columns: string[];
  missing: string[];
  unused: string[];
}

const DATASET_BASE = '/api/v1/dataset';
// Lives here rather than in a separate testRepoApi.ts: this route
// (backend/testRepoService's routes/testrepo.js) is the other half of the
// same bind/preview workflow this task's UI needs, and there is no
// existing module dedicated to testrepo-by-id calls to add it to instead.
const TESTREPO_BASE = '/api/v1/testrepo';

export const listDatasets = async (): Promise<Dataset[]> => {
  const resp = await axiosPrivate.get(DATASET_BASE);
  return resp.data.data;
};

export const getDataset = async (id: string): Promise<Dataset> => {
  const resp = await axiosPrivate.get(`${DATASET_BASE}/${id}`);
  return resp.data.data;
};

export const createDataset = async (body: DatasetPayload): Promise<Dataset> => {
  const resp = await axiosPrivate.post(DATASET_BASE, body);
  return resp.data.data;
};

export const updateDataset = async (id: string, body: DatasetPayload): Promise<Dataset> => {
  const resp = await axiosPrivate.put(`${DATASET_BASE}/${id}`, body);
  return resp.data.data;
};

// Deliberately no try/catch here -- same reasoning as
// sharedStepApi.ts's deleteSharedStep: a dataset still referenced by a
// test case comes back as HTTP 409 with
// `{ success:false, error, data:{ count, testCases } }`
// (controllers/dataset.js's deleteDataset), and axios's rejected error
// already carries that whole body untouched at `error.response.data`.
// Catching and rethrowing a generic Error here would strip `data` (the
// one thing a caller needs to tell the user WHICH test cases are in the
// way) down to a string message -- the exact mistake this module must not
// repeat.
export const deleteDataset = async (id: string): Promise<void> => {
  await axiosPrivate.delete(`${DATASET_BASE}/${id}`);
};

export const getDatasetUsage = async (id: string): Promise<DatasetUsage> => {
  const resp = await axiosPrivate.get(`${DATASET_BASE}/${id}/usage`);
  return resp.data.data;
};

// A test case's own {{placeholders}} vs its bound dataset's columns.
// `testCaseId` is the test case's mongo `_id` (the same id every
// /api/v1/testrepo/:id route reads), not its human-facing TestCaseId.
export const getTestCaseParameters = async (testCaseId: string): Promise<TestCaseParameters> => {
  const resp = await axiosPrivate.get(`${TESTREPO_BASE}/${testCaseId}/parameters`);
  return resp.data.data;
};
