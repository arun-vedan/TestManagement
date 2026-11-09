// WP-040 — cross-service targets, same "env var named after the target
// service, reached by container name over the Docker network, never
// localhost" convention as every other cross-service caller in this
// codebase (releaseService/controllers/releases.js, linkIssueService/
// controllers/linkIssue.js, service-core's projectScope.js). Centralized
// here since six different services/*.js files each need a subset of
// these.

module.exports = {
  REQUIREMENT_SERVICE: process.env.requirementService,
  DEFECT_SERVICE: process.env.defectService,
  // WP-F15/F18 Task 4 (release lens) -- the first service/*.js file here to
  // need testRepoService directly (resolving a release's linked test cases
  // to their summaries), so this env var name is new to this service's
  // docker-compose block even though testRepoService itself is not new.
  TESTREPO_SERVICE: process.env.testRepoService,
  TEST_PLAN_EXECUTION_SERVICE: process.env.testPlanExecutionService,
  LINK_ISSUE_SERVICE: process.env.linkIssueService,
  RELEASE_SERVICE: process.env.releaseService,
  ISTATUS_SERVICE: process.env.istatusService,
  USER_SERVICE: process.env.userService
};
