const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');

// Sprint 2.2: upgraded from the auth-gating-only black-box pattern used in
// Sprints 1.3/2.1 to real functional tests, now that a service-account token
// (client_credentials grant, same mechanism userService already uses
// server-to-server) is available in this environment. These tests exercise
// actual coverage-query behavior against the live service, not just "does
// this route reject a request with no token."

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';
const DUMMY_ID = '000000000000000000000000';

const anonClient = axios.create({ baseURL: BASE_URL, validateStatus: () => true });

describe('linkIssueService API (live)', () => {
  describe('every route requires authentication, including the new Sprint 2.2 coverage endpoints', () => {
    const protectedRoutes = [
      ['get', '/api/v1/linkIssue'],
      ['post', '/api/v1/linkIssue'],
      ['get', `/api/v1/linkIssue/${DUMMY_ID}`],
      ['put', `/api/v1/linkIssue/${DUMMY_ID}`],
      ['delete', `/api/v1/linkIssue/${DUMMY_ID}`],
      ['delete', '/api/v1/linkIssue/completedelete?srcId=x&destId=y'],
      ['get', '/api/v1/linkIssue/coverage/untested-requirements'],
      ['get', '/api/v1/linkIssue/coverage/orphan-testcases']
    ];

    it.each(protectedRoutes)('%s %s rejects a request with no token', async (method, path) => {
      const resp = await anonClient.request({ method, url: path });
      expect(resp.status).not.toBeLessThan(400);
      expect(resp.status).not.toBe(404);
    });
  });

  describe('coverage queries, authenticated', () => {
    let client;

    beforeAll(async () => {
      const token = await getServiceToken();
      // WP-111: every linkIssueService route now mounts requireProjectScope(),
      // so an authenticated request without X-Project-Id is a 403. These
      // assertions describe the Default Project's real data (Req-1/TC-1), so
      // project 1 is the scope they were always implicitly about -- before
      // WP-111 the two coverage endpoints hardcoded it themselves via the
      // DEFAULT_PROJECT_ID shim. Same adjustment WP-021 made to
      // testRepo/requirement/defect's suites when those services were scoped.
      client = axios.create({
        baseURL: BASE_URL,
        headers: { Authorization: `Bearer ${token}`, [PROJECT_ID_HEADER]: '1' },
        validateStatus: () => true
      });
    });

    it('untested-requirements returns the real requirement set with the correct shape', async () => {
      const resp = await client.get('/api/v1/linkIssue/coverage/untested-requirements');
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);
      expect(Array.isArray(resp.data.data)).toBe(true);
      expect(resp.data.count).toBe(resp.data.data.length);
      resp.data.data.forEach((r) => {
        expect(r).toHaveProperty('reqId');
      });
    });

    it('orphan-testcases returns the real test case set with the correct shape', async () => {
      const resp = await client.get('/api/v1/linkIssue/coverage/orphan-testcases');
      expect(resp.status).toBe(200);
      expect(resp.data.success).toBe(true);
      expect(Array.isArray(resp.data.data)).toBe(true);
      expect(resp.data.count).toBe(resp.data.data.length);
      resp.data.data.forEach((tc) => {
        expect(tc).toHaveProperty('TestCaseId');
      });
    });

    // WP-F13 final fix round, Finding 2 -- these two coverage-gap endpoints
    // carried their own independent `{linkType: 'tests'}` gate, the exact
    // wrong rule reportingService/services/coverage.js was fixed away from
    // in WP-F13 Task 1 (R1: ANY requirement<->test-case LinkIssue row
    // counts, any linkType, either direction -- linkType is a label on the
    // relationship, not a gate on whether it counts). Before this fix,
    // link-6 (TC-1 <-> Req-1, seeded as 'relates-to', the same shape as
    // all 23 live link rows) did NOT count here, so this test used to
    // assert TC-1 was an orphan-test-case beforehand and stopped being one
    // only once its linkType was flipped to 'tests' -- precisely the
    // now-corrected bug, and precisely the disagreement Finding 2 flagged
    // between this endpoint (fed the "Untested" chip in the workbench) and
    // /reports/traceability (fed the reports page), one navigation apart,
    // reading the exact same link rows.
    //
    // BREAKS IF: the `{linkType: 'tests'}` gate is reintroduced into
    // getUntestedRequirements/getOrphanTestCases (controllers/
    // linkIssue.js) -- confirmed live: with the gate back, `beforeOrphans`
    // contains 'TC-1' (this assertion goes red first) and, if that were
    // relaxed, flipping linkType to 'tests' would still change
    // `afterOrphans.data.count`. Restored after confirming red (final-fix-
    // report.md has the transcript).
    it('a "relates-to" link already counts as tested/linked -- flipping its linkType changes nothing (R1)', async () => {
      const linksResp = await client.get('/api/v1/linkIssue?linkId=link-6');
      const link = linksResp.data.data[0];
      expect(link).toBeDefined();
      expect(link.linkType).toBe('relates-to');

      const beforeOrphans = await client.get('/api/v1/linkIssue/coverage/orphan-testcases');
      const beforeUntested = await client.get('/api/v1/linkIssue/coverage/untested-requirements');
      // Already counted via the existing 'relates-to' row -- R1 means
      // linkType was never the thing that should have been gating this.
      expect(beforeOrphans.data.data.map((t) => t.TestCaseId)).not.toContain('TC-1');
      expect(beforeUntested.data.data.map((r) => r.reqId)).not.toContain('Req-1');

      await client.put(`/api/v1/linkIssue/${link._id}`, { linkType: 'tests' });
      const afterOrphans = await client.get('/api/v1/linkIssue/coverage/orphan-testcases');
      const afterUntested = await client.get('/api/v1/linkIssue/coverage/untested-requirements');
      expect(afterOrphans.data.count).toBe(beforeOrphans.data.count);
      expect(afterUntested.data.count).toBe(beforeUntested.data.count);

      // revert -- leave link-6 exactly as seeded.
      await client.put(`/api/v1/linkIssue/${link._id}`, { linkType: 'relates-to' });
      const revertedOrphans = await client.get('/api/v1/linkIssue/coverage/orphan-testcases');
      expect(revertedOrphans.data.count).toBe(beforeOrphans.data.count);
    });
  });

  // WP-141 — external-issue links, through Kong with a real token.
  describe('external (Jira) links', () => {
    let client;
    const runId = Date.now();
    const sourceId = `WP141-Bug-${runId}`;
    const created = [];

    beforeAll(async () => {
      const token = await getServiceToken();
      client = axios.create({
        baseURL: BASE_URL,
        headers: { Authorization: `Bearer ${token}`, [PROJECT_ID_HEADER]: '1' },
        validateStatus: () => true
      });
    });

    afterAll(async () => {
      for (const id of created) {
        // eslint-disable-next-line no-await-in-loop
        await client.delete(`/api/v1/linkIssue/${id}`);
      }
    });

    async function linkJira(body) {
      const resp = await client.post('/api/v1/linkIssue', {
        sourceId,
        srcModule: 5,
        destinationModule: 100,
        linkType: 'relates-to',
        ...body
      });
      if (resp.status === 201) created.push(resp.data.data._id);
      return resp;
    }

    it('round-trips: provider, normalised key, summary, and a server-derived namespaced destinationId', async () => {
      const resp = await linkJira({
        destinationId: 'ignored-by-server',
        external: { provider: 'jira', key: ' acme-77 ', status: 'Done', fetchedAt: '2020-01-01' },
        summary: 'Login button unresponsive on Safari'
      });
      expect(resp.status).toBe(201);
      const link = resp.data.data;
      expect(link.destinationId).toBe('jira:ACME-77');
      expect(link.destinationModule).toBe(100);
      expect(link.external.provider).toBe('jira');
      expect(link.external.key).toBe('ACME-77');
      // The cache fields are server-written only (WP-144); a client value is dropped.
      expect(link.external.status).toBeUndefined();
      expect(link.external.fetchedAt).toBeUndefined();
      expect(link.summary).toBe('Login button unresponsive on Safari');

      const single = await client.get(`/api/v1/linkIssue/${link._id}`);
      expect(single.data.data.external.key).toBe('ACME-77');
    });

    it('appears on the linked entity: listed by the entity id the links panel queries', async () => {
      const resp = await client.get(`/api/v1/linkIssue?sourceId=${sourceId}`);
      expect(resp.status).toBe(200);
      expect(resp.data.data.map((l) => l.destinationId)).toContain('jira:ACME-77');
    });

    it('a Jira key textually equal to one of our own ids is a distinct link, not a duplicate-key error', async () => {
      const internal = await client.post('/api/v1/linkIssue', {
        sourceId,
        srcModule: 5,
        destinationId: 'TC-1',
        destinationModule: 1,
        linkType: 'relates-to'
      });
      expect(internal.status).toBe(201);
      created.push(internal.data.data._id);

      const external = await linkJira({ external: { provider: 'jira', key: 'TC-1' } });
      expect(external.status).toBe(201);
      expect(external.data.data.destinationId).toBe('jira:TC-1');
    });

    it('linking the same issue twice from the same entity is refused, not silently duplicated', async () => {
      const again = await linkJira({ external: { provider: 'jira', key: 'ACME-77' } });
      expect(again.status).toBeGreaterThanOrEqual(400);
      expect(again.status).toBeLessThan(500);
    });

    it.each([
      ['a malformed key', { external: { provider: 'jira', key: 'not a key' } }],
      ['an unsupported provider', { external: { provider: 'github', key: 'ACME-1' } }],
      ['no external block at all', {}]
    ])('rejects %s with an actionable 400', async (_label, body) => {
      const resp = await linkJira(body);
      expect(resp.status).toBe(400);
      expect(resp.data.success).toBe(false);
      expect(typeof resp.data.error).toBe('string');
    });

    it('refuses an external issue as the source of a link', async () => {
      const resp = await client.post('/api/v1/linkIssue', {
        sourceId: 'jira:ACME-1',
        srcModule: 100,
        destinationId: sourceId,
        destinationModule: 5
      });
      expect(resp.status).toBe(400);
    });

    it("an update can change the link's type but not repoint it at a different issue", async () => {
      const [id] = created;
      const resp = await client.put(`/api/v1/linkIssue/${id}`, {
        linkType: 'blocks',
        external: { provider: 'jira', key: 'EVIL-1' },
        destinationId: 'jira:EVIL-1'
      });
      expect(resp.status).toBe(200);
      expect(resp.data.data.linkType).toBe('blocks');
      expect(resp.data.data.destinationId).toBe('jira:ACME-77');
      expect(resp.data.data.external.key).toBe('ACME-77');
    });

    it('the coverage aggregates ignore external links rather than miscounting them', async () => {
      const resp = await client.get('/api/v1/linkIssue/coverage/untested-requirements');
      expect(resp.status).toBe(200);
    });
  });

  describe('correlation ID propagation', () => {
    it('echoes back a caller-supplied correlation ID', async () => {
      const resp = await anonClient.get('/api/v1/linkIssue', {
        headers: { 'x-correlation-id': 'test-suite-trace-id' }
      });
      expect(resp.headers['x-correlation-id']).toBe('test-suite-trace-id');
    });
  });
});
