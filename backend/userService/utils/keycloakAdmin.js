const qs = require('qs');
const axios = require('axios');

// WP-022 — closes the second half of the members[] privilege hole flagged
// by the orchestrator: "whether the named userId is a real identity at
// all." Before this, addMember/updateMemberRole (controllers/projects.js)
// accepted any string as a member's userId with zero verification, so a
// caller could grant a role to a userId that doesn't correspond to any
// Keycloak account.
//
// Same admin-API pattern the identity controllers use. This module is now
// the single place that talks to Keycloak's admin API from userService, so
// the KeyCloak_Admin_URI vs KeyCloak_URI explanation (originally in
// controllers/users.js, whose duplicate helper was removed when its last
// caller went away) lives on keycloakAdminBaseUrl() below. Deliberately NOT sharing controllers/users.js's
// Redis existence-cache: this check gates a security decision (who gets
// added to a project), not a display lookup, so staleness there is a
// different, worse kind of bug than staleness on a "show me this user's
// name" cache. A few hundred ms of extra latency on the comparatively rare
// add/update-member call is an acceptable trade.
// WP-012b: `KeyCloak_URI` is consumed by @srckube/service-core's
// initKeycloak() (backend/shared/service-core/keycloak.js) purely as the
// keycloak-connect `serverUrl`, which is string-matched against the `iss`
// claim of incoming tokens. Tokens in this stack are minted via the
// host-facing `http://localhost:8080`, so KeyCloak_URI must stay
// `http://localhost:8080` for issuer validation to pass.
//
// The calls below are different: they are outbound HTTP requests made FROM
// INSIDE the userservice container to Keycloak's token/admin endpoints,
// where `localhost` resolves to the container itself, not the Keycloak
// container — that must go over the Docker network as `http://keycloak:8080`.
// One env var cannot correctly serve both uses (this was the WP-012 bug:
// collapsing them onto KeyCloak_URI made every real token get rejected with
// a 403 issuer mismatch). `KeyCloak_Admin_URI` carries the outbound value;
// it falls back to KeyCloak_URI so a config that only sets the older var
// still runs (degrading the same way pre-WP-012b did) instead of throwing.
function keycloakAdminBaseUrl() {
  return process.env.KeyCloak_Admin_URI || process.env.KeyCloak_URI;
}

async function getKeycloakAdminToken() {
  const data = qs.stringify({
    client_id: 'node-microservice',
    grant_type: 'client_credentials',
    client_secret: process.env.KeyCloak_Secret
  });
  const response = await axios.post(
    `${keycloakAdminBaseUrl()}/realms/${process.env.KeyCloak_Realm || 'srckube'}/protocol/openid-connect/token`,
    data,
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return response.data.access_token;
}

// Returns true/false. Never throws for a "not found" -- only for a genuine
// admin-API/network failure (propagated to the caller, which should treat
// it as a 503-class failure rather than silently treating "couldn't check"
// as "doesn't exist" or "exists").
async function keycloakUserExists(userId) {
  const accessToken = await getKeycloakAdminToken();
  try {
    await axios.get(
      `${keycloakAdminBaseUrl()}/admin/realms/${process.env.KeyCloak_Realm || 'srckube'}/users/${userId}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    return true;
  } catch (err) {
    if (err.response && err.response.status === 404) {
      return false;
    }
    throw err;
  }
}

// WP-132 — resolve an email address to its Keycloak account, if one exists.
//
// An invite is addressed to an EMAIL, but project membership is keyed by
// Keycloak `sub`. Two different questions need this lookup:
//   - at invite time: "is this person already a member?", so an admin gets
//     "already a member" instead of a pointless invite the recipient cannot
//     use for anything;
//   - never at accept time. Acceptance binds to the email claim in the
//     caller's own verified token, not to a lookup, so a rename or a second
//     account with the same address cannot be used to claim someone's invite.
//
// `exact: true` matters. Keycloak's ?email= search is a SUBSTRING match by
// default, so 'a@b.com' would also match 'aa@b.com' and 'a@b.com.evil.net'.
// Without exact, this helper would report the wrong account as an existing
// member and suppress a legitimate invite.
//
// Returns the user representation, or null when no account has that address.
// Like keycloakUserExists it propagates genuine admin-API failures rather than
// reporting "no such user", because "couldn't check" must not look like
// "nobody has this address".
async function keycloakUserByEmail(email) {
  const accessToken = await getKeycloakAdminToken();
  const realm = process.env.KeyCloak_Realm || 'srckube';
  const response = await axios.get(
    `${keycloakAdminBaseUrl()}/admin/realms/${realm}/users`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { email: String(email).toLowerCase(), exact: true }
    }
  );
  const users = Array.isArray(response.data) ? response.data : [];
  return users.length > 0 ? users[0] : null;
}

// WP-132 — fetch one Keycloak user's representation by id (sub).
//
// Used to render display names in the organization member picker. Returns null
// for a user that no longer exists, so a deleted account degrades to its raw id
// in the UI instead of failing the whole list. Unlike keycloakUserExists, which
// gates a security decision and therefore propagates lookup failures, this is a
// DISPLAY lookup: the caller treats an unresolved name as cosmetic.
async function keycloakUserById(userId) {
  const accessToken = await getKeycloakAdminToken();
  const realm = process.env.KeyCloak_Realm || 'srckube';
  try {
    const response = await axios.get(
      `${keycloakAdminBaseUrl()}/admin/realms/${realm}/users/${encodeURIComponent(userId)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    return response.data || null;
  } catch (err) {
    if (err.response && err.response.status === 404) return null;
    throw err;
  }
}

// Exact-username lookup. Keeps admin-API access in this one module rather than
// exporting the token-minting function for controllers to build their own
// calls -- the pattern this file's header establishes.
//
// `exact: true` is load-bearing: Keycloak's ?username= is a SUBSTRING match by
// default, so without it a one-letter query enumerates a large slice of the
// realm. That is the same disclosure the authorization fix closes, in a
// different shape, so it is pinned here at the call site.
async function keycloakUsersByUsername(username) {
  const accessToken = await getKeycloakAdminToken();
  const realm = process.env.KeyCloak_Realm || 'srckube';
  const response = await axios.get(
    `${keycloakAdminBaseUrl()}/admin/realms/${realm}/users`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: { username: String(username), exact: true }
    }
  );
  return Array.isArray(response.data) ? response.data : [];
}

module.exports = {
  keycloakUserExists,
  keycloakUserByEmail,
  keycloakUserById,
  keycloakUsersByUsername,
  keycloakAdminBaseUrl
};
