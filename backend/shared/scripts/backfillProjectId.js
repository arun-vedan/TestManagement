#!/usr/bin/env node
// WP-101 -- Mongo credentials come from backend/.env, not from source.
const { mongoAuth } = require('../test-utils/mongoCredentials');
/**
 * WP-021 backfill: stamp `projectId: 1` (the Default Project's
 * legacy-compatible numeric id, seeded by WP-020's backfillOrgProject.js)
 * onto every existing testRepoService/requirementService/defectService
 * document that doesn't already carry a projectId.
 *
 * WP-021b (this WP) extends the SAME script/mechanism to
 * testPlanExecutionService's two collections (testplans, testexecutions) --
 * WP-021's rollout stopped at three services ("the rest in later work");
 * TestPlan/TestExecution carried zero projectId concept right up until this
 * WP added the schema field (see ../../testPlanExecutionService/models/
 * TestPlan.js and TestExecution.js). Same strategy, same gating, same
 * idempotent-by-construction filter -- just two more targets in the same
 * TARGETS array below, sharing WP021_BACKFILL_CONFIRM (not a new env var:
 * this is the identical migration shape, run at the same time, and
 * inventing a second confirmation variable for the same operation would
 * only add a footgun, not safety).
 *
 * WHY THIS EXISTS (see EXECUTION_LOG.md for the full account, re-derived
 * independently via `docker exec mongodb mongosh`, not assumed): these
 * five services/collections had ZERO projectId concept before their
 * respective WPs -- no model field, no controller/route reference, zero
 * documents carrying it. Adding requireProjectScope() + a required
 * `projectId` schema field to them is therefore INTRODUCING tenant scoping
 * from scratch, not preserving an existing semantic. Without this
 * backfill, every pre-existing test case / requirement / defect / test
 * plan / test execution would fail to match any {projectId: N} filter once
 * the scoped controllers ship, and become invisible through every route --
 * a total data blackout that looks like data loss.
 *
 * STRATEGY CHOSEN: backfill existing documents to the Default Project
 * (id=1), not a runtime "missing projectId == default project" fallback
 * baked permanently into every query. Reasons:
 *   - The affected data set is tiny (3-5 docs per collection at the time
 *     this was written) and the value to assign is unambiguous: every
 *     other projectId-bearing document in this deployment (folders/fields/
 *     issuestatus) already holds the literal 1, traced to the same
 *     hardcoded frontend value (folderStructure.tsx:148). Assigning
 *     anything else would be inventing a new, undocumented convention.
 *   - A real, persisted field is simpler and more auditable than an
 *     indefinite "treat absence as project 1" special case that every
 *     future query/index/migration would need to remember to replicate.
 *   - It composes with the required-field schema (models/*.js) shipped in
 *     the same WP: once backfilled, `projectId` really is present on every
 *     document, so `required: true` is truthful rather than aspirational.
 *
 * GATED, same pattern as backend/userService/scripts/backfillOrgProject.js
 * (WP-020) and the WP-021 dispatch brief's DATA MIGRATION RULES:
 *   - Defaults to DRY RUN. Reports counts; writes nothing.
 *   - Writes only with BOTH `--apply` and env var
 *     WP021_BACKFILL_CONFIRM=yes-apply set.
 *   - Idempotent by construction: the update filter is
 *     `{ projectId: { $exists: false } }`, so a second run (apply or dry)
 *     matches zero documents and is a no-op -- safe to re-run.
 *   - Additive only: sets one new field on existing documents. Never
 *     deletes, renames, or reshapes anything else. Touches only the three
 *     collections named below -- no other service's database.
 *
 * ROLLBACK: this script's only write is `$set: { projectId: 1 }` on
 * documents that previously had no projectId field at all, so the
 * mechanical rollback is `$unset: { projectId: '' }` on the same filter's
 * complement (docs where projectId === 1 AND you know they were touched by
 * this run) -- but the authoritative rollback is restoring from the
 * pre-migration backup (see BACKUP_PATH recorded in EXECUTION_LOG.md),
 * taken via ./scripts/mongo-backup.sh immediately before this script's
 * --apply run, per the WP-021 DATA MIGRATION RULES.
 *
 * REPRODUCIBILITY NOTE (WP-020's footgun, avoided here by running from the
 * host, not from inside a container): this script is invoked as
 * `node backend/shared/scripts/backfillProjectId.js` directly against the
 * published Mongo port (27017 by default), matching how
 * backfillOrgProject.js is run. It is NOT copied into any service's Docker
 * image and is not meant to be `docker exec`'d.
 *
 * Usage:
 *   node backend/shared/scripts/backfillProjectId.js                # dry run (default)
 *   WP021_BACKFILL_CONFIRM=yes-apply node backend/shared/scripts/backfillProjectId.js --apply
 *
 * Env vars (optional, sensible local-dev defaults matching
 * backend/docker-compose.yml so this runs unmodified from the host):
 *   MONGO_HOST                 host:port for mongod (default: localhost:27017)
 *   TESTREPO_MONGO_URI         default: srckube-testrepo @ MONGO_HOST
 *   REQUIREMENTS_MONGO_URI     default: srckube-requirements @ MONGO_HOST
 *   DEFECTS_MONGO_URI          default: srckube-defects @ MONGO_HOST
 *   TESTPLAN_MONGO_URI         default: srckube-testplan @ MONGO_HOST (WP-021b)
 *   TESTEXECUTION_MONGO_URI    default: srckube-testexecution @ MONGO_HOST (WP-021b)
 *   BACKFILL_PROJECT_ID        default: 1 (the Default Project's numeric id)
 */

