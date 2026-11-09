#!/usr/bin/env node
// WP-101 -- Mongo credentials come from backend/.env, not from source.
const { mongoAuth } = require('../../shared/test-utils/mongoCredentials');
/**
 * WP-020 backfill: seed one default Organization + one default Project.
 *
 * GATED — see EXECUTION_LOG.md and the WP-020 dispatch brief. The human
 * owner's standing rule is "no data migration without a tested backup," and
 * a tested restore does not exist yet (WP-064 is building it concurrently).
 * This script therefore:
 *
 *   - Defaults to DRY RUN. It prints exactly what it would create, and
 *     against which real documents its numbers are grounded, but writes
 *     NOTHING.
 *   - Only writes if invoked with BOTH `--apply` and the environment
 *     variable WP020_BACKFILL_CONFIRM=yes-apply set. Missing either one is
 *     treated as a dry run. This script does not decide on its own that the
 *     gate is satisfied — that is an explicit orchestrator/human call.
 *   - Is purely additive even when applied: it creates one Organization
 *     document and one Project document in userService's own database
 *     (srckube-user). It does NOT modify, touch, or write to any other
 *     service's collection (folders, fields, issuestatus, comments, or any
 *     of testRepoService/requirementService/defectService/
 *     testPlanExecutionService, all outside this WP's scope).
 *
 * WP-020 discovery (see EXECUTION_LOG.md for the full account): the only
 * `projectId` values that exist anywhere in this deployment today are the
 * literal Number 1, in folders/fields/issuestatus (all real documents), and
 * null in comments (field present but never populated). There is no
 * existing "projects" collection anywhere to migrate from — the old
 * frontend project-CRUD UI (Pages/projects.tsx, createNewProject.tsx)
 * called routes (/api/v1/project, /api/v1/deployments, /api/v1/service,
 * /api/v1/ingress) that were never wired to any backend service or Kong
 * route. So "mapping existing projects onto Project docs" reduces to: seed
 * exactly one Project whose legacy-compatible numeric `id` is 1, matching
 * the value every existing projectId-bearing document already carries.
 *
 * Usage:
 *   node scripts/backfillOrgProject.js                # dry run (default)
 *   WP020_BACKFILL_CONFIRM=yes-apply node scripts/backfillOrgProject.js --apply
 *
 * Env vars (all optional, sensible local-dev defaults matching
 * backend/docker-compose.yml so this runs unmodified from the host):
 *   MONGO_URI            userService's own DB (default: srckube-user @ localhost:27017)
 *   FOLDER_MONGO_URI     folderService's DB, read-only survey only
 *   FIELDS_MONGO_URI     fieldsService's DB, read-only survey only
 *   ISSUESTATUS_MONGO_URI statusService's DB, read-only survey only
 *   COMMENTS_MONGO_URI   commentsService's DB, read-only survey only
 *   BACKFILL_CREATED_BY  createdBy value stamped on the seeded org/project
 *                        (default: 'system')
 */

const mongoose = require('mongoose');

const MONGO_AUTH = mongoAuth();
const MONGO_HOST = process.env.MONGO_HOST || 'localhost:27017';

const URIS = {
  user: process.env.MONGO_URI || `mongodb://${MONGO_AUTH}@${MONGO_HOST}/srckube-user?authSource=admin`,
  folder: process.env.FOLDER_MONGO_URI || `mongodb://${MONGO_AUTH}@${MONGO_HOST}/srckube-folder?authSource=admin`,
  fields: process.env.FIELDS_MONGO_URI || `mongodb://${MONGO_AUTH}@${MONGO_HOST}/srckube-fields?authSource=admin`,
  issuestatus: process.env.ISSUESTATUS_MONGO_URI || `mongodb://${MONGO_AUTH}@${MONGO_HOST}/srckube-issuestatus?authSource=admin`,
  comments: process.env.COMMENTS_MONGO_URI || `mongodb://${MONGO_AUTH}@${MONGO_HOST}/srckube-comments?authSource=admin`
};

const CREATED_BY = process.env.BACKFILL_CREATED_BY || 'system';
const DEFAULT_ORG = { name: 'Default Organization', key: 'default' };
const DEFAULT_PROJECT = { id: 1, name: 'Default Project', key: 'default' };

const APPLY = process.argv.includes('--apply') && process.env.WP020_BACKFILL_CONFIRM === 'yes-apply';
const REQUESTED_APPLY = process.argv.includes('--apply');

function openConnection(uri) {
  // Mongoose 5.7's createConnection() doesn't reliably expose .asPromise()
  // across all call shapes, so wait on the 'open'/'error' events directly —
  // works the same way regardless of exact mongoose 5.x patch version.
  const conn = mongoose.createConnection(uri, { useNewUrlParser: true, useUnifiedTopology: true });
  return new Promise((resolve, reject) => {
    conn.once('open', () => resolve(conn));
    conn.once('error', reject);
  });
}

