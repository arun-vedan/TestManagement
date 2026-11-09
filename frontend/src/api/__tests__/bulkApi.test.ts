// WP-F03c -- unit coverage for the requirement/test-plan/test-execution
// bulk client functions added to api/bulkApi.ts, mocking axiosPrivate
// directly (same technique as api/__tests__/aiApi.test.ts's default-export
// mock, adapted to bulkApi.ts's private bulkRequest() helper, which calls
// axiosPrivate.request({method, url, data, validateStatus}) rather than
// the per-verb post()/delete() shortcuts aiApi.ts uses).
//
// THE POINT: prove each new function hits the exact Task 1/2 backend
// contract (method + URL + body) and that the shared bulkRequest() 422
// path (BulkPolicyError) is reused, not re-implemented, for these new
// entities too.

import axiosPrivate from '../axios';
import {
    bulkUpdateRequirementStatus,
    bulkDeleteRequirements,
    bulkDeleteTestPlans,
    bulkAssignTestRuns,
    bulkDeleteTestRuns,
    BulkPolicyError
} from '../bulkApi';

jest.mock('../axios', () => ({
    __esModule: true,
    default: { request: jest.fn() }
}));

const mockedRequest = axiosPrivate.request as jest.Mock;

describe('api/bulkApi.ts -- requirements, test plans, test runs', () => {
    beforeEach(() => {
        mockedRequest.mockReset();
    });

    describe('bulkUpdateRequirementStatus', () => {
        it('PATCHes /api/v1/requirement/bulk with action:status', async () => {
            mockedRequest.mockResolvedValueOnce({ status: 200, data: { success: true, policy: 'all-or-nothing', updated: 2 } });

            const result = await bulkUpdateRequirementStatus(['r1', 'r2'], 'approved');

            expect(mockedRequest).toHaveBeenCalledWith({
                method: 'patch',
                url: '/api/v1/requirement/bulk',
                data: { ids: ['r1', 'r2'], action: 'status', status: 'approved' },
                validateStatus: expect.any(Function)
            });
            expect(result).toEqual({ success: true, policy: 'all-or-nothing', updated: 2 });
        });
    });

    describe('bulkDeleteRequirements', () => {
        it('DELETEs /api/v1/requirement/bulk with just ids', async () => {
            mockedRequest.mockResolvedValueOnce({ status: 200, data: { success: true, policy: 'all-or-nothing', deleted: 3 } });

            const result = await bulkDeleteRequirements(['r1', 'r2', 'r3']);

            expect(mockedRequest).toHaveBeenCalledWith({
                method: 'delete',
                url: '/api/v1/requirement/bulk',
                data: { ids: ['r1', 'r2', 'r3'] },
                validateStatus: expect.any(Function)
            });
            expect(result).toEqual({ success: true, policy: 'all-or-nothing', deleted: 3 });
        });
    });

    describe('bulkDeleteTestPlans', () => {
        it('DELETEs /api/v1/testplan/bulk with just ids', async () => {
            mockedRequest.mockResolvedValueOnce({ status: 200, data: { success: true, policy: 'all-or-nothing', deleted: 1 } });

            const result = await bulkDeleteTestPlans(['p1']);

            expect(mockedRequest).toHaveBeenCalledWith({
                method: 'delete',
                url: '/api/v1/testplan/bulk',
                data: { ids: ['p1'] },
                validateStatus: expect.any(Function)
            });
            expect(result).toEqual({ success: true, policy: 'all-or-nothing', deleted: 1 });
        });
    });

    describe('bulkAssignTestRuns', () => {
        it('PATCHes /api/v1/testexecution/bulk with action:assign', async () => {
            mockedRequest.mockResolvedValueOnce({ status: 200, data: { success: true, policy: 'all-or-nothing', updated: 5 } });

            const result = await bulkAssignTestRuns(['e1', 'e2'], 'user-9');

            expect(mockedRequest).toHaveBeenCalledWith({
                method: 'patch',
                url: '/api/v1/testexecution/bulk',
                data: { ids: ['e1', 'e2'], action: 'assign', assignedTo: 'user-9' },
                validateStatus: expect.any(Function)
            });
            expect(result).toEqual({ success: true, policy: 'all-or-nothing', updated: 5 });
        });
    });

    describe('bulkDeleteTestRuns', () => {
        it('DELETEs /api/v1/testexecution/bulk with just ids', async () => {
            mockedRequest.mockResolvedValueOnce({ status: 200, data: { success: true, policy: 'all-or-nothing', deleted: 4 } });

            const result = await bulkDeleteTestRuns(['e1', 'e2', 'e3', 'e4']);

            expect(mockedRequest).toHaveBeenCalledWith({
                method: 'delete',
                url: '/api/v1/testexecution/bulk',
                data: { ids: ['e1', 'e2', 'e3', 'e4'] },
                validateStatus: expect.any(Function)
            });
            expect(result).toEqual({ success: true, policy: 'all-or-nothing', deleted: 4 });
        });
    });

    // The 422 all-or-nothing path is bulkRequest()'s shared behavior,
    // already covered structurally for test cases/defects; this proves
    // the new functions route through the SAME helper rather than a
    // reimplementation that could silently diverge (e.g. swallow
    // missingIds), for one representative new function.
    it('bulkDeleteRequirements throws BulkPolicyError with missingIds on a 422', async () => {
        mockedRequest.mockResolvedValueOnce({
            status: 422,
            data: { success: false, policy: 'all-or-nothing', error: 'Some ids not found', missingIds: ['r-ghost'] }
        });

        let caught: unknown;
        try {
            await bulkDeleteRequirements(['r1', 'r-ghost']);
        } catch (err) {
            caught = err;
        }

        expect(caught).toBeInstanceOf(BulkPolicyError);
        expect((caught as BulkPolicyError).missingIds).toEqual(['r-ghost']);
    });
});
