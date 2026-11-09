const { requestWithRetry } = require('@srckube/service-core');
const { TEST_PLAN_EXECUTION_SERVICE } = require('./serviceUrls');

function isExecuted(status) {
  const s = (status || '').toLowerCase();
  return s !== '' && s !== 'no run';
}

// WP-040 — plan progress: executed/passed/blocked test-case counts per plan,
// computed from every TestExecution linked to it (TestExecution.TestPlanId
// -> TestPlan._id), not from TestPlan.TestCases[] itself (that array is the
// plan's own template/checklist -- e.g. every TestPlan document in real data
// carries TestStatus:'No Run' on all of its own entries; it is never mutated
// by execution, see backend/testPlanExecutionService/models/TestPlan.js's
// TestPlanTestCaseSchema comment). "Progress" is a property of what has
// actually been run, which lives on TestExecution.
//
// WP-103: scoped per project like every other report here. The downstream
// GETs below carry the caller's own X-Project-Id (forwarded by
// controllers/reports.js's getOrCompute), and both testPlanExecutionService
// routes mount requireProjectScope(), so each project sees only its own
// plans and executions.
async function computePlanProgress(projectId, headers) {
  if (!TEST_PLAN_EXECUTION_SERVICE) {
    throw new Error('testPlanExecutionService is not configured');
  }

  const [plansResp, execResp] = await Promise.all([
    requestWithRetry({
      method: 'get',
      url: `http://${TEST_PLAN_EXECUTION_SERVICE}/api/v1/testplan`,
      params: { limit: 10000 },
      headers
    }),
    requestWithRetry({
      method: 'get',
      url: `http://${TEST_PLAN_EXECUTION_SERVICE}/api/v1/testexecution`,
      params: { limit: 10000 },
      headers
    })
  ]);

  const plans = (plansResp.data && plansResp.data.data) || [];
  const executions = (execResp.data && execResp.data.data) || [];

  const progressByPlanId = new Map(); // TestPlan._id (string) -> { executed, passed, blocked }
  plans.forEach((p) => progressByPlanId.set(p._id, { executed: 0, passed: 0, blocked: 0 }));

  executions.forEach((execution) => {
    const planId = execution.TestPlanId && String(execution.TestPlanId);
    const bucket = planId && progressByPlanId.get(planId);
    if (!bucket) {
      return; // execution references a plan not in this project's plan list (or plan since deleted)
    }
    (execution.TestCases || []).forEach((tc) => {
      const status = (tc.TestStatus || '').toLowerCase();
      if (!isExecuted(status)) {
        return;
      }
      bucket.executed += 1;
      if (status === 'pass') {
        bucket.passed += 1;
      } else if (status === 'blocked') {
        bucket.blocked += 1;
      }
    });
  });

  const orderedPlans = plans.slice().sort((a, b) => (a.id || 0) - (b.id || 0));
  const categories = orderedPlans.map((p) => p.TestPlanId);

  return {
    categories,
    series: [
      { id: 'executed', label: 'Executed', data: orderedPlans.map((p) => progressByPlanId.get(p._id).executed) },
      { id: 'passed', label: 'Passed', data: orderedPlans.map((p) => progressByPlanId.get(p._id).passed) },
      { id: 'blocked', label: 'Blocked', data: orderedPlans.map((p) => progressByPlanId.get(p._id).blocked) }
    ]
  };
}

module.exports = { computePlanProgress };
