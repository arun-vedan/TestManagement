/* eslint-disable no-undef */
/**
 * pruneOrphanedProjects.mongo.js — WP-110 precursor (data cleanup)
 *
 * A mongosh script, run INSIDE the mongodb container. See "WHY NOT A NODE
 * SCRIPT" below — that detail is a safety property, not a style choice.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELETES, AND WHY IT EXISTS
 *
 * `srckube-user.projects` holds 703 documents, but only 2 of them belong to an
 * organization that actually exists. The other 701 carry an `organizationId`
 * pointing at an Organization document that is not in the collection —
 * accumulated test-fixture debris named things like "WP-021 isolation project
 * B", "WP-043 defect bulk rbac proj", "release-rbac matrix project". 698 of the
 * 701 match a WP/isolation/rbac/test naming pattern; the other 3 are
 * verification artifacts ("Review-probe project B", "Task4 live-verify
 * project").
 *
 * This blocks WP-110, whose whole job is scoping GET /api/v1/projects to the
 * caller's organization. Run that against this data and those 701 projects
 * become invisible to everyone — their organization does not exist, so nobody
 * can be a member of it — and every tenant-isolation suite WP-111..118 needs
 * would be asserting against garbage. The debris also grows on its own (630
 * projects a few days ago, 703 now) because the suites do not clean up.
 *
 * ORPHAN DEFINITION — deliberately structural, never name-based: a project
 * whose `organizationId` is absent, null, or not present in
 * `srckube-user.organizations`. Naming patterns are reported for context only.
 * A real project with an unlucky name must not be at risk, and a fixture that
 * happens to sit in a real organization must not be deleted.
 *
 * Dependent documents keyed on `projectId` are deleted alongside. Deleting the
 * projects alone would leave ~2 983 documents referencing projects that no
 * longer exist — a worse inconsistency than the one being fixed. The collection
 * list was built by scanning every srckube-* database for a `projectId` field,
 * not from memory.
 *
 * AUDIT EVENTS: `srckube-comments.auditevents` is the largest share (2 554
 * rows). Audit trails are conventionally append-only, so this is stated plainly
 * rather than buried — they ARE deleted by default, because an audit record of
 * a fixture project's creation is test noise, not history worth keeping. Set
 * PRUNE_KEEP_AUDIT=1 to retain them.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT A NODE SCRIPT (the important part)
 *
 * This host runs TWO MongoDB instances:
 *
 *   1. The container (`docker compose -f backend/docker-compose.yml`), which is
 *      what every service actually uses. Authenticated. Holds srckube-ai,
 *      srckube-release, srckube-reporting, srckube-automation, and the 703
 *      projects this script is about.
 *   2. A NATIVE host mongod bound to 127.0.0.1:27017, which accepts
 *      UNAUTHENTICATED connections and carries its own shadow copies of
 *      srckube-user / srckube-testrepo / srckube-requirements / srckube-defects
 *      and others, alongside unrelated projects (codeshark, fauserdb,
 *      authdeputy, fields-service, folders-service).
 *
 * Docker publishes the container on *:27017 while the native mongod holds
 * 127.0.0.1:27017 specifically, so a host-side `localhost:27017` connection
 * reaches the NATIVE instance, not the container. A host-side script that
 * supplies credentials fails to authenticate (how this was discovered); one
 * that omits them connects successfully to the WRONG DATABASE and would delete
 * from it. Running inside the container removes that ambiguity entirely.
 *
 * The INSTANCE GUARD below is the belt to that braces: it refuses to run unless
 * the connected instance looks like the container's (databases only it has) and
 * does not look like the native one (databases only it has). So even if someone
 * later points this at a host port, it stops rather than deleting.
 *
 * ---------------------------------------------------------------------------
 * SAFETY
 *   - DRY RUN by default. Reports every count; writes nothing.
 *   - Deletes only when PRUNE_APPLY=1 AND PRUNE_CONFIRM=yes-apply.
 *   - Idempotent: the orphan set is recomputed each run, so a second run finds
 *     nothing and reports zero.
 *   - Refuses if it would delete EVERY project, or if `organizations` is empty
 *     (the failure mode that would otherwise wipe real data).
 *   - Take a verified backup first: ./scripts/mongo-backup.sh
 *
 * ---------------------------------------------------------------------------
 * USAGE (from the repo root)
 *
 *   # dry run
 *   docker exec -i mongodb mongosh "$URI" --quiet \
 *     --file /dev/stdin < backend/shared/scripts/pruneOrphanedProjects.mongo.js
 *
 *   # apply
 *   docker exec -i -e PRUNE_APPLY=1 -e PRUNE_CONFIRM=yes-apply mongodb \
 *     mongosh "$URI" --quiet \
 *     --file /dev/stdin < backend/shared/scripts/pruneOrphanedProjects.mongo.js
 *
 * where $URI is the container's own authenticated URI. Credentials are never
 * hardcoded here (GR-9) — unlike this directory's backfillProjectId.js:93,
 * which is one of the 10 tracked files WP-100/WP-101 must clean up.
 */

