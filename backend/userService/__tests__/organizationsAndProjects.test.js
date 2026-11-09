const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { createTestPersona } = require('../../shared/test-utils/keycloakTestPersona');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

// WP-020: Organization & Project entities, homed in userService (ADR note
// in EXECUTION_LOG.md). Black-box HTTP tests per GR-6, run against both the
// container directly and through Kong (srckube-kong/kong.yml adds
// organizationRoute /api/v1/organizations and projectRoute /api/v1/projects
// to the existing "userService" Kong service).
//
// `members` is the anchor WP-022 (RBAC) will enforce against, so its shape
// and the create-project auto-admin-membership behavior are covered here.

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';
const KONG_URL = process.env.TEST_KONG_URL || 'http://localhost:8000';
const DUMMY_ID = '000000000000000000000000';

const client = axios.create({ baseURL: BASE_URL, validateStatus: () => true });
const kongClient = axios.create({ baseURL: KONG_URL, validateStatus: () => true });

function decodeJwtPayload(token) {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

describe('userService Organization & Project API (live, WP-020)', () => {
  describe('unauthenticated requests are rejected, not 404', () => {
    const protectedRoutes = [
      ['get', '/api/v1/organizations'],
      ['post', '/api/v1/organizations'],
      ['get', `/api/v1/organizations/${DUMMY_ID}`],
      ['put', `/api/v1/organizations/${DUMMY_ID}`],
      ['delete', `/api/v1/organizations/${DUMMY_ID}`],
      ['get', '/api/v1/projects'],
      ['post', '/api/v1/projects'],
      ['get', `/api/v1/projects/${DUMMY_ID}`],
      ['put', `/api/v1/projects/${DUMMY_ID}`],
      ['delete', `/api/v1/projects/${DUMMY_ID}`],
      ['post', `/api/v1/projects/${DUMMY_ID}/members`],
      ['put', `/api/v1/projects/${DUMMY_ID}/members/someUser`],
      ['delete', `/api/v1/projects/${DUMMY_ID}/members/someUser`]
    ];

    it.each(protectedRoutes)('%s %s rejects a request with no token', async (method, path) => {
      const resp = await client.request({ method, url: path });
      expect(resp.status).not.toBeLessThan(400);
      expect(resp.status).not.toBe(404);
    });
  });

  describe('authenticated round-trip through Kong: Organization -> Project -> membership', () => {
    let serviceToken;
    let ownUserId;
    let authedKong;
    let orgId;
    let projectMongoId;
    const runId = Date.now();
    // WP-022: addMember/updateMemberRole now verify the target userId is a
    // real Keycloak identity (closes the members[] hole -- see
    // controllers/projects.js and EXECUTION_LOG.md). The old hardcoded
    // 'wp020-fixture-user' string is not a real identity and would now be
    // correctly rejected (400), so member-management coverage below uses a
    // real, disposable Keycloak user created for this run instead.
    let secondMember;

    beforeAll(async () => {
      serviceToken = await getServiceToken();
      ownUserId = decodeJwtPayload(serviceToken).sub;
      authedKong = axios.create({
        baseURL: KONG_URL,
        headers: { Authorization: `Bearer ${serviceToken}` },
        validateStatus: () => true
      });
      secondMember = await createTestPersona('org-proj');
    });

    afterAll(async () => {
      // Best-effort cleanup so repeated runs don't accumulate orgs/projects.
      if (projectMongoId) {
        await authedKong.delete(`/api/v1/projects/${projectMongoId}`);
      }
      if (orgId) {
        await authedKong.delete(`/api/v1/organizations/${orgId}`);
      }
      if (secondMember) {
        await secondMember.cleanup();
      }
    });

    it('creates an Organization through Kong with a real token, ignoring any client-supplied createdBy', async () => {
      // WP-020b: createdBy is derived from the token's `sub` server-side.
      // A client-supplied createdBy in the body must be ignored, not
      // trusted or merged -- assert that directly by forging one here.
      const resp = await authedKong.post('/api/v1/organizations', {
        name: `WP-020 test org ${runId}`,
        key: `wp020-test-org-${runId}`,
        createdBy: 'forged-org-owner'
      });
      expect(resp.status).toBe(201);
      expect(resp.data.success).toBe(true);
      expect(resp.data.data.key).toBe(`wp020-test-org-${runId}`);
      expect(resp.data.data.createdBy).toBe(ownUserId);
      expect(resp.data.data.createdBy).not.toBe('forged-org-owner');
      orgId = resp.data.data._id;
      trackProject(orgId);
      trackOrganization(orgId);
      expect(typeof orgId).toBe('string');
    });

    it('rejects a Project without organizationId (400, not a 500)', async () => {
      const resp = await authedKong.post('/api/v1/projects', {
        name: 'No org project',
        key: `no-org-${runId}`
      });
      expect(resp.status).toBe(400);
      expect(resp.data.success).toBe(false);
    });

    it('creates a Project under the Organization, auto-adding the creator as an admin member, and ignores a forged createdBy', async () => {
      // WP-020b: a forged createdBy in the body must not be trusted -- the
      // stored document (and the auto-admin membership) must be anchored
      // to the token's `sub`, not this client-supplied value.
      const resp = await authedKong.post('/api/v1/projects', {
        name: `WP-020 test project ${runId}`,
        key: `wp020-test-project-${runId}`,
        organizationId: orgId,
        createdBy: 'somebody-else'
      });
      expect(resp.status).toBe(201);
      expect(resp.data.success).toBe(true);
      const project = resp.data.data;
      trackProject(project);
      expect(project.organizationId).toBe(orgId);
      expect(project.createdBy).toBe(ownUserId);
      expect(project.createdBy).not.toBe('somebody-else');
      expect(typeof project.id).toBe('number'); // legacy-compatible numeric id
      expect(Array.isArray(project.members)).toBe(true);
      // The forged createdBy must not have been granted admin membership either.
      expect(project.members).toEqual(
        expect.arrayContaining([expect.objectContaining({ userId: ownUserId, role: 'admin' })])
      );
      expect(project.members.some((m) => m.userId === 'somebody-else')).toBe(false);
      projectMongoId = project._id;
    });

    it('round-trips the Project via GET through Kong', async () => {
      const resp = await authedKong.get(`/api/v1/projects/${projectMongoId}`);
      expect(resp.status).toBe(200);
      expect(resp.data.data._id).toBe(projectMongoId);
      expect(resp.data.data.organizationId).toBe(orgId);
    });

    it('adds a second member with a non-admin role', async () => {
      const resp = await authedKong.post(`/api/v1/projects/${projectMongoId}/members`, {
        userId: secondMember.userId,
        role: 'contributor'
      });
      expect(resp.status).toBe(200);
      expect(resp.data.data.members).toEqual(
        expect.arrayContaining([expect.objectContaining({ userId: secondMember.userId, role: 'contributor' })])
      );
    });

    it('rejects an invalid role (400, not 500)', async () => {
      const resp = await authedKong.post(`/api/v1/projects/${projectMongoId}/members`, {
        userId: secondMember.userId,
        role: 'superuser'
      });
      expect(resp.status).toBe(400);
      expect(resp.data.success).toBe(false);
    });

    it('updates a member role', async () => {
      const resp = await authedKong.put(`/api/v1/projects/${projectMongoId}/members/${secondMember.userId}`, {
        role: 'manager'
      });
      expect(resp.status).toBe(200);
      expect(resp.data.data.members).toEqual(
        expect.arrayContaining([expect.objectContaining({ userId: secondMember.userId, role: 'manager' })])
      );
    });

    it('removes a member', async () => {
      const resp = await authedKong.delete(`/api/v1/projects/${projectMongoId}/members/${secondMember.userId}`);
      expect(resp.status).toBe(200);
      expect(resp.data.data.members.some((m) => m.userId === secondMember.userId)).toBe(false);
    });

    it('lists projects filtered by organizationId', async () => {
      const resp = await authedKong.get('/api/v1/projects', { params: { organizationId: orgId } });
      expect(resp.status).toBe(200);
      expect(resp.data.data.some((p) => p._id === projectMongoId)).toBe(true);
    });

    // WP-022 project-deletion-orphaning decision: DELETE archives, it never
    // removes the document. See controllers/projects.js's deleteProject
    // comment and EXECUTION_LOG.md for the full reasoning.
    describe('DELETE /api/v1/projects/:id soft-deletes (archives), never hard-removes', () => {
      it('flips status to archived and the project remains readable, not gone', async () => {
        const delResp = await authedKong.delete(`/api/v1/projects/${projectMongoId}`);
        expect(delResp.status).toBe(200);
        expect(delResp.data.data.status).toBe('archived');

        // Still reachable -- not orphaned, not 404.
        const getResp = await authedKong.get(`/api/v1/projects/${projectMongoId}`);
        expect(getResp.status).toBe(200);
        expect(getResp.data.data.status).toBe('archived');

        // Still present in the unfiltered list requireProjectScope() (WP-021)
        // depends on in every other service.
        const listResp = await authedKong.get('/api/v1/projects');
        expect(listResp.status).toBe(200);
        expect(listResp.data.data.some((p) => p._id === projectMongoId)).toBe(true);
      });

      it('is read-only while archived: a write is rejected (403), not silently applied', async () => {
        const resp = await authedKong.put(`/api/v1/projects/${projectMongoId}/members/${secondMember.userId}`, {
          role: 'contributor'
        });
        expect(resp.status).toBe(403);
      });

      it('is reversible: PUT status back to active restores full access (GR-3 one-line revert)', async () => {
        const restoreResp = await authedKong.put(`/api/v1/projects/${projectMongoId}`, { status: 'active' });
        expect(restoreResp.status).toBe(200);
        expect(restoreResp.data.data.status).toBe('active');

        const writeResp = await authedKong.post(`/api/v1/projects/${projectMongoId}/members`, {
          userId: secondMember.userId,
          role: 'viewer'
        });
        expect(writeResp.status).toBe(200);
      });
    });
  });
});

// Suite teardown (WP-110 follow-up) — declared as its own top-level afterAll
// ON PURPOSE, not inside the suite's existing one.
//
// Jest runs afterAll hooks outermost-last, so this fires AFTER the suite's own
// cleanup has finished. Order matters: an earlier attempt called this first,
// which hard-deleted the fixture project before the suite's own teardown tried
// to touch it -- that teardown then logged a warning after the test run had
// ended, and Jest failed the whole suite with "Cannot log after tests are
// done" even though every test passed.
//
// Why this is needed at all: DELETE /api/v1/projects only ARCHIVES (the
// deliberate WP-022 project-deletion-orphaning decision), while
// DELETE /api/v1/organizations hard-deletes. API-only teardown therefore left
// the project behind with its organization gone -- which is where this
// environment's 701 orphaned projects came from. See
// shared/test-utils/fixtureCleanup.js.
afterAll(() => {
  purgeTrackedFixtures();
});
