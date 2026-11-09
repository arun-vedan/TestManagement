const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { createTestPersona } = require('../../shared/test-utils/keycloakTestPersona');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

// Cross-tenant identity disclosure — regression suite.
//
// Found while verifying WP-132's premises. Measured on the live stack BEFORE
// the fix: a persona with no organization, no project and no relationship to
// anybody got HTTP 200 and another account's full Keycloak representation,
// INCLUDING THEIR EMAIL ADDRESS, by naming their username. /kcUsers with an
// empty filter returned every user in the realm.
//
// These tests exist because that is not the kind of thing to re-discover.
//
// What was measured against the running stack before the fix, and what was
// established by reading the code, kept separate on purpose:
//
//   MEASURED LIVE: an outsider persona received HTTP 200 plus
//   victim-secret-address@example.invalid and the full representation from
//   /kcUsers?id=<username>, and 200 from /kcUser?id=<sub>. The empty-filter
//   realm dump returned 200.
//
//   READ FROM THE CODE, not measured: getOrganization had no membership check
//   at all (routes/organizations.js mounted it behind keycloak.protect() only),
//   and GET /organizations/:id/members and /users/directory did not exist. The
//   organization assertions here are therefore new coverage of a gap confirmed
//   by inspection and by the diff, not a reproduction of a measured exploit.

const KONG_URL = process.env.TEST_KONG_URL || 'http://localhost:8000';
const runId = Date.now();

function clientFor(token, extraHeaders = {}) {
  return axios.create({
    baseURL: KONG_URL,
    headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
    validateStatus: () => true
  });
}

