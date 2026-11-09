// WP-F07a Task 4 -- unit coverage for the dataset library client
// functions added to api/datasetApi.ts, mocking axiosPrivate directly
// (same technique as api/__tests__/bulkApi.test.ts, adapted to this
// module's per-verb get()/post()/put()/delete() shortcuts rather than a
// single request() helper).
//
// THE POINT: prove each function hits the exact backend contract (method
// + URL) this task's brief specifies, and that a 409 delete refusal's
// `data.testCases` survives untouched all the way to the caller -- the
// same "don't collapse the usage payload to a string" contract
// sharedStepApi.ts's own header comment establishes.

import axiosPrivate from '../axios';
import {
    listDatasets,
    getDataset,
    createDataset,
    updateDataset,
    deleteDataset,
    getDatasetUsage,
    getTestCaseParameters,
    DatasetPayload
} from '../datasetApi';

jest.mock('../axios', () => ({
    __esModule: true,
    default: {
        get: jest.fn(),
        post: jest.fn(),
        put: jest.fn(),
        delete: jest.fn()
    }
}));

const mockGet = axiosPrivate.get as jest.Mock;
const mockPost = axiosPrivate.post as jest.Mock;
const mockPut = axiosPrivate.put as jest.Mock;
const mockDelete = axiosPrivate.delete as jest.Mock;

beforeEach(() => {
    jest.clearAllMocks();
});

describe('api/datasetApi.ts', () => {
    it('listDatasets GETs /api/v1/dataset and unwraps data', async () => {
        mockGet.mockResolvedValueOnce({ data: { success: true, data: [{ _id: 'd1' }] } });
        const result = await listDatasets();
        expect(mockGet).toHaveBeenCalledWith('/api/v1/dataset');
        expect(result).toEqual([{ _id: 'd1' }]);
    });

    it('getDataset GETs /api/v1/dataset/:id', async () => {
        mockGet.mockResolvedValueOnce({ data: { success: true, data: { _id: 'd1' } } });
        const result = await getDataset('d1');
        expect(mockGet).toHaveBeenCalledWith('/api/v1/dataset/d1');
        expect(result).toEqual({ _id: 'd1' });
    });

    it('createDataset POSTs /api/v1/dataset with the payload', async () => {
        const payload: DatasetPayload = { title: 'Roles', columns: ['role'], rows: [['admin']] };
        mockPost.mockResolvedValueOnce({ data: { success: true, data: { _id: 'd9', ...payload } } });
        const result = await createDataset(payload);
        expect(mockPost).toHaveBeenCalledWith('/api/v1/dataset', payload);
        expect(result).toEqual({ _id: 'd9', ...payload });
    });

    it('updateDataset PUTs /api/v1/dataset/:id with the payload', async () => {
        const payload: DatasetPayload = { title: 'Roles v2', columns: ['role'], rows: [] };
        mockPut.mockResolvedValueOnce({ data: { success: true, data: { _id: 'd1', ...payload } } });
        const result = await updateDataset('d1', payload);
        expect(mockPut).toHaveBeenCalledWith('/api/v1/dataset/d1', payload);
        expect(result).toEqual({ _id: 'd1', ...payload });
    });

    it('deleteDataset DELETEs /api/v1/dataset/:id', async () => {
        mockDelete.mockResolvedValueOnce({ data: { success: true, data: {} } });
        await deleteDataset('d1');
        expect(mockDelete).toHaveBeenCalledWith('/api/v1/dataset/d1');
    });

    // The contract this task's brief calls out by name: a 409's
    // `data.testCases` must reach the caller untouched, not collapsed
    // into a generic thrown Error. deleteDataset has no try/catch at all
    // (see its own header comment), so this proves the rejection's shape
    // survives, not just that SOME rejection happens.
    it('deleteDataset rejects with the 409 body intact, including data.testCases', async () => {
        const rejection = {
            response: {
                status: 409,
                data: {
                    success: false,
                    error: 'DS-1 is used by 2 test case(s) and cannot be deleted',
                    data: { count: 2, testCases: [{ TestCaseId: 'TC-1' }, { TestCaseId: 'TC-2' }] }
                }
            }
        };
        mockDelete.mockRejectedValueOnce(rejection);

        await expect(deleteDataset('d1')).rejects.toBe(rejection);
    });

    it('getDatasetUsage GETs /api/v1/dataset/:id/usage', async () => {
        mockGet.mockResolvedValueOnce({ data: { success: true, data: { count: 0, testCases: [] } } });
        const result = await getDatasetUsage('d1');
        expect(mockGet).toHaveBeenCalledWith('/api/v1/dataset/d1/usage');
        expect(result).toEqual({ count: 0, testCases: [] });
    });

    it('getTestCaseParameters GETs /api/v1/testrepo/:id/parameters', async () => {
        const params = { placeholders: ['role'], columns: ['role'], missing: [], unused: [] };
        mockGet.mockResolvedValueOnce({ data: { success: true, data: params } });
        const result = await getTestCaseParameters('tc-mongo-id');
        expect(mockGet).toHaveBeenCalledWith('/api/v1/testrepo/tc-mongo-id/parameters');
        expect(result).toEqual(params);
    });
});
