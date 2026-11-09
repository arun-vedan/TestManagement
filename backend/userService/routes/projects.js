const express = require('express');
const { initKeycloak } = require('@srckube/service-core');
const keycloak = initKeycloak();
const { requireProjectAction } = require('../middleware/projectAuthorize');
const { createInvite, listInvites, revokeInvite } = require('../controllers/invites');
const {
  getProjects,
  getProjectScope,
  getProject,
  createProject,
  updateProject,
  deleteProject,
  addMember,
  updateMemberRole,
  removeMember
} = require('../controllers/projects');

const router = express.Router();

// WP-022: requireProjectAction(action) mounted on every route below :id --
// see middleware/projectAuthorize.js's own comment on why this is a local
// equivalent of @srckube/service-core's authorize() rather than that
// middleware directly (it would otherwise have userService call itself
// over HTTP to authorize a request it can answer from its own DB).
//
// GET / (list) and POST / (create) are deliberately NOT membership-gated:
// there is no existing project to hold a role on yet for POST, and GET /
// must stay unfiltered by design (see controllers/projects.js's
// getProjects comment -- requireProjectScope() in every other service
// caches this exact response, globally, to answer membership checks).
router
  .route('/')
  .get(keycloak.protect(), getProjects)
  .post(keycloak.protect(), createProject);

// WP-110 architecture (c): mounted BEFORE /:id deliberately. Express matches
// in declaration order, so without this the literal path segment "scope"
// would be captured as req.params.id by the route below and looked up as a
// Mongo _id (a guaranteed CastError/404). This is the endpoint
// @srckube/service-core's requireProjectScope() now calls instead of caching
// the whole unfiltered project list — see controllers/projects.js's
// getProjectScope comment.
//
// Not membership-gated by requireProjectAction(): deciding whether the caller
// is a member IS what this endpoint answers, so gating it on membership would
// be circular. It is gated by keycloak.protect() and discloses nothing about
// projects the caller has no access to (403, never 404).
router.route('/scope/:projectId').get(keycloak.protect(), getProjectScope);

router
  .route('/:id')
  .get(keycloak.protect(), requireProjectAction('read'), getProject)
  .put(keycloak.protect(), requireProjectAction('manage_project'), updateProject)
  .delete(keycloak.protect(), requireProjectAction('manage_project'), deleteProject);

router
  .route('/:id/members')
  .post(keycloak.protect(), requireProjectAction('manage_members'), addMember);

// WP-132 — invitations. Gated on the SAME action as adding a member directly:
// an invite is a deferred membership grant, so anything that can add a member
// can invite one, and nothing else can. The nested path means Kong's existing
// /api/v1/projects route already covers these (prefix match), so no gateway
// change is needed for them.
router
  .route('/:id/invites')
  .get(keycloak.protect(), requireProjectAction('manage_members'), listInvites)
  .post(keycloak.protect(), requireProjectAction('manage_members'), createInvite);

router
  .route('/:id/invites/:inviteId')
  .delete(keycloak.protect(), requireProjectAction('manage_members'), revokeInvite);

router
  .route('/:id/members/:userId')
  .put(keycloak.protect(), requireProjectAction('manage_members'), updateMemberRole)
  .delete(keycloak.protect(), requireProjectAction('manage_members'), removeMember);

module.exports = router;
