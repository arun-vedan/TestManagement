const axios = require('axios');
const { execSync } = require('child_process');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { createTestPersona } = require('../../shared/test-utils/keycloakTestPersona');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');
// WP-101 -- Mongo credentials come from backend/.env, not from source.
const { mongoUri } = require('../../shared/test-utils/mongoCredentials');

// WP-F07a Task 1 -- Dataset CRUD, usage query, and delete guard.
//
// Follows this service's established black-box HTTP convention (see
// api.test.js/tenantIsolation.test.js/sharedStep.test.js): reached DIRECTLY
// against the running container (BASE_URL), bypassing Kong -- keycloak.
// protect() is bearerOnly and verifies the JWT itself, independent of Kong,
// so a direct call is exactly as strong a proof of the real auth chain as
// going through the gateway.
//
// Harness reused verbatim from the existing suites: getServiceToken() for
// the always-available service-account identity, X-Project-Id header for
// tenant scope, createTestPersona()/userService org+project setup for real
// distinct-role identities in the RBAC section.

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';
const USER_SERVICE_URL = process.env.TEST_USER_SERVICE_URL || 'http://localhost:8000';
const DEFAULT_PROJECT_ID = 1;
const runId = Date.now();

const withScope = (projectId) => ({ headers: { [PROJECT_ID_HEADER]: String(projectId) } });

// WP-F07a Task 2 -- createTestCase now rejects a cross-project datasetId
// at write time (controllers/testrepo.js's rejectInvalidDatasetBinding),
// so the cross-tenant reference this suite's "counts usage only within
// the caller's project" test needs can no longer be produced by calling
// the API -- that's the gap Task 2 closes. It can still exist from data
// that predates that check (or any future direct-write path), so this
// seeds it straight into Mongo instead, bypassing the service entirely.
// Reached only via `docker exec mongodb mongosh`, per this project's
// Mongo-access rule: never a host mongosh, never the MCP mongodb tools --
// both hit a stale look-alike DB on 127.0.0.1:27017, not this container's.
//
// `id`/`TestCaseId` are stamped server-side by TestRepoSchema's own
// pre('save') hook on every real write path; a raw insertOne bypasses
// that hook entirely, so both are supplied here by hand, unique per test
// run, to satisfy the collection's own unique indexes on those two paths.
const MONGO_URI = mongoUri('srckube-testrepo', 'localhost:27017');

function insertRawCrossProjectTestCase({ projectId, datasetId, summary }) {
  const uniqueId = Number(`9${runId}`);
  const testCaseId = `TC-CROSSREF-${runId}`;
  const script = `const res = db.testcaserepos.insertOne({ id: ${uniqueId}, TestCaseId: ${JSON.stringify(testCaseId)}, TestCaseSummary: ${JSON.stringify(summary)}, TestCaseDescription: "x", projectId: ${projectId}, datasetId: ObjectId(${JSON.stringify(datasetId)}), TestSteps: [], status: "draft", version: 1, tags: [] }); print(res.insertedId.toString());`;
  const out = execSync(
    `docker exec mongodb mongosh ${JSON.stringify(MONGO_URI)} --quiet --eval ${JSON.stringify(script)}`,
    { encoding: 'utf8' }
  );
  return out.trim();
}

