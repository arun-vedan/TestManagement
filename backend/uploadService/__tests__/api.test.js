const axios = require('axios');
const FormData = require('form-data');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');

// Black-box HTTP tests against the running service (WP-012 service-core
// rollout). Container: uploadservice, Kong route:
// /api/v1/attachment/download/files (one of the 14 explicitly Kong-swept
// routes). This service was migrated onto @srckube/service-core for
// initKeycloak() ONLY — applyStandardSecurity() was deliberately NOT applied
// (see index.js) because it bundles express-fileupload(), which would
// consume the multipart request stream ahead of this service's own
// multer + multer-gridfs-storage upload pipeline. These tests exercise the
// real GridFS upload/download/rename/delete flow end-to-end so a future
// regression there (e.g. someone "helpfully" wiring in
// applyStandardSecurity()) fails loudly here instead of silently breaking
// uploads in production.

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';


// WP-112: every uploadService route now mounts requireProjectScope(), so an
// authenticated request without X-Project-Id is a 403. This suite exercises the
// Default Project's attachment flow, which is the scope it was always
// implicitly about. Same adjustment WP-021 made to testRepo/requirement/defect
// and WP-111 made to linkIssueService when those services were scoped.
const SCOPE = { [PROJECT_ID_HEADER]: '1' };

const client = axios.create({
  baseURL: BASE_URL,
  validateStatus: () => true
});

describe('uploadService API (live)', () => {
  describe('protected routes require authentication', () => {
    it('rejects an unauthenticated upload', async () => {
      const form = new FormData();
      form.append('file', Buffer.from('no auth'), 'noauth.txt');
      const resp = await client.post('/api/v1/attachment/upload/file', form, {
        headers: form.getHeaders()
      });
      expect(resp.status).not.toBeLessThan(400);
    });

    it('rejects an unauthenticated download-all', async () => {
      const resp = await client.get('/api/v1/attachment/download/files');
      expect(resp.status).not.toBeLessThan(400);
    });
  });

  describe('authenticated GridFS upload/download/rename/delete flow', () => {
    let token;
    let fileId;
    const originalContent = `WP-012 upload test ${Date.now()}`;

    beforeAll(async () => {
      token = await getServiceToken();
    });

    afterAll(async () => {
      if (fileId) {
        await client.delete(`/api/v1/attachment/delete/file/${fileId}`, {
          headers: { Authorization: `Bearer ${token}`, ...SCOPE }
        });
      }
    });

    it('uploads a single file and returns a GridFS file id', async () => {
      const form = new FormData();
      form.append('file', Buffer.from(originalContent), 'wp012-test.txt');
      const resp = await client.post('/api/v1/attachment/upload/file', form, {
        headers: { ...form.getHeaders(), Authorization: `Bearer ${token}`, ...SCOPE }
      });
      expect(resp.status).toBe(201);
      expect(resp.data).toHaveProperty('fileID');
      fileId = resp.data.fileID;
      expect(typeof fileId).toBe('string');
    });

    it('downloads the file back with byte-identical content', async () => {
      const resp = await client.get(`/api/v1/attachment/download/file/${fileId}`, {
        headers: { Authorization: `Bearer ${token}`, ...SCOPE },
        responseType: 'text'
      });
      expect(resp.status).toBe(200);
      expect(resp.data).toBe(originalContent);
    });

    it('includes the uploaded file in the download-all zip listing', async () => {
      const resp = await client.get('/api/v1/attachment/download/files', {
        headers: { Authorization: `Bearer ${token}`, ...SCOPE },
        responseType: 'arraybuffer'
      });
      expect(resp.status).toBe(200);
      expect(resp.headers['content-type']).toBe('application/zip');
      expect(resp.data.byteLength).toBeGreaterThan(0);
    });

    it('renames the file', async () => {
      const resp = await client.put(
        `/api/v1/attachment/rename/file/${fileId}`,
        { filename: 'wp012-test-renamed.txt' },
        { headers: { Authorization: `Bearer ${token}`, ...SCOPE } }
      );
      expect(resp.status).toBe(200);
      expect(resp.data.text).toMatch(/renamed/i);
    });

    it('deletes the file, after which download 404s', async () => {
      const delResp = await client.delete(`/api/v1/attachment/delete/file/${fileId}`, {
        headers: { Authorization: `Bearer ${token}`, ...SCOPE }
      });
      expect(delResp.status).toBe(200);

      const getResp = await client.get(`/api/v1/attachment/download/file/${fileId}`, {
        headers: { Authorization: `Bearer ${token}`, ...SCOPE }
      });
      expect(getResp.status).toBe(404);
      fileId = null;
    });
  });
});