const mongoose = require('mongoose');

const MONGO_AUTH = mongoAuth();
const MONGO_HOST = process.env.MONGO_HOST || 'localhost:27017';

const TARGETS = [
  {
    label: 'testRepoService',
    uriEnv: 'TESTREPO_MONGO_URI',
    uri: process.env.TESTREPO_MONGO_URI || `mongodb://${MONGO_AUTH}@${MONGO_HOST}/srckube-testrepo?authSource=admin`,
    dbLabel: 'srckube-testrepo',
    collectionName: 'testcaserepos'
  },
  {
    label: 'requirementService',
    uriEnv: 'REQUIREMENTS_MONGO_URI',
    uri: process.env.REQUIREMENTS_MONGO_URI || `mongodb://${MONGO_AUTH}@${MONGO_HOST}/srckube-requirements?authSource=admin`,
    dbLabel: 'srckube-requirements',
    collectionName: 'requirements'
  },
  {
    label: 'defectService',
    uriEnv: 'DEFECTS_MONGO_URI',
    uri: process.env.DEFECTS_MONGO_URI || `mongodb://${MONGO_AUTH}@${MONGO_HOST}/srckube-defects?authSource=admin`,
    dbLabel: 'srckube-defects',
    collectionName: 'defects'
  },
  // WP-021b additions -- same script, same gating, two more targets.
  {
    label: 'testPlanExecutionService (plans)',
    uriEnv: 'TESTPLAN_MONGO_URI',
    uri: process.env.TESTPLAN_MONGO_URI || `mongodb://${MONGO_AUTH}@${MONGO_HOST}/srckube-testplan?authSource=admin`,
    dbLabel: 'srckube-testplan',
    collectionName: 'testplans'
  },
  {
    label: 'testPlanExecutionService (executions)',
    uriEnv: 'TESTEXECUTION_MONGO_URI',
    uri: process.env.TESTEXECUTION_MONGO_URI || `mongodb://${MONGO_AUTH}@${MONGO_HOST}/srckube-testexecution?authSource=admin`,
    dbLabel: 'srckube-testexecution',
    collectionName: 'testexecutions'
  }
];

const BACKFILL_PROJECT_ID = Number(process.env.BACKFILL_PROJECT_ID || 1);

const APPLY = process.argv.includes('--apply') && process.env.WP021_BACKFILL_CONFIRM === 'yes-apply';
const REQUESTED_APPLY = process.argv.includes('--apply');

