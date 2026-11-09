const Organization = require('../models/Organization');
const { Project } = require('../models/Project');

// Closes a cross-tenant identity disclosure found while verifying WP-132's
// premises (recorded as a candidate WP in that entry, fixed here).
//
// THE DEFECT. /api/v1/users/kcUser and /kcUsers were mounted behind
// keycloak.protect() and nothing else. Measured against the live stack before
// writing this: a persona with NO organization, NO project and no relationship
// to anybody received HTTP 200 and another account's full Keycloak
// representation -- including their EMAIL ADDRESS -- just by naming their
// username. /kcUsers with an empty filter returned every user in the realm.
//
// For a product whose entire Phase 1 was spent making one tenant unable to see
// another's data, an endpoint that hands out the platform's user list and their
// email addresses to any signed-in stranger undoes a meaningful part of it.
//
// TWO SEPARATE MISTAKES, FIXED SEPARATELY.
//
// 1. The RESPONSE SHAPE was the raw Keycloak representation: email,
//    emailVerified, requiredActions, enabled, totp, disableableCredentialTypes,
//    createdTimestamp, access. The product only ever reads `username` (and now
//    first/last for display). Narrowing the shape removes email and account
//    metadata from the blast radius permanently, independently of who is
//    allowed to call it -- so a future authorization slip leaks far less.
//
// 2. There was no AUTHORIZATION at all. Resolving an identity is a legitimate
//    need -- a "created by" column has to turn a `sub` into a name -- so the
//    fix is not to forbid it but to bound it: you may resolve people you
//    actually share a tenant with.
//
// WHY "SHARES A TENANT" AND NOT SOMETHING STRICTER. Display names appear on
// records authored by colleagues across any project in the organization, and a
// per-project rule would render those as blank. Organization or project
// co-membership is the narrowest rule that does not break a legitimate screen.

// The only identity fields this product displays. Deliberately NOT a blacklist
// of sensitive fields: a whitelist cannot start leaking a new field that a
// future Keycloak version adds to the representation.
function toDisplayIdentity(kcUser) {
  if (!kcUser) return null;
  return {
    id: kcUser.id,
    username: kcUser.username,
    firstName: kcUser.firstName || null,
    lastName: kcUser.lastName || null
  };
}

// True when caller and target are both members of some project, or of some
// organization. A caller can always resolve themselves.
async function sharesTenantWith(callerSub, targetSub) {
  if (!callerSub || !targetSub) return false;
  if (callerSub === targetSub) return true;

  const sharedProject = await Project.exists({
    $and: [{ 'members.userId': callerSub }, { 'members.userId': targetSub }]
  });
  if (sharedProject) return true;

  const sharedOrg = await Organization.exists({
    $and: [{ 'members.userId': callerSub }, { 'members.userId': targetSub }]
  });
  return Boolean(sharedOrg);
}

module.exports = { toDisplayIdentity, sharesTenantWith };
