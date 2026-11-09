const express = require('express');
const { initKeycloak, advancedResults, requireProjectScope, authorize } = require('@srckube/service-core');
const keycloak = initKeycloak()
const {
  getTestPlan,
  createTestPlan,
  updateTestPlan,
  deleteTestPlan,
  getTestPlans,
  wildcardSearch,
  bulkDeleteTestPlans
} = require('../controllers/testplan');

const router = express.Router({ mergeParams: true });

const TestPlan = require('../models/TestPlan');

// WP-021b: closes the gap WP-021 deferred ("the rest in later work") --
// requireProjectScope() mounted on every route, after keycloak.protect()
// (needs req.kauth) and, for the list route, before advancedResults()
// (needs req.projectScope to add the tenant filter -- see
// service-core/middleware/advancedResults.js). authorize(action) mounted
// immediately after requireProjectScope(), same convention as
// testRepoService/routes/testrepo.js (WP-022): writes gated on
// 'write'/'delete', reads on 'read'.
router
  .route('/')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), advancedResults(TestPlan), getTestPlans)
  .post(keycloak.protect(), requireProjectScope(), authorize('write'), createTestPlan);

// WP-F01 -- registered BEFORE '/:id'. Express matches in registration
// order, and '/:id' is a single-segment pattern that would otherwise
// swallow '/wildcardsearch' and try to cast it to an ObjectId. Same
// reasoning, and the same comment, as testRepoService/routes/testrepo.js's
// '/bulk' and '/wildcardsearch' registrations.
router
  .route('/wildcardsearch')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), wildcardSearch);

// WP-F03 -- registered BEFORE '/:id' (Express matches in registration
// order). DELETE only: TestPlan has no status or assignedTo to bulk-update.
router.route('/bulk')
  .delete(keycloak.protect(), requireProjectScope(), authorize('delete'), bulkDeleteTestPlans);

router
  .route('/:id')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), getTestPlan)
  .put(keycloak.protect(), requireProjectScope(), authorize('write'), updateTestPlan)
  .delete(keycloak.protect(), requireProjectScope(), authorize('delete'), deleteTestPlan);

module.exports = router;
