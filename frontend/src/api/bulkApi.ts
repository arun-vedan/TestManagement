import axiosPrivate from './axios';

// WP-043 — bulk-operation frontend client, originally for test cases
// (testRepoService) and defects (defectService), extended by WP-F03c to
// requirements (requirementService) and test plans/test runs
// (testPlanExecutionService). A *new* module (apiCalls.tsx is off-limits,
// WP-015/WP-025 precedent). Backed by:
//   PATCH/DELETE /api/v1/testrepo/bulk       (backend/testRepoService/
//     controllers/testrepo.js#bulkUpdateTestCases/bulkDeleteTestCases)
//   PATCH/DELETE /api/v1/defects/bulk        (backend/defectService/
//     controllers/defects.js#bulkUpdateDefects/bulkDeleteDefects)
//   PATCH/DELETE /api/v1/requirement/bulk    (backend/requirementService/
//     controllers/requirement.js#bulkUpdateRequirements/bulkDeleteRequirements)
//   DELETE /api/v1/testplan/bulk             (backend/testPlanExecutionService/
//     controllers/testplan.js#bulkDeleteTestPlans)
//   PATCH/DELETE /api/v1/testexecution/bulk  (backend/testPlanExecutionService/
//     controllers/testexecution.js#bulkUpdateTestExecutions/bulkDeleteTestExecutions)
//
// PARTIAL-FAILURE POLICY: every response below carries `policy:
// "all-or-nothing"` verbatim from the backend (see those controllers'
// header comments) -- either every item in the batch is changed, or (on
// any single item failing validation) NOTHING is. The bulk confirmation
// dialog (Components/common/BulkActionBar.tsx) states this exact policy to
// the user before they commit, so the dialog's promise and the backend's
// actual behavior can never diverge -- same discipline WP-045's CSV import
// preview/commit pair already established.

export interface BulkResponse<T> {
    success: boolean;
    policy: 'all-or-nothing';
    updated?: number;
    deleted?: number;
    data?: T[];
}

// A 422 all-or-nothing rejection. Thrown as a typed error (not just left
// as an axios error) so the caller's confirmation-dialog error path can
// read `.error`/`.missingIds`/`.invalidIds` without re-parsing an axios
// response shape at every call site.
export class BulkPolicyError extends Error {
    policy: 'all-or-nothing';
    missingIds?: string[];
    invalidIds?: string[];

    constructor(message: string, details: { missingIds?: string[]; invalidIds?: string[] } = {}) {
        super(message);
        this.name = 'BulkPolicyError';
        this.policy = 'all-or-nothing';
        this.missingIds = details.missingIds;
        this.invalidIds = details.invalidIds;
    }
}

async function bulkRequest<T>(method: 'patch' | 'delete', url: string, body: Record<string, unknown>): Promise<BulkResponse<T>> {
    const resp = await axiosPrivate.request({ method, url, data: body, validateStatus: () => true });
    if (resp.status === 422) {
        throw new BulkPolicyError(resp.data?.error || 'Bulk operation rejected: not every item was valid', {
            missingIds: resp.data?.missingIds,
            invalidIds: resp.data?.invalidIds
        });
    }
    if (resp.status < 200 || resp.status >= 300) {
        throw new Error(resp.data?.error || `Bulk operation failed (${resp.status})`);
    }
    return resp.data;
}

// -- Test cases (testRepoService) --------------------------------------

export const bulkAssignTestCases = (ids: string[], assignedTo: string) =>
    bulkRequest('patch', '/api/v1/testrepo/bulk', { ids, action: 'assign', assignedTo });

export const bulkUpdateTestCaseStatus = (ids: string[], status: string) =>
    bulkRequest('patch', '/api/v1/testrepo/bulk', { ids, action: 'status', status });

export const bulkDeleteTestCases = (ids: string[]) => bulkRequest('delete', '/api/v1/testrepo/bulk', { ids });

// -- Defects (defectService) ---------------------------------------------
// No bulk status-change for defects -- see defectService/controllers/
// defects.js's header comment on bulkUpdateDefects for why (istatusservice
// graph validation per item, judged out of this WP's proven-need scope).

export const bulkAssignDefects = (ids: string[], assignedTo: string) =>
    bulkRequest('patch', '/api/v1/defects/bulk', { ids, action: 'assign', assignedTo });

export const bulkDeleteDefects = (ids: string[]) => bulkRequest('delete', '/api/v1/defects/bulk', { ids });

// -- Requirements (requirementService) ---------------------------------
// WP-F03. No assign: requirements carry no assignedTo field.

export const bulkUpdateRequirementStatus = (ids: string[], status: string) =>
    bulkRequest('patch', '/api/v1/requirement/bulk', { ids, action: 'status', status });

export const bulkDeleteRequirements = (ids: string[]) => bulkRequest('delete', '/api/v1/requirement/bulk', { ids });

// -- Test plans (testPlanExecutionService) ------------------------------
// WP-F03. Delete only: TestPlan has neither status nor assignedTo.

export const bulkDeleteTestPlans = (ids: string[]) => bulkRequest('delete', '/api/v1/testplan/bulk', { ids });

// -- Test runs (testPlanExecutionService) -------------------------------
// WP-F03. Assign only on the update side: TestExecution has no lifecycle status.

export const bulkAssignTestRuns = (ids: string[], assignedTo: string) =>
    bulkRequest('patch', '/api/v1/testexecution/bulk', { ids, action: 'assign', assignedTo });

export const bulkDeleteTestRuns = (ids: string[]) => bulkRequest('delete', '/api/v1/testexecution/bulk', { ids });
