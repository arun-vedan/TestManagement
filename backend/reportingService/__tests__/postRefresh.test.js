// WP-F13 Task 2, Step 5 — proving premise 7 is actually caught, not just
// documented in a comment. ReportCache's `reportType` enum
// (models/ReportCache.js) and postRefresh's own `reportTypes` array
// (controllers/reports.js) are TWO SEPARATE lists; adding a type to the
// enum alone compiles, serves, and then never refreshes -- a silent
// staleness bug the brief calls out by name.
//
// This is a controller-level unit test (every cross-service call AND the
// ReportCache model mocked out), not a live one, specifically so it can
// run host-side with no container rebuild and still fail the instant
// 'traceability' is missing from postRefresh's reportTypes array --
// exactly the single-line regression this task's non-vacuity bar asks for.
// The live equivalent (api.test.js's own
// `resp.data.reports).toHaveLength(...)` assertion, updated for this task
// to expect 7) covers the same omission end-to-end against a real running
// stack; this file covers it without one.

jest.mock('../models/ReportCache', () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn().mockResolvedValue({})
}));

jest.mock('../services/coverage', () => ({ computeCoverage: jest.fn().mockResolvedValue({ report: 'coverage' }) }));
jest.mock('../services/passRateTrend', () => ({ computePassRateTrend: jest.fn().mockResolvedValue({ report: 'pass-rate-trend' }) }));
jest.mock('../services/defectSummary', () => ({ computeDefectSummary: jest.fn().mockResolvedValue({ report: 'defect-summary' }) }));
jest.mock('../services/planProgress', () => ({ computePlanProgress: jest.fn().mockResolvedValue({ report: 'plan-progress' }) }));
jest.mock('../services/releaseReadiness', () => ({ computeReleaseReadiness: jest.fn().mockResolvedValue({ report: 'release-readiness' }) }));
jest.mock('../services/workload', () => ({ computeWorkload: jest.fn().mockResolvedValue({ report: 'workload' }) }));
jest.mock('../services/traceability', () => ({ computeTraceability: jest.fn().mockResolvedValue({ report: 'traceability' }) }));
// Required at module load by controllers/reports.js but not exercised by
// postRefresh -- stubbed only so requiring the controller doesn't need a
// live releaseService.
jest.mock('../services/releaseLens', () => ({ computeReleaseLens: jest.fn() }));

const { postRefresh } = require('../controllers/reports');
const ReportCache = require('../models/ReportCache');

function buildReqRes() {
  const req = {
    projectScope: { projectId: 1 },
    headers: { authorization: 'Bearer x' },
    correlationId: 'corr-1'
  };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  return { req, res };
}

describe('postRefresh (WP-F13 Task 2 premise 7)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ReportCache.findOneAndUpdate.mockResolvedValue({});
  });

  // The core assertion: 'traceability' is one of the reports POST /refresh
  // actually recomputes and re-caches, not merely one the schema will
  // accept if handed data directly.
  // BREAKS IF: the `['traceability', computeTraceability]` entry is removed
  // from postRefresh's `reportTypes` array (controllers/reports.js) --
  // confirmed live: removing it drops `reports` to length 6 with no
  // 'traceability' entry, and this assertion goes red. Restored after
  // confirming red (see this task's report for the probe transcript).
  it('recomputes and re-caches traceability alongside the other six reports', async () => {
    const { req, res } = buildReqRes();

    await postRefresh(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(true);
    expect(body.reports).toHaveLength(7);

    const traceabilityEntry = body.reports.find((r) => r.reportType === 'traceability');
    expect(traceabilityEntry).toBeDefined();
    expect(traceabilityEntry.success).toBe(true);

    // And it was actually WRITTEN to the cache under that key, not merely
    // computed and discarded.
    expect(ReportCache.findOneAndUpdate).toHaveBeenCalledWith(
      { projectId: 1, reportType: 'traceability' },
      expect.objectContaining({ data: { report: 'traceability' } }),
      expect.objectContaining({ upsert: true })
    );
  });

  // A failure in computeTraceability alone must not sink the other six --
  // Promise.allSettled's existing per-report isolation, exercised here
  // specifically through the new report type.
  // BREAKS IF: postRefresh is changed to Promise.all (one rejection aborts
  // every report) instead of Promise.allSettled.
  it('a traceability compute failure is reported per-report (207), the other six still succeed', async () => {
    const { computeTraceability } = require('../services/traceability');
    computeTraceability.mockRejectedValueOnce(new Error('requirementService unreachable'));
    const { req, res } = buildReqRes();

    await postRefresh(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(207);
    const body = res.json.mock.calls[0][0];
    expect(body.success).toBe(false);
    const traceabilityEntry = body.reports.find((r) => r.reportType === 'traceability');
    expect(traceabilityEntry).toEqual({ reportType: 'traceability', success: false, error: 'requirementService unreachable' });
    expect(body.reports.filter((r) => r.success)).toHaveLength(6);
  });
});
