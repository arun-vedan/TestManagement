// Mock before requiring the service
jest.mock('@srckube/service-core', () => ({
  requestWithRetry: jest.fn()
}));

jest.mock('../services/serviceUrls', () => ({
  TEST_PLAN_EXECUTION_SERVICE: 'testPlanExecutionService:8080'
}));

const { computePassRateTrend } = require('../services/passRateTrend');
const { requestWithRetry } = require('@srckube/service-core');

describe('passRateTrend.js — parameterized cases with iterations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should count one result per iteration: 3 iterations (2 passed, 1 failed) reports 67% pass rate', async () => {
    // Create a date for today to ensure it falls in the 30-day window
    const today = new Date();
    const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const todayIso = todayUtc.toISOString();

    // Mock data: a parameterized test case with 3 iterations
    // Each iteration is a separate entry in TestCases[]
    const mockExecutions = [
      {
        _id: 'exec-1',
        TestPlanId: 'plan-1',
        createdAt: todayIso,
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

    requestWithRetry.mockResolvedValueOnce({ data: { data: mockExecutions } });

    const result = await computePassRateTrend(1, {}, 30);

    // Find today's bucket
    const todayKey = todayUtc.toISOString().slice(0, 10);
    const todayIndex = result.xLabels.indexOf(todayKey);

    expect(todayIndex).toBeGreaterThanOrEqual(0);
    // 2 out of 3 iterations passed = 2/3 * 100 = 66.67%
    expect(result.series[0].data[todayIndex]).toBe(66.67);
  });

  it('should handle mixed statuses (some No Run, some executed)', async () => {
    const today = new Date();
    const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const todayIso = todayUtc.toISOString();
    const todayKey = todayUtc.toISOString().slice(0, 10);

    const mockExecutions = [
      {
        _id: 'exec-2',
        TestPlanId: 'plan-1',
        createdAt: todayIso,
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

    const result = await computePassRateTrend(1, {}, 30);

    const todayIndex = result.xLabels.indexOf(todayKey);

    // All 3 are counted, but only 2 are passed (No Run is not Pass)
    // 2 out of 3 = 66.67%
    expect(result.series[0].data[todayIndex]).toBe(66.67);
  });
});

// WP-103 — the stale default-project guard is gone. Before this WP, any
// projectId other than 1 short-circuited to an empty series plus a `note`
// saying testPlanExecutionService had no per-project scoping. That premise
// is false: TestExecution.projectId is required+indexed
// (backend/testPlanExecutionService/models/TestExecution.js) and every
// route in routes/testexecution.js mounts requireProjectScope(), so the
// downstream call is scoped by the forwarded X-Project-Id header and a
// non-1 project returns its own real numbers.
describe('passRateTrend.js — WP-103: non-default projects compute for real', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns a real, non-empty pass-rate series for a project whose id is not 1', async () => {
    const today = new Date();
    const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const todayKey = todayUtc.toISOString().slice(0, 10);

    requestWithRetry.mockResolvedValueOnce({
      data: {
        data: [
          {
            _id: 'exec-p7',
            TestPlanId: 'plan-p7',
            createdAt: todayUtc.toISOString(),
            TestCases: [
              { _id: 'tc-1', TestStatus: 'Pass' },
              { _id: 'tc-2', TestStatus: 'Fail' }
            ]
          }
        ]
      }
    });

    const result = await computePassRateTrend(7, {}, 30);

    // The guard's fingerprints must be gone entirely.
    expect(result.note).toBeUndefined();
    expect(result.xLabels.length).toBe(30);

    // And the numbers must be this project's own real ones.
    const todayIndex = result.xLabels.indexOf(todayKey);
    expect(todayIndex).toBeGreaterThanOrEqual(0);
    expect(result.series[0].data[todayIndex]).toBe(50);
    expect(requestWithRetry).toHaveBeenCalledTimes(1);
  });
});
