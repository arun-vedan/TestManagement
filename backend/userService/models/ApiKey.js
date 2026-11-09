const mongoose = require('mongoose');

// WP-032 — Machine-to-machine auth (API keys / service accounts).
//
// Formalizes what backend/shared/test-utils/getServiceToken.js proves ad
// hoc for tests (a way to call the API without a human login) into a real,
// per-project, revocable, scoped credential, managed through these
// endpoints rather than a shared Keycloak client-credentials secret.
//
// SECURITY REQUIREMENT #1: only `hashedSecret` is ever persisted (bcrypt,
// see controllers/apikeys.js createApiKey). The plaintext secret is
// returned exactly once, in the create response, and is never written to
// this model, never logged (no controller here calls console.log/logger
// with req.body or the generated secret).
const ALLOWED_SCOPES = ['results:write', 'results:read', 'keys:admin'];

const ApiKeySchema = new mongoose.Schema(
  {
    keyId: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    hashedSecret: {
      type: String,
      required: true
    },
    projectId: {
      type: Number,
      required: true,
      index: true
    },
    scopes: {
      type: [String],
      required: true,
      validate: {
        validator: (arr) => Array.isArray(arr) && arr.length > 0 && arr.every((s) => ALLOWED_SCOPES.includes(s)),
        message: `scopes must be a non-empty array drawn from: ${ALLOWED_SCOPES.join(', ')}`
      }
    },
    name: {
      type: String,
      default: ''
    },
    // WP-020b pattern applied to machine identities: always derived from
    // the caller's Keycloak token `sub` in the controller, never trusted
    // from the request body. See controllers/apikeys.js createApiKey.
    createdBy: {
      type: String,
      required: true
    },
    lastUsed: {
      type: Date,
      default: null
    },
    revoked: {
      type: Boolean,
      default: false
    },
    revokedAt: {
      type: Date,
      default: null
    }
  },
  { timestamps: true }
);

module.exports = { ApiKey: mongoose.model('ApiKey', ApiKeySchema), ALLOWED_SCOPES };
