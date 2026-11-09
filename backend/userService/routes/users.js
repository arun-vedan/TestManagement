const express = require('express');
const { initKeycloak } = require('@srckube/service-core');
const keycloak = initKeycloak()
const {
  getKeycloakUser,
  getKeycloakUsers,
  getUserDirectory
} = require('../controllers/users');

const router = express.Router({ mergeParams: true });

// Identity lookup. Authorization is inside the controllers (co-membership),
// not a middleware: the rule depends on WHICH identity is being resolved, which
// a route-level guard cannot see. See utils/identityVisibility.js.
router.route('/kcUser').get(keycloak.protect(), getKeycloakUser)
router.route('/kcUsers').get(keycloak.protect(), getKeycloakUsers)
// The people on one project (X-Project-Id), replacing the realm-wide list the
// assignee picker used to read.
router.route('/directory').get(keycloak.protect(), getUserDirectory)

// The legacy generic User CRUD (GET/POST /, GET/PUT/DELETE /:id) and its
// models/User.js are retired: Kong never routed them, so they were unreachable
// in production, and no consumer existed anywhere. The `srckube-user.users`
// collection is left untouched -- retiring code does not need to destroy data.



module.exports = router;
