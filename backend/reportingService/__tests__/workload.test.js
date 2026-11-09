// Mock before requiring the service
jest.mock('@srckube/service-core', () => ({
  requestWithRetry: jest.fn()
}));

jest.mock('../services/serviceUrls', () => ({
  TEST_PLAN_EXECUTION_SERVICE: 'testPlanExecutionService:8080'
}));

const { computeWorkload } = require('../services/workload');
const { requestWithRetry } = require('@srckube/service-core');

describe('workload.js — parameterized cases with iterations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should count a run as one assigned execution, regardless of iteration count', async () => {
    const userId = 'user-1';

    const mockExecutions = [
      {
        _id: 'exec-1',
        TestPlanId: 'plan-1',
        assignedTo: userId,
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
            TestStatus: 'Pass',
            iterationIndex: 2
          }
        ]
      }
    ];

    requestWithRetry.mockResolvedValueOnce({ data: { data: mockExecutions } });

    const result = await computeWorkload(1);

    const userIndex = result.categories.indexOf(userId);
    expect(userIndex).toBeGreaterThanOrEqual(0);

    // One execution assigned, one execution completed (all iterations are terminal)
    expect(result.series.find(s => s.id === 'assigned').data[userIndex]).toBe(1);
    expect(result.series.find(s => s.id === 'completed').data[userIndex]).toBe(1);
  });

  it('should mark as NOT completed if any iteration is not terminal (No Run)', async () => {
    const userId = 'user-2';

    const mockExecutions = [
      {
        _id: 'exec-2',
        TestPlanId: 'plan-1',
        assignedTo: userId,
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

    requestWithRetry.mockResolvedValueOnce({ data: { data: mockExecutions } });

    const result = await computeWorkload(1);

    const userIndex = result.categories.indexOf(userId);
    expect(userIndex).toBeGreaterThanOrEqual(0);

    // One execution assigned, but NOT completed because one iteration is 'No Run'
    expect(result.series.find(s => s.id === 'assigned').data[userIndex]).toBe(1);
    expect(result.series.find(s => s.id === 'completed').data[userIndex]).toBe(0);
  });

  it('should mark as NOT completed if any iteration is InProgress', async () => {
    const userId = 'user-3';

    const mockExecutions = [
      {
        _id: 'exec-3',
        TestPlanId: 'plan-1',
        assignedTo: userId,
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
            TestStatus: 'InProgress',
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

    requestWithRetry.mockResolvedValueOnce({ data: { data: mockExecutions } });

    const result = await computeWorkload(1);

    const userIndex = result.categories.indexOf(userId);
    expect(userIndex).toBeGreaterThanOrEqual(0);

    // One execution assigned, but NOT completed because one iteration is InProgress
    expect(result.series.find(s => s.id === 'assigned').data[userIndex]).toBe(1);
    expect(result.series.find(s => s.id === 'completed').data[userIndex]).toBe(0);
  });

  it('should be completed when all iterations reach terminal state (Pass/Fail)', async () => {
    const userId = 'user-4';

    const mockExecutions = [
      {
        _id: 'exec-4',
        TestPlanId: 'plan-1',
        assignedTo: userId,
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
            TestStatus: 'Fail',
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

    requestWithRetry.mockResolvedValueOnce({ data: { data: mockExecutions } });

    const result = await computeWorkload(1);

    const userIndex = result.categories.indexOf(userId);
    expect(userIndex).toBeGreaterThanOrEqual(0);

    // One execution assigned and completed (all iterations are terminal: Pass or Fail)
    expect(result.series.find(s => s.id === 'assigned').data[userIndex]).toBe(1);
    expect(result.series.find(s => s.id === 'completed').data[userIndex]).toBe(1);
  });
});

// WP-103 — see passRateTrend.test.js's WP-103 block for why the
// default-project guard's premise was false. Same assertion for tester
// workload: a non-1 project computes for real instead of short-circuiting.
describe('workload.js — WP-103: non-default projects compute for real', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns real, non-empty workload for a project whose id is not 1', async () => {
    requestWithRetry.mockResolvedValueOnce({
      data: {
        data: [
          {
            _id: 'exec-p7',
            assignedTo: 'tester-p7',
            TestCases: [
              { _id: 'tc-1', TestStatus: 'Pass' },
              { _id: 'tc-2', TestStatus: 'Fail' }
            ]
          }
        ]
      }
    });

    const result = await computeWorkload(7);

    expect(result.note).toBeUndefined();
    expect(result.categories).toEqual(['tester-p7']);

    const userIndex = result.categories.indexOf('tester-p7');
    expect(result.series.find((s) => s.id === 'assigned').data[userIndex]).toBe(1);
    expect(result.series.find((s) => s.id === 'completed').data[userIndex]).toBe(1);
    expect(requestWithRetry).toHaveBeenCalledTimes(1);
  });
});
