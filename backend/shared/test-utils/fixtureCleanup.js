const path = require('path');
const { execFileSync } = require('child_process');

// Test-only helper (WP-110 follow-up: suite teardown). Like getServiceToken.js
// this is dev/test tooling that runs on the host via `npx jest`, never runtime
// code that ships in a Docker image.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
//
// 21 suites create fixture projects (and organizations) through userService and
// never remove them. Measured: one full suite run leaves ~19 orphaned projects
// behind, and they accumulate — 703 projects had built up before WP-110's
// precursor pruned them, and the count was back to 74 within two days of
// verification runs. They also leak into the Default Project (a defect with
// Status=undefined appeared there, which is why reportingService's
// hand-verified figures keep rotting).
//
// This matters beyond tidiness: WP-111..118 are eight parallel packages that
// each require a tenant-isolation suite. Without teardown, each one adds its
// own layer of debris to the data those very suites assert against.
//
// WHY NOT JUST CALL DELETE /api/v1/projects/:id. Because it does not delete.
// Project deletion is a SOFT delete by deliberate design (userService/
// controllers/projects.js's deleteProject sets status:'archived' — the
// project-deletion-orphaning decision in EXECUTION_LOG.md's WP-022 entry, so
// a project's test data is never orphaned). API-based teardown would therefore
// swap a pile of active fixture projects for a pile of archived ones. Removing
// them needs direct database access.
//
// WHY `docker exec` AND NOT A MONGO CLIENT FROM THE HOST. This host runs TWO
// mongod instances: the container's (authenticated, what every service uses)
// and a native one bound to 127.0.0.1:27017 that accepts UNAUTHENTICATED
// connections and carries shadow copies of the srckube databases. Docker
// publishes the container on *:27017 while the native mongod holds 127.0.0.1
// specifically, so a host process connecting to `localhost` reaches the NATIVE
// instance — measured, not theorised. A teardown helper that did that would
// silently delete nothing and report success, which is worse than no teardown
// at all because it would look like it worked. Running through the container
// removes the ambiguity, and the guard below makes targeting the wrong
// instance impossible rather than merely unlikely.
// ---------------------------------------------------------------------------

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env.test') });

const CONTAINER = process.env.TEST_MONGO_CONTAINER || 'mongodb';

function credentials() {
  // WP-101 put the Mongo root credentials in backend/.env under accurate
  // names. MONGO_BACKUP_* is the same credential under an older, misleading
  // one; it stays in the chain so an existing .env and another session's
  // committed helpers keep working.
  const user = process.env.MONGO_ROOT_USER || process.env.MONGO_BACKUP_USER || process.env.MONGO_USER;
  const password =
    process.env.MONGO_ROOT_PASSWORD || process.env.MONGO_BACKUP_PASSWORD || process.env.MONGO_PASSWORD;
  if (!user || !password) {
    throw new Error(
      'fixtureCleanup needs Mongo credentials: set MONGO_ROOT_USER/MONGO_ROOT_PASSWORD ' +
        '(they already live in backend/.env, which this module loads) or MONGO_USER/MONGO_PASSWORD. ' +
        'Refusing to guess.'
    );
  }
  return { user, password };
}

// Every collection that carries a projectId, so a purged fixture project does
// not leave its contents behind pointing at a project that no longer exists.
// Built by scanning all srckube-* databases for the field, not from memory.
const DEPENDENTS = [
  ['srckube-ai', 'aiprojectsettings'],
  ['srckube-ai', 'aiinteractions'],
  ['srckube-comments', 'auditevents'],
  ['srckube-comments', 'comments'],
  ['srckube-defects', 'defects'],
  ['srckube-fields', 'savedviews'],
  ['srckube-fields', 'fields'],
  ['srckube-folder', 'folders'],
  // WP-114: added after moduleService's new isolation suite leaked two
  // modules. The list was built by scanning for a projectId field BEFORE
  // moduleService had one, so it could not have included this — a reminder
  // that each WP-111..118 package which ADDS a projectId must also add its
  // collection here, or its own suite becomes a new debris source.
  ['srckube-module', 'modules'],
  ['srckube-issuestatus', 'staus'],
  ['srckube-linkissue', 'linkissues'],
  ['srckube-notifications', 'notifications'],
  ['srckube-objectrepo', 'objectrepos'],
  ['srckube-release', 'releases'],
  ['srckube-release', 'environments'],
  ['srckube-reporting', 'reportcaches'],
  ['srckube-requirements', 'requirements'],
  ['srckube-testexecution', 'testexecutions'],
  ['srckube-testplan', 'testplans'],
  ['srckube-testrepo', 'testcaserepos'],
  ['srckube-testrepo', 'casetemplates'],
  ['srckube-testrepo', 'sharedsteps'],
  ['srckube-testrepo', 'datasets'],
  ['srckube-user', 'apikeys'],
  // WP-132: invitations carry a projectId. Added with the feature, per the
  // WP-114 note above -- a new projectId-bearing collection that is not
  // listed here turns its own test suite into a new debris source.
  ['srckube-user', 'invites'],
  // WP-142: a project's Jira connection, which holds its sealed API token.
  ['srckube-linkissue', 'jiraconnections'],
  // WP-143: per-project Keycloak-sub <-> Jira-accountId mappings.
  ['srckube-linkissue', 'jirausermappings']
];

