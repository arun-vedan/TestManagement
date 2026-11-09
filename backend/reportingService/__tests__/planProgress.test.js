// Mock before requiring the service
jest.mock('@srckube/service-core', () => ({
  requestWithRetry: jest.fn()
}));

jest.mock('../services/serviceUrls', () => ({
  TEST_PLAN_EXECUTION_SERVICE: 'testPlanExecutionService:8080'
}));

const { computePlanProgress } = require('../services/planProgress');
const { requestWithRetry } = require('@srckube/service-core');

describe('planProgress.js — parameterized cases with iterations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should count one result per iteration: 3 iterations (2 passed, 1 failed) reports 3 executed / 2 passed', async () => {
    const planId = 'plan-1';
    const executionId = 'exec-1';

    // Mock data: a parameterized test case with 3 iterations
    // Each iteration is a separate entry in TestCases[]
    const mockPlans = [
      {
        _id: planId,
        TestPlanId: 'PLN-PARAM',
        id: 1
      }
    ];

    const mockExecutions = [
      {
        _id: executionId,
        TestPlanId: planId,
        TestCases: [
          {
            _id: 'tc-1',
            TestName: 'Parameterized Case',
            TestStatus: 'Pass',
            iterationIndex: 0
          },
          {
            _id: 'tc-2',
            TestName: 'Parameterized Case',
            TestStatus: 'Pass',
            iterationIndex: 1
          },
          {
            _id: 'tc-3',
            TestName: 'Parameterized Case',
            TestStatus: 'Fail',
            iterationIndex: 2
          }
        ]
      }
    ];

    requestWithRetry
      .mockResolvedValueOnce({ data: { data: mockPlans } }) // /testplan
      .mockResolvedValueOnce({ data: { data: mockExecutions } }); // /testexecution

    const result = await computePlanProgress(1);

    expect(result.categories).toContain('PLN-PARAM');
    const planIndex = result.categories.indexOf('PLN-PARAM');

    // Should count all 3 iterations
    expect(result.series.find(s => s.id === 'executed').data[planIndex]).toBe(3);
    // 2 of 3 are passed
    expect(result.series.find(s => s.id === 'passed').data[planIndex]).toBe(2);
    // none are blocked
    expect(result.series.find(s => s.id === 'blocked').data[planIndex]).toBe(0);
  });

  it('should handle mixed statuses (some No Run, some executed)', async () => {
    const planId = 'plan-2';
    const executionId = 'exec-2';

    const mockPlans = [
      {
        _id: planId,
        TestPlanId: 'PLN-MIXED',
        id: 1
      }
    ];

    const mockExecutions = [
      {
        _id: executionId,
        TestPlanId: planId,
        TestCases: [
          {
            _id: 'tc-1',
            TestName: 'Parameterized Case',
            TestStatus: 'Pass',
            iterationIndex: 0
          },
          {
            _id: 'tc-2',
            TestName: 'Parameterized Case',
            TestStatus: 'No Run',
            iterationIndex: 1
          },
          {
            _id: 'tc-3',
            TestName: 'Parameterized Case',
            TestStatus: 'Pass',
            iterationIndex: 2
          }
        ]
      }
    ];

    requestWithRetry
      .mockResolvedValueOnce({ data: { data: mockPlans } })
      .mockResolvedValueOnce({ data: { data: mockExecutions } });

    const result = await computePlanProgress(1);

    const planIndex = result.categories.indexOf('PLN-MIXED');

    // Should count only executed (Pass/Fail), not 'No Run'
    expect(result.series.find(s => s.id === 'executed').data[planIndex]).toBe(2);
    expect(result.series.find(s => s.id === 'passed').data[planIndex]).toBe(2);
  });
});

// WP-103 — see passRateTrend.test.js's WP-103 block for why the
// default-project guard's premise was false. Same assertion for plan
// progress: a non-1 project computes for real instead of short-circuiting.
describe('planProgress.js — WP-103: non-default projects compute for real', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns real, non-empty plan progress for a project whose id is not 1', async () => {
    const mockPlans = [{ _id: 'plan-p7', TestPlanId: 'PLN-P7', id: 1 }];
    const mockExecutions = [
      {
        _id: 'exec-p7',
        TestPlanId: 'plan-p7',
        TestCases: [
          { _id: 'tc-1', TestStatus: 'Pass' },
          { _id: 'tc-2', TestStatus: 'Fail' },
          { _id: 'tc-3', TestStatus: 'No Run' }
        ]
      }
    ];

    requestWithRetry
      .mockResolvedValueOnce({ data: { data: mockPlans } })
      .mockResolvedValueOnce({ data: { data: mockExecutions } });

    const result = await computePlanProgress(7);

    expect(result.note).toBeUndefined();
    expect(result.categories).toEqual(['PLN-P7']);

    const planIndex = result.categories.indexOf('PLN-P7');
    expect(result.series.find((s) => s.id === 'executed').data[planIndex]).toBe(2);
    expect(result.series.find((s) => s.id === 'passed').data[planIndex]).toBe(1);
    expect(requestWithRetry).toHaveBeenCalledTimes(2);
  });
});
