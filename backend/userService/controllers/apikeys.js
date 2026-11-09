const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { asyncHandler, ErrorResponse } = require('@srckube/service-core');
const { ApiKey, ALLOWED_SCOPES } = require('../models/ApiKey');

const SALT_ROUNDS = 10;
const KEY_ID_BYTES = 9; // -> 12 base64url chars
const SECRET_BYTES = 32; // -> 64 hex chars, 256 bits of entropy

function generateKeyId() {
  return `ak_${crypto.randomBytes(KEY_ID_BYTES).toString('base64url')}`;
}

function generateSecret() {
  return crypto.randomBytes(SECRET_BYTES).toString('hex');
}

// @desc      Create an API key scoped to the caller's current project
// @route     POST /api/v1/apikeys
// @access    Private (Keycloak human bearer only -- this route is mounted
//            with keycloak.protect(), NOT requireAuth(), so an API key can
//            never mint another API key), requireProjectScope() +
//            authorize('manage_project') (admin-only, same bar as
//            renaming/archiving a project -- minting a standing machine
//            credential is at least as sensitive).
//
// SECURITY REQUIREMENT #1: the plaintext `secret` is generated here, hashed
// with bcrypt, and the hash alone is persisted. The plaintext is returned
// in this response ONLY -- it is never logged (no console.log/logger call
// anywhere in this file references `secret` or `req.body`) and there is no
// endpoint that can ever retrieve it again.
//
// SECURITY REQUIREMENT #2: createdBy is read from
// req.kauth.grant.access_token.content.sub (set by keycloak.protect()),
// never from req.body -- mirrors the WP-020b fix in controllers/projects.js
// createProject exactly.
//
// projectId is likewise NEVER read from the body: it is
// req.projectScope.projectId, set by requireProjectScope() from the
// X-Project-Id header and already verified the caller is a member of. A
// client cannot mint a key bound to a project it didn't authenticate
// against by putting a different projectId in the JSON body.
exports.createApiKey = asyncHandler(async (req, res, next) => {
  const tokenSub = req.kauth?.grant?.access_token?.content?.sub;
  if (!tokenSub) {
    return next(new ErrorResponse('Authenticated user identity not found on request', 401));
  }

  const { scopes, name } = req.body;
  if (!Array.isArray(scopes) || scopes.length === 0) {
    return next(new ErrorResponse('scopes must be a non-empty array', 400));
  }
  const invalidScopes = scopes.filter((s) => !ALLOWED_SCOPES.includes(s));
  if (invalidScopes.length > 0) {
    return next(
      new ErrorResponse(
        `Unknown scope(s): ${invalidScopes.join(', ')}. Allowed: ${ALLOWED_SCOPES.join(', ')}`,
        400
      )
    );
  }

  const keyId = generateKeyId();
  const secret = generateSecret();
  const hashedSecret = await bcrypt.hash(secret, SALT_ROUNDS);

  const apiKey = await ApiKey.create({
    keyId,
    hashedSecret,
    projectId: req.projectScope.projectId,
    scopes,
    name: typeof name === 'string' ? name : '',
    createdBy: tokenSub
  });

  res.status(201).json({
    success: true,
    data: {
      keyId: apiKey.keyId,
      projectId: apiKey.projectId,
      scopes: apiKey.scopes,
      name: apiKey.name,
      createdBy: apiKey.createdBy,
      createdAt: apiKey.createdAt,
      // Shown exactly once. The caller MUST copy this now -- it is not
      // retrievable through any endpoint after this response.
      secret
    },
    warning: 'This secret will not be shown again. Store it now; it cannot be retrieved later.'
  });
});

// @desc      List API keys for the caller's current project (never
//            includes hashedSecret or the plaintext secret)
// @route     GET /api/v1/apikeys
// @access    Private (Keycloak), requireProjectScope() + authorize('manage_project')
exports.getApiKeys = asyncHandler(async (req, res) => {
  const keys = await ApiKey.find({ projectId: req.projectScope.projectId }).select('-hashedSecret').sort({ createdAt: -1 });
  res.status(200).json({ success: true, count: keys.length, data: keys });
});

// @desc      Revoke an API key
// @route     DELETE /api/v1/apikeys/:keyId
// @access    Private (Keycloak), requireProjectScope() + authorize('manage_project')
//
// SECURITY REQUIREMENT #4/#5: scoped to req.projectScope.projectId, not
// just keyId, so a caller cannot revoke (or, symmetrically, be told
// anything about) a key belonging to a different project by guessing its
// keyId. Revocation is immediate: verifyApiKey() below does a live,
// uncached DB read on every request, so the very next call using this key
// fails -- see EXECUTION_LOG.md's WP-032 entry for the measured proof.
exports.revokeApiKey = asyncHandler(async (req, res, next) => {
  const apiKey = await ApiKey.findOne({ keyId: req.params.keyId, projectId: req.projectScope.projectId });
  if (!apiKey) {
    return next(new ErrorResponse(`API key not found with id of ${req.params.keyId}`, 404));
  }
  if (!apiKey.revoked) {
    apiKey.revoked = true;
    apiKey.revokedAt = new Date();
    await apiKey.save();
  }
  res.status(200).json({ success: true, data: { keyId: apiKey.keyId, revoked: true, revokedAt: apiKey.revokedAt } });
});

// @desc      Verify an API key (internal, service-to-service only). Called
//            directly container-to-container (e.g.
//            http://userservice:3000/api/v1/apikeys/verify) by
//            @srckube/service-core's requireAuth() middleware
//            (middleware/apiKeyAuth.js) in every OTHER service -- never
//            intended to be called by a browser/end user, and never
//            requires a Keycloak token itself (that would be circular: the
//            whole point is to authenticate a request that doesn't have
//            one). Not mounted through Kong for external traffic -- see
//            EXECUTION_LOG.md's WP-032 Kong-layer section.
// @route     POST /api/v1/apikeys/verify
// @access    Public route, but the response only ever reveals scope/project
//            metadata when the caller proves knowledge of the exact
//            (keyId, secret) pair -- an unknown/wrong pair always gets the
//            same generic `{ valid: false }`, no information about which
//            half was wrong or whether the keyId exists at all.
exports.verifyApiKey = asyncHandler(async (req, res) => {
  const { keyId, secret } = req.body;
  if (!keyId || !secret || typeof keyId !== 'string' || typeof secret !== 'string') {
    return res.status(200).json({ valid: false });
  }

  const apiKey = await ApiKey.findOne({ keyId });
  if (!apiKey || apiKey.revoked) {
    return res.status(200).json({ valid: false });
  }

  // SECURITY REQUIREMENT #6: bcrypt.compare performs a constant-time digest
  // comparison internally (it re-hashes `secret` with the salt embedded in
  // `hashedSecret` and compares full hash output), so this is timing-safe
  // by construction -- not a plain `===` on the raw secret string.
  const matches = await bcrypt.compare(secret, apiKey.hashedSecret);
  if (!matches) {
    return res.status(200).json({ valid: false });
  }

  apiKey.lastUsed = new Date();
  await apiKey.save();

  return res.status(200).json({
    valid: true,
    keyId: apiKey.keyId,
    projectId: apiKey.projectId,
    scopes: apiKey.scopes
  });
});
