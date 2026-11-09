/* eslint-disable no-undef */
/**
 * backfillCommentProjectId.mongo.js — WP-115
 *
 * A mongosh script, run INSIDE the mongodb container. The instance guard below
 * refuses anything but the container's mongod — this host runs a second,
 * unauthenticated mongod on 127.0.0.1:27017 carrying shadow srckube databases
 * (see pruneOrphanedProjects.mongo.js for the full story).
 *
 * ---------------------------------------------------------------------------
 * WHAT AND WHY
 *
 * WP-115 makes Comments.projectId required + indexed. The field already
 * existed with its `required` COMMENTED OUT, so nothing ever set it: all 166
 * existing comments carry no projectId at all.
 *
 * IT IS DERIVED, NOT ASSUMED. A comment is attached to one entity, identified
 * by `typeId` (a business id like "Req-1", "TC-1", "Bug-2") plus `moduleId`
 * (which entity type that is). That entity already lives in a known project,
 * so each comment's project is resolved by looking it up:
 *
 *   module 1 -> srckube-testrepo.testcaserepos        by TestCaseId
 *   module 2 -> srckube-requirements.requirements     by reqId
 *   module 3 -> srckube-testplan.testplans            by TestPlanId
 *   module 4 -> srckube-testexecution.testexecutions  by TestExecutionId
 *   module 5 -> srckube-defects.defects               by defectId
 *   module 6 -> srckube-release.releases              by releaseId
 *
 * (Module numbering is the product's own — frontend/src/workbench/modules.ts
 * and linkIssueService/controllers/linkIssue.js both hardcode it.)
 *
 * Unresolvable comments are REPORTED, not filed under project 1. A comment
 * whose entity no longer exists belongs to no tenant, and asserting otherwise
 * is the mistake WP-103 and WP-104/111 both had to undo. Left without a
 * projectId it is invisible to the scoped routes, which is the honest state.
 *
 * NOTE ON SOFT-DELETED COMMENTS: 159 of the 166 have status 0 (this service's
 * advancedResults filters to status 1 — the documented deviation). They are
 * backfilled too where resolvable: they are still real history, and the audit
 * surface may want them later. Being soft-deleted is not a reason to misfile
 * them.
 *
 * ---------------------------------------------------------------------------
 * SAFETY
 *   - DRY RUN by default. Writes only with BACKFILL_APPLY=1 AND
 *     BACKFILL_CONFIRM=yes-apply.
 *   - Additive (GR-7): only ever SETS projectId where absent. Never
 *     overwrites, never deletes.
 *   - Idempotent: selects on absent projectId.
 *   - Take a backup first: ./scripts/mongo-backup.sh
 *
 * USAGE (from the repo root)
 *   docker exec -i mongodb mongosh "$URI" --quiet \
 *     --file /dev/stdin < backend/shared/scripts/backfillCommentProjectId.mongo.js
 *
 *   docker exec -i -e BACKFILL_APPLY=1 -e BACKFILL_CONFIRM=yes-apply mongodb \
 *     mongosh "$URI" --quiet \
 *     --file /dev/stdin < backend/shared/scripts/backfillCommentProjectId.mongo.js
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

const present = db.adminCommand({ listDatabases: 1 }).databases.map(function (d) { return d.name; });
const missing = MUST_HAVE_DBS.filter(function (n) { return present.indexOf(n) === -1; });
const foreign = MUST_NOT_HAVE_DBS.filter(function (n) { return present.indexOf(n) !== -1; });
if (missing.length) { abort('not the container mongod — missing ' + missing.join(', ') + '.'); }
if (foreign.length) { abort('this looks like the NATIVE host mongod (found ' + foreign.join(', ') + ').'); }
print('instance guard:  OK (container mongod)');
print('mode:            ' + (APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'));
print('');

const RESOLVERS = {
  1: { db: 'srckube-testrepo', coll: 'testcaserepos', field: 'TestCaseId' },
  2: { db: 'srckube-requirements', coll: 'requirements', field: 'reqId' },
  3: { db: 'srckube-testplan', coll: 'testplans', field: 'TestPlanId' },
  4: { db: 'srckube-testexecution', coll: 'testexecutions', field: 'TestExecutionId' },
  5: { db: 'srckube-defects', coll: 'defects', field: 'defectId' },
  6: { db: 'srckube-release', coll: 'releases', field: 'releaseId' }
};

const cache = {};
function projectOf(moduleId, typeId) {
  const r = RESOLVERS[moduleId];
  if (!r || typeId === undefined || typeId === null || typeId === '') { return null; }
  const key = moduleId + ':' + typeId;
  if (cache[key] !== undefined) { return cache[key]; }
  const target = db.getSiblingDB(r.db);
  if (target.getCollectionNames().indexOf(r.coll) === -1) { cache[key] = null; return null; }
  const q = {}; q[r.field] = typeId;
  const doc = target[r.coll].findOne(q, { projectId: 1 });
  cache[key] = doc && doc.projectId !== undefined ? doc.projectId : null;
  return cache[key];
}

const comments = db.getSiblingDB('srckube-comments').comments
  .find({ $or: [{ projectId: { $exists: false } }, { projectId: null }] },
        { _id: 1, typeId: 1, moduleId: 1, status: 1 })
  .toArray();

print('comments needing a projectId: ' + comments.length);
print('comments already scoped:      ' +
  db.getSiblingDB('srckube-comments').comments.countDocuments({ projectId: { $exists: true, $ne: null } }));
print('');

const planned = [];
const unresolved = [];
comments.forEach(function (c) {
  const pid = projectOf(c.moduleId, c.typeId);
  if (pid === null) { unresolved.push(c); return; }
  planned.push({ comment: c, projectId: pid });
});

const byProject = {};
planned.forEach(function (p) { byProject[p.projectId] = (byProject[p.projectId] || 0) + 1; });
print('resolvable: ' + planned.length);
Object.keys(byProject).forEach(function (pid) {
  print('    project ' + pid + ': ' + byProject[pid] + ' comment(s)');
});

if (unresolved.length) {
  const byModule = {};
  unresolved.forEach(function (c) {
    const k = 'module ' + c.moduleId;
    byModule[k] = (byModule[k] || 0) + 1;
  });
  print('');
  print('REPORTED, NOT GUESSED — ' + unresolved.length + ' comment(s) whose entity no longer exists.');
  print('  Left unscoped, so no scoped route surfaces them. A comment on a deleted');
  print('  entity belongs to no tenant; filing it under project 1 would assert otherwise.');
  Object.keys(byModule).forEach(function (k) { print('    ' + k + ': ' + byModule[k]); });
  print('  sample typeIds: ' + unresolved.slice(0, 8).map(function (c) { return c.typeId; }).join(', '));
}

print('');
print('to write: ' + planned.length + '   to leave alone: ' + unresolved.length);

if (!APPLY) {
  print('');
  print('DRY RUN — nothing was written.');
  if (planned.length === 0) {
    print('(Nothing to write. After an apply run, that is the idempotency check passing.)');
  } else {
    print('To apply: take a backup (./scripts/mongo-backup.sh), then re-run with');
    print('  -e BACKFILL_APPLY=1 -e BACKFILL_CONFIRM=yes-apply');
  }
  quit(0);
}
if (!CONFIRMED) {
  abort('BACKFILL_APPLY=1 also requires BACKFILL_CONFIRM=yes-apply. Refusing to write.');
}
if (planned.length === 0) {
  print('');
  print('Nothing to write — already backfilled. (Idempotent re-run.)');
  quit(0);
}

print('');
print('Applying (additive: only sets projectId where absent).');
let written = 0;
planned.forEach(function (p) {
  const res = db.getSiblingDB('srckube-comments').comments.updateOne(
    { _id: p.comment._id, $or: [{ projectId: { $exists: false } }, { projectId: null }] },
    { $set: { projectId: p.projectId } }
  );
  written += res.modifiedCount;
});
print('set projectId on ' + written + ' comment(s).');
print('');
db.getSiblingDB('srckube-comments').comments
  .aggregate([{ $group: { _id: '$projectId', n: { $sum: 1 } } }, { $sort: { _id: 1 } }])
  .forEach(function (g) { print('  projectId=' + g._id + ': ' + g.n + ' comment(s)'); });
