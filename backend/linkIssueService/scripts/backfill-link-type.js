// One-time backfill (Sprint 2.2, PB-05): explicitly writes linkType: 'relates-to'
// onto every existing link that predates typed links. Unlike Sprint 2.1's
// status backfill, there's no "wrong value written by old code" risk here —
// 'relates-to' is a safe universal default for any link that doesn't specify
// otherwise — but it still needs to be an explicit written value, not just a
// schema default, so a stored-field query (e.g. filtering by linkType) finds
// these documents; a schema default only affects hydration of missing
// fields at read time, not what Mongo can actually query against.
//
// Run with: node scripts/backfill-link-type.js [--dry-run]

require('colors');
require('dotenv').config({ path: './config/config.env' });
const connectDB = require('../config/db');
const LinkIssue = require('../models/linkIssue');

const DRY_RUN = process.argv.includes('--dry-run');

(async () => {
  await connectDB();

  const query = { linkType: { $exists: false } };
  const affected = await LinkIssue.collection.find(query).toArray();

  console.log(`Found ${affected.length} link(s) with no stored linkType field:`);
  affected.forEach((doc) => console.log(`  - ${doc.linkId} (${doc.sourceId} -> ${doc.destinationId})`));

  if (DRY_RUN) {
    console.log('\nDry run — no changes written. Re-run without --dry-run to apply.');
    process.exit(0);
  }

  if (affected.length === 0) {
    console.log('\nNothing to backfill.');
    process.exit(0);
  }

  const result = await LinkIssue.collection.updateMany(query, { $set: { linkType: 'relates-to' } });
  console.log(`\nBackfilled ${result.modifiedCount} document(s) to linkType: 'relates-to'.`);
  process.exit(0);
})().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
