// WP-030 -- canonical stream names, shared so every producer/consumer spells
// them identically (a typo'd stream name here is a silently-dropped event on
// one side and a silently-empty consumer on the other -- neither errors).
const EVENT_STREAMS = {
  // testPlanExecutionService -> a TestExecution write (see
  // controllers/testexecution.js's updateTestExecution).
  EXECUTION_COMPLETED: 'execution-completed',
  // requirementService + testRepoService -> a lifecycle status transition
  // (updateRequirementStatus / updateTestCaseStatus).
  STATUS_CHANGED: 'status-changed'
};

module.exports = { EVENT_STREAMS };
