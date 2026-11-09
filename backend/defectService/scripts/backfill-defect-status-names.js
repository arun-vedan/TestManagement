// WP-F04 (2026-09-06): one-time migration. Three defects -- Bug-1, Bug-2,
// Bug-3, the only real ones in project 1 -- store `Status` as a numeric
// istatusservice id rather than the status NAME that the other 113 defect
// documents store. Components/governance/DefectStatus.tsx resolves the
// current status by name only, so those three render a raw number and
// their status control is disabled.
//
// THE MAP IS NOT INVENTED. It is srckube-issuestatus.staus verbatim, read
// on 2026-09-06 (the collection name is the typo `staus`, hardcoded as
// mongoose.model's third argument in statusService/models/IssueStatus.js).
// It is duplicated here rather than queried because that collection lives
// in a DIFFERENT database from defectService's own, and adding a second
// connection and env var to a one-time script is a worse trade than a map
// that is asserted against reality by the unknown-code guard below.
//
// TYPE MATTERS: Bug-1 stores the STRING '8' while Bug-2/3 store the
// NUMBERS 1 and 2, so every comparison here goes through String().
//
// IMPORTANT -- run this INSIDE the defectservice container (or against
// MONGO_URI=mongodb://<user>:<pass>@mongodb:27017/srckube-defects?authSource=admin
// resolved via Docker's internal DNS), never as a bare `node
// scripts/backfill-defect-status-names.js` from the host shell. This dev
// host has a stray, non-Docker `mongod` bound to 127.0.0.1:27017/[::1]:27017
// (see docs/backup-restore-runbook.md's "host port collision" section) that
// silently wins over Docker's wildcard-bound proxy for any host-originated
// `localhost`/`127.0.0.1` connection -- config.env's MONGO_URI is exactly
// such a connection string. That stray process was found, during this
// migration, to be carrying its own stale copy of srckube-defects with
// look-alike Bug-1/2/3 documents (Status 8/1/2, no projectId), so running
// this script naively on the host does not error -- it silently migrates
// the wrong database while the real 116-document collection goes untouched.
// Always run via `docker exec defectservice node scripts/backfill-defect-status-names.js`
// so MONGO_URI resolves through the container's own environment (the
// `mongodb` Docker service name), matching how scripts/mongo-backup.sh and
// scripts/mongo-restore.sh already sidestep this exact issue.
//
// Run with: node scripts/backfill-defect-status-names.js [--dry-run]

require('colors');
require('dotenv').config({ path: './config/config.env' });
const connectDB = require('../config/db');
const Defect = require('../models/defects');

const DRY_RUN = process.argv.includes('--dry-run');

const ID_TO_NAME = {
  '1': 'New',
  '2': 'Open',
  '3': 'Fixed',
  '4': 'Rejected',
  '5': 'Deffered',
  '6': 'Retest',
  '7': 'Re-open',
  '8': 'Closed'
};

// A Status is "legacy" if it is entirely digits -- covering both the
// string '8' and the numbers 1/2. A real status name never is.
const isLegacyCode = (value) => value !== null && value !== undefined && /^\d+$/.test(String(value));

(async () => {
  await connectDB();

  const all = await Defect.collection.find({}, { projection: { defectId: 1, Status: 1, projectId: 1 } }).toArray();
  const affected = all.filter((d) => isLegacyCode(d.Status));

  console.log(`Scanned ${all.length} defect(s); ${affected.length} store a numeric status code.`);

  const unknown = affected.filter((d) => !ID_TO_NAME[String(d.Status)]);
  if (unknown.length > 0) {
    console.error('\nABORTING -- these documents carry a numeric status this script has no mapping for:'.red);
    unknown.forEach((d) => console.error(`  - ${d.defectId} (project ${d.projectId}): Status=${JSON.stringify(d.Status)}`));
    console.error('\nNothing was written. Re-read srckube-issuestatus.staus and extend ID_TO_NAME before re-running.');
    process.exit(1);
  }

  affected.forEach((d) => {
    console.log(`  - ${d.defectId} (project ${d.projectId}): ${JSON.stringify(d.Status)} -> '${ID_TO_NAME[String(d.Status)]}'`);
  });

  if (affected.length === 0) {
    console.log('\nNothing to migrate -- already applied, or no legacy codes present.');
    process.exit(0);
  }

  if (DRY_RUN) {
    console.log('\nDry run -- no changes written. Re-run without --dry-run to apply.');
    process.exit(0);
  }

  let changed = 0;
  for (const d of affected) {
    // collection.updateOne, not the model: this restores a correct value
    // onto an existing document and must not re-run Mongoose middleware
    // (the pre-save hook assigns ids from a sequence) or bump __v.
    // eslint-disable-next-line no-await-in-loop
    const res = await Defect.collection.updateOne({ _id: d._id }, { $set: { Status: ID_TO_NAME[String(d.Status)] } });
    changed += res.modifiedCount;
  }

  console.log(`\nMigrated ${changed} document(s).`);
  process.exit(0);
})().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