function openConnection(uri) {
  // Mongoose 5.7's createConnection() doesn't reliably expose .asPromise()
  // across all call shapes (same note as backfillOrgProject.js) -- wait on
  // 'open'/'error' directly.
  const conn = mongoose.createConnection(uri, { useNewUrlParser: true, useUnifiedTopology: true });
  return new Promise((resolve, reject) => {
    conn.once('open', () => resolve(conn));
    conn.once('error', reject);
  });
}

async function processTarget(target) {
  const conn = await openConnection(target.uri);
  try {
    const coll = conn.db.collection(target.collectionName);
    const totalBefore = await coll.countDocuments({});
    const missingBefore = await coll.countDocuments({ projectId: { $exists: false } });
    const alreadySet = totalBefore - missingBefore;

    console.log(
      `\n--- ${target.label} (${target.dbLabel}.${target.collectionName}) ---\n` +
      `  total documents: ${totalBefore}\n` +
      `  already have projectId: ${alreadySet}\n` +
      `  missing projectId (would be set to ${BACKFILL_PROJECT_ID}): ${missingBefore}`
    );

    if (!APPLY) {
      return { ...target, totalBefore, missingBefore, matchedCount: 0, modifiedCount: 0, totalAfter: totalBefore, missingAfter: missingBefore };
    }

    if (missingBefore === 0) {
      console.log('  Nothing to apply (idempotent no-op).');
      return { ...target, totalBefore, missingBefore, matchedCount: 0, modifiedCount: 0, totalAfter: totalBefore, missingAfter: 0 };
    }

    const result = await coll.updateMany(
      { projectId: { $exists: false } },
      { $set: { projectId: BACKFILL_PROJECT_ID } }
    );

    const totalAfter = await coll.countDocuments({});
    const missingAfter = await coll.countDocuments({ projectId: { $exists: false } });

    console.log(
      `  APPLIED: matched=${result.matchedCount} modified=${result.modifiedCount}\n` +
      `  after: total=${totalAfter} missing=${missingAfter}`
    );

    return { ...target, totalBefore, missingBefore, matchedCount: result.matchedCount, modifiedCount: result.modifiedCount, totalAfter, missingAfter };
  } finally {
    await conn.close();
  }
}

async function main() {
  console.log('='.repeat(78));
  console.log('WP-021 backfill: projectId=1 (Default Project) on pre-existing documents');
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'}`);
  if (REQUESTED_APPLY && !APPLY) {
    console.log(
      "NOTE: --apply was passed but WP021_BACKFILL_CONFIRM != 'yes-apply', so this " +
      'is still running as a dry run. Both are required to write.'
    );
  }
  console.log(
    'Scope of writes: ONLY the five collections named below ' +
    '(testcaserepos, requirements, defects, testplans, testexecutions), field `projectId` only, ' +
    'and only on documents that currently have no projectId field at all.'
  );
  console.log('='.repeat(78));

  const results = [];
  for (const target of TARGETS) {
    // Sequential, not Promise.all: keeps the console output readable and
    // means a failure on one target doesn't leave concurrent writes
    // in-flight on the others.
    // eslint-disable-next-line no-await-in-loop
    results.push(await processTarget(target));
  }

  console.log('\n--- Summary ---');
  for (const r of results) {
    console.log(
      `  ${r.label}: before(total=${r.totalBefore}, missing=${r.missingBefore}) -> ` +
      `after(total=${r.totalAfter}, missing=${r.missingAfter})` +
      (APPLY ? ` [matched=${r.matchedCount} modified=${r.modifiedCount}]` : '')
    );
  }

  if (!APPLY) {
    console.log('\nDRY RUN complete. No writes were made. Re-run with --apply and');
    console.log("WP021_BACKFILL_CONFIRM=yes-apply set to actually write, only after a");
    console.log('fresh ./scripts/mongo-backup.sh backup, per the WP-021 DATA MIGRATION RULES.');
  } else {
    console.log('\nApply complete.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Backfill script failed:', err);
    process.exit(1);
  });
