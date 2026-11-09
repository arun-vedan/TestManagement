const express = require('express');
const { initKeycloak, requireProjectScope, authorize } = require('@srckube/service-core');
const keycloak = initKeycloak();
const { getAuditEvents } = require('../controllers/audit');

const router = express.Router({ mergeParams: true });

// WP-024: GET only, deliberately. AuditEvent is append-only -- the only
// writer anywhere in the codebase is service-core's audit() helper, called
// from other services' controllers directly against Mongo (see
// backend/shared/service-core/audit.js), never through this HTTP surface.
// There is no POST/PUT/PATCH/DELETE route here and none should ever be
// added; that omission (not a permission check) is what makes this
// endpoint provably append-only from the API's point of view.
//
// requireProjectScope() + authorize('read') -- same WP-021/WP-022 chain as
// every other project-scoped read route (testrepo/requirement/defects).
// 'read' is permitted for every role including viewer (see
// service-core/permissions.js), matching the WP-024 brief's "viewer-role
// accessible... auditors read, they do not write".
router.route('/').get(keycloak.protect(), requireProjectScope(), authorize('read'), getAuditEvents);

module.exports = router;
