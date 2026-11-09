import { getWCTCList, getWCReqList, getWCDefectList, getWCPlanList, getWCRunList } from '../../../api/apiCalls';
import { moduleSearchConfigs } from '../entitySearchConfigs';

// Wave B-2 (workbench search) -- registry test, mirroring
// entityListConfigs.ts's own coverage shape: "this module supports X, that
// one doesn't". Backend wildcard search is VERIFIED (by reading the
// controllers directly) to exist for modules 1 (testRepoService), 2
// (requirementService), 3 and 4 (both testPlanExecutionService) and 5
// (defectService). Module 6 (releases) has none: no wildcardsearch route
// exists in releaseService, so that entry must stay undefined, never a
// fabricated client-side filter over a page of results.

jest.mock('../../../api/apiCalls', () => ({
    getWCTCList: jest.fn(),
    getWCReqList: jest.fn(),
    getWCDefectList: jest.fn(),
    getWCPlanList: jest.fn(),
    getWCRunList: jest.fn(),
}));

const mockGetWCTCList = getWCTCList as jest.Mock;
const mockGetWCReqList = getWCReqList as jest.Mock;
const mockGetWCDefectList = getWCDefectList as jest.Mock;
const mockGetWCPlanList = getWCPlanList as jest.Mock;
const mockGetWCRunList = getWCRunList as jest.Mock;

beforeEach(() => {
    jest.clearAllMocks();
});

describe('moduleSearchConfigs', () => {
    it('has a config for module 1 (test cases) that maps getWCTCList rows to {id, title}', async () => {
        mockGetWCTCList.mockResolvedValue([
            { _id: 'm1', TestCaseId: 'TC-104', TestCaseSummary: 'Login works', projectId: 1 },
        ]);
        const config = moduleSearchConfigs[1];
        expect(config).toBeDefined();
        const results = await config!.search('login');
        expect(mockGetWCTCList).toHaveBeenCalledWith('login');
        expect(results).toEqual([{ id: 'TC-104', title: 'TC-104', summary: 'Login works' }]);
    });

    it('has a config for module 2 (requirements) that maps getWCReqList rows to {id, title}', async () => {
        mockGetWCReqList.mockResolvedValue([
            { _id: 'm2', reqId: 'REQ-8', requirementSummary: 'Must log in', projectId: 1 },
        ]);
        const config = moduleSearchConfigs[2];
        expect(config).toBeDefined();
        const results = await config!.search('log');
        expect(mockGetWCReqList).toHaveBeenCalledWith('log');
        expect(results).toEqual([{ id: 'REQ-8', title: 'REQ-8', summary: 'Must log in' }]);
    });

    it('has a config for module 5 (defects) that maps getWCDefectList rows to {id, title}', async () => {
        mockGetWCDefectList.mockResolvedValue([
            { _id: 'm5', defectId: 'DEF-3', summary: 'Login button broken', projectId: 1 },
        ]);
        const config = moduleSearchConfigs[5];
        expect(config).toBeDefined();
        const results = await config!.search('broken');
        expect(mockGetWCDefectList).toHaveBeenCalledWith('broken');
        expect(results).toEqual([{ id: 'DEF-3', title: 'DEF-3', summary: 'Login button broken' }]);
    });

    it('has a config for module 3 (test plans) that maps getWCPlanList rows to {id, title}', async () => {
        mockGetWCPlanList.mockResolvedValue([
            { _id: 'm3', TestPlanId: 'PLN-3', objective: 'Verify login', projectId: 1 },
        ]);
        const config = moduleSearchConfigs[3];
        expect(config).toBeDefined();
        const results = await config!.search('login');
        expect(mockGetWCPlanList).toHaveBeenCalledWith('login');
        expect(results).toEqual([{ id: 'PLN-3', title: 'PLN-3', summary: 'Verify login' }]);
    });

    it('has a config for module 3 that tolerates a plan with no objective', async () => {
        // objective is optional on TestPlan -- a plan created before the
        // WP-025 enrichment fields existed has none.
        mockGetWCPlanList.mockResolvedValue([{ _id: 'm3', TestPlanId: 'PLN-1', projectId: 1 }]);
        const results = await moduleSearchConfigs[3]!.search('PLN');
        expect(results).toEqual([{ id: 'PLN-1', title: 'PLN-1', summary: '' }]);
    });

    it('has a config for module 4 (test runs) that maps getWCRunList rows to {id, title}', async () => {
        mockGetWCRunList.mockResolvedValue([
            { _id: 'm4', TestExecutionId: 'Run-7', assignedTo: 'c16a3041-919f-482f-a027-0b18060aa536', projectId: 1 },
        ]);
        const config = moduleSearchConfigs[4];
        expect(config).toBeDefined();
        const results = await config!.search('Run-7');
        expect(mockGetWCRunList).toHaveBeenCalledWith('Run-7');
        expect(results).toEqual([{ id: 'Run-7', title: 'Run-7', summary: '' }]);
    });

    it('never puts a run\'s assignedTo in the result line -- it is a Keycloak UUID, not a name', async () => {
        // Regression guard for WP-F01's Ruling 2. assignedTo looks like a
        // descriptive field and is not one; a future change that
        // "helpfully" surfaces it would put a UUID in front of a user.
        mockGetWCRunList.mockResolvedValue([
            { _id: 'm4', TestExecutionId: 'Run-2', assignedTo: 'b8c153e0-1230-4990-908e-aa6bf98e4587', projectId: 1 },
        ]);
        const results = await moduleSearchConfigs[4]!.search('Run-2');
        expect(results[0].summary).toBe('');
        expect(JSON.stringify(results)).not.toContain('b8c153e0');
    });

    it('has NO config for module 6 (releases)', () => {
        expect(moduleSearchConfigs[6]).toBeUndefined();
    });
});
