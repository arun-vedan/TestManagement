const express = require('express');
const { initKeycloak, advancedResults, requireProjectScope, authorize } = require('@srckube/service-core');
const keycloak = initKeycloak()
const {
  createFolder,
  getFolder,
  getFolders,
  updateFolder,
  deleteFolder,
  updateFolderByParam
} = require('../controllers/folder');


const router = express.Router({ mergeParams: true });

const Folder = require('../models/Folder');


// WP-113 — keycloak.protect() -> requireProjectScope() -> authorize(action) on
// every route, in that order, matching every other migrated service.
//
// Mounted before advancedResults() on the list route: requireProjectScope()
// sets req.projectScope, which advancedResults reads to add the tenant filter
// (and, since WP-102, to scope the pagination count as well).
router.route('/updatebyparam/:id').put(keycloak.protect(), requireProjectScope(), authorize('write'), updateFolderByParam)

router
  .route('/')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), advancedResults(Folder), getFolders)
  .post(keycloak.protect(), requireProjectScope(), authorize('write'), createFolder);

router
  .route('/:id')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), getFolder)
  .put(keycloak.protect(), requireProjectScope(), authorize('write'), updateFolder)
  .delete(keycloak.protect(), requireProjectScope(), authorize('delete'), deleteFolder);

module.exports = router;
