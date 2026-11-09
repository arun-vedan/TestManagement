const express = require('express');
const { initKeycloak, advancedResults, requireProjectScope, authorize } = require('@srckube/service-core');
const keycloak = initKeycloak()
const {
  getTestCase,
  createTestCase,
  updateTestCase,
  deleteTestCase,
  getTestCases,
  getStepDef
} = require('../controllers/automation');


const router = express.Router({ mergeParams: true });

const Folder = require('../models/automation');



// WP-117 — THIS ROUTE HAD NO AUTHENTICATION AT ALL.
//
// It was `.get(getStepDef)` — no keycloak.protect(), unlike every other route
// in this file. getStepDef reads every file under
// ./automationFramework/src/steps and returns their CONTENTS, so it is a
// source-disclosure endpoint that required no token.
//
// It was not reachable from outside: Kong rejects unauthenticated requests at
// the gateway since WP-023, and a request to
// /api/v1/automation/getstepdef through Kong returns 401 — verified. But
// hitting the service directly returned HTTP 200 with the file contents, also
// verified, which means any other container on the Docker network could read
// it, and the only thing standing in front of it was the gateway. Every other
// route here defends itself too; this one did not.
//
// Now authenticated and scoped like its siblings. The scope check does not
// filter anything — the step definitions are files shipped in the image, the
// same for every tenant — so it functions as "you must be a member of some
// project to read the automation framework's step definitions", which is the
// same bar the rest of the service sets.
router.route('/getstepdef').get(keycloak.protect(), requireProjectScope(), authorize('read'), getStepDef)
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
