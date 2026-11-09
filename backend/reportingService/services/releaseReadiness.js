const { requestWithRetry } = require('@srckube/service-core');
const { RELEASE_SERVICE } = require('./serviceUrls');

// WP-040 — release gate rollup.
//
// REUSE, DON'T RECOMPUTE: releaseService already computes per-release gate
// status live against real data at GET /api/v1/releases/:id/gate-status
// (WP-025, releaseService/controllers/releases.js#getGateStatus) --
// including its own fail-closed behavior on a dependency outage. This calls
// that endpoint once per release rather than re-implementing quality-gate
// evaluation (minPassRate / maxOpenDefects) a second time in a second
// service, which would risk the two ever disagreeing about what "green"
// means. Release IS project-scoped (WP-025 gave it `projectId` from birth),
// so both calls below are correctly scoped via the forwarded X-Project-Id
// header -- no Default-Project-only caveat here, unlike pass-rate-trend/
// plan-progress/workload.
//
// A single release's gate-status call failing (its own dependency outage,
// see getGateStatus's fail-closed 503) fails this WHOLE report closed too --
// a rollup that silently drops one release's status rather than reporting
// it is exactly the "partial aggregate presented as complete" the WP brief
// warns against, so any one 503 propagates up to computeReleaseReadiness's
// caller and is handled by the shared fail-closed/serve-stale logic in
// controllers/reports.js.
async function computeReleaseReadiness(projectId, headers) {
  if (!RELEASE_SERVICE) {
    throw new Error('releaseService is not configured');
  }

  const releasesResp = await requestWithRetry({
    method: 'get',
    url: `http://${RELEASE_SERVICE}/api/v1/releases`,
    params: { limit: 1000 },
    headers
  });
  const releases = (releasesResp.data && releasesResp.data.data) || [];

  const gateStatuses = await Promise.all(
    releases.map((release) =>
      requestWithRetry({
        method: 'get',
        url: `http://${RELEASE_SERVICE}/api/v1/releases/${release._id}/gate-status`,
        headers
      }).then((resp) => resp.data.data)
    )
  );

  const greenCount = gateStatuses.filter((g) => g.overall === 'green').length;
  const redCount = gateStatuses.filter((g) => g.overall === 'red').length;

  return {
    total: releases.length,
    // DonutChart-shaped, nested under `data` (matching DonutChartProps'
    // own prop name, same convention as coverage's `breakdown` and
    // defect-summary's `bySeverity` -- see coverage.js's comment). Named
    // `rollup` rather than something that would read as `data.data.data`
    // once nested inside this report's own top-level `data` envelope field
    // (see controllers/reports.js's getOrCompute response shape).
    rollup: {
      data: [
        { id: 'green', label: 'Green', value: greenCount },
        { id: 'red', label: 'Red', value: redCount }
      ]
    },
    // Per-release detail, for a table/list alongside the donut -- not one
    // of the four chart primitives, but every other report here also
    // returns supporting detail fields (coverage's tested/untested,
    // defect-summary's total) beyond the strict chart shape.
    releases: gateStatuses.map((g) => ({
      releaseId: g.releaseId,
      status: g.status,
      overall: g.overall,
      passed: g.passed,
      ruleCount: g.rules.length
    }))
  };
}

module.exports = { computeReleaseReadiness };
