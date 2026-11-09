const { requestWithRetry } = require('@srckube/service-core');
const { TEST_PLAN_EXECUTION_SERVICE } = require('./serviceUrls');

const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;

function dayKey(date) {
  return date.toISOString().slice(0, 10); // 'YYYY-MM-DD', UTC
}

// WP-040 — execution pass-rate trend, daily buckets.
//
// CI-sourced results decision (GR-1, per WP-033's new source:'ci' TestExecution
// records): included, on equal footing with source:'ui' runs. A pass-rate
// trend answers "how much of what we tested is passing" -- excluding CI runs
// would make the trend increasingly misleading as CI ingestion (WP-033)
// becomes a real, regular source of results, quietly hiding an entire
// category of test activity from the one chart whose whole purpose is to
// show test activity over time. Deliberate, not a default: nothing here
// filters on `source` at all, so 'ui' and 'ci' TestCases entries are
// counted identically.
//
// WP-103: scoped per project -- the downstream GET carries the caller's own
// X-Project-Id (forwarded by controllers/reports.js's getOrCompute) and
// routes/testexecution.js mounts requireProjectScope() on every route.
async function computePassRateTrend(projectId, headers, days = DEFAULT_DAYS) {
  const clampedDays = Math.min(Math.max(parseInt(days, 10) || DEFAULT_DAYS, 1), MAX_DAYS);

  if (!TEST_PLAN_EXECUTION_SERVICE) {
    throw new Error('testPlanExecutionService is not configured');
  }

  const resp = await requestWithRetry({
    method: 'get',
    url: `http://${TEST_PLAN_EXECUTION_SERVICE}/api/v1/testexecution`,
    params: { limit: 10000 },
    headers
  });
  const executions = (resp.data && resp.data.data) || [];

  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const buckets = new Map(); // dayKey -> { passed, total }
  const xLabels = [];
  for (let i = clampedDays - 1; i >= 0; i -= 1) {
    const d = new Date(todayUtc);
    d.setUTCDate(d.getUTCDate() - i);
    const key = dayKey(d);
    xLabels.push(key);
    buckets.set(key, { passed: 0, total: 0 });
  }

  executions.forEach((execution) => {
    if (!execution.createdAt) {
      return;
    }
    const key = dayKey(new Date(execution.createdAt));
    const bucket = buckets.get(key);
    if (!bucket) {
      return; // outside the requested window
    }
    (execution.TestCases || []).forEach((tc) => {
      bucket.total += 1;
      if ((tc.TestStatus || '').toLowerCase() === 'pass') {
        bucket.passed += 1;
      }
    });
  });

  // A day with zero executed test cases reports `null`, not 0 -- 0% pass
  // rate and "nothing ran" are different facts, and TrendChart's series
  // type ((number|null)[]) exists specifically to let a line chart show a
  // real gap for the former rather than a misleading dip to the floor.
  const data = xLabels.map((key) => {
    const bucket = buckets.get(key);
    return bucket.total > 0 ? Math.round((bucket.passed / bucket.total) * 10000) / 100 : null;
  });

  return {
    xLabels,
    series: [{ id: 'passRate', label: 'Pass rate (%)', data }]
  };
}

module.exports = { computePassRateTrend };
