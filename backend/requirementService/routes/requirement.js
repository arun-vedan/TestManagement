const express = require('express');
const { initKeycloak, advancedResults, requireProjectScope, authorize } = require('@srckube/service-core');
const keycloak = initKeycloak()
const {
  getRequirement,
  createRequirement,
  updateRequirement,
  deleteRequirement,
  getRequirements,
  updateRequirementByParam,
  wildcardSearch,
  updateRequirementStatus,
  getRequirementVersions,
  bulkUpdateRequirements,
  bulkDeleteRequirements
} = require('../controllers/requirement');
const { previewImport, commitImport } = require('../controllers/importExport');


const router = express.Router({ mergeParams: true });

const Folder = require('../models/requirement');

// WP-021: requireProjectScope() mounted on every protected route, after
// keycloak.protect() and, for the list route, before advancedResults().
// WP-022: authorize(action) mounted immediately after requireProjectScope()
// on every route -- write routes gated on 'write'/'delete' first per the
// WP brief, then reads on 'read' (viewer = read-only everywhere).
router.route('/updateRequirementByParam').put(keycloak.protect(), requireProjectScope(), authorize('write'), updateRequirementByParam)
router.route('/wildcardsearch').get(keycloak.protect(), requireProjectScope(), authorize('read'), wildcardSearch)

// WP-045 — CSV import (dry-run preview + commit). See
// backend/testRepoService/routes/testrepo.js's identical comment for why
// these are mounted here, above the `/:id` routes.
router.route('/import/preview').post(keycloak.protect(), requireProjectScope(), authorize('write'), previewImport)
router.route('/import/commit').post(keycloak.protect(), requireProjectScope(), authorize('write'), commitImport)

// WP-F03 -- registered BEFORE '/:id'. Express matches in registration
// order and '/:id' would otherwise swallow '/bulk' as id='bulk'. Split by
// HTTP method rather than one route dispatching on req.body.action, so the
// existing authorize() middleware gates write and delete separately with
// no new per-body authorization logic -- same shape as
// testRepoService/routes/testrepo.js:44-56.
router.route('/bulk')
  .patch(keycloak.protect(), requireProjectScope(), authorize('write'), bulkUpdateRequirements)
  .delete(keycloak.protect(), requireProjectScope(), authorize('delete'), bulkDeleteRequirements);

router
  .route('/')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), advancedResults(Folder), getRequirements)
  .post(keycloak.protect(), requireProjectScope(), authorize('write'), createRequirement);

router.route('/:id/status').put(keycloak.protect(), requireProjectScope(), authorize('write'), updateRequirementStatus)
router.route('/:id/versions').get(keycloak.protect(), requireProjectScope(), authorize('read'), getRequirementVersions)

router
  .route('/:id')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), getRequirement)
  .put(keycloak.protect(), requireProjectScope(), authorize('write'), updateRequirement)
  .delete(keycloak.protect(), requireProjectScope(), authorize('delete'), deleteRequirement);

module.exports = router;
