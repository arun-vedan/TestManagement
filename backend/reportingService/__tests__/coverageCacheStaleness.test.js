// WP-F13 final fix round, Finding 5 -- ReportCache carries no payload
// version, and getOrCompute (controllers/reports.js) serves any entry
// younger than REPORT_STALE_MS verbatim, by age alone. WP-F13 Task 1
// changed `coverage`'s own payload shape (added `segments`, replaced the
// old two-slice `breakdown.data` with today's four-way one) with no
// migration of documents already sitting in ReportCache from before that
// change. For up to REPORT_STALE_MS after a deploy, a pre-existing
// `coverage` entry (no `segments` field at all) would have been read as
// fresh and served as-is: two tiles instead of four, and the matrix's
// Segment column showing a raw, unmapped id instead of a label.
//
// controllers/reports.js's `isStaleShape` (exported for this test) is the
// fix: a cached `coverage` document with no `segments` is always stale,
// regardless of computedAt, so the first GET after a deploy recomputes and
// re-shapes it rather than trusting age alone.
//
// BREAKS IF: `isStaleShape` is reverted to `false` (or the `!isStaleShape`
// check is dropped from getOrCompute's `isFresh` expression) -- confirmed
// live by doing exactly that and re-running: the "serves a pre-WP-F13
// coverage entry verbatim" test below would then pass (wrongly) instead of
// the fixed behaviour being exercised. See this task's final-fix-report.md
// for the revert-and-confirm-red transcript.

jest.mock('../models/ReportCache', () => ({
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn().mockResolvedValue({})
}));
jest.mock('../services/coverage', () => ({ computeCoverage: jest.fn() }));
jest.mock('../services/passRateTrend', () => ({ computePassRateTrend: jest.fn() }));
jest.mock('../services/defectSummary', () => ({ computeDefectSummary: jest.fn() }));
jest.mock('../services/planProgress', () => ({ computePlanProgress: jest.fn() }));
jest.mock('../services/releaseReadiness', () => ({ computeReleaseReadiness: jest.fn() }));
jest.mock('../services/workload', () => ({ computeWorkload: jest.fn() }));
jest.mock('../services/traceability', () => ({ computeTraceability: jest.fn() }));
jest.mock('../services/releaseLens', () => ({ computeReleaseLens: jest.fn() }));

const ReportCache = require('../models/ReportCache');
const { getCoverage, isStaleShape } = require('../controllers/reports');
const { computeCoverage } = require('../services/coverage');

function buildReqRes() {
  const req = {
    projectScope: { projectId: 1 },
    headers: { authorization: 'Bearer x' },
    correlationId: 'corr-1'
  };
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  return { req, res };
}

describe('isStaleShape (unit)', () => {
  it('a coverage entry with no segments is stale, regardless of the reportType label matching', () => {
    expect(isStaleShape('coverage', { data: { tested: 2, untested: 3 } })).toBe(true);
    expect(isStaleShape('coverage', { data: {} })).toBe(true);
    expect(isStaleShape('coverage', { data: null })).toBe(true);
  });

  it('a coverage entry that already has segments is not stale-by-shape', () => {
    expect(isStaleShape('coverage', { data: { segments: { noTestsLinked: 1 } } })).toBe(false);
  });

  it('only applies to coverage -- another report type missing an unrelated field is not affected', () => {
    expect(isStaleShape('workload', { data: {} })).toBe(false);
  });

  it('no cached entry at all is not "stale-by-shape" (getOrCompute already treats no entry as not-fresh)', () => {
    expect(isStaleShape('coverage', null)).toBe(false);
    expect(isStaleShape('coverage', undefined)).toBe(false);
  });

  // WP-103 -- the same class of bug as Finding 5 above, on the three report
  // types whose stale default-project guard WP-103 deleted. Those guards
  // cached an empty payload carrying a `note` for every projectId but 1, so
  // without this the deleted guard's own output would still be served as
  // `stale:false` for up to REPORT_STALE_MS after the deploy -- for exactly
  // the projects the WP was meant to fix.
  it('a guard-era cached payload carrying a `note` is stale for all three ex-guarded report types', () => {
    const guardEra = { data: { categories: [], series: [], note: 'testPlanExecutionService has no per-project scoping yet' } };
    expect(isStaleShape('pass-rate-trend', guardEra)).toBe(true);
    expect(isStaleShape('plan-progress', guardEra)).toBe(true);
    expect(isStaleShape('workload', guardEra)).toBe(true);
  });

  it('a post-WP-103 payload for those types (no `note`) is not stale-by-shape', () => {
    const real = { data: { categories: ['PLN-1'], series: [{ id: 'executed', data: [2] }] } };
    expect(isStaleShape('pass-rate-trend', real)).toBe(false);
    expect(isStaleShape('plan-progress', real)).toBe(false);
    expect(isStaleShape('workload', real)).toBe(false);
  });

  it('a `note` on a report type that never had a guard is not treated as stale', () => {
    expect(isStaleShape('defect-summary', { data: { note: 'something else entirely' } })).toBe(false);
    expect(isStaleShape('release-readiness', { data: { note: 'something else entirely' } })).toBe(false);
  });
});

describe('getCoverage recomputes a pre-WP-F13 cache entry instead of serving it verbatim (Finding 5)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('a fresh-by-age but old-shape (no segments) cache entry triggers a synchronous recompute', async () => {
    const oldShapeEntry = {
      computedAt: new Date(), // as fresh as it gets by age alone
      data: { label: 'Requirement coverage', total: 5, tested: 2, untested: 3, breakdown: { data: [{ id: 'tested' }, { id: 'untested' }] } }
    };
    ReportCache.findOne.mockResolvedValue(oldShapeEntry);
    computeCoverage.mockResolvedValue({ label: 'Requirement coverage', total: 5, segments: { noTestsLinked: 3 } });

    const { req, res } = buildReqRes();
    await getCoverage(req, res, jest.fn());

    // The compute function WAS called -- proof this did not just serve
    // the cached (old-shape) document because it looked young enough.
    expect(computeCoverage).toHaveBeenCalledTimes(1);
    const body = res.json.mock.calls[0][0];
    expect(body.data.segments).toEqual({ noTestsLinked: 3 });
    expect(body.stale).toBe(false);
  });

  it('a fresh, current-shape (has segments) cache entry is served verbatim, no recompute', async () => {
    const currentShapeEntry = {
      computedAt: new Date(),
      data: { label: 'Requirement coverage', total: 5, segments: { noTestsLinked: 3 } }
    };
    ReportCache.findOne.mockResolvedValue(currentShapeEntry);

    const { req, res } = buildReqRes();
    await getCoverage(req, res, jest.fn());

    expect(computeCoverage).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.data).toBe(currentShapeEntry.data);
    expect(body.stale).toBe(false);
  });
});
