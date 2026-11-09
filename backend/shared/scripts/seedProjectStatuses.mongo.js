/* eslint-disable no-undef */
/**
 * seedProjectStatuses.mongo.js — WP-116
 *
 * A mongosh script, run INSIDE the mongodb container. The instance guard below
 * refuses anything but the container's mongod (this host also runs an
 * unauthenticated mongod on 127.0.0.1:27017 with shadow srckube databases —
 * see pruneOrphanedProjects.mongo.js).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS, AND WHY IT IS NOT A BACKFILL
 *
 * WP-116 scopes statusService. Every one of the 8 existing IssueStatus
 * documents already carried `projectId: 1`, so there was nothing to backfill.
 *
 * The problem is the opposite one: ONLY project 1 had them. Measured at the
 * time of this change — project 1 held 8 statuses and every other project held
 * ZERO, and nothing seeds a vocabulary when a project is created.
 *
 * So scoping alone would have broken a live feature. defectService's
 * updateDefectStatus (WP-010) fetches the whole vocabulary and validates the
 * requested transition against the `parentId` graph; with an empty vocabulary
 * every transition becomes "unrecognized status" and the defect-status
 * workflow stops working in every project except project 1. Tenant isolation
 * that silently disables a feature for all but one tenant is not isolation,
 * it is breakage with a filter in front of it.
 *
 * This script copies a source project's vocabulary into a target project,
 * preserving the transition graph. It is the seeding half of WP-116 and is
 * meant to be run for any project that needs the defect workflow.
 *
 * THE GRAPH IS REMAPPED, NOT COPIED BLIND. `parentId` holds the ids of the
 * statuses a target is reachable FROM, so a straight copy would leave the new
 * rows pointing at the SOURCE project's status ids. Each new status gets a
 * fresh id from the shared counter, and the parentId arrays are rewritten
 * through an old-id -> new-id map. 0 is preserved as-is: it is the graph root
 * ("reachable from nothing"), not a status id. Getting this wrong would
 * produce a vocabulary that looks right and refuses every transition — the
 * WP-010 entry records that the graph direction was verified against real
 * data rather than assumed, and the same care applies here.
 *
 * ---------------------------------------------------------------------------
 * SAFETY
 *   - DRY RUN by default. Writes only with SEED_APPLY=1 AND
 *     SEED_CONFIRM=yes-apply.
 *   - Idempotent: a target project that already has statuses is SKIPPED, never
 *     topped up or duplicated.
 *   - Additive: never modifies or deletes an existing status.
 *   - Take a backup first: ./scripts/mongo-backup.sh
 *
 * ENV
 *   SEED_SOURCE_PROJECT   project to copy from (default 1)
 *   SEED_TARGET_PROJECTS  comma-separated target project ids, or "all" to mean
 *                         every project that currently has no statuses
 *   SEED_APPLY=1 + SEED_CONFIRM=yes-apply   to write
 *
 * USAGE (from the repo root)
 *   docker exec -i -e SEED_TARGET_PROJECTS=1361 mongodb mongosh "$URI" --quiet \
 *     --file /dev/stdin < backend/shared/scripts/seedProjectStatuses.mongo.js
 */

const APPLY = process.env.SEED_APPLY === '1';
const CONFIRMED = process.env.SEED_CONFIRM === 'yes-apply';
const SOURCE = Number(process.env.SEED_SOURCE_PROJECT || 1);
const TARGET_SPEC = process.env.SEED_TARGET_PROJECTS || '';

const MUST_HAVE_DBS = ['srckube-ai', 'srckube-release', 'srckube-reporting'];
const MUST_NOT_HAVE_DBS = ['codeshark', 'fauserdb', 'authdeputy'];

function abort(message) {
  print('');
  print('ABORTED: ' + message);
  quit(1);
}

