const express = require('express');
const { initKeycloak } = require('@srckube/service-core');
const keycloak = initKeycloak();
const {
  getOrganizations,
  getOrganization,
  createOrganization,
  updateOrganization,
  deleteOrganization,
  addOrgMember,
  updateOrgMemberRole,
  removeOrgMember,
  listOrgMembers
} = require('../controllers/organizations');

const router = express.Router();

router
  .route('/')
  .get(keycloak.protect(), getOrganizations)
  .post(keycloak.protect(), createOrganization);

// WP-110 — organization membership. Authorization is inside the controllers
// (loadOrgForOrgAction) rather than a route-level middleware, so the
// ownerless-organization recovery path can be expressed per action; see
// controllers/organizations.js.
router
  .route('/:id/members')
  // WP-132: GET backs the project member picker (see controllers/organizations.js).
  .get(keycloak.protect(), listOrgMembers)
  .post(keycloak.protect(), addOrgMember);

router
  .route('/:id/members/:userId')
  .put(keycloak.protect(), updateOrgMemberRole)
  .delete(keycloak.protect(), removeOrgMember);

router
  .route('/:id')
  .get(keycloak.protect(), getOrganization)
  .put(keycloak.protect(), updateOrganization)
  .delete(keycloak.protect(), deleteOrganization);

module.exports = router;
