const express = require('express');
const { initKeycloak, advancedResults, requireProjectScope, authorize } = require('@srckube/service-core');
const keycloak = initKeycloak()
const {
  getDefect,
  createDefect,
  updateDefect,
  deleteDefect,
  getDefects,
  wildcardSearch,
  updateDefectStatus,
  bulkUpdateDefects,
  bulkDeleteDefects
} = require('../controllers/defects');


const router = express.Router({ mergeParams: true });

const Folder = require('../models/defects');
// WP-021: requireProjectScope() mounted on every protected route, after
// keycloak.protect() and, for the list route, before advancedResults().
// WP-022: authorize(action) mounted immediately after requireProjectScope()
// on every route -- write routes gated on 'write'/'delete' first per the
// WP brief, then reads on 'read' (viewer = read-only everywhere).
router.route('/wildcardsearch').get(keycloak.protect(), requireProjectScope(), authorize('read'), wildcardSearch)

// WP-043 -- bulk operations, registered before '/:id' -- see
// testRepoService/routes/testrepo.js's matching comment for the full
// reasoning (identical here).
router.route('/bulk')
  .patch(keycloak.protect(), requireProjectScope(), authorize('write'), bulkUpdateDefects)
  .delete(keycloak.protect(), requireProjectScope(), authorize('delete'), bulkDeleteDefects)

router
  .route('/')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), advancedResults(Folder), getDefects)
  .post(keycloak.protect(), requireProjectScope(), authorize('write'), createDefect);

// WP-010 (Sprint 2.4): dedicated, istatusservice-graph-validated transition
// endpoint. Registered before '/:id' would otherwise be ambiguous with
// Express route matching -- '/:id/status' is more specific so this is safe
// either way, but kept adjacent to '/:id' for readability.
router.route('/:id/status').put(keycloak.protect(), requireProjectScope(), authorize('write'), updateDefectStatus);

router
  .route('/:id')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), getDefect)
  .put(keycloak.protect(), requireProjectScope(), authorize('write'), updateDefect)
  .delete(keycloak.protect(), requireProjectScope(), authorize('delete'), deleteDefect);

module.exports = router;