async function surveyProjectIds(uri, dbLabel, collectionName) {
  const conn = await openConnection(uri);
  try {
    const coll = conn.db.collection(collectionName);
    const total = await coll.countDocuments({});
    const distinct = await coll.distinct('projectId');
    return { dbLabel, collectionName, total, distinctProjectIds: distinct };
  } catch (err) {
    return { dbLabel, collectionName, error: err.message };
  } finally {
    await conn.close();
  }
}

async function main() {
  console.log('='.repeat(78));
  console.log('WP-020 backfill: Default Organization + Default Project');
  console.log(`Mode: ${APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'}`);
  if (REQUESTED_APPLY && !APPLY) {
    console.log(
      "NOTE: --apply was passed but WP020_BACKFILL_CONFIRM != 'yes-apply', so this " +
      'is still running as a dry run. Both are required to write.'
    );
  }
  console.log('='.repeat(78));

  console.log('\n--- Survey: real projectId values in existing collections (read-only) ---');
  const surveys = await Promise.all([
    surveyProjectIds(URIS.folder, 'srckube-folder', 'folders'),
    surveyProjectIds(URIS.fields, 'srckube-fields', 'fields'),
    surveyProjectIds(URIS.issuestatus, 'srckube-issuestatus', 'staus'),
    surveyProjectIds(URIS.comments, 'srckube-comments', 'comments')
  ]);
  for (const s of surveys) {
    if (s.error) {
      console.log(`  ${s.dbLabel}.${s.collectionName}: ERROR (${s.error})`);
    } else {
      console.log(
        `  ${s.dbLabel}.${s.collectionName}: ${s.total} document(s), ` +
        `distinct projectId values = ${JSON.stringify(s.distinctProjectIds)}`
      );
    }
  }

  const userConn = await openConnection(URIS.user);
  try {
    const orgColl = userConn.db.collection('organizations');
    const projColl = userConn.db.collection('projects');

    const existingOrg = await orgColl.findOne({ key: DEFAULT_ORG.key });
    const existingProject = await projColl.findOne({ id: DEFAULT_PROJECT.id });

    console.log('\n--- Plan ---');
    if (existingOrg) {
      console.log(`  Organization key='${DEFAULT_ORG.key}' already exists (_id=${existingOrg._id}). Would SKIP creating it.`);
    } else {
      console.log(
        `  Would CREATE Organization: ${JSON.stringify({ ...DEFAULT_ORG, status: 'active', createdBy: CREATED_BY })}`
      );
    }

    if (existingProject) {
      console.log(`  Project id=${DEFAULT_PROJECT.id} already exists (_id=${existingProject._id}). Would SKIP creating it.`);
    } else {
      console.log(
        `  Would CREATE Project: ${JSON.stringify({
          ...DEFAULT_PROJECT,
          organizationId: existingOrg ? existingOrg._id : '<newly-created Organization _id>',
          status: 'active',
          createdBy: CREATED_BY,
          members: [{ userId: CREATED_BY, role: 'admin' }]
        })}`
      );
      console.log(
        `  Rationale: every existing projectId-bearing document surveyed above holds ` +
        `the literal value 1 (or null, for comments, which never populated it). This ` +
        `Project's legacy-compatible numeric id=1 preserves that convention for any ` +
        `future consumer that joins on it. No document in folders/fields/issuestatus/` +
        `comments is read again, modified, or written by this script beyond the ` +
        `read-only survey above.`
      );
    }

    console.log(
      '\n--- Scope of writes (when --apply + WP020_BACKFILL_CONFIRM=yes-apply) ---\n' +
      '  Writes ONLY to userService\'s own database (srckube-user): the ' +
      "'organizations' and 'projects' collections. Nothing else is touched."
    );

    if (!APPLY) {
      console.log('\nDRY RUN complete. No writes were made. Re-run with --apply and');
      console.log("WP020_BACKFILL_CONFIRM=yes-apply set to actually create these documents —");
      console.log('only do this after an explicit go-ahead per the WP-020 gating rule.');
      return;
    }

    console.log('\n--- Applying ---');
    let orgId = existingOrg ? existingOrg._id : null;
    if (!existingOrg) {
      const now = new Date();
      const insertResult = await orgColl.insertOne({
        ...DEFAULT_ORG,
        status: 'active',
        createdBy: CREATED_BY,
        createdAt: now,
        updatedAt: now
      });
      orgId = insertResult.insertedId;
      console.log(`  Created Organization _id=${orgId}`);
    }

    if (!existingProject) {
      const now = new Date();
      await projColl.insertOne({
        ...DEFAULT_PROJECT,
        organizationId: orgId,
        status: 'active',
        createdBy: CREATED_BY,
        members: [{ userId: CREATED_BY, role: 'admin', addedAt: now }],
        createdAt: now,
        updatedAt: now
      });
      console.log(`  Created Project id=${DEFAULT_PROJECT.id} under organizationId=${orgId}`);
    }

    console.log('\nApply complete.');
  } finally {
    await userConn.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Backfill script failed:', err);
    process.exit(1);
  });