const APPLY = process.env.PRUNE_APPLY === '1';
const KEEP_AUDIT = process.env.PRUNE_KEEP_AUDIT === '1';
const CONFIRMED = process.env.PRUNE_CONFIRM === 'yes-apply';

// Databases that exist ONLY on the container instance.
const MUST_HAVE_DBS = ['srckube-ai', 'srckube-release', 'srckube-reporting'];
// Databases that exist ONLY on the native host mongod.
const MUST_NOT_HAVE_DBS = ['codeshark', 'fauserdb', 'authdeputy'];

// Built by scanning every srckube-* database for a projectId field.
const DEPENDENTS = [
  ['srckube-ai', 'aiprojectsettings', false],
  ['srckube-ai', 'aiinteractions', false],
  ['srckube-comments', 'auditevents', true],
  ['srckube-defects', 'defects', false],
  ['srckube-fields', 'savedviews', false],
  ['srckube-fields', 'fields', false],
  ['srckube-folder', 'folders', false],
  ['srckube-issuestatus', 'staus', false],
  ['srckube-notifications', 'notifications', false],
  ['srckube-release', 'releases', false],
  ['srckube-release', 'environments', false],
  ['srckube-reporting', 'reportcaches', false],
  ['srckube-requirements', 'requirements', false],
  ['srckube-testexecution', 'testexecutions', false],
  ['srckube-testplan', 'testplans', false],
  ['srckube-testrepo', 'testcaserepos', false],
  ['srckube-testrepo', 'casetemplates', false],
  ['srckube-testrepo', 'sharedsteps', false],
  ['srckube-testrepo', 'datasets', false],
  ['srckube-user', 'apikeys', false]
];

function abort(message) {
  print('');
  print('ABORTED: ' + message);
  quit(1);
}

function pad(s, n) {
  s = String(s);
  while (s.length < n) s += ' ';
  return s;
}
function padStart(s, n) {
  s = String(s);
  while (s.length < n) s = ' ' + s;
  return s;
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
      '. Refusing to touch an instance that is not the one the services use. ' +
      'Run this inside the mongodb container (see USAGE in this file).'
  );
}
if (foreign.length > 0) {
  abort(
    'this looks like the NATIVE host mongod (found ' +
      foreign.join(', ') +
      '), which carries shadow copies of the srckube databases. Refusing.'
  );
}
print('instance guard:       OK (container mongod)');

// ---------------------------------------------------------------- classify
const userDb = db.getSiblingDB('srckube-user');
const realOrgIds = userDb.organizations.find({}, { _id: 1 }).toArray().map(function (o) {
  return o._id;
});

if (realOrgIds.length === 0) {
  abort('srckube-user.organizations is empty — every project would look orphaned. Refusing.');
}

const orphanFilter = {
  $or: [
    { organizationId: { $exists: false } },
    { organizationId: null },
    { organizationId: { $nin: realOrgIds } }
  ]
};

