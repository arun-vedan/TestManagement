const express = require("express");
const { initKeycloak, advancedResults, requireProjectScope, authorize } = require('@srckube/service-core');
const keycloak = initKeycloak()
const {
  getField,
  getFields,
  createField,
  updateField,
  deleteField,
} = require("../controllers/field");

const router = express.Router({ mergeParams: true });

const Folder = require("../models/field");

// Wave A-1 -- closes the tenant-isolation hole this route shipped with
// (this service's `/field` routes never adopted WP-021, unlike its own
// savedView.js sibling in this same service -- see that file's header
// comment, which this mirrors exactly): keycloak.protect() ->
// requireProjectScope() -> authorize(action), read for GET, write for
// POST/PUT, delete for DELETE. requireProjectScope() must run before
// advancedResults() on the list route -- it sets req.projectScope, which
// advancedResults() reads to fold the tenant filter into the Mongo query
// (see middleware/advancedResults.js).
router
  .route('/')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), advancedResults(Folder), getFields)
  .post(keycloak.protect(), requireProjectScope(), authorize('write'), createField);

router
  .route("/:id")
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), getField)
  .put(keycloak.protect(), requireProjectScope(), authorize('write'), updateField)
  .delete(keycloak.protect(), requireProjectScope(), authorize('delete'), deleteField);


module.exports = router;
