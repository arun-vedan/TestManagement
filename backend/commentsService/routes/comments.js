const express = require('express');
const { initKeycloak, requireProjectScope, authorize } = require('@srckube/service-core');
const keycloak = initKeycloak()
// NOT migrated to @srckube/service-core's shared advancedResults: this local
// copy has a deliberate deviation (hardcodes req.query.status = 1) that
// enforces the soft-delete convention used by this service (deleteComment
// sets status: 0 instead of removing the document — see controllers/comments.js).
// The shared advancedResults has no default-filter hook, so replacing this
// would silently start listing soft-deleted comments. Left local on purpose
// (WP-012).
const advancedResults = require('../middleware/advancedResults');
const {
  createComments,
  getComments,
  getComment,
  updateComments,
  deleteComment,
  updateCommentsByParam
} = require('../controllers/comments')


const router = express.Router({ mergeParams: true });

const Comments = require('../models/Comments');


// WP-115 — keycloak.protect() -> requireProjectScope() -> authorize(action) on
// every route. Mounted before the LOCAL advancedResults() on the list route,
// which WP-115 taught to fold in req.projectScope.projectId (it had missed the
// WP-021 addition service-core's copy received).
//
// deleteCommentById is a PUT because deletion here is a SOFT delete
// (status -> 0, the deviation this service's advancedResults enforces), so it
// takes authorize('delete') on intent rather than on HTTP verb.
router.route('/updateCommentsByParam').put(keycloak.protect(), requireProjectScope(), authorize('write'), updateCommentsByParam)
router.route('/deleteCommentById').put(keycloak.protect(), requireProjectScope(), authorize('delete'), deleteComment)
// WP-104 follow-up: the wildcardSearch handler this line used to reach has
// been DELETED, not re-enabled. It was dead three ways over -- this route was
// commented out, there is no Kong route for it, and it searched `reqId` and
// `requirementSummary`, neither of which exists on the Comments model (id,
// comments, moduleId, status, isEdited, typeId, projectId), so it could never
// have matched a document.
//
// Worth removing rather than leaving: it interpolated `req.query.search`
// straight into $regex with no escaping and no .limit(), so uncommenting one
// line would have published an unbounded, injectable regex search -- the exact
// thing WP-104 fixed on the other four services. A comment is not a control.
router
  .route('/')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), advancedResults(Comments), getComments)
  .post(keycloak.protect(), requireProjectScope(), authorize('write'), createComments);



router.route('/:id').get(keycloak.protect(), requireProjectScope(), authorize('read'), getComment);
  
  

  module.exports = router;