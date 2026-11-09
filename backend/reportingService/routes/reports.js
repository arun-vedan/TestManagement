const express = require('express');
const { initKeycloak, requireProjectScope, authorize } = require('@srckube/service-core');
const keycloak = initKeycloak();
const {
  getCoverage,
  getPassRateTrend,
  getDefectSummary,
  getPlanProgress,
  getReleaseReadiness,
  getWorkload,
  getReleaseLens,
  getTraceability,
  postRefresh
} = require('../controllers/reports');

const router = express.Router({ mergeParams: true });

// WP-040: every route project-scoped from birth (requireProjectScope()
// after keycloak.protect(), same order as every service migrated since
// WP-021) and RBAC-gated (authorize(), WP-022) -- reads need 'read' (every
// role including viewer can read, per the WP-022 matrix and this WP's own
// acceptance criterion "viewer can read"); the on-demand refresh endpoint
// mutates this service's OWN materialized cache, so it needs 'write' (same
// action every other service's create/update endpoint uses) -- viewer
// cannot trigger it, contributor/manager/admin can.
router.route('/coverage').get(keycloak.protect(), requireProjectScope(), authorize('read'), getCoverage);
router.route('/pass-rate-trend').get(keycloak.protect(), requireProjectScope(), authorize('read'), getPassRateTrend);
router.route('/defect-summary').get(keycloak.protect(), requireProjectScope(), authorize('read'), getDefectSummary);
router.route('/plan-progress').get(keycloak.protect(), requireProjectScope(), authorize('read'), getPlanProgress);
router.route('/release-readiness').get(keycloak.protect(), requireProjectScope(), authorize('read'), getReleaseReadiness);
router.route('/workload').get(keycloak.protect(), requireProjectScope(), authorize('read'), getWorkload);

// WP-F13 Task 2 -- the traceability matrix. Same guard chain, same 'read'
// action as every sibling GET above (materialized/cached like them, unlike
// release-lens below).
router.route('/traceability').get(keycloak.protect(), requireProjectScope(), authorize('read'), getTraceability);

// WP-F15/F18 Task 4 -- registered before nothing special is needed here
// ('release-lens' is a literal path segment, not a parameterized one, so
// route-ordering relative to the fixed routes above doesn't matter the way
// it does for e.g. testRepoService's '/bulk' vs '/:id'). Same
// keycloak.protect() -> requireProjectScope() -> authorize('read') chain
// as every other read route on this router.
router.route('/release-lens').get(keycloak.protect(), requireProjectScope(), authorize('read'), getReleaseLens);

router.route('/refresh').post(keycloak.protect(), requireProjectScope(), authorize('write'), postRefresh);

module.exports = router;
