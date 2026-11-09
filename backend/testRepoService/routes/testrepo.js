const express = require('express');
const { initKeycloak, advancedResults, requireProjectScope, authorize } = require('@srckube/service-core');
const keycloak = initKeycloak()
const {
  getTestCase,
  createTestCase,
  updateTestCase,
  deleteTestCase,
  getTestCases,
  updateTestCaseByParam,
  wildcardSearch,
  updateTestCaseStatus,
  getTestCaseVersions,
  bulkUpdateTestCases,
  bulkDeleteTestCases,
  getTestCaseParameters
} = require('../controllers/testrepo');
const { previewImport, commitImport } = require('../controllers/importExport');


const router = express.Router({ mergeParams: true });

const Folder = require('../models/testrepo');

// WP-021: requireProjectScope() mounted on every protected route, after
// keycloak.protect() (needs req.kauth) and, for the list route, before
// advancedResults() (needs req.projectScope to add the tenant filter).
// WP-022: authorize(action) mounted immediately after requireProjectScope()
// on every route -- write routes gated on 'write'/'delete' first per the
// WP brief, then reads on 'read' (viewer = read-only everywhere).
router.route('/updateTestCaseByParam').put(keycloak.protect(), requireProjectScope(), authorize('write'), updateTestCaseByParam)
router.route('/wildcardsearch').get(keycloak.protect(), requireProjectScope(), authorize('read'), wildcardSearch)

// WP-045 — CSV import (dry-run preview + commit). Mounted here, alongside
// the other named sub-routes above, before the generic `/:id` routes below
// -- same reasoning as updateTestCaseByParam/wildcardsearch already
// documented on this file: Express matches in registration order and these
// are multi-segment paths (`/import/preview`, `/import/commit`) that don't
// collide with `/:id` (single segment) or `/:id/status`/`/:id/versions`
// (second segment is a literal, never "preview"/"commit"), but keeping the
// named routes grouped together above the parameterized ones matches this
// file's existing convention. Gated on authorize('write') -- importing
// creates test cases, same permission as the plain POST /.
router.route('/import/preview').post(keycloak.protect(), requireProjectScope(), authorize('write'), previewImport)
router.route('/import/commit').post(keycloak.protect(), requireProjectScope(), authorize('write'), commitImport)

// WP-043 -- bulk operations. Registered before '/:id' (Express matches in
// registration order, and '/:id' would otherwise swallow '/bulk' as
// id='bulk' for any verb '/:id' itself handles -- same reasoning as
// import/preview and import/commit above). PATCH for assign/status
// (authorize('write')); DELETE for bulk delete (authorize('delete')) --
// split by HTTP method rather than a single route dispatching on
// req.body.action so the SAME authorize(action) middleware (WP-022) that
// already gates every other write/delete route here also gates these,
// with no new per-body-value authorization logic to get wrong.
router.route('/bulk')
  .patch(keycloak.protect(), requireProjectScope(), authorize('write'), bulkUpdateTestCases)
  .delete(keycloak.protect(), requireProjectScope(), authorize('delete'), bulkDeleteTestCases)

router
  .route('/')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), advancedResults(Folder), getTestCases)
  .post(keycloak.protect(), requireProjectScope(), authorize('write'), createTestCase);

router.route('/:id/status').put(keycloak.protect(), requireProjectScope(), authorize('write'), updateTestCaseStatus)
router.route('/:id/versions').get(keycloak.protect(), requireProjectScope(), authorize('read'), getTestCaseVersions)
// WP-F07a Task 2 -- registered before the generic '/:id' below, same
// convention as /:id/status and /:id/versions above (Express matches in
// registration order, and '/:id' would otherwise swallow '/:id/parameters'
// as a second path segment it doesn't handle -- i.e. "parameters" would be
// matched as :id itself if this came after).
router.route('/:id/parameters').get(keycloak.protect(), requireProjectScope(), authorize('read'), getTestCaseParameters)

router
  .route('/:id')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), getTestCase)
  .put(keycloak.protect(), requireProjectScope(), authorize('write'), updateTestCase)
  .delete(keycloak.protect(), requireProjectScope(), authorize('delete'), deleteTestCase);

module.exports = router;
