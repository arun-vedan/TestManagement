const axios = require('axios');
const { createLogger } = require('@srckube/service-core');

const logger = createLogger('reportingService:identityClient');

// WP-040 — mints a service-account bearer token for the node-cron background
// sweep (lib/cronJob.js). A cron tick has no incoming request/caller token
// to forward (unlike every GET .../reports/<type> handler, which forwards
// the REQUESTING USER'S OWN Authorization header -- see controllers/
// reports.js), so one has to be minted here instead.
//
// This is the exact same client_credentials pattern as notificationService's
// utils/identityClient.js (WP-031), copied rather than factored into
// service-core because it isn't one yet anywhere else either -- same
// client_id ('node-microservice'), same KeyCloak_Secret every service in
// this stack already carries, same WP-012b Host-header override (a token
// minted via KeyCloak_Admin_URI's http://keycloak:8080 otherwise carries
// `iss: http://keycloak:8080/realms/srckube`, which mismatches what every
// service's keycloak.protect() checks incoming tokens against --
// KeyCloak_URI's host:port -- and gets rejected). See that file's longer
// comment for the full empirical trace (EXECUTION_LOG.md's WP-031 report).
function keycloakTokenHostHeader() {
  const uri = process.env.KeyCloak_URI;
  if (!uri) {
    return null;
  }
  try {
    return new URL(uri).host;
  } catch (err) {
    return null;
  }
}

function keycloakTokenBaseUrl() {
  return process.env.KeyCloak_Admin_URI || process.env.KeyCloak_URI;
}

let cachedToken = null; // { token, expiresAt }

async function getServiceAccountToken() {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now) {
    return cachedToken.token;
  }

  const base = keycloakTokenBaseUrl();
  if (!base) {
    throw new Error('Neither KeyCloak_Admin_URI nor KeyCloak_URI is configured; cannot mint a service-account token');
  }

  const body = new URLSearchParams({
    client_id: process.env.KeyCloak_clientId || 'node-microservice',
    grant_type: 'client_credentials',
    client_secret: process.env.KeyCloak_Secret
  });

  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const hostHeader = keycloakTokenHostHeader();
  if (hostHeader) {
    headers.Host = hostHeader;
  }

  const resp = await axios.post(
    `${base}/realms/${process.env.KeyCloak_Realm || 'srckube'}/protocol/openid-connect/token`,
    body,
    { headers, timeout: 5000 }
  );

  const token = resp.data.access_token;
  const ttlMs = Math.max((resp.data.expires_in || 60) * 1000 - 5000, 5000);
  cachedToken = { token, expiresAt: now + ttlMs };
  logger.info('minted a fresh service-account token for the cron sweep');
  return token;
}

function _resetIdentityClientForTests() {
  cachedToken = null;
}

module.exports = { getServiceAccountToken, _resetIdentityClientForTests };
