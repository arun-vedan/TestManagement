const express = require('express');
const { initKeycloak, advancedResults, requireProjectScope, authorize } = require('@srckube/service-core');
const keycloak = initKeycloak();
const {
  getCaseTemplates, getCaseTemplate, createCaseTemplate,
  updateCaseTemplate, deleteCaseTemplate,
} = require('../controllers/caseTemplate');

const router = express.Router({ mergeParams: true });
const CaseTemplate = require('../models/CaseTemplate');

router.route('/')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), advancedResults(CaseTemplate), getCaseTemplates)
  .post(keycloak.protect(), requireProjectScope(), authorize('write'), createCaseTemplate);

router.route('/:id')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), getCaseTemplate)
  .put(keycloak.protect(), requireProjectScope(), authorize('write'), updateCaseTemplate)
  .delete(keycloak.protect(), requireProjectScope(), authorize('delete'), deleteCaseTemplate);

module.exports = router;
