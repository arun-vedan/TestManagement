const express = require('express');
const { initKeycloak, requireProjectScope, authorize } = require('@srckube/service-core');
const keycloak = initKeycloak();
const { getSavedViews, createSavedView, updateSavedView, deleteSavedView } = require('../controllers/savedView');

const router = express.Router({ mergeParams: true });

// WP-043 -- SavedView routes. Same keycloak.protect() -> requireProjectScope()
// -> authorize(action) chain as every other WP-021/WP-022-migrated route in
// this repo (testRepoService/routes/testrepo.js, defectService/routes/
// defects.js). Gated on 'write' for create/update (not a bespoke
// 'manage_views' action) -- a saved view is personal-productivity content,
// the same permission class as creating/updating a test case or defect;
// adding a new action to the shared PERMISSION_MATRIX for this alone was
// judged unnecessary scope. A viewer can list views (their own + system
// defaults) but cannot create/edit/delete one -- consistent with "viewer =
// read-only everywhere" (WP-022 acceptance criterion, verbatim).
router
  .route('/')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), getSavedViews)
  .post(keycloak.protect(), requireProjectScope(), authorize('write'), createSavedView);

router
  .route('/:id')
  .put(keycloak.protect(), requireProjectScope(), authorize('write'), updateSavedView)
  .delete(keycloak.protect(), requireProjectScope(), authorize('delete'), deleteSavedView);

module.exports = router;
