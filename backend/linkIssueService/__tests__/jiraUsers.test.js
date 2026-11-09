const path = require('path');
const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { createTestPersona } = require('../../shared/test-utils/keycloakTestPersona');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// WP-143 — mapping Keycloak identities to Jira accounts, over HTTP against the
// real Jira. The resolvers that carry the degradation rule are unit-tested
// separately in jiraUserResolve.test.js.
//
// Skips LOUDLY without JIRA_* rather than passing vacuously.

const KONG_URL = process.env.TEST_KONG_URL || 'http://localhost:8000';
const U = '/api/v1/linkIssue/jira/users';
const CONN = '/api/v1/linkIssue/jira/connection';
const runId = Date.now();

const JIRA = {
  baseUrl: process.env.JIRA_BASE_URL,
  accountEmail: process.env.JIRA_ACCOUNT_EMAIL,
  apiToken: process.env.JIRA_API_TOKEN,
  projectKey: (process.env.JIRA_PROJECT_KEYS || '').split(',')[0].trim()
};
const available = Boolean(JIRA.baseUrl && JIRA.accountEmail && JIRA.apiToken && JIRA.projectKey);

function decodeSub(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).sub;
}

describe('WP-143: map users to Jira accounts', () => {
  let admin;
  let client;
  let projectId;
  let projectMongoId;
  let selfSub;
  let jiraAccountId;

  beforeAll(async () => {
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('\n[WP-143] SUITE SKIPPED — JIRA_* not configured in backend/.env.\n[WP-143] Nothing below was verified.\n');
      return;
    }
    const token = await getServiceToken();
    selfSub = decodeSub(token);
    admin = axios.create({ baseURL: KONG_URL, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true });

    const org = await admin.post('/api/v1/organizations', { name: `wp143 org ${runId}`, key: `wp143-${runId}` });
    expect(org.status).toBe(201);
    trackOrganization(org.data.data._id);
    const proj = await admin.post('/api/v1/projects', {
      name: `wp143 project ${runId}`,
      key: `w143${String(runId).slice(-6)}`,
      organizationId: org.data.data._id
    });
    expect(proj.status).toBe(201);
    projectId = proj.data.data.id;
    projectMongoId = proj.data.data._id;
    trackProject(projectId);

    client = axios.create({
      baseURL: KONG_URL,
      headers: { Authorization: `Bearer ${token}`, 'X-Project-Id': String(projectId) },
      timeout: 40000,
      validateStatus: () => true
    });
  }, 150000);

  it('refuses to list candidates before a Jira connection exists', async () => {
    if (!available) return;
    const resp = await client.get(`${U}/candidates`);
    // 409, not 500: "no connection yet" is a state, and the message says
    // where to fix it.
    expect(resp.status).toBe(409);
    expect(String(resp.data.error)).toMatch(/no Jira connection yet/i);
    expect(String(resp.data.error)).toMatch(/jira\/connection/);
  }, 60000);

  describe('with a connection configured', () => {
    beforeAll(async () => {
      if (!available) return;
      const saved = await client.put(CONN, { ...JIRA, projectKeys: JIRA.projectKey });
      expect([200, 201]).toContain(saved.status);
    }, 90000);

    it('lists Jira accounts that can actually be ASSIGNED work on the project', async () => {
      if (!available) return;
      const resp = await client.get(`${U}/candidates`);
      expect(resp.status).toBe(200);
      expect(resp.data.count).toBeGreaterThan(0);
      const first = resp.data.data[0];
      // accountId is the identity Jira uses; a picker needs it, plus a name a
      // human recognises.
      expect(first.accountId).toBeTruthy();
      expect(first.displayName).toBeTruthy();
      expect(first.mappedTo).toBeNull();
      jiraAccountId = first.accountId;
    }, 90000);

    it('suggests mappings by email, and explains itself when it cannot', async () => {
      if (!available) return;
      const resp = await client.get(`${U}/suggest`);
      expect(resp.status).toBe(200);
      // Jira hides emailAddress on many sites by privacy setting, so the flag
      // matters more than the count: an empty result must be explicable
      // rather than read as "nobody matches".
      expect(typeof resp.data.emailMatchingAvailable).toBe('boolean');
      expect(Array.isArray(resp.data.unmatched)).toBe(true);
      if (!resp.data.emailMatchingAvailable) {
        expect(String(resp.data.note)).toMatch(/privacy setting/i);
      }
    }, 90000);

    it('refuses a Jira accountId that does not exist, before storing it', async () => {
      if (!available) return;
      // A typo'd accountId would otherwise save cleanly and surface much
      // later as an assignment that silently does nothing.
      const resp = await client.put(U, { keycloakSub: selfSub, jiraAccountId: '000000000000000000000000' });
      expect(resp.status).toBe(400);
      expect(String(resp.data.error)).toMatch(/No Jira account/i);
      // Says how to get a real one, and why email will not do.
      expect(String(resp.data.error)).toMatch(/candidates/);
      expect(String(resp.data.error)).toMatch(/accountId, not by email/i);
    }, 90000);

    it('requires both sides of the mapping', async () => {
      if (!available) return;
      expect((await client.put(U, { keycloakSub: selfSub })).status).toBe(400);
      expect((await client.put(U, { jiraAccountId: 'x' })).status).toBe(400);
    }, 60000);

    it('stores a mapping, capturing the Jira display name for rendering', async () => {
      if (!available) return;
      const resp = await client.put(U, { keycloakSub: selfSub, jiraAccountId });
      expect(resp.status).toBe(201);
      expect(resp.data.data.keycloakSub).toBe(selfSub);
      expect(resp.data.data.jiraAccountId).toBe(jiraAccountId);
      // Cached so a settings list renders without calling Jira per row.
      expect(resp.data.data.jiraDisplayName).toBeTruthy();
    }, 90000);

    it('is idempotent: re-mapping the same pair updates rather than duplicating', async () => {
      if (!available) return;
      const again = await client.put(U, { keycloakSub: selfSub, jiraAccountId });
      expect(again.status).toBe(200);
      const list = await client.get(U);
      expect(list.data.count).toBe(1);
    }, 90000);

    it('refuses to give one Jira account to a second person, so the reverse lookup stays unambiguous', async () => {
      if (!available) return;
      // WP-144 resolves BOTH ways. Two subs on one accountId would make the
      // reverse direction ambiguous, and an arbitrary answer there shows the
      // wrong colleague's name against a Jira issue.
      const resp = await client.put(U, { keycloakSub: `someone-else-${runId}`, jiraAccountId });
      expect(resp.status).toBe(409);
      expect(String(resp.data.error)).toMatch(/already mapped to another user/i);
      expect(String(resp.data.error)).toMatch(/resolves to exactly one/i);
    }, 90000);

    it('shows which candidates are already taken', async () => {
      if (!available) return;
      const resp = await client.get(`${U}/candidates`);
      const taken = resp.data.data.find((u) => u.accountId === jiraAccountId);
      // So a picker does not offer an account the uniqueness rule will refuse.
      expect(taken.mappedTo).toBe(selfSub);
    }, 90000);

    it('omits an already-mapped person from suggestions', async () => {
      if (!available) return;
      const resp = await client.get(`${U}/suggest`);
      expect(resp.data.data.map((s) => s.keycloakSub)).not.toContain(selfSub);
    }, 90000);

    it('deletes a mapping, and reports a second delete as not found', async () => {
      if (!available) return;
      expect((await client.delete(`${U}/${selfSub}`)).status).toBe(200);
      expect((await client.delete(`${U}/${selfSub}`)).status).toBe(404);
      expect((await client.get(U)).data.count).toBe(0);
    }, 90000);
  });

  describe('authorization', () => {
    it('needs manage_members: a contributor cannot read or write mappings', async () => {
      if (!available) return;
      const contributor = await createTestPersona('wp143-contrib');
      try {
        const added = await admin.post(`/api/v1/projects/${projectMongoId}/members`, {
          userId: contributor.sub,
          role: 'contributor'
        });
        expect(added.status).toBe(200);
        const cc = axios.create({
          baseURL: KONG_URL,
          headers: { Authorization: `Bearer ${await contributor.getToken()}`, 'X-Project-Id': String(projectId) },
          validateStatus: () => true
        });
        expect((await cc.get(U)).status).toBe(403);
        expect((await cc.put(U, { keycloakSub: 'x', jiraAccountId: 'y' })).status).toBe(403);
        expect((await cc.get(`${U}/candidates`)).status).toBe(403);
      } finally {
        await contributor.cleanup();
      }
    }, 150000);

    it('an outsider cannot read another project\'s mappings', async () => {
      if (!available) return;
      const outsider = await createTestPersona('wp143-outsider');
      try {
        const oc = axios.create({
          baseURL: KONG_URL,
          headers: { Authorization: `Bearer ${await outsider.getToken()}`, 'X-Project-Id': String(projectId) },
          validateStatus: () => true
        });
        expect((await oc.get(U)).status).toBe(403);
      } finally {
        await outsider.cleanup();
      }
    }, 120000);

    it('is rejected at the gateway without a token', async () => {
      if (!available) return;
      const anon = axios.create({ baseURL: KONG_URL, validateStatus: () => true });
      expect((await anon.get(U)).status).toBe(401);
    }, 60000);
  });
});

afterAll(() => {
  purgeTrackedFixtures();
});
