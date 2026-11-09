const express = require('express');
const { initKeycloak, advancedResults, requireProjectScope, authorize } = require('@srckube/service-core');
const keycloak = initKeycloak()
const {
  getTestCase,
  createTestCase,
  updateTestCase,
  deleteTestCase,
  getTestCases,

} = require('../controllers/objectrepo');


const router = express.Router({ mergeParams: true });

const Folder = require('../models/objectrepo');




router
  .route('/')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), advancedResults(Folder), getTestCases)
  .post(keycloak.protect(), requireProjectScope(), authorize('write'), createTestCase);

router
  .route('/:id')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), getTestCase)
  .put(keycloak.protect(), requireProjectScope(), authorize('write'), updateTestCase)
  .delete(keycloak.protect(), requireProjectScope(), authorize('delete'), deleteTestCase);

module.exports = router;
