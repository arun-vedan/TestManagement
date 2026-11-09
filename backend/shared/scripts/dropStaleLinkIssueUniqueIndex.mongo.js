/* eslint-disable no-undef */
/**
 * dropStaleLinkIssueUniqueIndex.mongo.js — found in WP-141, finishes WP-111
 *
 * A mongosh script, run INSIDE the mongodb container, behind the same instance
 * guard as every script in this directory (this host also runs a native mongod
 * on 127.0.0.1:27017 carrying shadow srckube databases).
 *
 * ---------------------------------------------------------------------------
 * WHAT AND WHY
 *
 * WP-111 changed LinkIssue's uniqueness from {sourceId, destinationId}
 * (global) to {projectId, sourceId, destinationId} (per project), because a
 * global constraint is a cross-tenant write collision: project B cannot create
 * a link between ids that project A already linked, and gets a duplicate-key
 * error about a link it cannot see.
 *
 * The MODEL changed; the DATABASE did not. Mongoose's autoIndex creates indexes
 * a schema declares but never drops ones it no longer declares, so the old
 * global index `sourceId_1_destinationId_1` is still live next to the new one
 * and still enforces the global rule. Measured during WP-141: the same Jira key
 * linked from the same entity id in two projects failed with
 *   E11000 ... index: sourceId_1_destinationId_1
 * Any internal link pair repeated across tenants hits the same wall.
 *
 * This drops exactly that one index. Nothing else.
 *
 * ---------------------------------------------------------------------------
 * SAFETY
 *   - DRY RUN by default; prints the indexes and what it would do.
 *   - Drops only with DROP_APPLY=1 AND DROP_CONFIRM=yes-drop.
 *   - Refuses unless the per-project unique replacement
 *     {projectId:1, sourceId:1, destinationId:1} exists and is unique, so the
 *     collection is never left without a uniqueness guarantee.
 *   - Idempotent: if the stale index is already gone it says so and exits 0.
 *   - Removes no documents. An index is derived data.
 *
 * ROLLBACK
 *   db.getSiblingDB('srckube-linkissue').linkissues.createIndex(
 *     { sourceId: 1, destinationId: 1 }, { unique: true })
 *   This fails once two projects legitimately hold the same pair, which is the
 *   behaviour being removed.
 *
 * USAGE (from the repo root)
 *   docker exec -i mongodb mongosh "$URI" --quiet \
 *     --file /dev/stdin < backend/shared/scripts/dropStaleLinkIssueUniqueIndex.mongo.js
 *
 *   docker exec -i -e DROP_APPLY=1 -e DROP_CONFIRM=yes-drop mongodb \
 *     mongosh "$URI" --quiet \
 *     --file /dev/stdin < backend/shared/scripts/dropStaleLinkIssueUniqueIndex.mongo.js
 */

const APPLY = process.env.DROP_APPLY === '1';
const CONFIRMED = process.env.DROP_CONFIRM === 'yes-drop';

const STALE = 'sourceId_1_destinationId_1';
const REPLACEMENT_KEY = { projectId: 1, sourceId: 1, destinationId: 1 };

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
  abort('this does not look like the container mongod -- missing ' + missing.join(', ') + '.');
}
if (foreign.length) {
  abort('this looks like the NATIVE host mongod (found ' + foreign.join(', ') + '). Refusing.');
}
print('instance guard:  OK (container mongod)');
print('mode:            ' + (APPLY ? 'APPLY (dropping)' : 'DRY RUN (no changes)'));
print('');

const coll = db.getSiblingDB('srckube-linkissue').linkissues;
const indexes = coll.getIndexes();
indexes.forEach(function (i) {
  print('  index ' + i.name + ' ' + JSON.stringify(i.key) + (i.unique ? ' unique' : ''));
});
print('');

const stale = indexes.filter(function (i) { return i.name === STALE; })[0];
if (!stale) {
  print('OK: ' + STALE + ' is not present. Nothing to do.');
  quit(0);
}

const replacement = indexes.filter(function (i) {
  return JSON.stringify(i.key) === JSON.stringify(REPLACEMENT_KEY) && i.unique === true;
})[0];
if (!replacement) {
  abort('the per-project unique index ' + JSON.stringify(REPLACEMENT_KEY) +
    ' is missing. Start linkIssueService once so Mongoose creates it, then re-run. ' +
    'Refusing to leave the collection without a uniqueness guarantee.');
}
print('replacement present: ' + replacement.name + ' (unique)');

if (!APPLY) {
  print('DRY RUN: would drop ' + STALE + '. Re-run with DROP_APPLY=1 DROP_CONFIRM=yes-drop.');
  quit(0);
}
if (!CONFIRMED) {
  abort('DROP_APPLY=1 requires DROP_CONFIRM=yes-drop.');
}

coll.dropIndex(STALE);
const still = coll.getIndexes().some(function (i) { return i.name === STALE; });
if (still) {
  abort(STALE + ' is still present after dropIndex.');
}
print('DROPPED: ' + STALE);
