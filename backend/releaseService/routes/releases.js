const express = require('express');
const { initKeycloak, advancedResults, requireProjectScope, authorize } = require('@srckube/service-core');
const keycloak = initKeycloak();
const {
  getReleases,
  getRelease,
  createRelease,
  updateRelease,
  deleteRelease,
  linkTestPlan,
  unlinkTestPlan,
  getGateStatus
} = require('../controllers/releases');

const router = express.Router({ mergeParams: true });

const Release = require('../models/Release');

// WP-025: project-scoped from birth — every route mounts
// requireProjectScope() after keycloak.protect() and, for the list route,
// before advancedResults(), same order as every WP-021-migrated service.
//
// authorize(action) (WP-022) is now wired in on every route below,
// immediately after requireProjectScope() — same insertion point and same
// convention as testRepoService/routes/testrepo.js and
// defectService/routes/defects.js: 'read' on GETs, 'write' on routes that
// create/mutate a release, 'delete' on the one route that removes the
// release resource itself (viewer = read-only everywhere, contributor =
// write but no delete, per the shared PERMISSION_MATRIX in
// service-core/permissions.js).
//
// gate-status is a pure evaluation endpoint (controllers/releases.js —
// getGateStatus reads the release and its dependencies' live data, never
// writes anything) so it is gated 'read', same tier as GET /:id.
//
// The /:id/plans link/unlink pair both mutate the SAME field
// (release.linkedTestPlanIds) on an existing release — linking pushes an
// id, unlinking filters one out; neither creates or destroys the release
// document itself. Gating link 'write' and leaving unlink at a stricter
// tier would make link/unlink asymmetric for a contributor (can attach a
// plan but not detach the same plan they just attached), which doesn't
// match "day-to-day content work" (PERMISSION_MATRIX's own description of
// what 'write' is for). unlink is therefore also 'write', not 'delete' —
// 'delete' is reserved for DELETE /:id, which destroys the release
// resource itself.
router
  .route('/')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), advancedResults(Release), getReleases)
  .post(keycloak.protect(), requireProjectScope(), authorize('write'), createRelease);

router.route('/:id/gate-status').get(keycloak.protect(), requireProjectScope(), authorize('read'), getGateStatus);

router.route('/:id/plans').post(keycloak.protect(), requireProjectScope(), authorize('write'), linkTestPlan);
router.route('/:id/plans/:testPlanId').delete(keycloak.protect(), requireProjectScope(), authorize('write'), unlinkTestPlan);

router
  .route('/:id')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), getRelease)
  .put(keycloak.protect(), requireProjectScope(), authorize('write'), updateRelease)
  .delete(keycloak.protect(), requireProjectScope(), authorize('delete'), deleteRelease);

module.exports = router;
