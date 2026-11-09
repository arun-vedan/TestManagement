const cron = require('node-cron');
const { CORRELATION_HEADER, PROJECT_ID_HEADER, createLogger } = require('@srckube/service-core');
const ReportCache = require('../models/ReportCache');
const { getServiceAccountToken } = require('../utils/identityClient');
const { computeCoverage } = require('../services/coverage');
const { computePassRateTrend } = require('../services/passRateTrend');
const { computeDefectSummary } = require('../services/defectSummary');
const { computePlanProgress } = require('../services/planProgress');
const { computeReleaseReadiness } = require('../services/releaseReadiness');
const { computeWorkload } = require('../services/workload');
const { computeTraceability } = require('../services/traceability');

const logger = createLogger('reportingService:cron');

// WP-F13 final fix round, Finding 1 — this array, ReportCache's own
// `reportType` enum (models/ReportCache.js), and postRefresh's own
// `reportTypes` array (controllers/reports.js, exported as
// POST_REFRESH_REPORT_TYPES) are THREE SEPARATE lists naming the same set
// of report types. 'traceability' was added to the other two when Task 2
// shipped and missed here: it compiled and served fine (the enum accepted
// writes to it, postRefresh recomputed it on demand) but this 5-minute
// sweep never refreshed it, so it drifted further stale on every tick
// while the other six stayed fresh -- a silent staleness bug at the
// caching seam, not the computation seam. See
// __tests__/reportTypeRegistries.test.js, which derives its expected set
// from the ReportCache enum so it fails the instant any one of these three
// lists falls out of sync with the others, not just this one.
const REPORT_TYPES = [
  ['coverage', computeCoverage],
  ['pass-rate-trend', (pid, h) => computePassRateTrend(pid, h)],
  ['defect-summary', computeDefectSummary],
  ['plan-progress', computePlanProgress],
  ['release-readiness', computeReleaseReadiness],
  ['workload', computeWorkload],
  ['traceability', computeTraceability]
];

// WP-040 — proactive background refresh.
//
// SCOPE: one project (id=1) only, not "every project that exists".
//
// WP-103 note: this limit is NOT the stale default-project guard that WP-103
// deleted from services/{passRateTrend,planProgress,workload}.js, and it does
// not share that guard's (false) premise. Those guards claimed
// testPlanExecutionService had no per-project scoping; it does
// (TestExecution.projectId and TestPlan.projectId are both required+indexed
// and every route in that service mounts requireProjectScope()). The
// constraint here is a different and still-real one: a cron tick has no
// caller/human token to forward, so cross-service reads go through a minted
// service-account token (utils/identityClient.js) -- and
// requireProjectScope() only admits a caller whose token `sub` is listed in
// Project.members[]. The service account is not a member of any project, and
// enrolling it into every project it discovers (via userService's POST
// /api/v1/projects/:id/members) would give this read-only service standing
// write access to every project's membership list merely to read its own
// reports. So the sweep targets the one project that account is already an
// admin member of. Lifting this needs an internal service-token path through
// requireProjectScope() (the same capability WP-110 has to build for
// GET /api/v1/projects) -- tracked as a candidate WP, not solvable here.
//
// This is a cron-only limit: a real user hitting POST /api/v1/reports/refresh
// (controllers/reports.js) refreshes ANY project they belong to on demand
// using their own token, and since WP-103 every report type computes real
// numbers for every project, not just this one.
const CRON_SWEEP_PROJECT_ID = 1;

async function refreshDefaultProject() {
  const projectId = CRON_SWEEP_PROJECT_ID;
  const start = Date.now();

  let token;
  try {
    token = await getServiceAccountToken();
  } catch (err) {
    logger.error('cron sweep: could not mint a service-account token, skipping this tick', { error: err.message });
    return;
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    [PROJECT_ID_HEADER]: String(projectId),
    [CORRELATION_HEADER]: `cron-${Date.now()}`
  };

  const results = await Promise.allSettled(
    REPORT_TYPES.map(async ([reportType, computeFn]) => {
      const data = await computeFn(projectId, headers);
      const computedAt = new Date();
      await ReportCache.findOneAndUpdate(
        { projectId, reportType },
        { data, computedAt, computeDurationMs: Date.now() - start },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );
      return reportType;
    })
  );

  const failed = results
    .map((r, i) => (r.status === 'rejected' ? { reportType: REPORT_TYPES[i][0], error: r.reason.message } : null))
    .filter(Boolean);

  const durationMs = Date.now() - start;
  if (failed.length > 0) {
    // Per-report fail-closed handled by controllers/reports.js's own logic
    // for the request-time path (serve-stale-with-label / 503 with no prior
    // cache) -- the cron sweep itself just logs and leaves whatever cache
    // entry already existed untouched for a report that failed this tick;
    // it never overwrites a good cached value with nothing, and never
    // crashes the whole tick over one dependency being down.
    logger.error('cron sweep: some reports failed to refresh', { projectId, durationMs, failed });
  } else {
    logger.info('cron sweep: refreshed all reports', { projectId, durationMs });
  }
}

// REPORT_REFRESH_CRON: standard 5-field cron syntax, default every 5 minutes
// (WP-040 spec). Guarded by node-cron's own validate() so a typo'd env var
// fails loudly at startup rather than silently never firing.
function startReportRefreshCron() {
  const schedule = process.env.REPORT_REFRESH_CRON || '*/5 * * * *';
  if (!cron.validate(schedule)) {
    logger.error('REPORT_REFRESH_CRON is not a valid cron expression; background refresh is disabled', { schedule });
    return null;
  }
  const task = cron.schedule(schedule, () => {
    refreshDefaultProject().catch((err) => {
      logger.error('cron sweep: unhandled error', { error: err.message });
    });
  });
  logger.info('report refresh cron scheduled', { schedule });
  return task;
}

module.exports = { startReportRefreshCron, refreshDefaultProject, REPORT_TYPES };