describe('cross-tenant identity disclosure (kcUser / kcUsers / organizations)', () => {
  let admin;
  let adminSub;
  let orgId;
  let projectId;
  let projectMongoId;
  let colleague;
  let outsider;
  let victim;

  beforeAll(async () => {
    const token = await getServiceToken();
    admin = clientFor(token);
    adminSub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).sub;

    const org = await admin.post('/api/v1/organizations', {
      name: `identity-probe org ${runId}`,
      key: `idprobe-org-${runId}`
    });
    expect(org.status).toBe(201);
    orgId = org.data.data._id;
    trackOrganization(orgId);

    const proj = await admin.post('/api/v1/projects', {
      name: `identity-probe project ${runId}`,
      key: `idp${String(runId).slice(-6)}`,
      organizationId: orgId
    });
    expect(proj.status).toBe(201);
    projectId = proj.data.data.id;
    projectMongoId = proj.data.data._id;
    trackProject(projectId);

    // A colleague on the project, an outsider with no tenant at all, and a
    // victim whose email address is the thing that must not leak.
    colleague = await createTestPersona('idprobe-colleague');
    outsider = await createTestPersona('idprobe-outsider');
    victim = await createTestPersona('idprobe-victim', {
      email: `idprobe-victim-${runId}@example.invalid`
    });

    const added = await admin.post(`/api/v1/projects/${projectMongoId}/members`, {
      userId: colleague.sub,
      role: 'contributor'
    });
    expect(added.status).toBe(200);
  }, 120000);

  afterAll(async () => {
    if (colleague) await colleague.cleanup();
    if (outsider) await outsider.cleanup();
    if (victim) await victim.cleanup();
  });

  describe('an outsider cannot read identities they share no tenant with', () => {
    it('kcUser by sub returns 404, not the account', async () => {
      const c = clientFor(await outsider.getToken());
      const resp = await c.get(`/api/v1/users/kcUser?id=${encodeURIComponent(victim.sub)}`);
      expect(resp.status).toBe(404);
      // Indistinguishable from a genuinely unknown id: a 403 would confirm the
      // account exists, making this an existence oracle.
      expect(String(resp.data.error)).toMatch(/not found/i);
    }, 60000);

    it('kcUsers by exact username returns an empty list, and no email', async () => {
      const c = clientFor(await outsider.getToken());
      const resp = await c.get(`/api/v1/users/kcUsers?id=${encodeURIComponent(victim.username)}`);
      expect(resp.status).toBe(200);
      expect(resp.data.count).toBe(0);
      expect(resp.data.data).toEqual([]);
      expect(JSON.stringify(resp.data)).not.toContain(victim.email);
    }, 60000);

    it('the realm dump is gone: kcUsers with an empty filter is refused', async () => {
      const c = clientFor(await outsider.getToken());
      const resp = await c.get('/api/v1/users/kcUsers?id=');
      // This single call used to return every user on the platform.
      expect(resp.status).toBe(400);
      expect(String(resp.data.error)).toMatch(/directory/i);
    }, 30000);

    it('cannot read a project directory they are not a member of', async () => {
      const c = clientFor(await outsider.getToken(), { 'X-Project-Id': String(projectId) });
      const resp = await c.get('/api/v1/users/directory');
      expect(resp.status).toBe(403);
    }, 60000);

    it('cannot read an organization by id', async () => {
      const c = clientFor(await outsider.getToken());
      const resp = await c.get(`/api/v1/organizations/${orgId}`);
      // 404 not 403, matching the scoped list endpoint: whether an org exists
      // is itself tenant information.
      expect(resp.status).toBe(404);
    }, 60000);

    it('cannot read an organization member list', async () => {
      const c = clientFor(await outsider.getToken());
      const resp = await c.get(`/api/v1/organizations/${orgId}/members`);
      expect(resp.status).toBe(403);
    }, 60000);
  });

  describe('legitimate access still works — the fix is not a lockout', () => {
    it('a caller can always resolve themselves', async () => {
      const c = clientFor(await outsider.getToken());
      const resp = await c.get(`/api/v1/users/kcUser?id=${encodeURIComponent(outsider.sub)}`);
      expect(resp.status).toBe(200);
      expect(resp.data.data.id).toBe(outsider.sub);
    }, 60000);

    it('a project colleague can resolve a co-member, for "created by" columns', async () => {
      const c = clientFor(await colleague.getToken());
      const resp = await c.get(`/api/v1/users/kcUser?id=${encodeURIComponent(adminSub)}`);
      expect(resp.status).toBe(200);
      expect(resp.data.data.username).toBeTruthy();
    }, 60000);

    it('a member can read the project directory, and it lists the members', async () => {
      const c = clientFor(await colleague.getToken(), { 'X-Project-Id': String(projectId) });
      const resp = await c.get('/api/v1/users/directory');
      expect(resp.status).toBe(200);
      const ids = resp.data.data.map((u) => u.id);
      expect(ids).toContain(colleague.sub);
      expect(ids).toContain(adminSub);
      expect(resp.data.data.every((u) => u.projectRole)).toBe(true);
    }, 60000);
  });

  describe('the response shape itself carries no sensitive fields', () => {
    // Independent of who may call it: narrowing the shape means a future
    // authorization slip leaks far less than it would have.
    const FORBIDDEN = [
      'email',
      'emailVerified',
      'requiredActions',
      'disableableCredentialTypes',
      'totp',
      'createdTimestamp',
      'access',
      'notBefore'
    ];

    it('kcUser returns only display fields', async () => {
      const c = clientFor(await colleague.getToken());
      const resp = await c.get(`/api/v1/users/kcUser?id=${encodeURIComponent(colleague.sub)}`);
      expect(resp.status).toBe(200);
      expect(Object.keys(resp.data.data).sort()).toEqual(
        ['firstName', 'id', 'lastName', 'username'].sort()
      );
      FORBIDDEN.forEach((f) => expect(Object.keys(resp.data.data)).not.toContain(f));
    }, 60000);

    it('the project directory returns only display fields', async () => {
      const c = clientFor(await colleague.getToken(), { 'X-Project-Id': String(projectId) });
      const resp = await c.get('/api/v1/users/directory');
      expect(resp.status).toBe(200);
      resp.data.data.forEach((u) => {
        FORBIDDEN.forEach((f) => expect(Object.keys(u)).not.toContain(f));
      });
    }, 60000);

    it('kcUser requires authentication', async () => {
      const anon = axios.create({ baseURL: KONG_URL, validateStatus: () => true });
      const resp = await anon.get('/api/v1/users/kcUser?id=whatever');
      expect(resp.status).toBe(401);
    }, 30000);

    it('the directory requires a project id rather than defaulting to something', async () => {
      const c = clientFor(await colleague.getToken());
      const resp = await c.get('/api/v1/users/directory', { headers: { 'X-Project-Id': '' } });
      expect(resp.status).toBe(400);
    }, 30000);
  });
});

afterAll(() => {
  purgeTrackedFixtures();
});
