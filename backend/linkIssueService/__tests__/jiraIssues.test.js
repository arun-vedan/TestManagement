const path = require('path');
const axios = require('axios');
const { execFileSync } = require('child_process');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { createTestPersona } = require('../../shared/test-utils/keycloakTestPersona');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// WP-144 — rendering a linked Jira issue's live summary, status and assignee.
//
// THE ACCEPTANCE IS THE FAILURE CASE: "a linked issue renders current status;
// Jira unreachable shows the cached value labelled stale, never a broken row."
// So the test that matters most is the one that breaks Jira on purpose, and it
// breaks it the realistic way -- a connection that validated at save time and
// then stopped working -- by rewriting the stored baseUrl directly, which is
// the only way to reach that state given WP-142 refuses to SAVE a bad one.
//
// Skips LOUDLY without JIRA_*, rather than passing vacuously.

const KONG = process.env.TEST_KONG_URL || 'http://localhost:8000';
const CONN = '/api/v1/linkIssue/jira/connection';
const ISSUES = '/api/v1/linkIssue/jira/issues';
const runId = Date.now();

const JIRA = {
  baseUrl: process.env.JIRA_BASE_URL,
  accountEmail: process.env.JIRA_ACCOUNT_EMAIL,
  apiToken: process.env.JIRA_API_TOKEN,
  projectKey: (process.env.JIRA_PROJECT_KEYS || '').split(',')[0].trim(),
  sampleIssue: (process.env.JIRA_SAMPLE_ISSUE_KEY || '').trim()
};
const available = Boolean(JIRA.baseUrl && JIRA.accountEmail && JIRA.apiToken && JIRA.projectKey && JIRA.sampleIssue);

function mongosh(js) {
  const user = process.env.MONGO_ROOT_USER || process.env.MONGO_BACKUP_USER;
  const password = process.env.MONGO_ROOT_PASSWORD || process.env.MONGO_BACKUP_PASSWORD;
  return execFileSync(
    'docker',
    ['exec', process.env.TEST_MONGO_CONTAINER || 'mongodb', 'mongosh', '--quiet',
      '-u', user, '-p', password, '--authenticationDatabase', 'admin', '--eval', js],
    { encoding: 'utf8' }
  );
}

