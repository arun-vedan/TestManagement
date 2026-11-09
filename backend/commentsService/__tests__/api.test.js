const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');

// Black-box HTTP tests against the running service (WP-012 service-core
// rollout). Container: commentsservice, Kong route: /api/v1/comments.
//
// NOTE ON A PRESERVED DEVIATION: middleware/advancedResults.js was
// deliberately NOT migrated to @srckube/service-core's shared version — it
// hardcodes req.query.status = 1, which enforces this service's soft-delete
// convention (deleteCommentById sets status: 0 rather than removing the
// document). The "soft-deleted comments are excluded from listings" test
// below exercises exactly that deviation, so a future accidental swap to the
// shared advancedResults would fail this suite immediately.

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';
const DUMMY_ID = '000000000000000000000000';

// WP-115: every commentsService route now mounts requireProjectScope(), so an
// authenticated request without X-Project-Id is a 403. This suite exercises the
// Default Project's comment flow. Same adjustment WP-021, WP-111, WP-112,
// WP-113 and WP-114 each made when their service was scoped.
const SCOPE = { [PROJECT_ID_HEADER]: '1' };

const client = axios.create({
  baseURL: BASE_URL,
  validateStatus: () => true
});

describe('commentsService API (live)', () => {
  describe('protected routes require authentication', () => {
    const protectedRoutes = [
      ['get', '/api/v1/comments'],
      ['post', '/api/v1/comments'],
      ['get', `/api/v1/comments/${DUMMY_ID}`],
      ['put', `/api/v1/comments/updateCommentsByParam?id=${DUMMY_ID}`],
      ['put', `/api/v1/comments/deleteCommentById?id=${DUMMY_ID}`]
    ];

    it.each(protectedRoutes)('%s %s rejects a request with no token', async (method, path) => {
      const resp = await client.request({ method, url: path });
      expect(resp.status).not.toBeLessThan(400);
      expect(resp.status).not.toBe(404);
    });
  });

  describe('authenticated CRUD + soft-delete flow', () => {
    let token;
    let createdId;

    const newComment = () => ({
      comments: `test comment ${Date.now()}`,
      moduleId: 1,
      typeId: 'defect'
    });

    beforeAll(async () => {
      token = await getServiceToken();
    });

    it('creates a comment, defaulting status to 1 and isEdited to 0', async () => {
      const payload = newComment();
      const resp = await client.post('/api/v1/comments', payload, {
        headers: { Authorization: `Bearer ${token}`, ...SCOPE }
      });
      expect(resp.status).toBe(201);
      expect(resp.data.success).toBe(true);
      expect(resp.data.data).toHaveProperty('_id');
      expect(resp.data.data.comments).toBe(payload.comments);
      expect(resp.data.data.status).toBe(1);
      expect(resp.data.data.isEdited).toBe(0);
      createdId = resp.data.data._id;
    });

    it('lists comments, filterable down to the one just created (status=1 by default)', async () => {
      const resp = await client.get(`/api/v1/comments?_id=${createdId}`, {
        headers: { Authorization: `Bearer ${token}`, ...SCOPE }
      });
      expect(resp.status).toBe(200);
      expect(resp.data.data).toHaveLength(1);
      expect(resp.data.data[0]._id).toBe(createdId);
    });

    it('fetches a single comment by id', async () => {
      const resp = await client.get(`/api/v1/comments/${createdId}`, {
        headers: { Authorization: `Bearer ${token}`, ...SCOPE }
      });
      expect(resp.status).toBe(200);
      expect(resp.data.data._id).toBe(createdId);
    });

    it('edits a comment via updateCommentsByParam, marking isEdited=1', async () => {
      const resp = await client.put(
        `/api/v1/comments/updateCommentsByParam?id=${createdId}`,
        { comments: 'edited comment text' },
        { headers: { Authorization: `Bearer ${token}`, ...SCOPE } }
      );
      expect(resp.status).toBe(200);
      expect(resp.data.data.comments).toBe('edited comment text');
      expect(resp.data.data.isEdited).toBe(1);
    });

    it('soft-deletes a comment (status -> 0) and it disappears from the default listing', async () => {
      const delResp = await client.put(
        `/api/v1/comments/deleteCommentById?id=${createdId}`,
        {},
        { headers: { Authorization: `Bearer ${token}`, ...SCOPE } }
      );
      expect(delResp.status).toBe(200);
      expect(delResp.data.success).toBe(true);

      // The document still exists (soft delete, not a real delete)...
      const getResp = await client.get(`/api/v1/comments/${createdId}`, {
        headers: { Authorization: `Bearer ${token}`, ...SCOPE }
      });
      expect(getResp.data.data.status).toBe(0);

      // ...but the advancedResults listing's hardcoded status=1 filter
      // excludes it, even when explicitly filtered by _id.
      const listResp = await client.get(`/api/v1/comments?_id=${createdId}`, {
        headers: { Authorization: `Bearer ${token}`, ...SCOPE }
      });
      expect(listResp.data.data).toHaveLength(0);
    });
  });
});
