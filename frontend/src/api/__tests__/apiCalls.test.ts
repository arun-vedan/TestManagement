import axiosPrivate from '../axios';
import { getWCPlanList, getWCRunList } from '../apiCalls';

// WP-F01 -- these two helpers URL-encode the search text, which the three
// pre-existing WC helpers (getWCTCList/getWCReqList/getWCDefectList) do
// not: an unencoded "&" or "#" is silently truncated in transit. Bringing
// those three into line is deliberately out of this WP's scope.
jest.mock('../axios', () => ({
    __esModule: true,
    default: { get: jest.fn() },
}));

const mockGet = axiosPrivate.get as jest.Mock;

beforeEach(() => {
  mockGet.mockReset();
});

describe('getWCPlanList', () => {
  it('calls the test plan wildcardsearch route and unwraps data.data', async () => {
    mockGet.mockResolvedValue({ data: { success: true, data: [{ TestPlanId: 'PLN-3', objective: 'Verify login' }] } });
    const rows = await getWCPlanList('login');
    expect(mockGet).toHaveBeenCalledWith('api/v1/testplan/wildcardsearch?search=login');
    expect(rows).toEqual([{ TestPlanId: 'PLN-3', objective: 'Verify login' }]);
  });

  it('URL-encodes the search text', async () => {
    mockGet.mockResolvedValue({ data: { success: true, data: [] } });
    await getWCPlanList('a&b');
    expect(mockGet).toHaveBeenCalledWith('api/v1/testplan/wildcardsearch?search=a%26b');
  });
});

describe('getWCRunList', () => {
  it('calls the test run wildcardsearch route and unwraps data.data', async () => {
    mockGet.mockResolvedValue({ data: { success: true, data: [{ TestExecutionId: 'Run-7', assignedTo: 'asha' }] } });
    const rows = await getWCRunList('Run-7');
    expect(mockGet).toHaveBeenCalledWith('api/v1/testexecution/wildcardsearch?search=Run-7');
    expect(rows).toEqual([{ TestExecutionId: 'Run-7', assignedTo: 'asha' }]);
  });
});
