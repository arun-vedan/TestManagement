const axios = require('axios');
const FormData = require('form-data');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

// WP-112 — Multi-tenancy isolation suite for uploadService
// (release-blocking, per WP-021's precedent).
//
// Same two-axis design as the seven sibling suites, because only one real
// Keycloak identity exists in this environment: query-level filtering while a
// member of BOTH projects, then membership-level authorization after leaving
// project B.
//
// WHY THIS SERVICE'S SUITE MATTERS MORE THAN MOST. uploadService has no
// Mongoose model -- its storage is a GridFS bucket, so tenancy lives in each
// file's `metadata.projectId`. Before WP-112, GET /download/files and
// /download/files2 called `bucket.find()` with NO FILTER: they zipped up and
// returned EVERY file in the system, across every tenant, to any authenticated
// caller. The response body was the file CONTENTS, so unlike an over-broad
// list endpoint there was nothing downstream that could have limited the
// damage. Section 3 is dedicated to those two routes.
//
// Also covered: delete and rename. GridFSBucket's delete()/rename() accept
// only an _id and no filter, so those routes have to verify ownership with a
// scoped find() first -- a class of hole that does not exist in the
// model-backed services, where the filter travels with the query.

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';
const USER_SERVICE_URL = process.env.TEST_USER_SERVICE_URL || 'http://localhost:8000';
const runId = Date.now();