// Module-level, which is per test FILE: Jest gives each test file its own
// module registry, so one suite's tracked ids never bleed into another's.
let trackedProjects = [];        // numeric Project.id
let trackedProjectOids = [];     // Mongo _id, for suites that only capture that
let trackedOrganizations = [];

const OID = /^[0-9a-f]{24}$/i;

/**
 * Record a fixture project for teardown. Accepts whichever identifier the
 * suite happens to have: the numeric Project.id, the Mongo _id, or the whole
 * created document.
 *
 * ACCEPTING BOTH IS NOT CONVENIENCE, IT IS A BUG FIX. The first version took
 * only the numeric id and did `Number(projectId)`. Several userService suites
 * capture `projResp.data.data._id` and never touch the numeric id at all, so
 * a 24-hex string arrived, became NaN, and was DROPPED WITHOUT A WORD -- the
 * suite looked wired, the teardown reported success, and five projects leaked
 * on every run. A silent no-op in a cleanup helper is worse than no helper,
 * because it also removes the pressure to notice. Hence the explicit throw
 * below rather than a quiet return.
 */
function trackProject(projectIdOrDoc) {
  if (projectIdOrDoc && typeof projectIdOrDoc === 'object') {
    if (projectIdOrDoc.id !== undefined) trackProject(projectIdOrDoc.id);
    if (projectIdOrDoc._id !== undefined) trackProject(projectIdOrDoc._id);
    return projectIdOrDoc;
  }

  const raw = String(projectIdOrDoc);
  if (OID.test(raw)) {
    if (!trackedProjectOids.includes(raw)) trackedProjectOids.push(raw);
    return projectIdOrDoc;
  }

  const numeric = Number(raw);
  if (Number.isInteger(numeric)) {
    if (!trackedProjects.includes(numeric)) trackedProjects.push(numeric);
    return projectIdOrDoc;
  }

  throw new Error(
    `trackProject() could not interpret ${JSON.stringify(projectIdOrDoc)} as a numeric Project.id ` +
      'or a Mongo _id. Refusing to drop it silently — pass the created project document instead.'
  );
}

/** Record a fixture organization (Mongo _id, or the created document). */
function trackOrganization(organizationIdOrDoc) {
  if (organizationIdOrDoc && typeof organizationIdOrDoc === 'object' && organizationIdOrDoc._id !== undefined) {
    return trackOrganization(organizationIdOrDoc._id);
  }
  const id = String(organizationIdOrDoc);
  if (!OID.test(id)) {
    throw new Error(
      `trackOrganization() could not interpret ${JSON.stringify(organizationIdOrDoc)} as a Mongo _id. ` +
        'Refusing to drop it silently.'
    );
  }
  if (!trackedOrganizations.includes(id)) {
    trackedOrganizations.push(id);
  }
  return organizationIdOrDoc;
}

