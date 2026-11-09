const path = require('path');
const axios = require('axios');

// WP-022 — real multi-persona test identities.
//
// The RBAC matrix (backend/shared/service-core/permissions.js) is proven
// exhaustively at the unit level (permissions.test.js, authorize.test.js),
// but the release-blocking suite also needs to prove it holds over real
// HTTP, with a real distinct role-holder making the request -- not just
// the one always-admin service-account identity getServiceToken.js
// provides (WP-021 documented this exact constraint: "Only one real
// Keycloak identity is available to this harness"). It also needs a
// genuinely nonexistent identity to prove the members[] fix rejects one.
//
// This module closes that gap by using the Keycloak Admin API (same
// client_credentials service account as getServiceToken.js, which turns
// out to hold realm-management/manage-users -- confirmed empirically
// against the live dev realm before relying on it here) to create
// throwaway, disposable Keycloak users on demand, get a real bearer token
// for each via the Resource Owner Password Credentials grant (confirmed
// the 'node-microservice' client has Direct Access Grants enabled), and
// delete them again in an afterAll. Every created user's username is
// prefixed 'wp022-persona-' plus a run id so a crashed suite's leftovers
// are unambiguous to find and hand-clean.
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
      'TEST_KEYCLOAK_CLIENT_SECRET is not set -- see getServiceToken.js for how to configure it.'
    );
  }
  return secret;
}

async function getAdminAccessToken() {
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

// Creates a real, disposable Keycloak user and returns { userId, sub,
// username, getToken(), cleanup() }. `sub` === `userId` in this realm's
// tokens (Keycloak's user id is the JWT `sub`), matching how every
// controller in this stack reads token identity.
// WP-132 added the optional second argument. An invitation is addressed to an
// EMAIL and acceptance is bound to the email claim in the accepting user's own
// token, so a suite testing that flow has to create a persona whose address it
// chose, not one derived from a generated username. Omitted, behaviour is
// exactly as before.
async function createTestPersona(labelPrefix, { email } = {}) {
  const adminToken = await getAdminAccessToken();
  const adminHeaders = { Authorization: `Bearer ${adminToken}` };

  const username = `wp022-persona-${labelPrefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const password = `TestPass!${Math.random().toString(36).slice(2)}${Date.now()}`;

  await axios.post(
    `${DEFAULT_KEYCLOAK_URL}/admin/realms/${DEFAULT_REALM}/users`,
    { username, enabled: true, email: email || `${username}@example.invalid`, emailVerified: true },
    { headers: { ...adminHeaders, 'Content-Type': 'application/json' } }
  );

  const lookup = await axios.get(
    `${DEFAULT_KEYCLOAK_URL}/admin/realms/${DEFAULT_REALM}/users`,
    { headers: adminHeaders, params: { username, exact: true } }
  );
  const userId = lookup.data && lookup.data[0] && lookup.data[0].id;
  if (!userId) {
    throw new Error(`Failed to look up newly created Keycloak test persona '${username}'`);
  }

  // Clear the realm's DEFAULT required actions from this persona.
  //
  // WP-130 made TERMS_AND_CONDITIONS a realm default action, which is correct
  // product behaviour: a real human must accept terms in the browser before
  // their account is usable. But Keycloak applies default actions to every
  // newly created user, including these admin-created personas, and a user
  // with a pending required action cannot use the direct access grant — the
  // token endpoint returns 400 invalid_grant "Account is not fully set up".
  //
  // That took out 10 tests across apiKeys.test.js and rbacMembers.test.js,
  // and the failure surfaced far from its cause: the assertions looked like
  // RBAC regressions ("viewer cannot add a member" etc.) when in fact no
  // persona could log in at all.
  //
  // This MUST be a PUT after creation, not `requiredActions: []` in the POST
  // above: Keycloak applies the realm defaults regardless of what the create
  // call specifies (verified — the created user came back with
  // requiredActions ['TERMS_AND_CONDITIONS'] either way).
  //
  // Clearing it here, rather than turning the realm flag off, keeps the
  // product behaviour WP-130 is accepted on while letting a non-interactive
  // test persona authenticate. A persona is a machine identity that has no
  // browser to accept terms in.
  await axios.put(
    `${DEFAULT_KEYCLOAK_URL}/admin/realms/${DEFAULT_REALM}/users/${userId}`,
    { requiredActions: [] },
    { headers: { ...adminHeaders, 'Content-Type': 'application/json' } }
  );

  await axios.put(
    `${DEFAULT_KEYCLOAK_URL}/admin/realms/${DEFAULT_REALM}/users/${userId}/reset-password`,
    { type: 'password', value: password, temporary: false },
    { headers: { ...adminHeaders, 'Content-Type': 'application/json' } }
  );

  async function getToken() {
    const resp = await axios.post(
      `${DEFAULT_KEYCLOAK_URL}/realms/${DEFAULT_REALM}/protocol/openid-connect/token`,
      new URLSearchParams({
        client_id: DEFAULT_CLIENT_ID,
        client_secret: getClientSecret(),
        grant_type: 'password',
        username,
        password
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    return resp.data.access_token;
  }

  async function cleanup() {
    const token = await getAdminAccessToken();
    // Best-effort: a suite that already crashed mid-test shouldn't also
    // fail its own teardown loudly.
    await axios
      .delete(`${DEFAULT_KEYCLOAK_URL}/admin/realms/${DEFAULT_REALM}/users/${userId}`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      .catch(() => {});
  }

  return { userId, sub: userId, username, email: email || `${username}@example.invalid`, getToken, cleanup };
}

// A syntactically well-formed but never-created userId, for proving the
// members[] real-identity check rejects it. UUID-shaped so it can't be
// rejected for looking malformed rather than for not existing.
function nonexistentUserId() {
  return `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, '0').slice(-12)}`;
}

module.exports = { createTestPersona, nonexistentUserId };
