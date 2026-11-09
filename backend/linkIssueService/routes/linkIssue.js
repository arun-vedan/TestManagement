const express = require('express');
const { initKeycloak, advancedResults, requireProjectScope, authorize } = require('@srckube/service-core');
const keycloak = initKeycloak()
const {
  getLink,
  createLink,
  updateLink,
  deleteLink,
  getLinks,
  deleteLinks,
  getUntestedRequirements,
  getOrphanTestCases
} = require('../controllers/linkIssue');
const {
  getConnection,
  validate,
  saveConnection,
  deleteConnection
} = require('../controllers/jiraConnection');
const {
  listMappings,
  candidates,
  suggest,
  setMapping,
  deleteMapping
} = require('../controllers/jiraUsers');
const {
  listIssues,
  searchIssues: searchJiraIssues
} = require('../controllers/jiraIssues');


const router = express.Router({ mergeParams: true });

const LinkIssue = require('../models/linkIssue');
// WP-111 — requireProjectScope() then authorize(action), in that order, after
// keycloak.protect() on every route. Same convention and same order as
// testRepoService/routes/testrepo.js (WP-021/WP-022).
//
// The two coverage routes are reads, so authorize('read'): they aggregate this
// project's link graph against requirementService/testRepoService, and since
// WP-111 they forward the caller's own verified project id rather than a
// hardcoded '1'.
// WP-142 — Jira connection settings, registered BEFORE '/:id' so 'jira' is
// not parsed as a link id (the same ordering hazard the coverage routes note).
//
// Gated on manage_project, not write: this is project-wide configuration
// holding an administrative credential for an external system, so it sits at
// the same action level as renaming or archiving the project -- matching what
// aiService's own settings routes chose for the same reason. A contributor who
// can create links must not be able to read or replace the Jira credential.
//
// validate is a POST despite reading nothing of ours, because it carries a
// secret in the body: a GET would put the token in the URL, and from there
// into access logs, browser history and any proxy in between.
router
  .route('/jira/connection')
  .get(keycloak.protect(), requireProjectScope(), authorize('manage_project'), getConnection)
  .put(keycloak.protect(), requireProjectScope(), authorize('manage_project'), saveConnection)
  .delete(keycloak.protect(), requireProjectScope(), authorize('manage_project'), deleteConnection);

router
  .route('/jira/connection/validate')
  .post(keycloak.protect(), requireProjectScope(), authorize('manage_project'), validate);

// WP-143 — Keycloak sub <-> Jira accountId mapping.
//
// manage_members, not manage_project: this is about who is who, the same
// question the project's own member list answers, and it exposes no
// credential. The connection routes above stay at manage_project because they
// hold an administrative token for an external system.
//
// The specific sub-paths are registered BEFORE '/jira/users' so 'candidates'
// and 'suggest' are not parsed as part of it.
router
  .route('/jira/users/candidates')
  .get(keycloak.protect(), requireProjectScope(), authorize('manage_members'), candidates);

router
  .route('/jira/users/suggest')
  .get(keycloak.protect(), requireProjectScope(), authorize('manage_members'), suggest);

router
  .route('/jira/users')
  .get(keycloak.protect(), requireProjectScope(), authorize('manage_members'), listMappings)
  .put(keycloak.protect(), requireProjectScope(), authorize('manage_members'), setMapping);

router
  .route('/jira/users/:keycloakSub')
  .delete(keycloak.protect(), requireProjectScope(), authorize('manage_members'), deleteMapping);

// WP-144 — reading linked Jira issues.
//
// authorize('read'), not manage_*: anyone who can read the project's links can
// see a linked issue's summary and status. These routes expose no credential —
// the stored token is used server-side and never returned — and withholding a
// linked issue's status from a contributor would make the traceability chain
// useless to the people who work in it.
//
// Registered before '/:id' so 'jira' is not parsed as a link id.
router
  .route('/jira/issues/search')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), searchJiraIssues);

router
  .route('/jira/issues')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), listIssues);

router.route('/completedelete').delete(keycloak.protect(), requireProjectScope(), authorize('delete'), deleteLinks)

// Sprint 2.2 (PB-05) — registered before '/:id' so 'coverage' isn't parsed as an id
router.route('/coverage/untested-requirements').get(keycloak.protect(), requireProjectScope(), authorize('read'), getUntestedRequirements)
router.route('/coverage/orphan-testcases').get(keycloak.protect(), requireProjectScope(), authorize('read'), getOrphanTestCases)

router
  .route('/')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), advancedResults(LinkIssue), getLinks)
  .post(keycloak.protect(), requireProjectScope(), authorize('write'), createLink);

router
  .route('/:id')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), getLink)
  .put(keycloak.protect(), requireProjectScope(), authorize('write'), updateLink)
  .delete(keycloak.protect(), requireProjectScope(), authorize('delete'), deleteLink);

module.exports = router;