function buildScript(projectIds, projectOids, orgIds) {
  // The instance guard is the same one the two data scripts use: require
  // databases only the container has, refuse ones only the native mongod has.
  return `
const MUST_HAVE = ['srckube-ai', 'srckube-release', 'srckube-reporting'];
const MUST_NOT_HAVE = ['codeshark', 'fauserdb', 'authdeputy'];
const present = db.adminCommand({ listDatabases: 1 }).databases.map(function (d) { return d.name; });
const missing = MUST_HAVE.filter(function (n) { return present.indexOf(n) === -1; });
const foreign = MUST_NOT_HAVE.filter(function (n) { return present.indexOf(n) !== -1; });
if (missing.length || foreign.length) {
  print('FIXTURE_CLEANUP_ABORT wrong mongod instance (missing=' + missing.join(',') + ' foreign=' + foreign.join(',') + ')');
  quit(1);
}

const projectOids = ${JSON.stringify(projectOids)}.map(function (s) { return ObjectId(s); });
const orgIds = ${JSON.stringify(orgIds)};
const dependents = ${JSON.stringify(DEPENDENTS)};
let removed = 0;

// Resolve any _id-only fixtures to their numeric ids, so dependent documents
// (which reference projectId, never _id) are removed too.
let projectIds = ${JSON.stringify(projectIds)};
if (projectOids.length) {
  db.getSiblingDB('srckube-user').projects
    .find({ _id: { $in: projectOids } }, { id: 1 })
    .forEach(function (p) {
      if (p.id !== undefined && projectIds.indexOf(p.id) === -1) { projectIds.push(p.id); }
    });
}

if (projectIds.length) {
  dependents.forEach(function (entry) {
    const target = db.getSiblingDB(entry[0]);
    if (target.getCollectionNames().indexOf(entry[1]) === -1) { return; }
    removed += target[entry[1]].deleteMany({ projectId: { $in: projectIds } }).deletedCount;
  });
  removed += db.getSiblingDB('srckube-user').projects.deleteMany({ id: { $in: projectIds } }).deletedCount;

  // WP-135: uploaded attachments. GridFS is the exception to the loop above,
  // twice over:
  //   1. tenancy lives at metadata.projectId, not at a top-level projectId
  //      (uploadService has no Mongoose model -- its storage IS the bucket,
  //      see uploadService/utils/upload.js), so the { projectId: ... } filter
  //      the dependents loop uses matches nothing here;
  //   2. a file is TWO documents -- the entry in filesBucket.files and its
  //      payload in filesBucket.chunks, joined by files_id. Deleting only the
  //      files entry leaves the bytes behind forever, invisible to every
  //      query that looks for them.
  // So it is handled explicitly. Found while adding upload-cap tests, which
  // would otherwise have left their own fixtures in the bucket -- the same
  // trap the WP-114 note above records.
  const attachDb = db.getSiblingDB('srckube-attachments');
  if (attachDb.getCollectionNames().indexOf('filesBucket.files') !== -1) {
    const doomed = attachDb['filesBucket.files']
      .find({ 'metadata.projectId': { $in: projectIds } }, { _id: 1 })
      .toArray()
      .map(function (f) { return f._id; });
    if (doomed.length) {
      if (attachDb.getCollectionNames().indexOf('filesBucket.chunks') !== -1) {
        removed += attachDb['filesBucket.chunks'].deleteMany({ files_id: { $in: doomed } }).deletedCount;
      }
      removed += attachDb['filesBucket.files'].deleteMany({ _id: { $in: doomed } }).deletedCount;
    }
  }
}

if (projectOids.length) {
  removed += db.getSiblingDB('srckube-user').projects.deleteMany({ _id: { $in: projectOids } }).deletedCount;
}

if (orgIds.length) {
  const oids = orgIds.map(function (s) { return ObjectId(s); });
  removed += db.getSiblingDB('srckube-user').organizations.deleteMany({ _id: { $in: oids } }).deletedCount;
}

print('FIXTURE_CLEANUP_OK removed=' + removed);
`;
}

/**
 * Hard-delete every fixture tracked by this test file, plus any document in
 * another service that belonged to one of those projects.
 *
 * Deliberately NEVER THROWS. Teardown that fails a green suite is worse than
 * teardown that leaves debris: it would turn a passing run red for a reason
 * unrelated to the code under test, which is exactly the kind of false signal
 * this repo's operational warnings exist to prevent. Failures are reported on
 * stderr and the suite's own result stands.
 *
 * @returns {{ removed: number, ok: boolean, reason?: string }}
 */
function purgeTrackedFixtures() {
  const projectIds = trackedProjects.slice();
  const projectOids = trackedProjectOids.slice();
  const orgIds = trackedOrganizations.slice();
  trackedProjects = [];
  trackedProjectOids = [];
  trackedOrganizations = [];

  if (projectIds.length === 0 && projectOids.length === 0 && orgIds.length === 0) {
    return { removed: 0, ok: true };
  }

  let out;
  try {
    const { user, password } = credentials();
    const uri = `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(password)}@localhost:27017/?authSource=admin`;
    out = execFileSync(
      'docker',
      ['exec', '-i', CONTAINER, 'mongosh', uri, '--quiet', '--file', '/dev/stdin'],
      { input: buildScript(projectIds, projectOids, orgIds), encoding: 'utf8', timeout: 60000 }
    );
  } catch (err) {
    const reason = (err.stdout || '') + (err.stderr || '') || err.message;
    process.stderr.write(`\n[fixtureCleanup] teardown failed, leaving fixtures behind: ${String(reason).trim()}\n`);
    return { removed: 0, ok: false, reason: String(reason).trim() };
  }

  if (!/FIXTURE_CLEANUP_OK/.test(out)) {
    process.stderr.write(`\n[fixtureCleanup] teardown did not confirm success: ${out.trim()}\n`);
    return { removed: 0, ok: false, reason: out.trim() };
  }

  const match = out.match(/removed=(\d+)/);
  return { removed: match ? Number(match[1]) : 0, ok: true };
}

/** Test-only: inspect what is currently tracked. */
function _tracked() {
  return {
    projects: trackedProjects.slice(),
    projectOids: trackedProjectOids.slice(),
    organizations: trackedOrganizations.slice()
  };
}

module.exports = {
  trackProject,
  trackOrganization,
  purgeTrackedFixtures,
  _tracked,
  DEPENDENTS
};
