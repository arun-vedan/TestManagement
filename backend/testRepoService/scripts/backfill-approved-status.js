// One-time backfill (2026-08-24): explicitly writes status: 'approved' onto
// every test case that predates Sprint 2.1's versioning work and has no
// status field stored at all. Must run BEFORE the schema's default changes
// from 'approved' to 'draft' — otherwise these documents would start
// hydrating as 'draft' the moment the new code deploys, since Mongoose can't
// tell "old document, field genuinely missing" apart from "new document,
// nothing provided" once the default itself changes.
//
// Uses the raw MongoDB collection (bypasses Mongoose's own schema/hydration)
// so { status: { $exists: false } } reflects what's actually stored, not
// what today's schema default would paper over.
//
// Run with: node scripts/backfill-approved-status.js [--dry-run]

require('colors');
require('dotenv').config({ path: './config/config.env' });
const connectDB = require('../config/db');
const TestCase = require('../models/testrepo');

const DRY_RUN = process.argv.includes('--dry-run');

(async () => {
  await connectDB();

  const query = { status: { $exists: false } };
  const affected = await TestCase.collection.find(query).toArray();

  console.log(`Found ${affected.length} test case(s) with no stored status field:`);
  affected.forEach((doc) => console.log(`  - ${doc.TestCaseId} (_id: ${doc._id})`));

  if (DRY_RUN) {
    console.log('\nDry run — no changes written. Re-run without --dry-run to apply.');
    process.exit(0);
  }

  if (affected.length === 0) {
    console.log('\nNothing to backfill.');
    process.exit(0);
  }

  const result = await TestCase.collection.updateMany(query, { $set: { status: 'approved' } });
  console.log(`\nBackfilled ${result.modifiedCount} document(s) to status: 'approved'.`);
  process.exit(0);
})().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
