const express = require('express');
const { initKeycloak, advancedResults, requireProjectScope, authorize } = require('@srckube/service-core');
const keycloak = initKeycloak();
const {
  getDatasets, getDataset, createDataset,
  updateDataset, deleteDataset, getDatasetUsage,
} = require('../controllers/dataset');

const router = express.Router({ mergeParams: true });
const Dataset = require('../models/Dataset');

// Named route registered before the generic '/:id' -- same convention as
// routes/testrepo.js's updateTestCaseByParam/wildcardsearch (Express
// matches in registration order, and '/:id' would otherwise swallow
// '/:id/usage' as a second path segment it doesn't handle).
router.route('/:id/usage').get(keycloak.protect(), requireProjectScope(), authorize('read'), getDatasetUsage);

router.route('/')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), advancedResults(Dataset), getDatasets)
  .post(keycloak.protect(), requireProjectScope(), authorize('write'), createDataset);

router.route('/:id')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), getDataset)
  .put(keycloak.protect(), requireProjectScope(), authorize('write'), updateDataset)
  .delete(keycloak.protect(), requireProjectScope(), authorize('delete'), deleteDataset);

module.exports = router;
