const path = require('path');
const axios = require('axios');

// Test-only helper (Sprint 2.2) — gets a real Keycloak bearer token via the
// client_credentials grant, using the same client this app already uses
// server-to-server (userService's Keycloak Admin API proxy uses the exact
// same grant). This is deliberately NOT part of @srckube/service-core: it's
// dev/test tooling that runs on the host via `npx jest`, not runtime code
// that ships in a Docker image, so it doesn't need the Docker build-context
// wiring the runtime shared library requires — a plain relative require is
// enough. Lets test suites exercise real authenticated behavior (not just
// "does this route reject an unauthenticated request") without needing a
// real human login.
//
// Load repo-root .env.test for local/dev runs. Guarded so a value already
// present in the environment (CI secrets, shell export, etc.) always wins
// over the file. Safe to call from any service directory since the path is
// resolved relative to this file, not to process.cwd().
require('dotenv').config({
  path: path.resolve(__dirname, '../../../.env.test')
});

const DEFAULT_KEYCLOAK_URL = process.env.TEST_KEYCLOAK_URL || 'http://localhost:8080';
const DEFAULT_REALM = process.env.TEST_KEYCLOAK_REALM || 'srckube';
const DEFAULT_CLIENT_ID = process.env.TEST_KEYCLOAK_CLIENT_ID || 'node-microservice';

function getClientSecret() {
  const secret = process.env.TEST_KEYCLOAK_CLIENT_SECRET;
  if (!secret) {
    throw new Error(
      'TEST_KEYCLOAK_CLIENT_SECRET is not set. Copy .env.test.example (repo root) to ' +
      '.env.test and fill in the real Keycloak client secret for the ' +
      '"node-microservice" service account (realm: srckube), or export ' +
      'TEST_KEYCLOAK_CLIENT_SECRET directly in your shell/CI. Refusing to fall back to ' +
      'a hardcoded default — see backend/shared/test-utils/getServiceToken.js.'
    );
  }
  return secret;
}

async function getServiceToken() {
  const response = await axios.post(
    `${DEFAULT_KEYCLOAK_URL}/realms/${DEFAULT_REALM}/protocol/openid-connect/token`,
    new URLSearchParams({
      client_id: DEFAULT_CLIENT_ID,
      grant_type: 'client_credentials',
      client_secret: getClientSecret()
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return response.data.access_token;
}

module.exports = { getServiceToken };
