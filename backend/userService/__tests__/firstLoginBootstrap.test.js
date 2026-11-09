const axios = require('axios');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

// WP-131 — "a brand-new verified account reaches a usable workspace with no
// manual steps and no 403s."
//
// WHY THIS SUITE EXISTS WITH NO ACCOMPANYING CODE CHANGE.
//
// WP-131's stated premise was that "a verified user with no membership gets 403
// from every scoped service". That was true when the plan was written and is
// false now — not because WP-131 was done, but because other work removed the
// cause:
//
//   WP-022  createProject makes the creator the sole admin and ignores
//           client-supplied members[]
//   WP-110  createOrganization enrols its creator as org_admin, so a user with
//           no organization can make one and immediately belongs to it
//   WP-116  follow-up: a new project is seeded the defect-status workflow, so
//           it is usable rather than merely visible
//   frontend Pages/projects.tsx:120 defaults an organization-less user straight
//           into the "+ Create new organization" path, so the UI can express
//           the bootstrap (GR-4)
//
// Measured before writing this: GET /organizations and GET /projects return
// 200 with count=0 (not 403 — WP-110's scoping returns an empty list), and the
// only real dead end would have been POST /projects requiring an
// organizationId the user does not have. Creating the organization first
// resolves it, and that path works.
//
// So rather than invent a change, this locks the acceptance down. Onboarding is
// the kind of path that breaks silently: nobody exercises it after the first
// week, and every tenancy change since WP-110 could plausibly have broken it.
//
// It needs Keycloak admin credentials to mint a genuinely new user. Without
// them the suite SKIPS rather than failing, so it does not turn red in an
// environment that cannot run it.

const KC = process.env.TEST_KEYCLOAK_URL || 'http://localhost:8080';
const REALM = process.env.TEST_KEYCLOAK_REALM || 'srckube';
const KONG = process.env.TEST_KONG_URL || 'http://localhost:8000';
const KC_ADMIN = process.env.KC_ADMIN_USER || 'admin';
const KC_ADMIN_PW = process.env.KC_ADMIN_PASSWORD || 'Pass;word1';
// The realm's public client with direct access grants. NOT node-microservice:
// that one is confidential, and using it returns unauthorized_client, which
// reads like a refused login but is the client being wrong (a false positive
// this project already hit once during WP-130).
const PUBLIC_CLIENT = process.env.TEST_PUBLIC_CLIENT || 'mern-app';

const runId = Date.now();
const form = (o) => new URLSearchParams(o).toString();
const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };

