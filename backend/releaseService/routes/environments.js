const express = require('express');
const { initKeycloak, advancedResults, requireProjectScope, authorize } = require('@srckube/service-core');
const keycloak = initKeycloak();
const {
  getEnvironments,
  getEnvironment,
  createEnvironment,
  updateEnvironment,
  deleteEnvironment
} = require('../controllers/environments');

const router = express.Router({ mergeParams: true });

const Environment = require('../models/Environment');

// WP-025: project-scoped from birth (per dispatch brief) — every route
// mounts requireProjectScope() after keycloak.protect() and, for the list
// route, before advancedResults(), same order as every WP-021-migrated
// service.
//
// authorize(action) (WP-022) is wired in on every route below, immediately
// after requireProjectScope() — same convention as releases.js in this
// same service and as testRepoService/routes/testrepo.js: 'read' on GETs,
// 'write' on create/update, 'delete' on the route that removes the
// environment resource itself.
router
  .route('/')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), advancedResults(Environment), getEnvironments)
  .post(keycloak.protect(), requireProjectScope(), authorize('write'), createEnvironment);

router
  .route('/:id')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), getEnvironment)
  .put(keycloak.protect(), requireProjectScope(), authorize('write'), updateEnvironment)
  .delete(keycloak.protect(), requireProjectScope(), authorize('delete'), deleteEnvironment);

module.exports = router;