const present = db.adminCommand({ listDatabases: 1 }).databases.map(function (d) { return d.name; });
if (MUST_HAVE_DBS.filter(function (n) { return present.indexOf(n) === -1; }).length) {
  abort('not the container mongod.');
}
if (MUST_NOT_HAVE_DBS.filter(function (n) { return present.indexOf(n) !== -1; }).length) {
  abort('this looks like the NATIVE host mongod. Refusing.');
}
print('instance guard:  OK (container mongod)');
print('mode:            ' + (APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'));
print('');

const statusColl = db.getSiblingDB('srckube-issuestatus').staus;
const source = statusColl.find({ projectId: SOURCE }).sort({ id: 1 }).toArray();
if (source.length === 0) {
  abort('source project ' + SOURCE + ' has no statuses to copy.');
}
print('source project ' + SOURCE + ': ' + source.length + ' statuses');
source.forEach(function (s) {
  print('    id=' + s.id + '  ' + s.istatus + '  reachable-from=' + JSON.stringify(s.parentId));
});
print('');

const realProjects = db.getSiblingDB('srckube-user').projects.distinct('id');
let targets;
if (TARGET_SPEC === 'all') {
  targets = realProjects.filter(function (p) {
    return p !== SOURCE && statusColl.countDocuments({ projectId: p }) === 0;
  });
} else if (TARGET_SPEC) {
  targets = TARGET_SPEC.split(',').map(function (x) { return Number(x.trim()); }).filter(function (n) {
    return Number.isInteger(n);
  });
} else {
  abort('set SEED_TARGET_PROJECTS to a comma-separated list of project ids, or "all".');
}

const skipped = [];
const planned = [];
targets.forEach(function (p) {
  if (realProjects.indexOf(p) === -1) { skipped.push([p, 'no such project']); return; }
  const existing = statusColl.countDocuments({ projectId: p });
  if (existing > 0) { skipped.push([p, 'already has ' + existing + ' statuses']); return; }
  planned.push(p);
});

print('targets to seed:  ' + planned.length + '  ' + JSON.stringify(planned));
if (skipped.length) {
  print('skipped:');
  skipped.forEach(function (s) { print('    project ' + s[0] + ': ' + s[1]); });
}

if (!APPLY) {
  print('');
  print('DRY RUN — nothing was written.');
  if (planned.length === 0) {
    print('(Nothing to seed. After an apply run, that is the idempotency check passing.)');
  } else {
    print('To apply: take a backup (./scripts/mongo-backup.sh), then re-run with');
    print('  -e SEED_APPLY=1 -e SEED_CONFIRM=yes-apply');
  }
  quit(0);
}
if (!CONFIRMED) { abort('SEED_APPLY=1 also requires SEED_CONFIRM=yes-apply.'); }
if (planned.length === 0) {
  print('');
  print('Nothing to seed. (Idempotent re-run.)');
  quit(0);
}

// The same atomic counter service-core's getNextSequence() uses, so seeded ids
// never collide with ids the running service hands out.
function nextId() {
  const r = db.getSiblingDB('srckube-issuestatus').counters.findOneAndUpdate(
    { _id: 'issuestatus' },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  const doc = r && (r.value || r);
  return doc.seq;
}

print('');
print('Applying.');
planned.forEach(function (target) {
  const idMap = {};
  const docs = [];
  source.forEach(function (s) {
    const newId = nextId();
    idMap[s.id] = newId;
    docs.push({
      id: newId,
      istatus: s.istatus,
      moduleId: s.moduleId,
      projectId: target,
      parentId: [],           // filled below, once every id is known
      createdAt: new Date(),
      updatedAt: new Date()
    });
  });
  // Remap the graph. 0 stays 0: it is the root marker, not a status id.
  source.forEach(function (s, i) {
    docs[i].parentId = (s.parentId || []).map(function (pid) {
      return pid === 0 ? 0 : (idMap[pid] !== undefined ? idMap[pid] : pid);
    });
  });
  statusColl.insertMany(docs);
  print('  project ' + target + ': seeded ' + docs.length + ' statuses');
  docs.forEach(function (d) {
    print('      id=' + d.id + '  ' + d.istatus + '  reachable-from=' + JSON.stringify(d.parentId));
  });
});

print('');
statusColl.aggregate([{ $group: { _id: '$projectId', n: { $sum: 1 } } }, { $sort: { _id: 1 } }])
  .forEach(function (g) { print('  projectId=' + g._id + ': ' + g.n + ' statuses'); });
