const {
  ErrorResponse,
  asyncHandler,
  CORRELATION_HEADER,
  PROJECT_ID_HEADER,
  createLogger
} = require('@srckube/service-core');
const ReportCache = require('../models/ReportCache');
const { computeCoverage } = require('../services/coverage');
const { computePassRateTrend } = require('../services/passRateTrend');
const { computeDefectSummary } = require('../services/defectSummary');
const { computePlanProgress } = require('../services/planProgress');
const { computeReleaseReadiness } = require('../services/releaseReadiness');
const { computeWorkload } = require('../services/workload');
const { computeReleaseLens } = require('../services/releaseLens');
const { computeTraceability } = require('../services/traceability');

const logger = createLogger('reportingService');

// How old a cached report can be before a GET triggers a synchronous
// recompute instead of serving it as-is. Overridable (REPORT_STALE_MS,
// default 5 minutes -- matches the node-cron sweep's own default interval,
// so in steady state a GET almost always finds a cache entry the cron
// already refreshed and serves it without waiting on any cross-service
// call at all).
function resolveStaleMs() {
  const raw = process.env.REPORT_STALE_MS;
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 5 * 60 * 1000;
}

// WP-040 — read-availability policy, deliberately in between WP-025's
// gate-status (fails CLOSED on a dependency outage -- no cached fallback
// exists there at all) and WP-030's event publisher (fails OPEN, an
// outage never blocks the write path it guards).
//
// A report is a number someone reads and acts on, same class of concern
// as a release gate -- so a dependency outage never fabricates or silently
// serves a PARTIAL aggregate as if it were complete. But unlike a gate
// (evaluated fresh every call, nothing to fall back to), this service's
// whole point is a MATERIALIZED cache: a value that was correct 3 minutes
// ago and is now unrefreshable because a dependency is briefly down is
// meaningfully different from a value that was NEVER computed. So:
//   - No cache entry exists yet AND compute fails -> 503, fail closed.
//     There is nothing honest to serve.
//   - A cache entry exists AND a recompute attempt fails -> serve the
//     cached value, but with `stale:true` and `staleReason` set, never
//     silently. The caller (WP-041's dashboards) can decide how to
//     present a labeled-stale number; this service never presents one
//     as fresh when it isn't, and never blocks a page that has a
//     perfectly good (if slightly old) number just because a transient
//     dependency hiccup is happening right now.
// WP-F13 final fix round, Finding 5 -- ReportCache carries no payload
// version, and getOrCompute above serves any entry younger than staleMs
// VERBATIM regardless of shape. WP-F13 Task 1 changed `coverage`'s own
// payload (added `segments`, replaced the old two-slice `breakdown.data`
// with today's four-way one) with no migration of documents already
// sitting in the cache from before that change -- for up to staleMs after
// a deploy, a pre-existing `coverage` entry would be read as fresh and
// served as-is: two tiles instead of four, and every row's Segment column
// showing a raw, unmapped id (buildSegmentLabelLookup finds no match for
// it) instead of a label. Self-healing once staleMs elapses, but that is
// the first thing a user sees right after the deploy that announces the
// changed number. Rather than add a migration framework (out of scope --
// this cache has never had one and this is one field on one report type),
// a `coverage` entry with no `segments` is treated as stale unconditionally,
// so the very first GET after a deploy recomputes and re-shapes it instead
// of trusting computedAt alone.
// WP-103 — second instance of the same class of bug, found while deleting
// the stale default-project guards. Those guards returned an empty payload
// carrying a `note` ("testPlanExecutionService has no per-project scoping
// yet...") for every projectId but 1, and getOrCompute cached it like any
// other result. Deleting the guards does not delete those cache entries: for
// up to staleMs after the deploy, a non-default project's first GET would be
// served the guard's own empty series, as `stale:false`, from a guard that no
// longer exists -- i.e. the bug would look unfixed precisely for the projects
// it was fixed for. None of these three report types ever emits a `note`
// field now, so a cached one is by definition a pre-WP-103 document and is
// treated as stale unconditionally, exactly like the `coverage` shape change
// above.
const GUARD_ERA_NOTE_REPORT_TYPES = ['pass-rate-trend', 'plan-progress', 'workload'];

