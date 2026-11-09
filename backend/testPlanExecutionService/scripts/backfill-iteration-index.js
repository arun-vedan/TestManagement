// One-time backfill (2026-09-14, WP-F07b Task 1): stamps iterationIndex: 0
// onto every existing TestCases[] row that doesn't already store the field.
//
// WHY THIS IS NEEDED EVEN THOUGH THE SCHEMA DEFAULTS iterationIndex TO 0:
// Mongoose's `default: 0` only applies once a document is hydrated into
// application memory (Mongoose read paths, e.g. TestExecution.find()) -- it
// is never seen by a raw MongoDB query run against the stored document.
// controllers/testexecution.js's caseIterationQuery() and
// caseIterationFilterCond() both work around that at read time (matching an
// absent field OR an explicit 0, per R1), but a raw query working around a
// gap is not the same as closing it: this script closes it, so the stored
// data says what it means instead of relying on every future reader to
// apply the same workaround correctly.
//
// IDEMPOTENT: the write only touches array elements matching
// { iterationIndex: { $exists: false } } (via arrayFilters, so it can
// selectively fix some rows of a document while leaving already-stamped
// rows in the same document untouched). A second run finds nothing left to
// touch and reports that -- it does not assume a prior run happened, it
// checks.
//
// Uses the raw MongoDB collection (bypasses Mongoose hydration/casting) so
// the "before" report reflects exactly what's stored, not what the schema
// default would paper over -- same reasoning as testRepoService's
// scripts/backfill-approved-status.js.
//
// VERIFIED against srckube-testexecution (2026-09-14, via
// `docker exec mongodb mongosh`): 14 executions, 14 TestCases[] rows total
// across them, max 3 rows in a single run (Run-7), and ZERO runs with two
// rows sharing the same TestCaseId -- so in this database, this migration
// collides with nothing: every row simply gets iterationIndex: 0, which is
// already what it means today (the one and only row for that case). A
// production database is not guaranteed to match that shape, which is
// exactly why this script reports what it finds rather than assuming it,
// and why it's safe to re-run.
//
// CONTAINERS HAVE NO BIND MOUNT: a host-invoked script does not run inside
// the container's network, so it cannot reach Mongo the way the running
// service does (the container-network hostname `mongodb`, the credentials
// docker-compose.yml injects as this service's own environment). It must
// be run FROM INSIDE the container:
//
//   docker exec testplanexecutionservice node scripts/backfill-iteration-index.js [--dry-run]
//
// (This mirrors the running service's own connection exactly: it requires
// this same service's models/TestExecution.js, which opens
// executionConnection via config/db.js using this container's own
// MONGO_URI_TESTEXECUTION -- the identical path getExecutionTestCaseDetails
// etc. use at runtime, not a separately-constructed URI.)

// config/db.js's connection-event logging calls String.prototype.cyan
// etc. (added by the `colors` package) unconditionally -- server.js
// normally requires `colors` before config/db.js ever loads; this script
// loads models/TestExecution.js (and transitively config/db.js) on its
// own, so it needs the same require for that side effect.
require('colors');
require('dotenv').config({ path: './config/config.env' });
const TestExecution = require('../models/TestExecution');

const DRY_RUN = process.argv.includes('--dry-run');

function waitForConnection(conn) {
  if (conn.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    conn.once('open', resolve);
    conn.once('error', reject);
  });
}

(async () => {
  const conn = TestExecution.db;
  await waitForConnection(conn);

  const coll = TestExecution.collection;

  const totalDocs = await coll.countDocuments({});
  const totalRows = await coll
    .aggregate([{ $unwind: '$TestCases' }, { $count: 'n' }])
    .toArray();
  const rowsMissing = await coll
    .aggregate([
      { $unwind: '$TestCases' },
      { $match: { 'TestCases.iterationIndex': { $exists: false } } },
      { $count: 'n' }
    ])
    .toArray();
  // $elemMatch, not the dot path: `{'TestCases.iterationIndex': {$exists:
  // false}}` also matches a document whose TestCases array is EMPTY, because
  // the path trivially does not exist there. Measured against real data, the
  // dot-path form reported 5 affected executions when the true answer was 0 --
  // all five were empty-array documents with nothing to stamp. A backfill whose
  // whole job is to report what it found rather than assume cannot afford a
  // count that says "work remaining" when there is none.
  const docsAffected = await coll.countDocuments({
    TestCases: { $elemMatch: { iterationIndex: { $exists: false } } }
  });

  const totalRowCount = totalRows[0] ? totalRows[0].n : 0;
  const missingRowCount = rowsMissing[0] ? rowsMissing[0].n : 0;

  console.log('='.repeat(78));
  console.log('WP-F07b Task 1 backfill: iterationIndex: 0 on pre-existing TestCases[] rows');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'APPLY (writing)'}`);
  console.log('='.repeat(78));
  console.log(`  executions (documents): ${totalDocs}`);
  console.log(`  TestCases[] rows total: ${totalRowCount}`);
  console.log(`  rows already carrying iterationIndex: ${totalRowCount - missingRowCount}`);
  console.log(`  rows missing iterationIndex (would be set to 0): ${missingRowCount}`);
  console.log(`  executions with at least one such row: ${docsAffected}`);

  if (DRY_RUN) {
    console.log('\nDry run -- no changes written. Re-run without --dry-run to apply.');
    process.exit(0);
  }

  if (missingRowCount === 0) {
    console.log('\nNothing to backfill (idempotent no-op) -- every row already carries iterationIndex.');
    process.exit(0);
  }

  const result = await coll.updateMany(
    { 'TestCases.iterationIndex': { $exists: false } },
    { $set: { 'TestCases.$[elem].iterationIndex': 0 } },
    { arrayFilters: [{ 'elem.iterationIndex': { $exists: false } }] }
  );

  const rowsMissingAfter = await coll
    .aggregate([
      { $unwind: '$TestCases' },
      { $match: { 'TestCases.iterationIndex': { $exists: false } } },
      { $count: 'n' }
    ])
    .toArray();
  const missingRowCountAfter = rowsMissingAfter[0] ? rowsMissingAfter[0].n : 0;

  console.log(
    `\nAPPLIED: matched ${result.matchedCount} document(s), modified ${result.modifiedCount} document(s).`
  );
  console.log(`  rows missing iterationIndex after: ${missingRowCountAfter}`);
  if (missingRowCountAfter > 0) {
    console.log('  WARNING: rows still missing iterationIndex after the update -- investigate before re-running.');
  }
  process.exit(0);
})().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
