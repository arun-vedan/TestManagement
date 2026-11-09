const path = require('path');
const axios = require('axios');
const { execFileSync } = require('child_process');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { createTestPersona } = require('../../shared/test-utils/keycloakTestPersona');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// WP-142 — Jira connection settings and validation.
//
// Acceptance, verbatim: "a wrong token, a wrong base URL, and a project key
// the account cannot see each produce a distinct actionable error before
// anything is saved."
//
// AGAINST THE REAL JIRA, not a stub. The whole package is about what Jira
// actually answers, and the design turned on a measurement a stub would have
// hidden: a wrong base URL and an invisible project key BOTH return 404,
// because Atlassian wildcards *.atlassian.net so a mistyped site resolves. A
// hand-written mock would have returned whatever I assumed, and the validator
// would have told people with a typo'd site name that their project key was
// wrong.
//
// SKIPS LOUDLY when JIRA_* is absent, rather than passing vacuously -- every
// test early-returns on that flag, so a silent skip would look like the
// acceptance had been verified when nothing ran.

const KONG_URL = process.env.TEST_KONG_URL || 'http://localhost:8000';
const P = '/api/v1/linkIssue/jira/connection';
const runId = Date.now();

const JIRA = {
  baseUrl: process.env.JIRA_BASE_URL,
  accountEmail: process.env.JIRA_ACCOUNT_EMAIL,
  apiToken: process.env.JIRA_API_TOKEN,
  projectKey: (process.env.JIRA_PROJECT_KEYS || '').split(',')[0].trim()
};
const available = Boolean(JIRA.baseUrl && JIRA.accountEmail && JIRA.apiToken && JIRA.projectKey);

// A site name that resolves (Atlassian wildcards the domain) but is not a Jira
// site -- which is the whole point: it 404s rather than failing to connect.
const WRONG_SITE = 'https://srckube-no-such-site-9z8y7x.atlassian.net';

