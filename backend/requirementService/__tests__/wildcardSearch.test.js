const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER, SEARCH_TERM_MAX_LENGTH } = require('@srckube/service-core');

// WP-104 — black-box tests for GET /api/v1/requirement/wildcardsearch.
//
// This route previously interpolated `req.query.search` straight into $regex
// with no escaping and no result cap. Each assertion below names the concrete
// behaviour that changed; the "before" values were measured against the live
// service and are recorded in EXECUTION_LOG.md's WP-104 entry.
//
// NOTE on what WP-104 did and did not fix: the brief framed this as a
// catastrophic-backtracking denial of service. That was measured on this
// deployment (MongoDB 6.0.28) and NOT reproduced — exponential patterns
// against 50 000-character subjects returned in <= 5 ms. So escaping here is a
// correctness fix (a search for "." must mean the character) plus defence in
// depth; the result cap is what closes the real resource-exhaustion path.

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';

describe('requirementService wildcardsearch (WP-104)', () => {
  let client;

  beforeAll(async () => {
    const token = await getServiceToken();
    client = axios.create({
      baseURL: BASE_URL,
      headers: { Authorization: `Bearer ${token}`, [PROJECT_ID_HEADER]: '1' },
      validateStatus: () => true
    });
  });

  describe('input validation — bad input is 400, never 500 and never unbounded', () => {
    it('a missing ?search= returns 400, not the 500 Mongo used to produce', async () => {
      // Before: HTTP 500, error "$regex has to be a string" — a server-fault
      // status for purely bad input.
      const resp = await client.get('/api/v1/requirement/wildcardsearch');
      expect(resp.status).toBe(400);
      expect(resp.data.success).toBe(false);
      expect(String(resp.data.error)).toMatch(/search term is required/i);
    });

    it('an empty ?search= returns 400 instead of every document in the project', async () => {
      // Before: HTTP 200 returning the project's entire matching set.
      const resp = await client.get('/api/v1/requirement/wildcardsearch', { params: { search: '' } });
      expect(resp.status).toBe(400);
      expect(String(resp.data.error)).toMatch(/search term is required/i);
    });

    it('a whitespace-only ?search= returns 400', async () => {
      const resp = await client.get('/api/v1/requirement/wildcardsearch', { params: { search: '   ' } });
      expect(resp.status).toBe(400);
    });

    it('a term longer than the cap returns 400 naming the limit', async () => {
      const resp = await client.get('/api/v1/requirement/wildcardsearch', {
        params: { search: 'a'.repeat(SEARCH_TERM_MAX_LENGTH + 1) }
      });
      expect(resp.status).toBe(400);
      expect(String(resp.data.error)).toMatch(new RegExp(String(SEARCH_TERM_MAX_LENGTH + 1)));
    });
  });

  describe('the search term is treated as literal text, not as a regex', () => {
    it('"." matches only a literal dot, not every document', async () => {
      // Before: "." matched every document in the project.
      const dot = await client.get('/api/v1/requirement/wildcardsearch', { params: { search: '.' } });
      expect(dot.status).toBe(200);

      const all = await client.get('/api/v1/requirement', { params: { limit: 1000 } });
      expect(all.status).toBe(200);
      const totalInProject = all.data.data.length;

      // The only way this could equal the whole project is if every document
      // genuinely contains a literal dot in a searched field.
      const withLiteralDot = all.data.data.filter(
        (d) => String(d.reqId || '').includes('.') || String(d.requirementSummary || '').includes('.')
      ).length;
      expect(dot.data.data.length).toBe(withLiteralDot);
      expect(dot.data.data.length).toBeLessThan(totalInProject);
    });

    it('".*" matches only a literal ".*" sequence (nothing, in this data)', async () => {
      // Before: ".*" returned the project's entire matching set.
      const resp = await client.get('/api/v1/requirement/wildcardsearch', { params: { search: '.*' } });
      expect(resp.status).toBe(200);
      resp.data.data.forEach((d) => {
        const hay = `${d.reqId || ''} ${d.requirementSummary || ''}`;
        expect(hay).toContain('.*');
      });
    });

    it('"^" does not anchor — it matches only a literal caret', async () => {
      // Before: "^" matched every document (empty match at position 0).
      const resp = await client.get('/api/v1/requirement/wildcardsearch', { params: { search: '^' } });
      expect(resp.status).toBe(200);
      resp.data.data.forEach((d) => {
        const hay = `${d.reqId || ''} ${d.requirementSummary || ''}`;
        expect(hay).toContain('^');
      });
    });

    it('a catastrophic-backtracking pattern is inert and fast', async () => {
      const t0 = Date.now();
      const resp = await client.get('/api/v1/requirement/wildcardsearch', { params: { search: '((a+)+)+b' } });
      const elapsedMs = Date.now() - t0;
      expect(resp.status).toBe(200);
      // Escaped, so it can only match that literal string — and returns inside
      // any sane latency budget.
      expect(resp.data.data.length).toBe(0);
      expect(elapsedMs).toBeLessThan(5000);
    });
  });

  describe('real searches still work and stay bounded', () => {
    it('a genuine partial id search returns matching documents, all project-scoped', async () => {
      const all = await client.get('/api/v1/requirement', { params: { limit: 1000 } });
      const sample = all.data.data.find((d) => d.reqId);
      if (!sample) return; // no seed data for this project; nothing to assert

      const resp = await client.get('/api/v1/requirement/wildcardsearch', {
        params: { search: sample.reqId }
      });
      expect(resp.status).toBe(200);
      expect(resp.data.data.length).toBeGreaterThan(0);
      expect(resp.data.data.map((d) => d.reqId)).toContain(sample.reqId);
      resp.data.data.forEach((d) => expect(d.projectId).toBe(1));
    });

    it('the prefix shared by this entity type\'s ids returns a bounded result set', async () => {
      const resp = await client.get('/api/v1/requirement/wildcardsearch', { params: { search: 'Req-' } });
      expect(resp.status).toBe(200);
      // Never unbounded: the route caps at WILDCARD_SEARCH_MAX_RESULTS
      // (default 100). Proven to cap live by temporarily setting it to 3 —
      // 12 matches, exactly 3 returned (see EXECUTION_LOG.md WP-104).
      expect(resp.data.data.length).toBeLessThanOrEqual(100);
    });

    it('search is case-insensitive, as before', async () => {
      const lower = await client.get('/api/v1/requirement/wildcardsearch', { params: { search: 'Req-'.toLowerCase() } });
      const upper = await client.get('/api/v1/requirement/wildcardsearch', { params: { search: 'Req-'.toUpperCase() } });
      expect(lower.status).toBe(200);
      expect(upper.status).toBe(200);
      expect(lower.data.data.length).toBe(upper.data.data.length);
    });
  });

  describe('auth gating is unchanged', () => {
    it('rejects an unauthenticated request', async () => {
      const anon = axios.create({ baseURL: BASE_URL, validateStatus: () => true });
      const resp = await anon.get('/api/v1/requirement/wildcardsearch', { params: { search: 'x' } });
      expect(resp.status).not.toBeLessThan(400);
      expect(resp.status).not.toBe(404);
    });
  });
});