const totalProjects = userDb.projects.countDocuments();
const orphans = userDb.projects.find(orphanFilter, { id: 1, name: 1 }).toArray();
const orphanOids = orphans.map(function (p) {
  return p._id;
});
const orphanIds = orphans
  .map(function (p) {
    return p.id;
  })
  .filter(function (id) {
    return id !== undefined && id !== null;
  });
const survivors = userDb.projects.find({ _id: { $nin: orphanOids } }, { id: 1, name: 1 }).toArray();

print('mode:                 ' + (APPLY ? 'APPLY (deleting)' : 'DRY RUN (no writes)'));
print('audit events:         ' + (KEEP_AUDIT ? 'KEPT (PRUNE_KEEP_AUDIT=1)' : 'deleted with their projects'));
print('');
print('organizations present:  ' + realOrgIds.length);
print('projects total:         ' + totalProjects);
print('  orphaned (to delete): ' + orphans.length);
print('  surviving:            ' + survivors.length);
survivors.forEach(function (s) {
  print('     keep id=' + s.id + '  ' + s.name);
});

if (orphans.length === totalProjects) {
  abort('every project classified as orphaned — almost certainly wrong. Refusing.');
}
if (orphans.length === 0) {
  print('');
  print('Nothing to do — no orphaned projects. (Idempotent re-run.)');
  quit(0);
}

const fixturePattern = /WP-|isolation|test|rbac|matrix|scope|probe|live-verify/i;
const fixtureLike = orphans.filter(function (p) {
  return fixturePattern.test(p.name || '');
}).length;
print('');
print(
  '  of the orphans, ' +
    fixtureLike +
    '/' +
    orphans.length +
    ' match a fixture naming pattern (context only; deletion is decided structurally)'
);

// ---------------------------------------------------------------- dependents
print('');
print('dependent documents owned by orphaned projects:');
let dependentTotal = 0;
const planned = [];
DEPENDENTS.forEach(function (entry) {
  const dbName = entry[0];
  const collName = entry[1];
  const isAudit = entry[2];
  const target = db.getSiblingDB(dbName);
  if (target.getCollectionNames().indexOf(collName) === -1) {
    return;
  }
  const n = target[collName].countDocuments({ projectId: { $in: orphanIds } });
  if (n === 0) {
    return;
  }
  const skipped = isAudit && KEEP_AUDIT;
  print('  ' + pad(dbName + '.' + collName, 38) + padStart(n, 6) + (skipped ? '   SKIPPED' : ''));
  if (!skipped) {
    dependentTotal += n;
    planned.push([dbName, collName, n]);
  }
});
print('');
print('total dependent documents to delete: ' + dependentTotal);

// ---------------------------------------------------------------- apply
if (!APPLY) {
  print('');
  print('DRY RUN — nothing was written.');
  print('To apply: take a backup (./scripts/mongo-backup.sh), then re-run with');
  print('  -e PRUNE_APPLY=1 -e PRUNE_CONFIRM=yes-apply');
  quit(0);
}
if (!CONFIRMED) {
  abort('PRUNE_APPLY=1 also requires PRUNE_CONFIRM=yes-apply. Refusing to delete.');
}

print('');
print('Applying. (A verified backup is assumed — ./scripts/mongo-backup.sh.)');
let deletedDependents = 0;
planned.forEach(function (entry) {
  const res = db.getSiblingDB(entry[0])[entry[1]].deleteMany({ projectId: { $in: orphanIds } });
  deletedDependents += res.deletedCount;
  print('  deleted ' + padStart(res.deletedCount, 6) + ' from ' + entry[0] + '.' + entry[1]);
});

const projectRes = userDb.projects.deleteMany({ _id: { $in: orphanOids } });
print('');
print('deleted ' + projectRes.deletedCount + ' orphaned projects and ' + deletedDependents + ' dependent documents.');
print('projects remaining: ' + userDb.projects.countDocuments());
