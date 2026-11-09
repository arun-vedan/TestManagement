const express = require('express');
const { initKeycloak, advancedResults, requireProjectScope, authorize } = require('@srckube/service-core');
const keycloak = initKeycloak()
const {
  createIssueStatus,
  getIssueStatus,
  getIssueStatuses,
  updateIssueStatus,
  deleteIssueStatus,
  seedProjectStatuses
} = require('../controllers/issueStatus');

const router = express.Router({ mergeParams: true });

const IssueStatus = require('../models/IssueStatus');

// WP-116 follow-up — mounted BEFORE '/:id' so the literal segment "seed" is
// not captured as an id. Scoped and authorize('write') like any other write.
router.route('/seed').post(keycloak.protect(), requireProjectScope(), authorize('write'), seedProjectStatuses);

router
  .route('/')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), advancedResults(IssueStatus), getIssueStatuses)
  .post(keycloak.protect(), requireProjectScope(), authorize('write'), createIssueStatus);

router
  .route('/:id')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), getIssueStatus)
  .put(keycloak.protect(), requireProjectScope(), authorize('write'), updateIssueStatus)
  .delete(keycloak.protect(), requireProjectScope(), authorize('delete'), deleteIssueStatus);

module.exports = router;
