/* eslint-disable no-undef */
/**
 * backfillAttachmentProjectId.mongo.js — WP-112
 *
 * A mongosh script, run INSIDE the mongodb container. See
 * pruneOrphanedProjects.mongo.js for why that is a safety property (a second,
 * unauthenticated mongod holds 127.0.0.1:27017 and carries shadow srckube
 * databases). The same instance guard is applied below.
 *
 * ---------------------------------------------------------------------------
 * WHAT AND WHY
 *
 * WP-112 scopes uploadService. Unlike the other seven services in WP-111…118
 * this one has NO Mongoose model: its storage is a GridFS bucket, so tenancy
 * lives in each file's `metadata.projectId` (stamped on upload by
 * uploadService/utils/upload.js) and that is what every read filters on.
 *
 * Existing files have no metadata at all, so they need one before the scoped
 * routes can see them.
 *
 * IT IS DERIVED, NOT ASSUMED. A file is an attachment ON something — a
 * requirement, a defect, a test execution — and that something already lives
 * in a known project. So each file's project is resolved by finding the entity
 * that references its id and reading that entity's projectId.
 *
 * The search is deliberately broad (stringify the document and look for the
 * file id) rather than keyed to specific field names, because attachment
 * references are not stored uniformly across these services — some sit in an
 * `attachment: [Mixed]` array, some in nested step structures. Keying on field
 * names would have silently missed whichever shape was not anticipated, and a
 * missed reference means a file filed under no project at all.
 *
 * UNREFERENCED AND CONFLICTING FILES ARE REPORTED, NEVER GUESSED:
 *   - exactly one project references it  -> that project
 *   - several entities in the SAME project -> that project
 *   - entities in DIFFERENT projects      -> reported, left alone
 *   - nothing references it               -> reported, left alone
 *
 * A file left without metadata.projectId is invisible to every scoped route,
 * which is the correct failure mode. It is also, bluntly, the honest state for
 * an attachment nobody can point at: filing it under project 1 would make an
 * orphan look like that tenant's data, which is the mistake this phase has
 * spent its time undoing (reportingService's UNSCOPED_SOURCE_DEFAULT_PROJECT_ID
 * in WP-103, linkIssueService's DEFAULT_PROJECT_ID in WP-104/111).
 *
 * ---------------------------------------------------------------------------
 * SAFETY
 *   - DRY RUN by default; reports every change and every unresolved file.
 *   - Writes only with BACKFILL_APPLY=1 AND BACKFILL_CONFIRM=yes-apply.
 *   - Additive (GR-7): only ever SETS metadata.projectId where it is absent.
 *     Never overwrites, never deletes, never touches file CONTENT (chunks).
 *   - Idempotent: selects on absent metadata.projectId.
 *   - Take a backup first: ./scripts/mongo-backup.sh
 *
 * USAGE (from the repo root)
 *   docker exec -i mongodb mongosh "$URI" --quiet \
 *     --file /dev/stdin < backend/shared/scripts/backfillAttachmentProjectId.mongo.js
 *
 *   docker exec -i -e BACKFILL_APPLY=1 -e BACKFILL_CONFIRM=yes-apply mongodb \
 *     mongosh "$URI" --quiet \
 *     --file /dev/stdin < backend/shared/scripts/backfillAttachmentProjectId.mongo.js
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
if (missing.length) {
  abort('this does not look like the container mongod — missing ' + missing.join(', ') + '.');
}
if (foreign.length) {
  abort('this looks like the NATIVE host mongod (found ' + foreign.join(', ') + '). Refusing.');
}
print('instance guard:  OK (container mongod)');
print('mode:            ' + (APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'));
print('');

// Collections that can carry an attachment reference. Broad on purpose — see
// the header note on why this is not keyed to field names.
const REFERRERS = [
  ['srckube-requirements', 'requirements'],
  ['srckube-defects', 'defects'],
  ['srckube-testexecution', 'testexecutions'],
  ['srckube-testrepo', 'testcaserepos'],
  ['srckube-comments', 'comments'],
  ['srckube-release', 'releases']
];

const files = db.getSiblingDB('srckube-attachments')['filesBucket.files']
  .find({ 'metadata.projectId': { $exists: false } }, { _id: 1, filename: 1 })
  .toArray();

print('files needing a projectId: ' + files.length);
print('files already scoped:      ' +
  db.getSiblingDB('srckube-attachments')['filesBucket.files'].countDocuments({ 'metadata.projectId': { $exists: true } }));
print('');

// Build fileId -> set of projectIds that reference it, in ONE pass per
// collection rather than one query per file.
const refs = {};
files.forEach(function (f) { refs[String(f._id)] = {}; });
const fileIds = Object.keys(refs);

REFERRERS.forEach(function (entry) {
  const target = db.getSiblingDB(entry[0]);
  if (target.getCollectionNames().indexOf(entry[1]) === -1) { return; }
  target[entry[1]].find({}, { projectId: 1, attachment: 1, TestCases: 1, TestSteps: 1, description: 1 })
    .forEach(function (doc) {
      if (doc.projectId === undefined) { return; }
      const blob = JSON.stringify(doc);
      fileIds.forEach(function (id) {
        if (blob.indexOf(id) !== -1) { refs[id][doc.projectId] = true; }
      });
    });
});

const planned = [];
const conflicted = [];
const unreferenced = [];

files.forEach(function (f) {
  const projects = Object.keys(refs[String(f._id)]);
  if (projects.length === 0) { unreferenced.push(f); return; }
  if (projects.length > 1) { conflicted.push({ file: f, projects: projects }); return; }
  planned.push({ file: f, projectId: Number(projects[0]) });
});

const byProject = {};
planned.forEach(function (p) { byProject[p.projectId] = (byProject[p.projectId] || 0) + 1; });
print('resolvable: ' + planned.length);
Object.keys(byProject).forEach(function (pid) {
  print('    project ' + pid + ': ' + byProject[pid] + ' file(s)');
});

if (conflicted.length) {
  print('');
  print('REPORTED, NOT GUESSED — ' + conflicted.length + ' file(s) referenced from MORE THAN ONE project.');
  conflicted.forEach(function (c) {
    print('    ' + c.file.filename + '  referenced by projects ' + c.projects.join(', '));
  });
}

if (unreferenced.length) {
  print('');
  print('REPORTED, NOT GUESSED — ' + unreferenced.length + ' file(s) that no entity references.');
  print('  Left unscoped, so no scoped route surfaces them. Filing an orphan under');
  print('  project 1 would make it look like that tenant\'s data.');
  unreferenced.forEach(function (f) { print('    ' + f.filename + '  (' + f._id + ')'); });
}

print('');
print('to write: ' + planned.length + '   to leave alone: ' + (conflicted.length + unreferenced.length));

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
print('Applying (additive: only sets metadata.projectId where absent; never touches chunks).');
let written = 0;
planned.forEach(function (p) {
  const res = db.getSiblingDB('srckube-attachments')['filesBucket.files'].updateOne(
    { _id: p.file._id, 'metadata.projectId': { $exists: false } },
    { $set: { 'metadata.projectId': p.projectId } }
  );
  written += res.modifiedCount;
});
print('set metadata.projectId on ' + written + ' file(s).');
print('');
db.getSiblingDB('srckube-attachments')['filesBucket.files']
  .aggregate([{ $group: { _id: '$metadata.projectId', n: { $sum: 1 } } }, { $sort: { _id: 1 } }])
  .forEach(function (g) { print('  projectId=' + g._id + ': ' + g.n + ' file(s)'); });