function isStaleShape(reportType, cached) {
  if (!cached || !cached.data) {
    return reportType === 'coverage' && !!cached;
  }
  if (reportType === 'coverage') {
    return cached.data.segments === undefined;
  }
  return GUARD_ERA_NOTE_REPORT_TYPES.includes(reportType) && cached.data.note !== undefined;
}

async function getOrCompute(reportType, computeFn, req, res, next) {
  const projectId = req.projectScope.projectId;
  const staleMs = resolveStaleMs();

  const cached = await ReportCache.findOne({ projectId, reportType });
  const isFresh =
    cached && Date.now() - cached.computedAt.getTime() < staleMs && !isStaleShape(reportType, cached);
  if (isFresh) {
    return res.status(200).json({
      success: true,
      projectId,
      reportType,
      computedAt: cached.computedAt,
      stale: false,
      data: cached.data
    });
  }

  const headers = {
    Authorization: req.headers.authorization,
    [PROJECT_ID_HEADER]: String(projectId),
    [CORRELATION_HEADER]: req.correlationId
  };

  try {
    const start = Date.now();
    const data = await computeFn(projectId, headers);
    const computedAt = new Date();
    await ReportCache.findOneAndUpdate(
      { projectId, reportType },
      { data, computedAt, computeDurationMs: Date.now() - start },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return res.status(200).json({ success: true, projectId, reportType, computedAt, stale: false, data });
  } catch (err) {
    logger.error('report compute failed', {
      correlationId: req.correlationId,
      projectId,
      reportType,
      error: err.message
    });
    if (cached) {
      return res.status(200).json({
        success: true,
        projectId,
        reportType,
        computedAt: cached.computedAt,
        stale: true,
        staleReason: err.message,
        data: cached.data
      });
    }
    return next(new ErrorResponse(`Unable to compute ${reportType}: a dependency call failed or was unreachable`, 503));
  }
}

// Exported for __tests__/coverageCacheStaleness.test.js (Finding 5) -- so
// that test can assert the predicate directly rather than only indirectly
// through a full getCoverage() call.
exports.isStaleShape = isStaleShape;

exports.getCoverage = asyncHandler((req, res, next) => getOrCompute('coverage', computeCoverage, req, res, next));

exports.getPassRateTrend = asyncHandler((req, res, next) =>
  getOrCompute(
    'pass-rate-trend',
    (projectId, headers) => computePassRateTrend(projectId, headers, req.query.days),
    req,
    res,
    next
  )
);

exports.getDefectSummary = asyncHandler((req, res, next) =>
  getOrCompute('defect-summary', computeDefectSummary, req, res, next)
);

exports.getPlanProgress = asyncHandler((req, res, next) =>
  getOrCompute('plan-progress', computePlanProgress, req, res, next)
);

exports.getReleaseReadiness = asyncHandler((req, res, next) =>
  getOrCompute('release-readiness', computeReleaseReadiness, req, res, next)
);

exports.getWorkload = asyncHandler((req, res, next) => getOrCompute('workload', computeWorkload, req, res, next));

// WP-F13 Task 2 -- the traceability matrix (one row per requirement).
// Routed through getOrCompute/ReportCache exactly like this file's other
// six reports (unlike release-lens below, this IS keyed by
// (projectId, reportType) alone, same grain as coverage/defect-summary/
// etc -- there is no extra dimension like release-lens's releaseId).
exports.getTraceability = asyncHandler((req, res, next) =>
  getOrCompute('traceability', computeTraceability, req, res, next)
);

// @desc      The release lens (WP-F15/F18 Task 4) -- for ONE release: its
//            linked requirements/test cases/defects (resolved, not raw
//            link rows), its linked test plans, and the execution results
//            reachable through those plans.
// @route     GET /api/v1/reports/release-lens?releaseId=<human id>
//
// Deliberately NOT routed through getOrCompute/ReportCache: that cache's
// key is (projectId, reportType), one row per project per report, and this
// report is keyed by (projectId, releaseId) -- a finer grain the cache was
// never built to hold. Every call here computes fresh, same "always live"
// posture as releaseService's own gate-status endpoint, not the
// materialized-and-refreshed posture of this file's other six reports.
//
// `releaseId` identifies WHICH release inside the caller's own project
// (req.projectScope.projectId, from requireProjectScope() -- never a body
// or query value) -- computeReleaseLens forwards that scope to
// releaseService's own project-scoped list route, so a releaseId
// belonging to a different project resolves to null here, same as it not
// existing at all, and this returns 404 rather than another project's
// data.
exports.getReleaseLens = asyncHandler(async (req, res, next) => {
  const { releaseId } = req.query;
  if (!releaseId) {
    return next(new ErrorResponse('releaseId query parameter is required', 400));
  }

  const projectId = req.projectScope.projectId;
  const headers = {
    Authorization: req.headers.authorization,
    [PROJECT_ID_HEADER]: String(projectId),
    [CORRELATION_HEADER]: req.correlationId
  };

  const data = await computeReleaseLens(releaseId, headers);
  if (!data) {
    return next(new ErrorResponse(`No release found with releaseId ${releaseId} in this project`, 404));
  }

  res.status(200).json({ success: true, projectId, releaseId, computedAt: new Date(), data });
});

// @desc      On-demand refresh: recomputes and re-caches all six reports for
//            the CALLER'S OWN project, synchronously, forwarding the
//            caller's own Authorization/X-Project-Id (never a service-account
//            token -- see lib/cronJob.js's header comment for why the
//            background sweep needs one and this endpoint doesn't: a real
//            user's own token already carries real project membership, so
//            every downstream requireProjectScope() check just works).
// @route     POST /api/v1/reports/refresh
// WP-F13 Task 2 -- premise 7: a reportType must be added HERE, not only to
// ReportCache's schema enum, or it compiles/serves fine and then never
// refreshes on demand (a silent staleness bug). See
// __tests__/postRefresh.test.js for the unit test that fails if the
// 'traceability' entry is ever dropped.
//
// WP-F13 final fix round, Finding 1 -- exported (not just a local const
// inside postRefresh below) so __tests__/reportTypeRegistries.test.js can
// compare this list's names, lib/cronJob.js's own REPORT_TYPES, and
// ReportCache's own enum against each other WITHOUT hand-restating all
// seven names a fourth time -- a test that only restates the list can be
// satisfied by updating the test alone and would not have caught this
// package's own Finding 1 (cronJob.js's list was missed even though this
// one and the enum were both updated).
const POST_REFRESH_REPORT_TYPES = [
  ['coverage', computeCoverage],
  ['pass-rate-trend', (pid, h) => computePassRateTrend(pid, h)],
  ['defect-summary', computeDefectSummary],
  ['plan-progress', computePlanProgress],
  ['release-readiness', computeReleaseReadiness],
  ['workload', computeWorkload],
  ['traceability', computeTraceability]
];
exports.POST_REFRESH_REPORT_TYPES = POST_REFRESH_REPORT_TYPES;

exports.postRefresh = asyncHandler(async (req, res) => {
  const projectId = req.projectScope.projectId;
  const headers = {
    Authorization: req.headers.authorization,
    [PROJECT_ID_HEADER]: String(projectId),
    [CORRELATION_HEADER]: req.correlationId
  };

  const start = Date.now();
  const results = await Promise.allSettled(
    POST_REFRESH_REPORT_TYPES.map(async ([reportType, computeFn]) => {
      const reportStart = Date.now();
      const data = await computeFn(projectId, headers);
      const computedAt = new Date();
      await ReportCache.findOneAndUpdate(
        { projectId, reportType },
        { data, computedAt, computeDurationMs: Date.now() - reportStart },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      return { reportType, computedAt, durationMs: Date.now() - reportStart };
    })
  );

  const summary = results.map((r, i) =>
    r.status === 'fulfilled'
      ? { reportType: POST_REFRESH_REPORT_TYPES[i][0], success: true, computedAt: r.value.computedAt, durationMs: r.value.durationMs }
      : { reportType: POST_REFRESH_REPORT_TYPES[i][0], success: false, error: r.reason.message }
  );

  const durationMs = Date.now() - start;
  const allSucceeded = summary.every((s) => s.success);

  logger.info('on-demand refresh completed', { correlationId: req.correlationId, projectId, durationMs, allSucceeded });

  res.status(allSucceeded ? 200 : 207).json({
    success: allSucceeded,
    projectId,
    durationMs,
    reports: summary
  });
});
