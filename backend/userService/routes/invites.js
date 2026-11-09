const express = require('express');
const { initKeycloak } = require('@srckube/service-core');
const { acceptInvite } = require('../controllers/invites');

const keycloak = initKeycloak();
const router = express.Router();

// WP-132 — accepting an invitation.
//
// This router is mounted at /api/v1/invites and is deliberately NOT
// project-scoped. requireProjectScope() resolves the caller's membership of a
// project and 403s when they have none — which is precisely the state every
// invitee is in at the moment they accept. Mounting it here would make the
// endpoint reject every legitimate call.
//
// What replaces that protection is the binding in acceptInvite(): the token
// must hash to a pending, unexpired invite, AND the caller's own verified token
// must carry the email address the invite was sent to. So the authorisation
// decision is "do you hold this address", not "are you already a member".
router.route('/accept').post(keycloak.protect(), acceptInvite);

module.exports = router;
