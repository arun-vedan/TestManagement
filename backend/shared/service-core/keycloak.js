const session = require('express-session');
const { resolveSessionSecret } = require('./sessionSecret');
const KeyCloak = require('keycloak-connect');

// Sprint 1.1 fix (TD-04/TD-19): every prior version of this file was copy-pasted
// per service, and 10 of 14 copies drifted to hardcode serverUrl/secret/realmPublicKey
// directly instead of reading them from env — which is exactly how TD-19 (stale
// public key) and TD-20 (wrong serverUrl) happened. This single copy is always
// env-driven, and fails fast instead of silently issuing 403s if config is missing.

let keycloakInstance;

const REQUIRED_ENV_VARS = [
  'KeyCloak_clientId',
  'KeyCloak_URI',
  'KeyCloak_Realm',
  'KeyCloak_Secret',
  'KeyCloak_publicKey'
];

function initKeycloak() {
  if (keycloakInstance) {
    return keycloakInstance;
  }

  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required Keycloak env var(s): ${missing.join(', ')}. ` +
      'Refusing to start with an incomplete/silently-wrong Keycloak config (see TD-19/TD-20).'
    );
  }

  const keycloakConfig = {
    clientId: process.env.KeyCloak_clientId,
    bearerOnly: true,
    serverUrl: process.env.KeyCloak_URI,
    realm: process.env.KeyCloak_Realm,
    secret: process.env.KeyCloak_Secret,
    realmPublicKey: process.env.KeyCloak_publicKey
  };

  const memoryStore = new session.MemoryStore();
  keycloakInstance = new KeyCloak(
    {
      store: memoryStore,
      secret: resolveSessionSecret(),
      resave: false,
      saveUninitialized: true
    },
    keycloakConfig
  );

  return keycloakInstance;
}

module.exports = { initKeycloak };
