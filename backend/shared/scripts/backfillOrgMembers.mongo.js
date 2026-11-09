/* eslint-disable no-undef */
/**
 * backfillOrgMembers.mongo.js — WP-110
 *
 * A mongosh script, run INSIDE the mongodb container. See
 * pruneOrphanedProjects.mongo.js's "WHY NOT A NODE SCRIPT" for the reason that
 * is a safety property here and not a style choice: this host runs a second,
 * unauthenticated mongod on 127.0.0.1:27017 carrying shadow srckube databases,
 * and a host-side `localhost` connection reaches THAT one. The same instance
 * guard is applied below and refuses to run anywhere but the container's
 * mongod.
 *
 * ---------------------------------------------------------------------------
 * WHAT AND WHY
 *
 * WP-110 added Organization.members[] and made GET /api/v1/projects
 * organization-scoped: a caller now sees the projects of organizations they
 * belong to, and nothing else. Every organization that existed before WP-110
 * has no members[] at all, so without this backfill the new scoping would
 * return an EMPTY LIST to everyone — including the people who created those
 * organizations and the service account the test suites authenticate as.
 *
 * WHAT IT DERIVES, AND WHY THAT IS THE RIGHT RULE. Membership is derived from
 * the projects each organization already owns: whoever is a member of a
 * project is made a member of that project's organization.
 *
 *   - This preserves exactly today's visibility. Before WP-110 everyone could
 *     see every project; after it, each person sees the projects of the
 *     organizations they already had a project in. Nobody loses access to
 *     something they were legitimately working on, and nobody gains access to
 *     an organization they had no connection to.
 *   - Project role 'admin' maps to 'org_admin', everything else to
 *     'org_member'. A project admin is the closest thing the pre-WP-110 data
 *     has to someone entitled to administer that organization's membership,
 *     and it guarantees every organization with any admin anywhere ends up
 *     with at least one org_admin rather than being born ownerless.
 *   - Organization.createdBy is also enrolled as org_admin even if they hold
 *     no project role, so an organization whose creator never joined one of
 *     its own projects is still administrable.
 *
 * An organization that owns no projects and whose createdBy cannot be
 * determined is left with an empty members[] and REPORTED, not guessed at. It
 * stays reachable through the ownerless-organization recovery path in
 * userService/controllers/organizations.js rather than being quietly assigned
 * an owner this script invented.
 *
 * ---------------------------------------------------------------------------
 * SAFETY
 *   - DRY RUN by default. Reports every change it would make; writes nothing.
 *   - Writes only when BACKFILL_APPLY=1 AND BACKFILL_CONFIRM=yes-apply.
 *   - ADDITIVE ONLY (GR-7): it never removes a member, never downgrades a
 *     role, and never touches an organization that already has members unless
 *     it has someone genuinely new to add. An existing org_member is left as
 *     org_member even if they are a project admin, because a human may have
 *     deliberately set it.
 *   - Idempotent: membership is recomputed from current data each run, and
 *     every candidate is checked against the existing array, so a second run
 *     reports zero additions.
 *   - Take a backup first: ./scripts/mongo-backup.sh
 *
 * USAGE (from the repo root)
 *   # dry run
 *   docker exec -i mongodb mongosh "$URI" --quiet \
 *     --file /dev/stdin < backend/shared/scripts/backfillOrgMembers.mongo.js
 *
 *   # apply
 *   docker exec -i -e BACKFILL_APPLY=1 -e BACKFILL_CONFIRM=yes-apply mongodb \
 *     mongosh "$URI" --quiet \
 *     --file /dev/stdin < backend/shared/scripts/backfillOrgMembers.mongo.js
 *
 * Credentials are never hardcoded here (GR-9).
 */

const APPLY = process.env.BACKFILL_APPLY === '1';
const CONFIRMED = process.env.BACKFILL_CONFIRM === 'yes-apply';

const MUST_HAVE_DBS = ['srckube-ai', 'srckube-release', 'srckube-reporting'];
const MUST_NOT_HAVE_DBS = ['codeshark', 'fauserdb', 'authdeputy'];

function abort(message) {
  print('');
  print('ABORTED: ' + message);
  quit(1);
}

