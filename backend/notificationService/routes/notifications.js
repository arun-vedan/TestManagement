const express = require('express');
const { initKeycloak, requireProjectScope, authorize } = require('@srckube/service-core');
const keycloak = initKeycloak();
const { getNotifications, markNotificationRead } = require('../controllers/notifications');

const router = express.Router();

// WP-021/WP-022 chain (keycloak.protect() -> requireProjectScope() ->
// authorize(action)), same as testrepo/requirement/defects/audit. 'read' is
// used on BOTH routes below, including the mark-read PATCH -- deliberately,
// not an oversight: 'read' is the one action every project role (including
// viewer, per service-core/permissions.js's PERMISSION_MATRIX) is permitted,
// and acknowledging your own notification is a personal state change, not a
// project-content mutation of the kind 'write' gates elsewhere (creating/
// editing a requirement, test case, defect). A viewer-role auditor must be
// able to dismiss their own notifications the same as any other role.
router.route('/').get(keycloak.protect(), requireProjectScope(), authorize('read'), getNotifications);
router.route('/:id/read').patch(keycloak.protect(), requireProjectScope(), authorize('read'), markNotificationRead);

module.exports = router;
