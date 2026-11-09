const express = require('express');
const { initKeycloak, advancedResults, requireProjectScope, authorize } = require('@srckube/service-core');
const keycloak = initKeycloak();
const {
  getSharedSteps, getSharedStep, createSharedStep,
  updateSharedStep, deleteSharedStep, getSharedStepUsage,
} = require('../controllers/sharedStep');

const router = express.Router({ mergeParams: true });
const SharedStep = require('../models/SharedStep');

// Named route registered before the generic '/:id' -- same convention as
// routes/testrepo.js's updateTestCaseByParam/wildcardsearch (Express
// matches in registration order, and '/:id' would otherwise swallow
// '/:id/usage' as a second path segment it doesn't handle).
router.route('/:id/usage').get(keycloak.protect(), requireProjectScope(), authorize('read'), getSharedStepUsage);

router.route('/')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), advancedResults(SharedStep), getSharedSteps)
  .post(keycloak.protect(), requireProjectScope(), authorize('write'), createSharedStep);

router.route('/:id')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), getSharedStep)
  .put(keycloak.protect(), requireProjectScope(), authorize('write'), updateSharedStep)
  .delete(keycloak.protect(), requireProjectScope(), authorize('delete'), deleteSharedStep);

module.exports = router;