describe('WP-131 — a brand-new verified account reaches a usable workspace', () => {
  let adminTok;
  let userId;
  let userTok;
  let available = true;
  const username = `wp131-bootstrap-${runId}`;
  const password = `Tmp-${runId}-Aa!`;

  beforeAll(async () => {
    try {
      const r = await axios.post(
        `${KC}/realms/master/protocol/openid-connect/token`,
        form({ client_id: 'admin-cli', username: KC_ADMIN, password: KC_ADMIN_PW, grant_type: 'password' }),
        { headers: FORM, timeout: 10000 }
      );
      adminTok = r.data.access_token;
    } catch (err) {
      available = false;
      // Loud, because every test below early-returns when this is false. A
      // silent skip would make the whole suite pass vacuously and look like
      // the acceptance had been verified when nothing ran at all.
      // eslint-disable-next-line no-console
      console.warn(
        '\n[WP-131] SUITE SKIPPED — no Keycloak admin access at ' + KC +
        '\n[WP-131] Nothing below was verified. Set KC_ADMIN_USER / KC_ADMIN_PASSWORD to run it.\n'
      );
      return;
    }

    const H = { Authorization: `Bearer ${adminTok}`, 'Content-Type': 'application/json' };
    // A genuinely fresh, verified account with nothing attached to it.
    //
    // requiredActions is explicitly emptied AFTER creation, not just passed as
    // []: TERMS_AND_CONDITIONS is a realm default action since WP-130, so
    // Keycloak adds it to every new user regardless of what the create call
    // says. Leaving it would make the login fail with "Account is not fully set
    // up", which is correct product behaviour but not what this suite is
    // testing — a real user clears it by accepting terms in the browser.
    const create = await axios.post(
      `${KC}/admin/realms/${REALM}/users`,
      {
        username,
        email: `${username}@example.invalid`,
        firstName: 'WP131',
        lastName: 'Bootstrap',
        enabled: true,
        emailVerified: true,
        credentials: [{ type: 'password', value: password, temporary: false }]
      },
      { headers: H, validateStatus: () => true }
    );
    expect(create.status).toBe(201);
    userId = (create.headers.location || '').split('/').pop();
    await axios.put(`${KC}/admin/realms/${REALM}/users/${userId}`, { requiredActions: [] }, { headers: H });

    const tok = await axios.post(
      `${KC}/realms/${REALM}/protocol/openid-connect/token`,
      form({ client_id: PUBLIC_CLIENT, username, password, grant_type: 'password' }),
      { headers: FORM, validateStatus: () => true }
    );
    expect(tok.data.access_token).toBeTruthy();
    userTok = tok.data.access_token;
    // eslint-disable-next-line no-console
    console.log(`[WP-131] running against a real new account: ${username} (kc id ${userId})`);
  }, 40000);

  afterAll(async () => {
    if (adminTok && userId) {
      await axios.delete(`${KC}/admin/realms/${REALM}/users/${userId}`, {
        headers: { Authorization: `Bearer ${adminTok}` },
        validateStatus: () => true
      });
    }
  });

  const asUser = (projectId) =>
    axios.create({
      baseURL: KONG,
      headers: {
        Authorization: `Bearer ${userTok}`,
        ...(projectId ? { [PROJECT_ID_HEADER]: String(projectId) } : {})
      },
      validateStatus: () => true
    });

  it('starts with no organizations and no projects — empty lists, NOT 403s', async () => {
    if (!available) return;
    const orgs = await asUser().get('/api/v1/organizations');
    const projects = await asUser().get('/api/v1/projects');
    // The distinction matters: WP-110 scoped these to the caller, so an
    // org-less user gets an empty list. A 403 here would mean the frontend
    // could not even render its empty state.
    expect(orgs.status).toBe(200);
    expect(orgs.data.count).toBe(0);
    expect(projects.status).toBe(200);
    expect(projects.data.count).toBe(0);
  }, 20000);

  it('can create its own organization and is enrolled as org_admin', async () => {
    if (!available) return;
    const resp = await asUser().post('/api/v1/organizations', {
      name: `WP-131 bootstrap org ${runId}`,
      key: `wp131-boot-${runId}`
    });
    expect(resp.status).toBe(201);
    trackOrganization(resp.data.data._id);
    // Without this enrolment the user would own an organization they cannot
    // see, and GET /projects would still return nothing.
    expect(resp.data.data.members.map((m) => m.role)).toContain('org_admin');
    global.__wp131OrgId = resp.data.data._id;
  }, 20000);

  it('can create a project in it, and the project is seeded a usable defect workflow', async () => {
    if (!available) return;
    const resp = await asUser().post('/api/v1/projects', {
      name: `WP-131 bootstrap project ${runId}`,
      key: `wp131p${String(runId).slice(-6)}`,
      organizationId: global.__wp131OrgId
    });
    expect(resp.status).toBe(201);
    trackProject(resp.data.data.id);
    expect(resp.data.data.members.map((m) => m.role)).toContain('admin');
    // The WP-116 follow-up: a project with no status vocabulary is visible but
    // not usable, because no defect can be transitioned in it.
    expect(resp.data.statusWorkflowSeeded).toBe(true);
    global.__wp131ProjectId = resp.data.data.id;
    // eslint-disable-next-line no-console
    console.log(`[WP-131] bootstrapped org ${global.__wp131OrgId} -> project ${resp.data.data.id}`);
  }, 30000);

  it('reaches every scoped service with no 403s — the acceptance clause', async () => {
    if (!available) return;
    const pid = global.__wp131ProjectId;
    const paths = [
      '/api/v1/testrepo',
      '/api/v1/requirement',
      '/api/v1/defects',
      '/api/v1/folders',
      '/api/v1/modules',
      '/api/v1/issuestatus',
      '/api/v1/comments',
      '/api/v1/linkIssue',
      '/api/v1/fields',
      '/api/v1/testplan',
      '/api/v1/testexecution'
    ];
    const results = {};
    for (const p of paths) {
      // eslint-disable-next-line no-await-in-loop
      const r = await asUser(pid).get(p);
      results[p] = r.status;
    }
    // eslint-disable-next-line no-console
    console.log('[WP-131] scoped reads: ' + Object.entries(results).map(([p, s2]) => `${p.replace('/api/v1/', '')}=${s2}`).join(' '));
    Object.entries(results).forEach(([p, status]) => {
      expect({ path: p, status }).toEqual({ path: p, status: 200 });
    });
  }, 60000);

  it('its new project already has the 8-status defect workflow', async () => {
    if (!available) return;
    const resp = await asUser(global.__wp131ProjectId).get('/api/v1/issuestatus?limit=100');
    expect(resp.status).toBe(200);
    const names = resp.data.data.map((s) => s.istatus);
    ['New', 'Open', 'Fixed', 'Rejected', 'Deffered', 'Retest', 'Re-open', 'Closed'].forEach((n) => {
      expect(names).toContain(n);
    });
  }, 20000);

  it('can do real work: create a test case and transition a defect', async () => {
    if (!available) return;
    const pid = global.__wp131ProjectId;

    const tc = await asUser(pid).post('/api/v1/testrepo', {
      TestCaseSummary: `WP-131 first test case ${runId}`,
      TestCaseDescription: 'created by a brand-new account with no manual setup'
    });
    expect(tc.status).toBe(201);
    expect(tc.data.data.projectId).toBe(pid);

    const defect = await asUser(pid).post('/api/v1/defects', {
      summary: `WP-131 first defect ${runId}`,
      Severity: 'High',
      Status: 'New'
    });
    expect(defect.status).toBe(201);

    // The end-to-end proof that the workspace is USABLE and not merely
    // reachable: a transition validates against this project's own seeded
    // graph.
    const moved = await asUser(pid).put(`/api/v1/defects/${defect.data.data._id}/status`, { status: 'Open' });
    expect(moved.status).toBe(200);
  }, 40000);

  it('still cannot see another tenant — onboarding did not widen access', async () => {
    if (!available) return;
    // The counterweight: a usable workspace must not mean a shared one.
    const foreign = await asUser(1).get('/api/v1/testrepo');
    expect(foreign.status).toBe(403);
  }, 20000);
});

// Suite teardown (WP-110 follow-up) — its own top-level afterAll, which Jest
// runs last. See shared/test-utils/fixtureCleanup.js.
afterAll(() => {
  purgeTrackedFixtures();
});
