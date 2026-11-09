// One-time backfill (2026-08-24): explicitly writes status: 'approved' onto
// every requirement that predates Sprint 2.1's versioning work and has no
// status field stored at all. Must run BEFORE the schema's default changes
// from 'approved' to 'draft' — see the matching script/comment in
// testRepoService for the full reasoning.
//
// Run with: node scripts/backfill-approved-status.js [--dry-run]

require('colors');
require('dotenv').config({ path: './config/config.env' });
const connectDB = require('../config/db');
const Requirement = require('../models/requirement');

const DRY_RUN = process.argv.includes('--dry-run');

(async () => {
  await connectDB();

  const query = { status: { $exists: false } };
  const affected = await Requirement.collection.find(query).toArray();

  console.log(`Found ${affected.length} requirement(s) with no stored status field:`);
  affected.forEach((doc) => console.log(`  - ${doc.reqId} (_id: ${doc._id})`));

  if (DRY_RUN) {
    console.log('\nDry run — no changes written. Re-run without --dry-run to apply.');
    process.exit(0);
  }

  if (affected.length === 0) {
    console.log('\nNothing to backfill.');
    process.exit(0);
  }

  const result = await Requirement.collection.updateMany(query, { $set: { status: 'approved' } });
  console.log(`\nBackfilled ${result.modifiedCount} document(s) to status: 'approved'.`);
  process.exit(0);
})().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