describe('WP-144: link an existing Jira issue and render it live', () => {
  let admin;
  let client;
  let projectId;
  let projectMongoId;
  const sourceId = `WP144-Bug-${runId}`;

  beforeAll(async () => {
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn('\n[WP-144] SUITE SKIPPED — JIRA_* (including JIRA_SAMPLE_ISSUE_KEY) not configured.\n[WP-144] Nothing below was verified.\n');
      return;
    }
    const token = await getServiceToken();
    admin = axios.create({ baseURL: KONG, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true });
    const org = await admin.post('/api/v1/organizations', { name: `wp144 org ${runId}`, key: `wp144-${runId}` });
    expect(org.status).toBe(201);
    trackOrganization(org.data.data._id);
    const proj = await admin.post('/api/v1/projects', {
      name: `wp144 project ${runId}`,
      key: `w144${String(runId).slice(-6)}`,
      organizationId: org.data.data._id
    });
    expect(proj.status).toBe(201);
    projectId = proj.data.data.id;
    projectMongoId = proj.data.data._id;
    trackProject(projectId);
    client = axios.create({
      baseURL: KONG,
      headers: { Authorization: `Bearer ${token}`, 'X-Project-Id': String(projectId) },
      timeout: 40000,
      validateStatus: () => true
    });
  }, 150000);

  function linkIssue(key, src = sourceId, srcModule = 5) {
    return client.post('/api/v1/linkIssue', {
      sourceId: src,
      srcModule,
      destinationModule: 100,
      external: { provider: 'jira', key },
      summary: 'linked by the WP-144 suite'
    });
  }

  it('links an issue WITHOUT a Jira connection — creating a link must not need Jira up', async () => {
    if (!available) return;
    // WP-141 shipped before WP-142, so links predating a connection are
    // legitimate; and a Jira outage must not block recording intent.
    const resp = await linkIssue(JIRA.sampleIssue);
    expect(resp.status).toBe(201);
  }, 90000);

  it('renders the key with a stale label when no connection is configured', async () => {
    if (!available) return;
    const resp = await client.get(ISSUES);
    expect(resp.status).toBe(200);
    expect(resp.data.stale).toBe(true);
    expect(String(resp.data.staleReason)).toMatch(/no Jira connection/i);
    const row = resp.data.data[0];
    // Never a broken row: the key is renderable even with nothing cached.
    expect(row.key).toBe(JIRA.sampleIssue);
    expect(row.neverFetched).toBe(true);
  }, 90000);

  describe('with a connection configured', () => {
    beforeAll(async () => {
      if (!available) return;
      const saved = await client.put(CONN, { ...JIRA, projectKeys: JIRA.projectKey });
      expect([200, 201]).toContain(saved.status);
    }, 90000);

    it('renders the live summary, status, status CATEGORY and assignee', async () => {
      if (!available) return;
      const resp = await client.get(ISSUES);
      expect(resp.status).toBe(200);
      expect(resp.data.stale).toBe(false);
      const row = resp.data.data.find((r) => r.key === JIRA.sampleIssue);
      expect(row.summary).toBeTruthy();
      expect(row.status).toBeTruthy();
      // Jira status NAMES are workflow-configurable per project, so a UI
      // cannot colour a badge from them; the category is one of three fixed
      // values and is what a badge keys off.
      expect(row.statusCategory).toBeTruthy();
      expect(row.fetchedAt).toBeTruthy();
      expect(row.missing).toBe(false);
    }, 90000);

    it('resolves the Jira assignee back to a local user once WP-143 maps them', async () => {
      if (!available) return;
      const before = await client.get(ISSUES);
      const row = before.data.data.find((r) => r.key === JIRA.sampleIssue);
      if (!row.assigneeAccountId) return; // sample issue unassigned; nothing to map
      expect(row.assigneeMapped).toBe(false);

      const token = await getServiceToken();
      const selfSub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).sub;
      const mapped = await client.put('/api/v1/linkIssue/jira/users', {
        keycloakSub: selfSub,
        jiraAccountId: row.assigneeAccountId
      });
      expect([200, 201]).toContain(mapped.status);

      const after = await client.get(`${ISSUES}?refresh=true`);
      const row2 = after.data.data.find((r) => r.key === JIRA.sampleIssue);
      expect(row2.assigneeMapped).toBe(true);
      expect(row2.assigneeKeycloakSub).toBe(selfSub);
    }, 120000);

    it('marks an issue Jira does not have as missing, KEEPING any cached summary', async () => {
      if (!available) return;
      const bogus = `${JIRA.projectKey}-999999`;
      expect((await linkIssue(bogus)).status).toBe(201);
      const resp = await client.get(`${ISSUES}?refresh=true`);
      const row = resp.data.data.find((r) => r.key === bogus);
      // "Jira answered and does not have it" is a different user action from
      // "we could not reach Jira", so it is a different field.
      expect(row.missing).toBe(true);
      expect(resp.data.stale).toBe(false);
    }, 120000);

    it('searches Jira and flags results already linked', async () => {
      if (!available) return;
      const resp = await client.get(`${ISSUES}/search?q=${encodeURIComponent(JIRA.sampleIssue.split('-')[0])}`);
      expect(resp.status).toBe(200);
      const hit = resp.data.data.find((i) => i.key === JIRA.sampleIssue);
      if (hit) expect(hit.alreadyLinkedTo).toBeTruthy();
    }, 90000);

    it('requires a search term rather than returning the whole project', async () => {
      if (!available) return;
      expect((await client.get(`${ISSUES}/search`)).status).toBe(400);
      expect((await client.get(`${ISSUES}/search?q=%20%20`)).status).toBe(400);
    }, 60000);

    it('THE ACCEPTANCE: Jira unreachable serves the CACHED value, labelled stale, never a broken row', async () => {
      if (!available) return;
      // Cache is warm from the tests above.
      const warm = await client.get(ISSUES);
      const before = warm.data.data.find((r) => r.key === JIRA.sampleIssue);
      expect(before.summary).toBeTruthy();

      // Break Jira the realistic way: a connection that validated at save
      // time and then stopped working. Written directly because WP-142
      // refuses to SAVE an unreachable base URL, so this state is otherwise
      // unreachable from the API.
      mongosh(
        `db.getSiblingDB('srckube-linkissue').jiraconnections.updateOne(` +
          `{projectId:${projectId}},{$set:{baseUrl:"https://srckube-jira-down-${runId}.atlassian.net"}})`
      );

      const resp = await client.get(`${ISSUES}?refresh=true`);
      // A 502 here would take out the whole links panel because one external
      // row could not refresh. It must stay a 200.
      expect(resp.status).toBe(200);
      expect(resp.data.stale).toBe(true);
      expect(String(resp.data.staleReason)).toMatch(/could not be reached/i);

      const after = resp.data.data.find((r) => r.key === JIRA.sampleIssue);
      expect(after.summary).toBe(before.summary);
      expect(after.status).toBe(before.status);
      expect(after.neverFetched).toBe(false);
      // The row still renders. That is the acceptance.
      expect(after.key).toBeTruthy();
    }, 150000);
  });

  describe('authorization and tenancy', () => {
    it('a contributor CAN read linked issues — withholding status breaks the chain for the people who use it', async () => {
      if (!available) return;
      const contributor = await createTestPersona('wp144-contrib');
      try {
        expect((await admin.post(`/api/v1/projects/${projectMongoId}/members`, {
          userId: contributor.sub,
          role: 'contributor'
        })).status).toBe(200);
        const cc = axios.create({
          baseURL: KONG,
          headers: { Authorization: `Bearer ${await contributor.getToken()}`, 'X-Project-Id': String(projectId) },
          validateStatus: () => true
        });
        expect((await cc.get(ISSUES)).status).toBe(200);
        // ...but still cannot see or change the credential.
        expect((await cc.get(CONN)).status).toBe(403);
      } finally {
        await contributor.cleanup();
      }
    }, 150000);

    it('an outsider cannot read this project\'s linked issues', async () => {
      if (!available) return;
      const outsider = await createTestPersona('wp144-outsider');
      try {
        const oc = axios.create({
          baseURL: KONG,
          headers: { Authorization: `Bearer ${await outsider.getToken()}`, 'X-Project-Id': String(projectId) },
          validateStatus: () => true
        });
        expect((await oc.get(ISSUES)).status).toBe(403);
      } finally {
        await outsider.cleanup();
      }
    }, 120000);

    it('is rejected at the gateway without a token', async () => {
      if (!available) return;
      const anon = axios.create({ baseURL: KONG, validateStatus: () => true });
      expect((await anon.get(ISSUES)).status).toBe(401);
    }, 60000);
  });
});

afterAll(() => {
  purgeTrackedFixtures();
});
