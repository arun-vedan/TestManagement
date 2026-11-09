const { requestWithRetry } = require('@srckube/service-core');
const { TEST_PLAN_EXECUTION_SERVICE } = require('./serviceUrls');

// A TestExecution counts as "completed" for its assignee when it actually
// has test cases AND every one of them has reached a terminal outcome
// (Pass/Fail) -- 'No Run' (never started) and 'InProgress' (started, not
// finished) are both "not completed", and an execution with an empty
// TestCases[] (not yet enriched/populated) can't be "completed" either.
function isCompletedExecution(execution) {
  const cases = execution.TestCases || [];
  if (cases.length === 0) {
    return false;
  }
  return cases.every((tc) => ['pass', 'fail'].includes((tc.TestStatus || '').toLowerCase()));
}

// WP-040 — tester workload: assigned/completed TestExecution counts per
// user. Scoped to TestExecution.assignedTo specifically (not
// defectService's `assignedTo`, which is a developer/fixer assignment, not
// a tester one) -- "tester workload" per the WP brief's own phrasing.
//
// WP-103: scoped per project like every other report here -- the downstream
// GET below carries the caller's own X-Project-Id and
// routes/testexecution.js mounts requireProjectScope() on every route.
//
// `assignedTo` is a raw Keycloak user id (sub), e.g.
// 'b8c153e0-1230-4990-908e-aa6bf98e4587' -- resolving that to a display
// name would need either a Keycloak Admin API lookup (a new kind of
// cross-service call this WP doesn't otherwise need) or userService's own
// Mongo `User` collection, which is a legacy, Keycloak-independent CRUD
// collection with no `sub` field of its own (verified: backend/userService/
// models/User.js has no sub/keycloakId field, and the real srckube-user.users
// documents have no such field either) -- there is no reliable id it could be
// joined against today. Left as the raw sub, labeled as a known display-name
// gap rather than silently guessing; a future WP wiring userService to
// Keycloak's own user id can resolve this without changing this shape.
async function computeWorkload(projectId, headers) {
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

  const byUser = new Map(); // assignedTo -> { assigned, completed }
  executions.forEach((execution) => {
    const user = execution.assignedTo || 'unassigned';
    if (!byUser.has(user)) {
      byUser.set(user, { assigned: 0, completed: 0 });
    }
    const bucket = byUser.get(user);
    bucket.assigned += 1;
    if (isCompletedExecution(execution)) {
      bucket.completed += 1;
    }
  });

  const categories = Array.from(byUser.keys());

  return {
    categories,
    series: [
      { id: 'assigned', label: 'Assigned', data: categories.map((c) => byUser.get(c).assigned) },
      { id: 'completed', label: 'Completed', data: categories.map((c) => byUser.get(c).completed) }
    ]
  };
}

module.exports = { computeWorkload };