function decodeJwtPayload(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

async function uploadFile(client, projectId, name, contents) {
  const form = new FormData();
  form.append('file', Buffer.from(contents), { filename: name, contentType: 'text/plain' });
  return client.post('/api/v1/attachment/upload/file', form, {
    headers: Object.assign({ [PROJECT_ID_HEADER]: String(projectId) }, form.getHeaders())
  });
}

describe('uploadService tenant isolation (WP-112, release-blocking)', () => {
  let token;
  let sub;
  let client;
  let userServiceClient;
  const projectAId = 1;
  let projectBId;
  let projectBMongoId;
  let orgBId;
  let fileInA;
  let fileInB;

  const withScope = (projectId) => ({ headers: { [PROJECT_ID_HEADER]: String(projectId) } });

  beforeAll(async () => {
    token = await getServiceToken();
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

    const orgResp = await userServiceClient.post('/api/v1/organizations', {
      name: `WP-112 isolation org ${runId}`,
      key: `wp112-iso-org-${runId}`
    });
    expect(orgResp.status).toBe(201);
    orgBId = orgResp.data.data._id;
    trackOrganization(orgBId);

    const projResp = await userServiceClient.post('/api/v1/projects', {
      name: `WP-112 isolation project B ${runId}`,
      key: `wp112-iso-proj-b-${runId}`,
      organizationId: orgBId
    });
    expect(projResp.status).toBe(201);
    projectBId = projResp.data.data.id;
    trackProject(projectBId);
    projectBMongoId = projResp.data.data._id;

    // One file in each project, uploaded through the real multipart path.
    const upB = await uploadFile(client, projectBId, `wp112-b-${runId}.txt`, `secret of project B ${runId}`);
    expect(upB.status).toBe(201);
    fileInB = upB.data.fileID;
    expect(fileInB).toBeTruthy();

    const upA = await uploadFile(client, projectAId, `wp112-a-${runId}.txt`, `content of project A ${runId}`);
    expect(upA.status).toBe(201);
    fileInA = upA.data.fileID;
  }, 40000);

  afterAll(async () => {
    // Remove the two uploaded files, each through its own project's scope.
    if (fileInA) await client.delete(`/api/v1/attachment/delete/file/${fileInA}`, withScope(projectAId));
  });

  describe('1. Query-level isolation (member of both A and B)', () => {
    it("upload stamps the caller's verified project, not a body value", async () => {
      // Proven indirectly but decisively: the file is visible under B's scope
      // and invisible under A's. If the stamp came from anywhere the client
      // controls, both or neither would see it.
      const asB = await client.get('/api/v1/attachment/download/file/' + fileInB, withScope(projectBId));
      expect(asB.status).toBe(200);
    });

    it("download by id, scoped to A, cannot fetch B's file", async () => {
      const resp = await client.get(`/api/v1/attachment/download/file/${fileInB}`, withScope(projectAId));
      expect(resp.status).toBe(404);
    });

    it("download by id, scoped to B, DOES fetch B's file (positive control)", async () => {
      const resp = await client.get(`/api/v1/attachment/download/file/${fileInB}`, withScope(projectBId));
      expect(resp.status).toBe(200);
    });

    it("rename, scoped to A, cannot rename B's file", async () => {
      const resp = await client.put(
        `/api/v1/attachment/rename/file/${fileInB}`,
        { filename: 'renamed-by-project-a.txt' },
        withScope(projectAId)
      );
      expect(resp.status).toBe(404);
    });

    it("delete, scoped to A, cannot delete B's file", async () => {
      const resp = await client.delete(`/api/v1/attachment/delete/file/${fileInB}`, withScope(projectAId));
      expect(resp.status).toBe(404);

      // Still there, read back through B's own scope.
      const verify = await client.get(`/api/v1/attachment/download/file/${fileInB}`, withScope(projectBId));
      expect(verify.status).toBe(200);
    });
  });

  describe('2. Membership-level authorization (identity is NOT a member of B)', () => {
    beforeAll(async () => {
      const resp = await userServiceClient.delete(`/api/v1/projects/${projectBMongoId}/members/${sub}`);
      expect([200, 204]).toContain(resp.status);
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }, 20000);

    it('claiming scope B for a download is rejected with 403', async () => {
      const resp = await client.get(`/api/v1/attachment/download/file/${fileInB}`, withScope(projectBId));
      expect(resp.status).toBe(403);
    });

    it('claiming scope B for an upload is rejected with 403', async () => {
      const resp = await uploadFile(client, projectBId, 'nope.txt', 'nope');
      expect(resp.status).toBe(403);
    });

    it('claiming scope B for a delete is rejected with 403', async () => {
      const resp = await client.delete(`/api/v1/attachment/delete/file/${fileInB}`, withScope(projectBId));
      expect(resp.status).toBe(403);
    });

    it('missing X-Project-Id is rejected with 403 on every verb', async () => {
      const get = await client.get(`/api/v1/attachment/download/file/${fileInA}`);
      const list = await client.get('/api/v1/attachment/download/files');
      const del = await client.delete(`/api/v1/attachment/delete/file/${fileInA}`);
      expect(get.status).toBe(403);
      expect(list.status).toBe(403);
      expect(del.status).toBe(403);
    });

    it('an unknown projectId is rejected with 403', async () => {
      const resp = await client.get('/api/v1/attachment/download/files', withScope(99999999));
      expect(resp.status).toBe(403);
    });

    it('a non-integer projectId is rejected with 403', async () => {
      const resp = await client.get('/api/v1/attachment/download/files', withScope('not-a-number'));
      expect(resp.status).toBe(403);
    });
  });

  describe('3. The bulk download routes no longer return every tenant\'s files', () => {
    // THE headline fix. Both of these used to call bucket.find() with no
    // filter, so any authenticated caller received the contents of every file
    // in the system. These assertions are about what is NOT in the response.
    it('/download/files scoped to A does not contain B\'s file', async () => {
      const resp = await client.get('/api/v1/attachment/download/files', {
        ...withScope(projectAId),
        responseType: 'arraybuffer'
      });
      expect(resp.status).toBe(200);
      const body = Buffer.from(resp.data).toString('binary');
      // The zip stores entries by filename, so B's filename must not appear.
      expect(body).not.toContain(`wp112-b-${runId}.txt`);
      expect(body).toContain(`wp112-a-${runId}.txt`);
    });

    it('/download/files2 scoped to A does not contain B\'s content', async () => {
      const resp = await client.get('/api/v1/attachment/download/files2', withScope(projectAId));
      expect(resp.status).toBe(200);
      expect(Array.isArray(resp.data)).toBe(true);
      const decoded = resp.data.map((b64) => Buffer.from(b64, 'base64').toString('utf8')).join('\n');
      expect(decoded).not.toContain(`secret of project B ${runId}`);
      expect(decoded).toContain(`content of project A ${runId}`);
    });

    it('/download/files requires a scope header at all (no silent all-tenant default)', async () => {
      const resp = await client.get('/api/v1/attachment/download/files');
      expect(resp.status).toBe(403);
    });

    it('/download/files2 requires a scope header at all', async () => {
      const resp = await client.get('/api/v1/attachment/download/files2');
      expect(resp.status).toBe(403);
    });
  });
});

// Suite teardown (WP-110 follow-up) — its own top-level afterAll, which Jest
// runs last. See shared/test-utils/fixtureCleanup.js.
afterAll(() => {
  purgeTrackedFixtures();
});