// ---------------------------------------------------------------- instance guard
const presentDbs = db.adminCommand({ listDatabases: 1 }).databases.map(function (d) {
  return d.name;
});
const missing = MUST_HAVE_DBS.filter(function (n) {
  return presentDbs.indexOf(n) === -1;
});
const foreign = MUST_NOT_HAVE_DBS.filter(function (n) {
  return presentDbs.indexOf(n) !== -1;
});
if (missing.length > 0) {
  abort(
    'this does not look like the container mongod — missing ' +
      missing.join(', ') +
      '. Run this inside the mongodb container (see USAGE in this file).'
  );
}
if (foreign.length > 0) {
  abort('this looks like the NATIVE host mongod (found ' + foreign.join(', ') + '). Refusing.');
}
print('instance guard:  OK (container mongod)');
print('mode:            ' + (APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'));
print('');

// ---------------------------------------------------------------- derive
const userDb = db.getSiblingDB('srckube-user');
const orgs = userDb.organizations.find({}).toArray();
const projects = userDb.projects.find({}, { id: 1, name: 1, organizationId: 1, members: 1 }).toArray();

print('organizations: ' + orgs.length + '   projects: ' + projects.length);
print('');

let totalAdditions = 0;
let orgsChanged = 0;
const ownerless = [];
const planned = [];

orgs.forEach(function (org) {
  const orgIdStr = String(org._id);
  const owned = projects.filter(function (p) {
    return String(p.organizationId) === orgIdStr;
  });

  // userId -> highest-privilege org role derived for them.
  const derived = {};
  owned.forEach(function (p) {
    (p.members || []).forEach(function (m) {
      const role = m.role === 'admin' ? 'org_admin' : 'org_member';
      // org_admin wins over org_member if a user is admin on any one project.
      if (derived[m.userId] !== 'org_admin') {
        derived[m.userId] = role;
      }
    });
  });
  if (org.createdBy) {
    derived[org.createdBy] = 'org_admin';
  }

  const existing = (org.members || []).map(function (m) {
    return m.userId;
  });
  const toAdd = Object.keys(derived)
    .filter(function (userId) {
      return existing.indexOf(userId) === -1;
    })
    .map(function (userId) {
      return { userId: userId, role: derived[userId] };
    });

  if (Object.keys(derived).length === 0 && existing.length === 0) {
    ownerless.push(org);
    return;
  }
  if (toAdd.length === 0) {
    return;
  }

  orgsChanged += 1;
  totalAdditions += toAdd.length;
  planned.push({ org: org, toAdd: toAdd, owned: owned.length, existing: existing.length });
});

planned.forEach(function (entry) {
  print(
    '  ' +
      entry.org.name +
      '  (' +
      entry.owned +
      ' project(s), ' +
      entry.existing +
      ' existing member(s)) -> adding ' +
      entry.toAdd.length
  );
  entry.toAdd.forEach(function (m) {
    print('      + ' + m.userId + '  as ' + m.role);
  });
});

if (ownerless.length > 0) {
  print('');
  print(
    'REPORTED, NOT GUESSED — ' +
      ownerless.length +
      ' organization(s) own no projects and have no createdBy, so no membership can be derived.'
  );
  ownerless.forEach(function (o) {
    print('    ' + o._id + '  ' + o.name);
  });
  print('    They keep an empty members[] and stay reachable via the');
  print('    ownerless-organization recovery path in');
  print('    userService/controllers/organizations.js.');
}

print('');
print('organizations to change: ' + orgsChanged + '   memberships to add: ' + totalAdditions);

// ---------------------------------------------------------------- apply
if (!APPLY) {
  print('');
  print('DRY RUN — nothing was written.');
  if (totalAdditions === 0) {
    print('(Nothing to add. If this follows an apply run, that is the idempotency check passing.)');
  } else {
    print('To apply: take a backup (./scripts/mongo-backup.sh), then re-run with');
    print('  -e BACKFILL_APPLY=1 -e BACKFILL_CONFIRM=yes-apply');
  }
  quit(0);
}
if (!CONFIRMED) {
  abort('BACKFILL_APPLY=1 also requires BACKFILL_CONFIRM=yes-apply. Refusing to write.');
}
if (totalAdditions === 0) {
  print('');
  print('Nothing to add — already backfilled. (Idempotent re-run.)');
  quit(0);
}

print('');
print('Applying (additive only: no member removed, no role downgraded).');
let added = 0;
planned.forEach(function (entry) {
  const now = new Date();
  const docs = entry.toAdd.map(function (m) {
    return { userId: m.userId, role: m.role, addedAt: now };
  });
  const res = userDb.organizations.updateOne(
    { _id: entry.org._id },
    { $push: { members: { $each: docs } } }
  );
  if (res.modifiedCount === 1) {
    added += docs.length;
    print('  ' + entry.org.name + ': +' + docs.length);
  } else {
    print('  ' + entry.org.name + ': NOT MODIFIED (concurrent change?) — re-run the dry run');
  }
});

print('');
print('added ' + added + ' membership(s) across ' + planned.length + ' organization(s).');
userDb.organizations.find({}, { name: 1, members: 1 }).forEach(function (o) {
  print('  ' + o.name + ': ' + (o.members || []).length + ' member(s)');
});
