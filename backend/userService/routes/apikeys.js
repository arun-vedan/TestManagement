const express = require('express');
const { initKeycloak, requireProjectScope, authorize, requireAuth } = require('@srckube/service-core');
const keycloak = initKeycloak();
const { requireProjectScopeLocal } = require('../middleware/apiKeyProjectScope');
const { createApiKey, getApiKeys, revokeApiKey, verifyApiKey } = require('../controllers/apikeys');

const router = express.Router();

// Management endpoints -- human Keycloak bearer ONLY (keycloak.protect(),
// not requireAuth()), so an API key can never mint, list, or revoke API
// keys, including itself. requireProjectScopeLocal('manage_project') keeps
// key issuance at the same admin-only bar as renaming/archiving a project
// (see controllers/apikeys.js's header comment) and resolves project
// membership straight from userService's own DB (see
// middleware/apiKeyProjectScope.js -- same "don't call yourself over HTTP"
// reasoning as the existing middleware/projectAuthorize.js), unlike the
// demo routes below which deliberately DO use the cross-service
// requireProjectScope() to prove that real pattern end-to-end.
router
  .route('/')
  .post(keycloak.protect(), requireProjectScopeLocal('manage_project'), createApiKey)
  .get(keycloak.protect(), requireProjectScopeLocal('manage_project'), getApiKeys);

router
  .route('/:keyId')
  .delete(keycloak.protect(), requireProjectScopeLocal('manage_project'), revokeApiKey);

// Internal, service-to-service only (see controllers/apikeys.js
// verifyApiKey's header comment) -- deliberately no keycloak.protect()
// here, and not reachable from outside the Docker network in the intended
// deployment (calls always go container-to-container by hostname, e.g.
// http://userservice:3000/api/v1/apikeys/verify, mirroring
// requireProjectScope()'s existing call to GET /api/v1/projects).
router.route('/verify').post(verifyApiKey);

// WP-032 matrix-test / demo harness.
//
// WP-033 (the real CI-result-ingestion endpoint this middleware is FOR)
// is explicitly BLOCKED BY this WP and lives in backend/defectService,
// which is out of this WP's scope and does not exist yet. There is
// therefore no real `results:write` route to test the mechanism against
// end-to-end through Kong yet. These two routes exist ONLY to prove the
// requireAuth() + requireProjectScope() + authorize() composition works
// correctly over real HTTP (both the positive and negative scope/project
// cases) using infrastructure this WP does own (userService). WP-033
// should mount requireAuth('results:write') the same way on its own real
// route and can then delete/ignore these once that lands -- see
// EXECUTION_LOG.md's WP-032 entry for the full matrix-test results and the
// Kong-layer discussion of why these two paths carry an `anonymous`-
// fallback jwt config in srckube-kong/kong.yml while every other userService
// route keeps strict Kong-level JWT enforcement (WP-023) unchanged.
router.get(
  '/demo/results',
  requireAuth('results:write'),
  requireProjectScope(),
  authorize('write'),
  (req, res) => {
    res.status(200).json({
      success: true,
      via: req.apiKeyAuth ? 'apiKey' : 'keycloak',
      projectId: req.projectScope.projectId
    });
  }
);

router.get(
  '/demo/admin',
  requireAuth('keys:admin'),
  requireProjectScope(),
  authorize('manage_project'),
  (req, res) => {
    res.status(200).json({
      success: true,
      via: req.apiKeyAuth ? 'apiKey' : 'keycloak',
      projectId: req.projectScope.projectId
    });
  }
);

module.exports = router;