function decodeJwtPayload(token) {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

// requireProjectScope()'s in-process project-list cache is global to the
// container (projectScope.js, PROJECT_SCOPE_CACHE_TTL_MS) -- same race
// tenantIsolation.test.js/sharedStep.test.js retry around: a membership
// change (new project, new member) can be momentarily invisible to a
// request that lands just after it.
async function withCacheRetry(fn, { retries = 8, delayMs = 400 } = {}) {
  let resp;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    resp = await fn();
    if (resp.status !== 403) return resp;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return resp;
}

describe('Dataset CRUD, usage, and delete guard (WP-F07a Task 1)', () => {
  let client; // authed (service account), no default project header
  let userServiceClient;
  let sub;

  // Project B -- fresh org+project, used for the cross-project tests.
  let projectBId;
  let projectBMongoId;
  let orgBId;

  const createdDatasetIds = []; // project 1
  const createdTestCaseIds = []; // project 1
  const createdDatasetIdsB = []; // project B
  const createdTestCaseIdsB = []; // project B

  beforeAll(async () => {
    const token = await getServiceToken();
    sub = decodeJwtPayload(token).sub;

    client = axios.create({
      baseURL: BASE_URL,
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true
    });
    userServiceClient = axios.create({
      baseURL: USER_SERVICE_URL,
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true
    });

    // Ensure this identity is a member of Project A (Default, id=1) --
    // same defensive step tenantIsolation.test.js/sharedStep.test.js take;
    // membership isn't otherwise guaranteed for the service account in
    // every environment.
    const listResp = await userServiceClient.get('/api/v1/projects');
    expect(listResp.status).toBe(200);
    const projectA = listResp.data.data.find((p) => p.id === DEFAULT_PROJECT_ID);
    expect(projectA).toBeDefined();
    await userServiceClient.post(`/api/v1/projects/${projectA._id}/members`, { userId: sub, role: 'admin' });

    // Create Project B (this identity is auto-added as admin creator).
    const orgResp = await userServiceClient.post('/api/v1/organizations', {
      name: `WP-F07a dataset org B ${runId}`,
      key: `wpf07a-ds-org-b-${runId}`
    });
    expect(orgResp.status).toBe(201);
    orgBId = orgResp.data.data._id;
    trackOrganization(orgBId);

    const projResp = await userServiceClient.post('/api/v1/projects', {
      name: `WP-F07a dataset project B ${runId}`,
      key: `wpf07a-ds-proj-b-${runId}`,
      organizationId: orgBId
    });
    expect(projResp.status).toBe(201);
    projectBId = projResp.data.data.id;
    trackProject(projectBId);
    projectBMongoId = projResp.data.data._id;
    trackProject(projectBMongoId);
    expect(projectBId).not.toBe(DEFAULT_PROJECT_ID);
  }, 30000);

  afterAll(async () => {
    // Test cases first, THEN datasets -- a dataset still referenced by a
    // test case is refused by the delete guard (by design), so deleting
    // the referencing test case first is required for this cleanup to
    // actually succeed rather than silently no-op on a 409.
    for (const id of createdTestCaseIds) {
      // eslint-disable-next-line no-await-in-loop
      await client.delete(`/api/v1/testrepo/${id}`, withScope(DEFAULT_PROJECT_ID)).catch(() => {});
    }
    for (const id of createdTestCaseIdsB) {
      // eslint-disable-next-line no-await-in-loop
      await client.delete(`/api/v1/testrepo/${id}`, withScope(projectBId)).catch(() => {});
    }
    for (const id of createdDatasetIds) {
      // eslint-disable-next-line no-await-in-loop
      await client.delete(`/api/v1/dataset/${id}`, withScope(DEFAULT_PROJECT_ID)).catch(() => {});
    }
    for (const id of createdDatasetIdsB) {
      // eslint-disable-next-line no-await-in-loop
      await client.delete(`/api/v1/dataset/${id}`, withScope(projectBId)).catch(() => {});
    }
    if (projectBMongoId) {
      await userServiceClient.delete(`/api/v1/projects/${projectBMongoId}`);
    }
    if (orgBId) {
      await userServiceClient.delete(`/api/v1/organizations/${orgBId}`);
    }
  }, 30000);

  describe('Dataset CRUD', () => {
    it("creates a dataset with a server-generated DS- id and the caller's projectId", async () => {
      const res = await withCacheRetry(() => client.post(
        '/api/v1/dataset',
        { title: `WP-F07a users ${runId}`, columns: ['username', 'role'], rows: [['alice', 'admin'], ['bob', 'viewer']] },
        withScope(DEFAULT_PROJECT_ID)
      ));
      expect(res.status).toBe(201);
      createdDatasetIds.push(res.data.data._id);
      expect(res.data.data.DatasetId).toMatch(/^DS-\d+$/);
      expect(res.data.data.projectId).toBe(DEFAULT_PROJECT_ID);
    });

    it("ignores a projectId supplied in the create body", async () => {
      const res = await client.post(
        '/api/v1/dataset',
        { title: `WP-F07a spoof projectId ${runId}`, projectId: 999, columns: [], rows: [] },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(res.status).toBe(201);
      createdDatasetIds.push(res.data.data._id);
      expect(res.data.data.projectId).toBe(DEFAULT_PROJECT_ID);
    });

    it("rejects a create with no title", async () => {
      const res = await client.post(
        '/api/v1/dataset',
        { columns: [], rows: [] },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(res.status).toBe(400);
    });

    it("rejects a row whose length does not match columns.length", async () => {
      const res = await client.post(
        '/api/v1/dataset',
        {
          title: `WP-F07a ragged ${runId}`,
          columns: ['username', 'role'],
          // second row has 3 values against 2 columns
          rows: [['alice', 'admin'], ['bob', 'viewer', 'extra']]
        },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(res.status).toBe(400);
    });

    it("does not return another project's dataset (404 on GET /:id, absent from the list)", async () => {
      const created = await client.post(
        '/api/v1/dataset',
        { title: `WP-F07a project A only ${runId}`, columns: [], rows: [] },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(created.status).toBe(201);
      createdDatasetIds.push(created.data.data._id);
      const id = created.data.data._id;

      const crossRead = await withCacheRetry(() => client.get(`/api/v1/dataset/${id}`, withScope(projectBId)));
      expect(crossRead.status).toBe(404);

      const listB = await client.get('/api/v1/dataset', withScope(projectBId));
      expect(listB.status).toBe(200);
      expect(listB.data.data.some((s) => s._id === id)).toBe(false);
    });
  });

  describe('Dataset usage and delete guard', () => {
    it('reports zero usage for an unreferenced dataset', async () => {
      const created = await client.post(
        '/api/v1/dataset',
        { title: `WP-F07a unreferenced ${runId}`, columns: [], rows: [] },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(created.status).toBe(201);
      createdDatasetIds.push(created.data.data._id);

      const usage = await client.get(`/api/v1/dataset/${created.data.data._id}/usage`, withScope(DEFAULT_PROJECT_ID));
      expect(usage.status).toBe(200);
      expect(usage.data.data.count).toBe(0);
      expect(usage.data.data.testCases).toEqual([]);
    });

    it('reports the referencing test cases', async () => {
      const dataset = await client.post(
        '/api/v1/dataset',
        { title: `WP-F07a referenced ${runId}`, columns: ['username'], rows: [['alice']] },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(dataset.status).toBe(201);
      createdDatasetIds.push(dataset.data.data._id);
      const datasetId = dataset.data.data._id;

      const tc = await client.post(
        '/api/v1/testrepo',
        {
          TestCaseSummary: `WP-F07a refers to dataset ${runId}`,
          TestCaseDescription: 'x',
          datasetId
        },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(tc.status).toBe(201);
      createdTestCaseIds.push(tc.data.data._id);
      // Sanity: the reference actually persisted (would silently vanish if
      // Task 1's schema addition to TestRepoSchema were missing/wrong).
      expect(tc.data.data.datasetId).toBe(datasetId);

      const usage = await client.get(`/api/v1/dataset/${datasetId}/usage`, withScope(DEFAULT_PROJECT_ID));
      expect(usage.status).toBe(200);
      expect(usage.data.data.count).toBe(1);
      expect(usage.data.data.testCases[0].TestCaseId).toBe(tc.data.data.TestCaseId);
    });

    it('refuses to delete a dataset that is in use, with 409 and the usage payload', async () => {
      const dataset = await client.post(
        '/api/v1/dataset',
        { title: `WP-F07a delete-guard target ${runId}`, columns: [], rows: [] },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(dataset.status).toBe(201);
      createdDatasetIds.push(dataset.data.data._id);
      const datasetId = dataset.data.data._id;

      const tc = await client.post(
        '/api/v1/testrepo',
        {
          TestCaseSummary: `WP-F07a delete-guard referencer ${runId}`,
          TestCaseDescription: 'x',
          datasetId
        },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(tc.status).toBe(201);
      createdTestCaseIds.push(tc.data.data._id);

      const del = await client.delete(`/api/v1/dataset/${datasetId}`, withScope(DEFAULT_PROJECT_ID));
      expect(del.status).toBe(409);
      expect(del.data.success).toBe(false);
      expect(del.data.data.count).toBe(1);
      expect(del.data.data.testCases[0].TestCaseId).toBe(tc.data.data.TestCaseId);

      // and it genuinely was not deleted
      const stillThere = await client.get(`/api/v1/dataset/${datasetId}`, withScope(DEFAULT_PROJECT_ID));
      expect(stillThere.status).toBe(200);
    });

    it('deletes an unreferenced dataset', async () => {
      const dataset = await client.post(
        '/api/v1/dataset',
        { title: `WP-F07a deletable ${runId}`, columns: [], rows: [] },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(dataset.status).toBe(201);
      const datasetId = dataset.data.data._id;

      const del = await client.delete(`/api/v1/dataset/${datasetId}`, withScope(DEFAULT_PROJECT_ID));
      expect(del.status).toBe(200);
      expect(del.data.success).toBe(true);

      const read = await client.get(`/api/v1/dataset/${datasetId}`, withScope(DEFAULT_PROJECT_ID));
      expect(read.status).toBe(404);
      // Deleted for real -- don't track it in createdDatasetIds for
      // cleanup (that would just be a harmless 404 delete, but leaving it
      // out is clearer about what this test actually proved).
    });

    it("counts usage only within the caller's project", async () => {
      // Dataset lives in project 1 (A).
      const dataset = await client.post(
        '/api/v1/dataset',
        { title: `WP-F07a cross-project reference target ${runId}`, columns: ['x'], rows: [['secret']] },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(dataset.status).toBe(201);
      createdDatasetIds.push(dataset.data.data._id);
      const datasetId = dataset.data.data._id;

      // A test case in project B "references" A's dataset _id. This is a
      // cross-tenant reference that should never happen through the real
      // UI or, as of WP-F07a Task 2, the API at all (createTestCase now
      // refuses a cross-project datasetId) -- seeded directly in Mongo
      // instead (see insertRawCrossProjectTestCase's comment above). It's
      // exactly the shape that proves findUsage's projectId filter is
      // doing real work: without it, this row would be counted.
      const crossRefId = insertRawCrossProjectTestCase({
        projectId: projectBId,
        datasetId,
        summary: `WP-F07a project B cross-reference ${runId}`,
      });
      createdTestCaseIdsB.push(crossRefId);

      // Usage, scoped to project A: must NOT include project B's test case.
      const usage = await client.get(`/api/v1/dataset/${datasetId}/usage`, withScope(DEFAULT_PROJECT_ID));
      expect(usage.status).toBe(200);
      expect(usage.data.data.count).toBe(0);
      expect(usage.data.data.testCases).toEqual([]);

      // And the delete guard must not be blocked by it either. Deleting
      // the dataset here, before project B's referencing test case is
      // cleaned up in the top-level afterAll, is intentional and matches
      // this test's own point (a cross-project reference must not block
      // the owning project's delete) -- the referencing test case itself
      // is still cleaned up afterward, in the existing createdTestCaseIdsB
      // afterAll loop, and that loop already runs test-case deletes before
      // dataset deletes at the top level, so no fixture is left behind on
      // any path, including this one where the dataset is deleted
      // mid-test rather than in afterAll.
      const del = await client.delete(`/api/v1/dataset/${datasetId}`, withScope(DEFAULT_PROJECT_ID));
      expect(del.status).toBe(200);
    });
  });

  // Fix round 1 -- review found that DatasetSchema's rows validator never
  // actually runs on findOneAndUpdate for this nested-array path (confirmed
  // live: `this.getUpdate` is not a function there), so PUT had two live
  // bugs: a columns-only shrink left existing rows silently ragged (200,
  // no error), and a valid rows-only update was unconditionally rejected
  // (400, columnCount always resolved to 0). The fix is
  // DatasetSchema.pre('findOneAndUpdate') in models/Dataset.js, which loads
  // the stored {columns, rows}, overlays whatever the update supplies, and
  // rejects the MERGED result if ragged. These five cases are exactly the
  // ones the fix round 1 instruction enumerated: three that must reject,
  // two that must succeed.
  describe('Dataset update (ragged-row guard on PUT, fix round 1)', () => {
    const createdUpdateDatasetIds = [];

    afterAll(async () => {
      for (const id of createdUpdateDatasetIds) {
        // eslint-disable-next-line no-await-in-loop
        await client.delete(`/api/v1/dataset/${id}`, withScope(DEFAULT_PROJECT_ID)).catch(() => {});
      }
    }, 30000);

    async function seedDataset(columns, rows) {
      const created = await client.post(
        '/api/v1/dataset',
        { title: `WP-F07a update-guard ${runId}-${createdUpdateDatasetIds.length}`, columns, rows },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(created.status).toBe(201);
      createdUpdateDatasetIds.push(created.data.data._id);
      return created.data.data._id;
    }

    it('accepts a rows-only update whose rows all match the existing columns', async () => {
      const id = await seedDataset(['a', 'b'], [['1', '2'], ['3', '4']]);

      const res = await client.put(
        `/api/v1/dataset/${id}`,
        { rows: [['5', '6'], ['7', '8'], ['9', '10']] },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(res.status).toBe(200);
      expect(res.data.data.rows).toEqual([['5', '6'], ['7', '8'], ['9', '10']]);
    });

    it('accepts a combined columns+rows update that is internally consistent', async () => {
      const id = await seedDataset(['a', 'b'], [['1', '2']]);

      const res = await client.put(
        `/api/v1/dataset/${id}`,
        { columns: ['x', 'y', 'z'], rows: [['1', '2', '3']] },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(res.status).toBe(200);
      expect(res.data.data.columns).toEqual(['x', 'y', 'z']);
      expect(res.data.data.rows).toEqual([['1', '2', '3']]);
    });

    it('rejects a rows-only update whose new rows disagree with the STORED columns', async () => {
      const id = await seedDataset(['a', 'b'], [['1', '2']]);

      const res = await client.put(
        `/api/v1/dataset/${id}`,
        { rows: [['1', '2', '3']] }, // 3 values against 2 stored columns
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(res.status).toBe(400);

      // and the stored document is genuinely untouched
      const read = await client.get(`/api/v1/dataset/${id}`, withScope(DEFAULT_PROJECT_ID));
      expect(read.data.data.rows).toEqual([['1', '2']]);
    });

    it('rejects a columns-only update that shrinks columns out from under the STORED rows', async () => {
      const id = await seedDataset(['a', 'b', 'c'], [['1', '2', '3']]);

      const res = await client.put(
        `/api/v1/dataset/${id}`,
        { columns: ['a'] }, // stored rows still have 3 values each
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(res.status).toBe(400);

      const read = await client.get(`/api/v1/dataset/${id}`, withScope(DEFAULT_PROJECT_ID));
      expect(read.data.data.columns).toEqual(['a', 'b', 'c']);
      expect(read.data.data.rows).toEqual([['1', '2', '3']]);
    });

    it('rejects a combined columns+rows update where the two disagree with each other', async () => {
      const id = await seedDataset(['a', 'b'], [['1', '2']]);

      const res = await client.put(
        `/api/v1/dataset/${id}`,
        { columns: ['x', 'y'], rows: [['1', '2', '3']] }, // 3 values against 2 new columns
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(res.status).toBe(400);

      const read = await client.get(`/api/v1/dataset/${id}`, withScope(DEFAULT_PROJECT_ID));
      expect(read.data.data.columns).toEqual(['a', 'b']);
      expect(read.data.data.rows).toEqual([['1', '2']]);
    });
  });

  // WP-F07b Task 2 fix round 1 (review, Important) -- `rows` had no
  // maximum anywhere: enrichment issues one sequential HTTP round trip
  // AND creates one execution subdocument per row, so an unbounded
  // dataset is a real availability risk, not just a storage one. See
  // models/Dataset.js's MAX_DATASET_ROWS comment for why 100 was chosen.
  describe('Dataset row-count cap (fix round 1)', () => {
    const MAX_DATASET_ROWS = 100; // must match models/Dataset.js

    function makeRows(count) {
      return Array.from({ length: count }, (_, i) => [String(i)]);
    }

    it('accepts a dataset with exactly the maximum number of rows', async () => {
      const res = await client.post(
        '/api/v1/dataset',
        { title: `WP-F07b cap boundary ${runId}`, columns: ['n'], rows: makeRows(MAX_DATASET_ROWS) },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(res.status).toBe(201);
      createdDatasetIds.push(res.data.data._id);
      expect(res.data.data.rows).toHaveLength(MAX_DATASET_ROWS);
    });

    it('rejects creating a dataset one row over the maximum, with a clear message', async () => {
      const res = await client.post(
        '/api/v1/dataset',
        { title: `WP-F07b cap over on create ${runId}`, columns: ['n'], rows: makeRows(MAX_DATASET_ROWS + 1) },
        withScope(DEFAULT_PROJECT_ID)
      );
      // Single-line break: removing the second `rows` validator (or its
      // `this instanceof mongoose.Document` guard reversed) would accept
      // this as 201 with 101 rows stored.
      expect(res.status).toBe(400);
      expect(res.data.error).toMatch(new RegExp(`cannot have more than ${MAX_DATASET_ROWS} rows`));
    });

    it('rejects a PUT that grows an existing dataset past the maximum, and leaves it unchanged', async () => {
      const seeded = await client.post(
        '/api/v1/dataset',
        { title: `WP-F07b cap over on update ${runId}`, columns: ['n'], rows: makeRows(5) },
        withScope(DEFAULT_PROJECT_ID)
      );
      expect(seeded.status).toBe(201);
      const id = seeded.data.data._id;
      createdDatasetIds.push(id);

      const res = await client.put(
        `/api/v1/dataset/${id}`,
        { rows: makeRows(MAX_DATASET_ROWS + 1) },
        withScope(DEFAULT_PROJECT_ID)
      );
      // Single-line break: dropping the cap check from
      // DatasetSchema.pre('findOneAndUpdate') (the create-time validator's
      // own `this instanceof mongoose.Document` guard skips every
      // update-time call, same as the pre-existing ragged-row guard) would
      // accept this and grow the stored dataset to 101 rows.
      expect(res.status).toBe(400);

      const read = await client.get(`/api/v1/dataset/${id}`, withScope(DEFAULT_PROJECT_ID));
      expect(read.data.data.rows).toHaveLength(5);
    });
  });

  describe('Dataset RBAC (viewer read-only, contributor no delete)', () => {
    let projectId;
    let projectMongoId;
    let orgId;
    const personas = {};
    const createdEntities = [];

    beforeAll(async () => {
      const orgResp = await userServiceClient.post('/api/v1/organizations', {
        name: `WP-F07a dataset rbac org ${runId}`,
        key: `wpf07a-ds-rbac-org-${runId}`
      });
      expect(orgResp.status).toBe(201);
      orgId = orgResp.data.data._id;
      trackOrganization(orgId);

      const projResp = await userServiceClient.post('/api/v1/projects', {
        name: `WP-F07a dataset rbac project ${runId}`,
        key: `wpf07a-ds-rbac-proj-${runId}`,
        organizationId: orgId
      });
      expect(projResp.status).toBe(201);
      projectId = projResp.data.data.id;
      trackProject(projectId);
      projectMongoId = projResp.data.data._id;
      trackProject(projectMongoId);

      for (const role of ['contributor', 'viewer']) {
        // eslint-disable-next-line no-await-in-loop
        const persona = await createTestPersona(role);
        // eslint-disable-next-line no-await-in-loop
        const addResp = await userServiceClient.post(`/api/v1/projects/${projectMongoId}/members`, {
          userId: persona.userId,
          role
        });
        expect(addResp.status).toBe(200);
        // eslint-disable-next-line no-await-in-loop
        const token = await persona.getToken();
        personas[role] = {
          persona,
          client: axios.create({ baseURL: BASE_URL, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true })
        };
      }
    }, 60000);

    afterAll(async () => {
      for (const id of createdEntities) {
        // eslint-disable-next-line no-await-in-loop
        await client.delete(`/api/v1/dataset/${id}`, withScope(projectId)).catch(() => {});
      }
      for (const role of Object.keys(personas)) {
        // eslint-disable-next-line no-await-in-loop
        await personas[role].persona.cleanup().catch(() => {});
      }
      if (projectMongoId) {
        await userServiceClient.delete(`/api/v1/projects/${projectMongoId}`);
      }
      if (orgId) {
        await userServiceClient.delete(`/api/v1/organizations/${orgId}`);
      }
    }, 30000);

    it('viewer can GET the list', async () => {
      const resp = await withCacheRetry(() => personas.viewer.client.get('/api/v1/dataset', withScope(projectId)));
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);
    });

    it('viewer gets 403 on POST', async () => {
      const resp = await personas.viewer.client.post(
        '/api/v1/dataset',
        { title: 'viewer should never create this', columns: [], rows: [] },
        withScope(projectId)
      );
      expect(resp.status).toBe(403);
    });

    it('viewer gets 403 on PUT', async () => {
      // Seed the target as the contributor (write-capable) so the PUT
      // attempt itself is the only thing under test.
      const seed = await personas.contributor.client.post(
        '/api/v1/dataset',
        { title: `WP-F07a rbac viewer-put target ${runId}`, columns: [], rows: [] },
        withScope(projectId)
      );
      expect(seed.status).toBe(201);
      createdEntities.push(seed.data.data._id);

      const resp = await personas.viewer.client.put(
        `/api/v1/dataset/${seed.data.data._id}`,
        { title: 'viewer should never update this' },
        withScope(projectId)
      );
      expect(resp.status).toBe(403);
    });

    it('viewer gets 403 on DELETE', async () => {
      const seed = await personas.contributor.client.post(
        '/api/v1/dataset',
        { title: `WP-F07a rbac viewer-delete target ${runId}`, columns: [], rows: [] },
        withScope(projectId)
      );
      expect(seed.status).toBe(201);
      createdEntities.push(seed.data.data._id);

      const resp = await personas.viewer.client.delete(`/api/v1/dataset/${seed.data.data._id}`, withScope(projectId));
      expect(resp.status).toBe(403);
    });

    it('contributor can POST (write, no delete)', async () => {
      const resp = await personas.contributor.client.post(
        '/api/v1/dataset',
        { title: `WP-F07a rbac contributor create ${runId}`, columns: [], rows: [] },
        withScope(projectId)
      );
      expect(resp.status).toBe(201);
      createdEntities.push(resp.data.data._id);
    });

    it('contributor gets 403 on DELETE', async () => {
      const seed = await personas.contributor.client.post(
        '/api/v1/dataset',
        { title: `WP-F07a rbac contributor-delete target ${runId}`, columns: [], rows: [] },
        withScope(projectId)
      );
      expect(seed.status).toBe(201);
      createdEntities.push(seed.data.data._id);

      const resp = await personas.contributor.client.delete(`/api/v1/dataset/${seed.data.data._id}`, withScope(projectId));
      expect(resp.status).toBe(403);
    });
  });
});

// Suite teardown (WP-110 follow-up) — declared as its own top-level afterAll
// ON PURPOSE, not inside the suite's existing one.
//
// Jest runs afterAll hooks outermost-last, so this fires AFTER the suite's own
// cleanup has finished. Order matters: an earlier attempt called this first,
// which hard-deleted the fixture project before the suite's own teardown tried
// to touch it -- that teardown then logged a warning after the test run had
// ended, and Jest failed the whole suite with "Cannot log after tests are
// done" even though every test passed.
//
// Why this is needed at all: DELETE /api/v1/projects only ARCHIVES (the
// deliberate WP-022 project-deletion-orphaning decision), while
// DELETE /api/v1/organizations hard-deletes. API-only teardown therefore left
// the project behind with its organization gone -- which is where this
// environment's 701 orphaned projects came from. See
// shared/test-utils/fixtureCleanup.js.
afterAll(() => {
  purgeTrackedFixtures();
});
