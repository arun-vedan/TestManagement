import axiosPrivate from './axios';

// WP-014: TestPlan enrichment fields (objective/scope/entryCriteria/
// exitCriteria/risk/schedule/environment). Deliberately a *new* module, not
// an addition to apiCalls.tsx -- a concurrent WP is editing that file for
// lint fixes and WP-015 rewrites it wholesale with TanStack Query shortly
// after, so keeping this self-contained avoids both stepping on that work
// and creating churn that WP-015 has to re-untangle. Follows the same
// axiosPrivate + Keycloak-token-interceptor pattern as apiCalls.tsx (see
// ./axios.tsx) -- just isolated to its own file.

export type RiskLevel = 'Low' | 'Medium' | 'High';

export interface TestPlanSchedule {
  // Plain YYYY-MM-DD strings, matching the native <input type="date"> value
  // format the form uses. The backend stores these as Mongoose Dates; a
  // date-only ISO string round-trips losslessly (see the model comment in
  // backend/testPlanExecutionService/models/TestPlan.js) as long as callers
  // only ever send/read the date portion, which is all this form does.
  plannedStart?: string;
  plannedEnd?: string;
}

export interface TestPlanEnrichment {
  objective?: string;
  scope?: string;
  entryCriteria?: string;
  exitCriteria?: string;
  risk?: RiskLevel;
  schedule?: TestPlanSchedule;
  environment?: string;
}

// Fetches a TestPlan by its human-readable TestPlanId (e.g. "PLN-4"), the
// identifier the rest of the test-plan UI already keys off of (see
// TestPlanContent.tsx's use of the same `TestPlanId=` filter via
// getTestPlanList). Unlike that existing call site, this one does not pass
// `select=`, so it returns every field -- including the enrichment fields
// and the Mongo `_id` a subsequent update needs.
export const getTestPlanByPlanId = async (testPlanId: string) => {
  const resp = await axiosPrivate.get(`/api/v1/testplan?TestPlanId=${testPlanId}`);
  return resp.data.data && resp.data.data[0];
};

export const createTestPlanWithDetails = async (payload: Record<string, unknown>) => {
  const resp = await axiosPrivate.post('/api/v1/testplan', payload);
  return resp.data;
};

export const updateTestPlanDetails = async (mongoId: string, payload: TestPlanEnrichment) => {
  const resp = await axiosPrivate.put(`/api/v1/testplan/${mongoId}`, payload);
  return resp.data;
};
