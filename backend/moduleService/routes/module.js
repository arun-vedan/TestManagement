const express = require('express');
const { initKeycloak, advancedResults, requireProjectScope, authorize } = require('@srckube/service-core');
const keycloak = initKeycloak()
const {
  createModule,
  getModule,
  getModules,
  updateModule,
  deleteModule
} = require('../controllers/module');


const router = express.Router({ mergeParams: true });

const Module = require('../models/Module');




// WP-114 — keycloak.protect() -> requireProjectScope() -> authorize(action) on
// every route, mounted before advancedResults() on the list route so the
// tenant filter is applied.
router
  .route('/')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), advancedResults(Module), getModules)
  .post(keycloak.protect(), requireProjectScope(), authorize('write'), createModule);

router
  .route('/:id')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), getModule)
  .put(keycloak.protect(), requireProjectScope(), authorize('write'), updateModule)
  .delete(keycloak.protect(), requireProjectScope(), authorize('delete'), deleteModule);

module.exports = router;
