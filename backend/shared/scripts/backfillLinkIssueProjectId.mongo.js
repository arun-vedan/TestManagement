/* eslint-disable no-undef */
/**
 * backfillLinkIssueProjectId.mongo.js — WP-111
 *
 * A mongosh script, run INSIDE the mongodb container. See
 * pruneOrphanedProjects.mongo.js for why that is a safety property: this host
 * runs a second, unauthenticated mongod on 127.0.0.1:27017 carrying shadow
 * srckube databases, so a host-side `localhost` connection reaches the WRONG
 * instance. The same instance guard is applied below.
 *
 * ---------------------------------------------------------------------------
 * WHAT AND WHY
 *
 * WP-111 adds a required, indexed `projectId` to LinkIssue. Existing link rows
 * have none, so they need one before the scoped routes can see them.
 *
 * IT IS DERIVED, NOT ASSUMED. A link references two entities by their business
 * ids (e.g. `Req-1` -> `TC-1`), and those entities already live in a known
 * project. So each link's project is resolved by looking up what it actually
 * connects:
 *
 *   module 1 -> srckube-testrepo.testcaserepos    by TestCaseId
 *   module 2 -> srckube-requirements.requirements by reqId
 *   module 5 -> srckube-defects.defects           by defectId
 *
 * (The module numbering is linkIssueService's own — see
 * controllers/linkIssue.js's MODULE map and the frontend's
 * entitySearchConfigs.ts, which documents all six.)
 *
 * This matters because the obvious shortcut — stamp everything with project 1 —
 * is exactly the move that produced the two shims this phase has spent time
 * undoing: reportingService's UNSCOPED_SOURCE_DEFAULT_PROJECT_ID (deleted in
 * WP-103, premise had gone false) and this very service's DEFAULT_PROJECT_ID
 * (audited in WP-104, retired by WP-111). Assuming a project is how you get a
 * number that is right today and silently wrong later.
 *
 * DISAGREEMENT AND UNRESOLVABLE ROWS ARE REPORTED, NEVER GUESSED:
 *   - both ends resolve and AGREE        -> that project
 *   - only one end resolves              -> that project (the other end is a
 *                                           dangling business id)
 *   - ends resolve to DIFFERENT projects -> reported, left alone. A
 *                                           cross-project link should not
 *                                           exist and this script will not
 *                                           pick a winner.
 *   - neither end resolves               -> reported, left alone.
 *
 * A link left without a projectId is invisible to the scoped routes, which is
 * the correct failure mode: better an orphaned link nobody sees than a link
 * silently filed under the wrong tenant.
 *
 * ---------------------------------------------------------------------------
 * SAFETY
 *   - DRY RUN by default; reports every change and every unresolved row.
 *   - Writes only with BACKFILL_APPLY=1 AND BACKFILL_CONFIRM=yes-apply.
 *   - Additive (GR-7): only ever SETS projectId on a document that has none.
 *     Never overwrites an existing value, never deletes.
 *   - Idempotent: it selects on { projectId: { $exists: false } }, so a second
 *     run finds nothing.
 *   - Take a backup first: ./scripts/mongo-backup.sh
 *
 * USAGE (from the repo root)
 *   docker exec -i mongodb mongosh "$URI" --quiet \
 *     --file /dev/stdin < backend/shared/scripts/backfillLinkIssueProjectId.mongo.js
 *
 *   docker exec -i -e BACKFILL_APPLY=1 -e BACKFILL_CONFIRM=yes-apply mongodb \
 *     mongosh "$URI" --quiet \
 *     --file /dev/stdin < backend/shared/scripts/backfillLinkIssueProjectId.mongo.js
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

const present = db.adminCommand({ listDatabases: 1 }).databases.map(function (d) {
  return d.name;
});
const missing = MUST_HAVE_DBS.filter(function (n) { return present.indexOf(n) === -1; });
const foreign = MUST_NOT_HAVE_DBS.filter(function (n) { return present.indexOf(n) !== -1; });
if (missing.length) {
  abort('this does not look like the container mongod — missing ' + missing.join(', ') + '.');
}
if (foreign.length) {
  abort('this looks like the NATIVE host mongod (found ' + foreign.join(', ') + '). Refusing.');
}
print('instance guard:  OK (container mongod)');
print('mode:            ' + (APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'));
print('');

// linkIssueService module id -> where that entity type lives.
const RESOLVERS = {
  1: { db: 'srckube-testrepo', coll: 'testcaserepos', field: 'TestCaseId' },
  2: { db: 'srckube-requirements', coll: 'requirements', field: 'reqId' },
  5: { db: 'srckube-defects', coll: 'defects', field: 'defectId' }
};

const cache = {};
function projectOf(moduleId, businessId) {
  const r = RESOLVERS[moduleId];
  if (!r || businessId === undefined || businessId === null || businessId === '') {
    return null;
  }
  const key = moduleId + ':' + businessId;
  if (cache[key] !== undefined) {
    return cache[key];
  }
  const q = {};
  q[r.field] = businessId;
  const doc = db.getSiblingDB(r.db)[r.coll].findOne(q, { projectId: 1 });
  cache[key] = doc && doc.projectId !== undefined ? doc.projectId : null;
  return cache[key];
}

const links = db.getSiblingDB('srckube-linkissue').linkissues
  .find({ projectId: { $exists: false } })
  .toArray();

print('links needing a projectId: ' + links.length);
print('links already scoped:      ' + db.getSiblingDB('srckube-linkissue').linkissues.countDocuments({ projectId: { $exists: true } }));
print('');

const planned = [];
const conflicted = [];
const unresolved = [];

links.forEach(function (link) {
  const srcProject = projectOf(link.srcModule, link.sourceId);
  const destProject = projectOf(link.destinationModule, link.destinationId);

  if (srcProject !== null && destProject !== null && srcProject !== destProject) {
    conflicted.push({ link: link, srcProject: srcProject, destProject: destProject });
    return;
  }
  const resolved = srcProject !== null ? srcProject : destProject;
  if (resolved === null) {
    unresolved.push(link);
    return;
  }
  planned.push({ link: link, projectId: resolved });
});

const byProject = {};
planned.forEach(function (p) {
  byProject[p.projectId] = (byProject[p.projectId] || 0) + 1;
});
print('resolvable: ' + planned.length);
Object.keys(byProject).forEach(function (pid) {
  print('    project ' + pid + ': ' + byProject[pid] + ' link(s)');
});

if (conflicted.length) {
  print('');
  print('REPORTED, NOT GUESSED — ' + conflicted.length + ' link(s) whose two ends sit in DIFFERENT projects.');
  print('  A cross-project link should not exist; this script will not pick a winner.');
  conflicted.forEach(function (c) {
    print('    ' + c.link.linkId + '  ' + c.link.sourceId + '(project ' + c.srcProject + ') -> ' +
      c.link.destinationId + '(project ' + c.destProject + ')');
  });
}

if (unresolved.length) {
  print('');
  print('REPORTED, NOT GUESSED — ' + unresolved.length + ' link(s) whose ends resolve to no known entity.');
  print('  Left without a projectId, so the scoped routes will not surface them.');
  unresolved.forEach(function (l) {
    print('    ' + l.linkId + '  ' + l.sourceId + '(m' + l.srcModule + ') -> ' + l.destinationId + '(m' + l.destinationModule + ')');
  });
}

print('');
print('to write: ' + planned.length + '   to leave alone: ' + (conflicted.length + unresolved.length));

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
print('Applying (additive: only sets projectId where it is absent).');
let written = 0;
planned.forEach(function (p) {
  const res = db.getSiblingDB('srckube-linkissue').linkissues.updateOne(
    { _id: p.link._id, projectId: { $exists: false } },
    { $set: { projectId: p.projectId } }
  );
  written += res.modifiedCount;
});
print('set projectId on ' + written + ' link(s).');
print('');
db.getSiblingDB('srckube-linkissue').linkissues
  .aggregate([{ $group: { _id: '$projectId', n: { $sum: 1 } } }, { $sort: { _id: 1 } }])
  .forEach(function (g) {
    print('  projectId=' + g._id + ': ' + g.n + ' link(s)');
  });
