const express = require('express');
const { initKeycloak, advancedResults, requireAuth, requireProjectScope, authorize } = require('@srckube/service-core');
const keycloak = initKeycloak()
const {
  getTestExecution,
  getTestExecutions,
  updateTestExecution,
  deleteTestExecution,
  createTestExecution,
  getExecutionTestCaseDetails,
  updateTestStep,
  updateAttachment,
  wildcardSearch,
  bulkUpdateTestExecutions,
  bulkDeleteTestExecutions
} = require('../controllers/testexecution');
const { ingestResults } = require('../controllers/ingest');

const router = express.Router({ mergeParams: true });

const TestExecution = require('../models/TestExecution');

// WP-021b: closes the gap WP-021 deferred ("the rest in later work") --
// requireProjectScope() + authorize(action) mounted on every route below,
// same convention already used on /ingest (WP-033) and on
// testRepoService/routes/testrepo.js (WP-021/022): requireProjectScope()
// after keycloak.protect() (needs req.kauth) and, for the list route,
// before advancedResults() (needs req.projectScope to add the tenant
// filter -- see service-core/middleware/advancedResults.js).
router
  .route('/')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), advancedResults(TestExecution), getTestExecutions)
  .post(keycloak.protect(), requireProjectScope(), authorize('write'), createTestExecution);

// WP-033 -- CI result ingestion. Mounted BEFORE /getexecutiontc etc. purely
// by convention (matches how those sub-routes are already grouped ahead of
// the /:id catch-all below); order has no effect on THIS route specifically
// since it's the only one claiming the literal path /ingest.
//
// requireAuth('results:write') replaces keycloak.protect() as the first
// gate -- accepts EITHER an X-Api-Key credential (the real CI use case) OR
// falls through to the exact same keycloak.protect() every other route
// here uses (see @srckube/service-core's middleware/apiKeyAuth.js). Kong
// (srckube-kong/kong.yml) carries a matching `config.anonymous` fallback
// ONLY on the /api/v1/testexecution/ingest path -- see that file's comment
// block and EXECUTION_LOG.md's WP-033 entry for the empirically-verified
// route-precedence proof. requireProjectScope()+authorize('write') are
// mounted after it, exactly like WP-032's demo routes
// (userService/routes/apikeys.js) -- for an API-key-authenticated request
// both short-circuit as already-satisfied (requireAuth() already fully
// decided scope+project binding); for a human Keycloak bearer they run for
// real, so this endpoint is reachable either way.
//
// express.text() here (not express.json(), already mounted globally in
// server.js) is what lets a raw JUnit XML body reach req.body as a string
// -- express.json() only consumes the stream when Content-Type is
// application/json, so it leaves an application/xml or text/xml request's
// body untouched for this route-local parser to read.
router
  .route('/ingest')
  .post(
    requireAuth('results:write'),
    requireProjectScope(),
    authorize('write'),
    express.text({ type: ['application/xml', 'text/xml'] }),
    ingestResults
  );

router.route('/getexecutiontc').get(keycloak.protect(), requireProjectScope(), authorize('read'), getExecutionTestCaseDetails)
router.route('/updateteststep').put(keycloak.protect(), requireProjectScope(), authorize('write'), updateTestStep)
router.route('/updateattachment').put(keycloak.protect(), requireProjectScope(), authorize('write'), updateAttachment)

// WP-F01 -- grouped with the other literal sub-routes above, all of which
// are registered ahead of the '/:id' catch-all for the reason given in
// testRepoService/routes/testrepo.js: Express matches in registration
// order and '/:id' would swallow this path.
router
  .route('/wildcardsearch')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), wildcardSearch);

// WP-F03 -- registered BEFORE '/:id', grouped with the other literal
// sub-routes. PATCH is assign-only (no lifecycle status on a run); the
// write/delete split matches every other bulk route in this codebase.
router.route('/bulk')
  .patch(keycloak.protect(), requireProjectScope(), authorize('write'), bulkUpdateTestExecutions)
  .delete(keycloak.protect(), requireProjectScope(), authorize('delete'), bulkDeleteTestExecutions);

router
  .route('/:id')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), getTestExecution)
  .put(keycloak.protect(), requireProjectScope(), authorize('write'), updateTestExecution)
  .delete(keycloak.protect(), requireProjectScope(), authorize('delete'), deleteTestExecution);

module.exports = router;
