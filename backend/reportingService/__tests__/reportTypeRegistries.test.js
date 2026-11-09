// WP-F13 final fix round, Finding 1 -- the report-type rule ("here are the
// reports this service knows how to compute and cache") is decided once,
// but the product delivers it through THREE separate registries:
//   1. ReportCache's own `reportType` schema enum (models/ReportCache.js)
//   2. postRefresh's own reportTypes array (controllers/reports.js,
//      exported as POST_REFRESH_REPORT_TYPES)
//   3. the node-cron sweep's own REPORT_TYPES array (lib/cronJob.js)
// Task 2 added 'traceability' to (1) and (2) and missed (3): it compiled,
// served, and refreshed correctly through POST /reports/refresh, while the
// 5-minute background sweep silently never touched it -- ReportCache's
// six siblings stayed fresh forever while 'traceability' drifted further
// stale on every tick, invisible until someone diffed computedAt across
// the collection by hand.
//
// This test derives its expected set from ReportCache's enum (the schema
// that actually gates what CAN be written under a reportType key) rather
// than hand-restating all seven names a fourth time -- a test that merely
// repeats the list can be satisfied by editing the test alone the next
// time a registry is forgotten, which is exactly how Finding 1 slipped
// past Task 2's own review (the enum and postRefresh's list were checked
// against EACH OTHER, never against a third, independently-sourced list).
//
// BREAKS IF: any one of the three registries names a different set of
// report types than the other two -- confirmed live by reverting
// cronJob.js's 'traceability' entry (this task's own regression) and
// re-running: the cronTypes assertion below goes red. Restored after
// confirming red; see this task's final-fix-report.md for the transcript.

jest.mock('../services/coverage', () => ({ computeCoverage: jest.fn() }));
jest.mock('../services/passRateTrend', () => ({ computePassRateTrend: jest.fn() }));
jest.mock('../services/defectSummary', () => ({ computeDefectSummary: jest.fn() }));
jest.mock('../services/planProgress', () => ({ computePlanProgress: jest.fn() }));
jest.mock('../services/releaseReadiness', () => ({ computeReleaseReadiness: jest.fn() }));
jest.mock('../services/workload', () => ({ computeWorkload: jest.fn() }));
jest.mock('../services/traceability', () => ({ computeTraceability: jest.fn() }));
// Required at module load by controllers/reports.js but not exercised
// here -- stubbed only so requiring the controller doesn't need a live
// releaseService.
jest.mock('../services/releaseLens', () => ({ computeReleaseLens: jest.fn() }));
// lib/cronJob.js requires node-cron and mints its own service-account
// token machinery at require time only as function definitions (never
// invoked by merely requiring the module) -- no mock needed for either,
// same as postRefresh.test.js needs none for controllers/reports.js's own
// unexercised handlers.

const ReportCache = require('../models/ReportCache');
const { REPORT_TYPES: CRON_REPORT_TYPES } = require('../lib/cronJob');
const { POST_REFRESH_REPORT_TYPES } = require('../controllers/reports');

describe('the three report-type registries stay in sync (WP-F13 final fix round, Finding 1)', () => {
  const enumTypes = ReportCache.schema.path('reportType').enumValues;

  it('ReportCache enum is the seven report types this service actually knows about', () => {
    // Sanity check on the source of truth itself -- if this ever fails,
    // the other two assertions below are meaningless (comparing against a
    // moved target), so it's asserted explicitly rather than assumed.
    expect(enumTypes).toEqual(
      expect.arrayContaining([
        'coverage',
        'pass-rate-trend',
        'defect-summary',
        'plan-progress',
        'release-readiness',
        'workload',
        'traceability'
      ])
    );
    expect(enumTypes).toHaveLength(7);
  });

  it("cronJob.js's REPORT_TYPES names exactly the same set as ReportCache's enum -- no more, no fewer", () => {
    const cronTypes = CRON_REPORT_TYPES.map(([reportType]) => reportType);
    expect(new Set(cronTypes)).toEqual(new Set(enumTypes));
    expect(cronTypes).toHaveLength(enumTypes.length);
  });

  it("postRefresh's reportTypes names exactly the same set as ReportCache's enum -- no more, no fewer", () => {
    const postRefreshTypes = POST_REFRESH_REPORT_TYPES.map(([reportType]) => reportType);
    expect(new Set(postRefreshTypes)).toEqual(new Set(enumTypes));
    expect(postRefreshTypes).toHaveLength(enumTypes.length);
  });

  it('every registry actually pairs each reportType name with a compute function, not a stray string', () => {
    CRON_REPORT_TYPES.forEach(([, computeFn]) => expect(typeof computeFn).toBe('function'));
    POST_REFRESH_REPORT_TYPES.forEach(([, computeFn]) => expect(typeof computeFn).toBe('function'));
  });
});
