// WP-053 -- pulls reporting-service AGGREGATES (never raw records) and
// turns them into a single plain-text "facts" block that is BOTH:
//   (a) the only data the model's prompt is given (controllers/ai.js), and
//   (b) the grounding corpus groundingCheck.js checks the model's output
//       numbers against.
// Using the exact same text for both jobs is deliberate: there is no
// separate "what the model saw" vs "what the post-check allows" -- a
// second, independently-maintained copy of the same facts is exactly the
// kind of divergence bug that would quietly reopen the hole this feature
// exists to close.
//
// ONLY AGGREGATES: every number here comes from reportingService's own
// already-computed report endpoints (WP-040) -- coverage percentages,
// defect counts, release gate rollups, plan progress counts, pass-rate
// percentages. Nothing here calls requirementService/defectService/
// testRepoService/releaseService directly, and nothing here ever touches a
// requirement description, defect summary text, or test step body. That is
// both the grounding constraint (a narrative can only be as leaky as its
// numeric inputs) and the privacy constraint the WP brief states
// explicitly ("numbers, not raw records") -- the same posture WP-050's
// AiInteraction model took for prompt/response text (preview + hash, not
// full text, by default).
//
// buildXxxFacts() below are PURE functions (envelope objects in, {facts,
// stale, ...} out) -- deliberately split from fetchReportAggregates()'s
// HTTP calls so __tests__/reportAggregates.test.js can exercise the
// facts-formatting and staleness-propagation logic directly, without
// standing up or mocking a live reportingService.
'use strict';

const { requestWithRetry } = require('@srckube/service-core');

const REPORTING_SERVICE = process.env.reportingService;

const SUPPORTED_SCOPES = ['release', 'plan', 'timerange'];
const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;

function clampDays(raw) {
  const parsed = parseInt(raw, 10);
  return Math.min(Math.max(Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_DAYS, 1), MAX_DAYS);
}

function notFound(message) {
  const err = new Error(message);
  err.status = 404;
  return err;
}

// `envelope` is exactly what a WP-040 GET /api/v1/reports/* call returns:
// {success, projectId, reportType, computedAt, stale, staleReason?, data}.
function freshnessTag(envelope) {
  const computedAtIso = new Date(envelope.computedAt).toISOString();
  return envelope.stale
    ? `STALE -- last refreshed ${computedAtIso}${envelope.staleReason ? ` (${envelope.staleReason})` : ''}, presented here labelled as stale, not as current`
    : `fresh as of ${computedAtIso}`;
}

function sourceEntry(envelope) {
  return { reportType: envelope.reportType, computedAt: new Date(envelope.computedAt).toISOString(), stale: !!envelope.stale };
}

function finish(lines, sourceReports, extra) {
  const staleReports = sourceReports.filter((s) => s.stale).map((s) => s.reportType);
  return {
    facts: lines.join('\n'),
    stale: staleReports.length > 0,
    staleReports,
    sourceReports,
    ...extra
  };
}

const FACTS_PREAMBLE = (projectId, extra) =>
  `Project ${projectId} -- reporting-service aggregates${extra || ''}. These are the ONLY real numbers; never state any figure that is not one of them, and never invent a number to fill a gap.`;

function buildReleaseFacts({ projectId, coverage, defectSummary, releaseReadiness, releaseId }) {
  const lines = [FACTS_PREAMBLE(projectId, '')];

  const cov = coverage.data;
  lines.push(
    `COVERAGE (${freshnessTag(coverage)}): ${cov.value}% requirement coverage (${cov.tested} of ${cov.total} requirements tested, ${cov.untested} untested).`
  );

  const def = defectSummary.data;
  const severityText = def.bySeverity.data.length ? def.bySeverity.data.map((s) => `${s.label}: ${s.value}`).join(', ') : 'none';
  lines.push(`DEFECTS (${freshnessTag(defectSummary)}): ${def.total} total defects. By severity -- ${severityText}.`);

  const rr = releaseReadiness.data;
  const greenCount = (rr.rollup.data.find((d) => d.id === 'green') || {}).value || 0;
  const redCount = (rr.rollup.data.find((d) => d.id === 'red') || {}).value || 0;
  lines.push(`RELEASE READINESS (${freshnessTag(releaseReadiness)}): ${rr.total} release(s) tracked project-wide, ${greenCount} green, ${redCount} red.`);

  if (releaseId) {
    const match = rr.releases.find((r) => r.releaseId === releaseId);
    if (!match) {
      throw notFound(`No release '${releaseId}' found in this project's release-readiness aggregates`);
    }
    lines.push(
      `RELEASE ${match.releaseId} (${freshnessTag(releaseReadiness)}): status=${match.status}, overall=${match.overall}, gate passed=${match.passed}, rule count=${match.ruleCount}.`
    );
  } else {
    rr.releases.forEach((r) => {
      lines.push(`RELEASE ${r.releaseId}: status=${r.status}, overall=${r.overall}, gate passed=${r.passed}, rule count=${r.ruleCount}.`);
    });
  }

  return finish(lines, [sourceEntry(coverage), sourceEntry(defectSummary), sourceEntry(releaseReadiness)], { releaseId: releaseId || undefined });
}