describe('WP-142: Jira connection settings and validation', () => {
  let admin;
  let client;
  let projectId;
  let projectMongoId;
  let orgId;

  beforeAll(async () => {
    if (!available) {
      // eslint-disable-next-line no-console
      console.warn(
        '\n[WP-142] SUITE SKIPPED — JIRA_BASE_URL / JIRA_ACCOUNT_EMAIL / JIRA_API_TOKEN / ' +
          'JIRA_PROJECT_KEYS are not all set in backend/.env.' +
          '\n[WP-142] Nothing below was verified.\n'
      );
      return;
    }
    const token = await getServiceToken();
    admin = axios.create({
      baseURL: KONG_URL,
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true
    });
    const org = await admin.post('/api/v1/organizations', {
      name: `wp142 org ${runId}`,
      key: `wp142-${runId}`
    });
    expect(org.status).toBe(201);
    orgId = org.data.data._id;
    trackOrganization(orgId);
    const proj = await admin.post('/api/v1/projects', {
      name: `wp142 project ${runId}`,
      key: `w142${String(runId).slice(-6)}`,
      organizationId: orgId
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
  }, 120000);

  it('reports an unconfigured project without erroring', async () => {
    if (!available) return;
    const resp = await client.get(P);
    // Not a 404: "no Jira connection" is a normal state a settings screen
    // renders, not a missing resource.
    expect(resp.status).toBe(200);
    expect(resp.data.data.configured).toBe(false);
  }, 60000);

  describe('the three distinct errors, and nothing saved', () => {
    it('a wrong TOKEN is reported as a credential problem', async () => {
      if (!available) return;
      const resp = await client.put(P, { ...JIRA, apiToken: 'definitely-not-the-token', projectKeys: JIRA.projectKey });
      expect(resp.status).toBe(400);
      expect(String(resp.data.error)).toMatch(/rejected the credentials/i);
      // Points at where tokens are managed, so the message is actionable.
      expect(String(resp.data.error)).toMatch(/api-tokens/);
    }, 90000);

    it('a wrong BASE URL is reported as a site problem, not a project-key problem', async () => {
      if (!available) return;
      // The measurement this whole design rests on: this returns 404, exactly
      // like an invisible project key. Distinguishing them is the point.
      const resp = await client.put(P, { ...JIRA, baseUrl: WRONG_SITE, projectKeys: JIRA.projectKey });
      expect(resp.status).toBe(400);
      expect(String(resp.data.error)).toMatch(/No Jira site answered/i);
      // And it explains WHY a typo looks like a working URL.
      expect(String(resp.data.error)).toMatch(/atlassian\.net address resolves/i);
      expect(String(resp.data.error)).not.toMatch(/project key/i);
    }, 90000);

    it('an invisible PROJECT KEY is reported as a key problem, not a site problem', async () => {
      if (!available) return;
      const resp = await client.put(P, { ...JIRA, projectKeys: 'NOSUCHKEY' });
      expect(resp.status).toBe(400);
      expect(String(resp.data.error)).toMatch(/NOSUCHKEY/);
      // Says it cannot tell "does not exist" from "cannot browse it", because
      // Jira answers identically -- rather than guessing one.
      expect(String(resp.data.error)).toMatch(/does not exist or/i);
      expect(String(resp.data.error)).not.toMatch(/No Jira site answered/i);
    }, 90000);

    it('all three error messages differ from one another', async () => {
      if (!available) return;
      const a = await client.put(P, { ...JIRA, apiToken: 'wrong', projectKeys: JIRA.projectKey });
      const b = await client.put(P, { ...JIRA, baseUrl: WRONG_SITE, projectKeys: JIRA.projectKey });
      const c = await client.put(P, { ...JIRA, projectKeys: 'NOSUCHKEY' });
      const messages = [a.data.error, b.data.error, c.data.error].map(String);
      // The acceptance says "distinct". Three identical 400s would satisfy a
      // careless reading of it.
      expect(new Set(messages).size).toBe(3);
    }, 120000);

    it('NOTHING was saved by any of those failures', async () => {
      if (!available) return;
      // The other half of the acceptance: "before anything is saved". Saving
      // first and validating after would leave a project configured with
      // credentials that cannot work, and the next person to look would
      // reasonably believe the integration was set up.
      const resp = await client.get(P);
      expect(resp.data.data.configured).toBe(false);
    }, 60000);
  });

  describe('validate without saving', () => {
    it('validates good credentials and reports what it FOUND', async () => {
      if (!available) return;
      const resp = await client.post(`${P}/validate`, { ...JIRA, projectKeys: JIRA.projectKey });
      // 200 whether or not valid: the request succeeded, the verdict is the
      // payload. A non-2xx would make a UI treat "your token is wrong" as a
      // transport failure.
      expect(resp.status).toBe(200);
      expect(resp.data.data.valid).toBe(true);
      // Reports the account and projects, not merely "ok" -- the WP asks for
      // validation that says what it saw rather than saving blind.
      expect(resp.data.data.account.accountId).toBeTruthy();
      expect(resp.data.data.projects.map((p) => p.key)).toContain(JIRA.projectKey);
      expect(String(resp.data.data.message)).toContain(resp.data.data.account.displayName);
    }, 90000);

    it('normalises the web-UI path and a lower-case project key', async () => {
      if (!available) return;
      // Both were real inputs: the owner supplied the base URL with /jira/ on
      // it, copied from the browser. Left alone it would 404 every call
      // against a URL that looks correct.
      const resp = await client.post(`${P}/validate`, {
        ...JIRA,
        baseUrl: `${JIRA.baseUrl}/jira/`,
        projectKeys: JIRA.projectKey.toLowerCase()
      });
      expect(resp.data.data.valid).toBe(true);
    }, 90000);

    it('does not persist anything', async () => {
      if (!available) return;
      const resp = await client.get(P);
      expect(resp.data.data.configured).toBe(false);
    }, 60000);
  });

  describe('saving', () => {
    it('saves a validated connection, storing the normalised URL and upper-case keys', async () => {
      if (!available) return;
      const resp = await client.put(P, {
        ...JIRA,
        baseUrl: `${JIRA.baseUrl}/jira/`,
        projectKeys: JIRA.projectKey.toLowerCase()
      });
      expect(resp.status).toBe(201);
      expect(resp.data.data.baseUrl).toBe(JIRA.baseUrl);
      expect(resp.data.data.projectKeys).toEqual([JIRA.projectKey]);
      expect(resp.data.data.apiTokenConfigured).toBe(true);
      expect(resp.data.validation.account.displayName).toBeTruthy();
    }, 90000);

    it('never returns the token, on save or on read', async () => {
      if (!available) return;
      const saved = await client.put(P, { ...JIRA, projectKeys: JIRA.projectKey });
      expect(JSON.stringify(saved.data)).not.toContain(JIRA.apiToken);
      const read = await client.get(P);
      expect(JSON.stringify(read.data)).not.toContain(JIRA.apiToken);
      // Presence is reported; the value is not.
      expect(read.data.data.apiTokenConfigured).toBe(true);
    }, 90000);

    it('stores the token ENCRYPTED, not in plaintext', async () => {
      if (!available) return;
      const user = process.env.MONGO_ROOT_USER || process.env.MONGO_BACKUP_USER;
      const password = process.env.MONGO_ROOT_PASSWORD || process.env.MONGO_BACKUP_PASSWORD;
      const out = execFileSync(
        'docker',
        ['exec', process.env.TEST_MONGO_CONTAINER || 'mongodb', 'mongosh', '--quiet',
          '-u', user, '-p', password, '--authenticationDatabase', 'admin', '--eval',
          `printjson(db.getSiblingDB('srckube-linkissue').jiraconnections.findOne({projectId:${projectId}},{apiTokenSealed:1}))`],
        { encoding: 'utf8' }
      );
      // The acceptance of WP-140 applied to a real credential: unreadable in
      // a mongodump.
      expect(out).not.toContain(JIRA.apiToken);
      expect(out).toMatch(/enc:v1:/);
    }, 90000);

    it('re-validates using the stored token when none is re-supplied', async () => {
      if (!available) return;
      // A settings form cannot re-send the token, because the API never
      // returns it. Without this fallback, editing any other field would
      // demand the token again.
      const resp = await client.post(`${P}/validate`, {});
      expect(resp.status).toBe(200);
      expect(resp.data.data.valid).toBe(true);
      expect(resp.data.data.usedStoredToken).toBe(true);
    }, 90000);

    it('deletes the connection', async () => {
      if (!available) return;
      const del = await client.delete(P);
      expect(del.status).toBe(200);
      const after = await client.get(P);
      expect(after.data.data.configured).toBe(false);
    }, 60000);
  });

  describe('authorization', () => {
    it('is admin-only: a manager cannot read or write the Jira credential', async () => {
      if (!available) return;
      // manage_project, the same level as renaming or archiving a project.
      // A contributor who can create links must not be able to read or
      // replace an administrative credential for an external system.
      const manager = await createTestPersona('wp142-manager');
      try {
        const added = await admin.post(`/api/v1/projects/${projectMongoId}/members`, {
          userId: manager.sub,
          role: 'manager'
        });
        expect(added.status).toBe(200);
        const mc = axios.create({
          baseURL: KONG_URL,
          headers: { Authorization: `Bearer ${await manager.getToken()}`, 'X-Project-Id': String(projectId) },
          validateStatus: () => true
        });
        expect((await mc.get(P)).status).toBe(403);
        expect((await mc.put(P, { ...JIRA, projectKeys: JIRA.projectKey })).status).toBe(403);
        expect((await mc.post(`${P}/validate`, {})).status).toBe(403);
      } finally {
        await manager.cleanup();
      }
    }, 150000);

    it('an outsider cannot reach another project\'s Jira settings', async () => {
      if (!available) return;
      const outsider = await createTestPersona('wp142-outsider');
      try {
        const oc = axios.create({
          baseURL: KONG_URL,
          headers: { Authorization: `Bearer ${await outsider.getToken()}`, 'X-Project-Id': String(projectId) },
          validateStatus: () => true
        });
        expect((await oc.get(P)).status).toBe(403);
      } finally {
        await outsider.cleanup();
      }
    }, 120000);

    it('is rejected at the gateway without a token', async () => {
      if (!available) return;
      const anon = axios.create({ baseURL: KONG_URL, validateStatus: () => true });
      expect((await anon.get(P)).status).toBe(401);
    }, 60000);
  });
});

afterAll(() => {
  purgeTrackedFixtures();
});
