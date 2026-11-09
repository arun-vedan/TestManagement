const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');

// Regression test for the "creating a folder in the workbench tree fails"
// bug report. Black-box HTTP against the live container (same pattern as
// testRepoService's __tests__/api.test.js), because the failure only shows
// up on the real Mongoose validation path (Folder.create), not something a
// unit test against a mocked model would catch.
//
// The frontend (frontend/src/workbench/SourcePanel.tsx) sends the signed-in
// user's Keycloak `sub` claim as createdBy/updatedBy. A `sub` is a UUID
// string ("c16a3041-919f-482f-a027-0b18060aa536" shape), never a 24-hex-char
// Mongo ObjectId. Folder.js originally declared both fields as
// mongoose.Schema.Types.ObjectId, so every real folder-creation request cast
// -failed and the folder was never created. Every comparable model
// (requirementService/models/requirement.js, testRepoService/models/testrepo.js)
// stores the same value as a plain String -- this test locks folderService
// to that same shape.
//
// A real Keycloak service-account token is used for its `sub` claim, which
// is itself a UUID -- the same shape a human user's sub takes, and
// sufficient to trigger the cast failure this test guards against.

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';

describe('folder creation with a Keycloak-style UUID sub', () => {
  let client;
  let sub;
  const createdIds = [];

  beforeAll(async () => {
    const token = await getServiceToken();
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    sub = payload.sub;
    // A real Keycloak subject id is always a UUID, never a 24-hex Mongo
    // ObjectId -- fail loudly here rather than silently passing a
    // non-representative value if that ever stops being true.
    expect(sub).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    // WP-113: folderService is now project-scoped, so every route requires
    // X-Project-Id. This suite's folder belongs to the Default Project.
    client = axios.create({
      baseURL: BASE_URL,
      validateStatus: () => true,
      headers: { Authorization: `Bearer ${token}`, [PROJECT_ID_HEADER]: '1' }
    });
  });

  afterAll(async () => {
    for (const id of createdIds) {
      await client.delete(`/api/v1/folders/${id}`);
    }
  });

  it('succeeds and stores the UUID sub verbatim in createdBy/updatedBy', async () => {
    const resp = await client.post('/api/v1/folders', {
      createdBy: sub,
      updatedBy: sub,
      moduleId: 1,
      // Deliberately left in place, and now an assertion rather than an
      // accident. This suite has always sent a nonsense projectId here, and
      // before WP-113 folderService stored it verbatim -- Folder.create(
      // req.body) took the tenant straight from the client. That this line
      // never caused a problem is the clearest illustration of the hole
      // WP-113 closes.
      projectId: 999999,
      parentFolder: 0,
      folderName: `regression-folder-${Date.now()}`
    });

    expect(resp.status).toBe(201);
    expect(resp.data.success).toBe(true);
    expect(resp.data.data.createdBy).toBe(sub);
    expect(resp.data.data.updatedBy).toBe(sub);
    // WP-113: the forged body value is ignored; the stamp comes from the
    // verified X-Project-Id header.
    expect(resp.data.data.projectId).toBe(1);

    createdIds.push(resp.data.data._id);
  });
});