function buildPlanFacts({ projectId, planProgress, planId }) {
  const lines = [FACTS_PREAMBLE(projectId, '')];
  const pp = planProgress.data;
  if (pp.note) {
    lines.push(`NOTE: ${pp.note}`);
  }
  lines.push(`PLAN PROGRESS (${freshnessTag(planProgress)}): ${pp.categories.length} plan(s) tracked project-wide.`);

  const executedSeries = pp.series.find((s) => s.id === 'executed');
  const passedSeries = pp.series.find((s) => s.id === 'passed');
  const blockedSeries = pp.series.find((s) => s.id === 'blocked');

  if (planId) {
    const idx = pp.categories.indexOf(planId);
    if (idx === -1) {
      throw notFound(`No plan '${planId}' found in this project's plan-progress aggregates`);
    }
    lines.push(
      `PLAN ${planId} (${freshnessTag(planProgress)}): executed=${(executedSeries && executedSeries.data[idx]) || 0}, passed=${(passedSeries && passedSeries.data[idx]) || 0}, blocked=${(blockedSeries && blockedSeries.data[idx]) || 0}.`
    );
  } else {
    pp.categories.forEach((cat, i) => {
      lines.push(
        `PLAN ${cat}: executed=${(executedSeries && executedSeries.data[i]) || 0}, passed=${(passedSeries && passedSeries.data[i]) || 0}, blocked=${(blockedSeries && blockedSeries.data[i]) || 0}.`
      );
    });
  }

  return finish(lines, [sourceEntry(planProgress)], { planId: planId || undefined });
}

function buildTimerangeFacts({ projectId, passRateTrend, defectSummary, coverage, days }) {
  const lines = [FACTS_PREAMBLE(projectId, ` for the last ${days} day(s)`)];
  const prt = passRateTrend.data;
  if (prt.note) {
    lines.push(`NOTE: ${prt.note}`);
  }
  const series = prt.series.find((s) => s.id === 'passRate');
  const points = prt.xLabels
    .map((label, i) => {
      const v = series && series.data[i];
      return v === null || v === undefined ? null : `${label}=${v}%`;
    })
    .filter(Boolean);
  lines.push(`PASS RATE TREND (${freshnessTag(passRateTrend)}): ${points.length ? points.join(', ') : 'no executed test cases in this window'}.`);

  const def = defectSummary.data;
  lines.push(`DEFECTS (${freshnessTag(defectSummary)}): ${def.total} total defects.`);

  const cov = coverage.data;
  lines.push(`COVERAGE (${freshnessTag(coverage)}): ${cov.value}% requirement coverage (${cov.tested} of ${cov.total}).`);

  return finish(lines, [sourceEntry(passRateTrend), sourceEntry(defectSummary), sourceEntry(coverage)], { days });
}

async function getReport(reportType, headers, params) {
  const resp = await requestWithRetry({
    method: 'get',
    url: `http://${REPORTING_SERVICE}/api/v1/reports/${reportType}`,
    params,
    headers
  });
  return resp.data;
}

// @param scope 'release' | 'plan' | 'timerange'
// @param projectId caller's own project (req.projectScope.projectId -- see
//        controllers/ai.js's header comment on why this is never accepted
//        from the request body).
// @param releaseId / planId optional -- narrows to one release/plan; when
//        omitted, the facts cover every release/plan in the project.
// @param days optional (timerange only), clamped 1-90, default 30 -- same
//        clamp as reportingService's own pass-rate-trend route.
// @param headers forwarded Authorization/X-Project-Id/correlation headers,
//        same convention as every other cross-service call in this file's
//        sibling controllers/ai.js.
async function fetchReportAggregates({ scope, projectId, releaseId, planId, days, headers }) {
  if (!REPORTING_SERVICE) {
    const err = new Error('reportingService is not configured');
    err.status = 500;
    throw err;
  }
  if (!SUPPORTED_SCOPES.includes(scope)) {
    const err = new Error(`unsupported scope '${scope}'`);
    err.status = 400;
    throw err;
  }

  if (scope === 'release') {
    const [coverage, defectSummary, releaseReadiness] = await Promise.all([
      getReport('coverage', headers),
      getReport('defect-summary', headers),
      getReport('release-readiness', headers)
    ]);
    return buildReleaseFacts({ projectId, coverage, defectSummary, releaseReadiness, releaseId });
  }

  if (scope === 'plan') {
    const planProgress = await getReport('plan-progress', headers);
    return buildPlanFacts({ projectId, planProgress, planId });
  }

  // scope === 'timerange'
  const clampedDays = clampDays(days);
  const [passRateTrend, defectSummary, coverage] = await Promise.all([
    getReport('pass-rate-trend', headers, { days: clampedDays }),
    getReport('defect-summary', headers),
    getReport('coverage', headers)
  ]);
  return buildTimerangeFacts({ projectId, passRateTrend, defectSummary, coverage, days: clampedDays });
}

module.exports = {
  SUPPORTED_SCOPES,
  fetchReportAggregates,
  buildReleaseFacts,
  buildPlanFacts,
  buildTimerangeFacts,
  clampDays
};
