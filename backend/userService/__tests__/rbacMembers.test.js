const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { createTestPersona, nonexistentUserId } = require('../../shared/test-utils/keycloakTestPersona');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

// WP-022 — release-blocking: closes the members[] privilege hole
// (orchestrator-confirmed live: POST { members: [{userId:
// "ARBITRARY-OUTSIDER", role: "admin"}] } used to store exactly that, with
// zero authorization check) and proves the manage_members/manage_project
// persona rules on userService's own project/member routes. Companion to
// testRepoService/__tests__/rbacMatrix.test.js, which covers content
// read/write/delete instead.

const KONG_URL = process.env.TEST_KONG_URL || 'http://localhost:8000';
const runId = Date.now();

function decodeJwtPayload(token) {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

describe('RBAC: members[] privilege hole + manage_members/manage_project (WP-022, release-blocking)', () => {
  let adminToken;
  let adminSub;
  let adminClient;

  beforeAll(async () => {
    adminToken = await getServiceToken();
    adminSub = decodeJwtPayload(adminToken).sub;
    adminClient = axios.create({ baseURL: KONG_URL, headers: { Authorization: `Bearer ${adminToken}` }, validateStatus: () => true });
  });

  describe('members[] hole, half 1: client-supplied members[] at creation is never trusted', () => {
    let orgId;
    let projectMongoId;

    afterEach(async () => {
      if (projectMongoId) await adminClient.delete(`/api/v1/projects/${projectMongoId}`);
      if (orgId) await adminClient.delete(`/api/v1/organizations/${orgId}`);
      projectMongoId = undefined;
      orgId = undefined;
    });

    it('an authenticated caller cannot grant admin to an arbitrary outsider via POST /projects members[]', async () => {
      const orgResp = await adminClient.post('/api/v1/organizations', {
        name: `WP-022 members-hole org ${runId}`,
        key: `wp022-members-hole-org-${runId}`
      });
      expect(orgResp.status).toBe(201);
      orgId = orgResp.data.data._id;
      trackOrganization(orgId);

      // The orchestrator's exact probe: an arbitrary, non-existent outsider
      // handed 'admin' via the creation payload.
      const projResp = await adminClient.post('/api/v1/projects', {
        name: `WP-022 members-hole project ${runId}`,
        key: `wp022-members-hole-proj-${runId}`,
        organizationId: orgId,
        members: [{ userId: 'ARBITRARY-OUTSIDER', role: 'admin' }]
      });
      expect(projResp.status).toBe(201);
      projectMongoId = projResp.data.data._id;
      trackProject(projectMongoId);

      const members = projResp.data.data.members;
      expect(members.some((m) => m.userId === 'ARBITRARY-OUTSIDER')).toBe(false);
      // Only the real, token-derived creator is a member, and only as admin.
      expect(members).toEqual([expect.objectContaining({ userId: adminSub, role: 'admin' })]);
    });
  });

  describe('members[] hole, half 2: a non-Keycloak-identity userId is rejected by addMember', () => {
    let orgId;
    let projectMongoId;

    beforeAll(async () => {
      const orgResp = await adminClient.post('/api/v1/organizations', {
        name: `WP-022 members-hole2 org ${runId}`,
        key: `wp022-members-hole2-org-${runId}`
      });
      expect(orgResp.status).toBe(201);
      orgId = orgResp.data.data._id;
      trackOrganization(orgId);

      const projResp = await adminClient.post('/api/v1/projects', {
        name: `WP-022 members-hole2 project ${runId}`,
        key: `wp022-members-hole2-proj-${runId}`,
        organizationId: orgId
      });
      expect(projResp.status).toBe(201);
      projectMongoId = projResp.data.data._id;
      trackProject(projectMongoId);
    });

    afterAll(async () => {
      if (projectMongoId) await adminClient.delete(`/api/v1/projects/${projectMongoId}`);
      if (orgId) await adminClient.delete(`/api/v1/organizations/${orgId}`);
    });

    it('rejects a syntactically valid but nonexistent userId (400, not silently stored)', async () => {
      const fakeId = nonexistentUserId();
      const resp = await adminClient.post(`/api/v1/projects/${projectMongoId}/members`, {
        userId: fakeId,
        role: 'viewer'
      });
      expect(resp.status).toBe(400);
      expect(resp.data.success).toBe(false);

      // Confirm it truly was not stored, not just a 400 with a side effect.
      const getResp = await adminClient.get(`/api/v1/projects/${projectMongoId}`);
      expect(getResp.data.data.members.some((m) => m.userId === fakeId)).toBe(false);
    });

    it('accepts a real Keycloak identity', async () => {
      const persona = await createTestPersona('real-identity-check');
      try {
        const resp = await adminClient.post(`/api/v1/projects/${projectMongoId}/members`, {
          userId: persona.userId,
          role: 'viewer'
        });
        expect(resp.status).toBe(200);
        expect(resp.data.data.members.some((m) => m.userId === persona.userId)).toBe(true);
      } finally {
        await persona.cleanup();
      }
    });
  });

  describe('manage_members / manage_project persona rules', () => {
    let orgId;
    let projectMongoId;
    const p = {}; // role -> { persona, client }

    beforeAll(async () => {
      const orgResp = await adminClient.post('/api/v1/organizations', {
        name: `WP-022 persona-rules org ${runId}`,
        key: `wp022-persona-rules-org-${runId}`
      });
      expect(orgResp.status).toBe(201);
      orgId = orgResp.data.data._id;
      trackOrganization(orgId);

      const projResp = await adminClient.post('/api/v1/projects', {
        name: `WP-022 persona-rules project ${runId}`,
        key: `wp022-persona-rules-proj-${runId}`,
        organizationId: orgId
      });
      expect(projResp.status).toBe(201);
      projectMongoId = projResp.data.data._id;
      trackProject(projectMongoId);

      for (const role of ['manager', 'contributor', 'viewer']) {
        const persona = await createTestPersona(`members-${role}`);
        const addResp = await adminClient.post(`/api/v1/projects/${projectMongoId}/members`, {
          userId: persona.userId,
          role
        });
        expect(addResp.status).toBe(200);
        const token = await persona.getToken();
        p[role] = {
          persona,
          client: axios.create({ baseURL: KONG_URL, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true })
        };
      }
    }, 30000);

    afterAll(async () => {
      for (const role of Object.keys(p)) {
        await p[role].persona.cleanup().catch(() => {});
      }
      if (projectMongoId) await adminClient.delete(`/api/v1/projects/${projectMongoId}`);
      if (orgId) await adminClient.delete(`/api/v1/organizations/${orgId}`);
    }, 20000);

    it('viewer cannot add a member (403) -- lacks manage_members entirely', async () => {
      const persona = await createTestPersona('viewer-add-attempt');
      try {
        const resp = await p.viewer.client.post(`/api/v1/projects/${projectMongoId}/members`, {
          userId: persona.userId,
          role: 'viewer'
        });
        expect(resp.status).toBe(403);
      } finally {
        await persona.cleanup();
      }
    });

    it('manager CAN add an ordinary (non-admin) member -- manage_members is granted to manager', async () => {
      const persona = await createTestPersona('manager-add-ok');
      try {
        const resp = await p.manager.client.post(`/api/v1/projects/${projectMongoId}/members`, {
          userId: persona.userId,
          role: 'contributor'
        });
        expect(resp.status).toBe(200);
      } finally {
        await persona.cleanup();
      }
    });

    it('manager CANNOT grant the admin role to anyone (403) -- escalation guard beyond the flat matrix', async () => {
      const persona = await createTestPersona('manager-escalate-attempt');
      try {
        const resp = await p.manager.client.post(`/api/v1/projects/${projectMongoId}/members`, {
          userId: persona.userId,
          role: 'admin'
        });
        expect(resp.status).toBe(403);
      } finally {
        await persona.cleanup();
      }
    });

    it('manager CANNOT remove the project admin (403) -- removing an admin is admin-only', async () => {
      const resp = await p.manager.client.delete(`/api/v1/projects/${projectMongoId}/members/${adminSub}`);
      expect(resp.status).toBe(403);
    });


    it('manager cannot rename/archive the project (403) -- manage_project is admin-only', async () => {
      const putResp = await p.manager.client.put(`/api/v1/projects/${projectMongoId}`, { name: 'renamed by manager' });
      expect(putResp.status).toBe(403);

      const delResp = await p.manager.client.delete(`/api/v1/projects/${projectMongoId}`);
      expect(delResp.status).toBe(403);
    });

    it('contributor cannot manage members at all (403)', async () => {
      const persona = await createTestPersona('contributor-add-attempt');
      try {
        const resp = await p.contributor.client.post(`/api/v1/projects/${projectMongoId}/members`, {
          userId: persona.userId,
          role: 'viewer'
        });
        expect(resp.status).toBe(403);
      } finally {
        await persona.cleanup();
      }
    });

    it('admin (the real project owner) CAN rename the project', async () => {
      const resp = await adminClient.put(`/api/v1/projects/${projectMongoId}`, { name: `WP-022 renamed by admin ${runId}` });
      expect(resp.status).toBe(200);
      expect(resp.data.data.name).toBe(`WP-022 renamed by admin ${runId}`);
    });
  });

  describe('deliberate design decision: the last admin CAN fully vacate a project, and it stays recoverable', () => {
    // Considered and dropped a "cannot demote/remove the last remaining
    // admin" guard (see controllers/projects.js's updateMemberRole/
    // removeMember comments): it broke WP-021's tenantIsolation.test.js,
    // which legitimately revokes its own fixture identity's sole-admin
    // membership to prove non-member behavior. Once dropped, a project can
    // genuinely end up with zero members -- proven recoverable here via
    // middleware/projectAuthorize.js's ownerless-project bootstrap path,
    // rather than left as an unverified side effect.
    let orgId;

    afterAll(async () => {
      // Project cleanup happens inside the test itself, via whichever
      // identity holds admin at that point (adminClient no longer does,
      // once ownership is handed to the rescuer persona below). Org
      // deletion is unaffected -- Organization has no membership/RBAC
      // concept (out of this WP's scope), so adminClient can always do it.
      if (orgId) await adminClient.delete(`/api/v1/organizations/${orgId}`);
    });

    it('removing the sole admin leaves zero members, and the project remains reachable and recoverable', async () => {
      const orgResp = await adminClient.post('/api/v1/organizations', {
        name: `WP-022 vacate-recovery org ${runId}`,
        key: `wp022-vacate-recovery-org-${runId}`
      });
      expect(orgResp.status).toBe(201);
      orgId = orgResp.data.data._id;
      trackOrganization(orgId);

      const projResp = await adminClient.post('/api/v1/projects', {
        name: `WP-022 vacate-recovery project ${runId}`,
        key: `wp022-vacate-recovery-proj-${runId}`,
        organizationId: orgId
      });
      expect(projResp.status).toBe(201);
      const projectMongoId = projResp.data.data._id;
      trackProject(projectMongoId);

      // The sole admin (adminSub, the creator) removes their own membership.
      const removeResp = await adminClient.delete(`/api/v1/projects/${projectMongoId}/members/${adminSub}`);
      expect(removeResp.status).toBe(200);
      expect(removeResp.data.data.members).toEqual([]);

      // Still reachable via the unfiltered list (never orphaned/deleted) --
      // just genuinely ownerless now.
      const listResp = await adminClient.get('/api/v1/projects');
      expect(listResp.data.data.some((p) => p._id === projectMongoId)).toBe(true);

      // GET /:id and every other action correctly 403 -- nobody is a member.
      const getResp = await adminClient.get(`/api/v1/projects/${projectMongoId}`);
      expect(getResp.status).toBe(403);

      // But manage_members specifically works for ANY authenticated caller
      // on an ownerless project -- the only path that can ever bring it
      // back. A brand-new persona claims it here (not the original admin),
      // proving this isn't "the creator has a secret backdoor" but a real
      // ownerless-project bootstrap rule.
      const rescuer = await createTestPersona('ownerless-rescue');
      try {
        const rescuerToken = await rescuer.getToken();
        const rescuerClient = axios.create({
          baseURL: KONG_URL,
          headers: { Authorization: `Bearer ${rescuerToken}` },
          validateStatus: () => true
        });

        const claimResp = await rescuerClient.post(`/api/v1/projects/${projectMongoId}/members`, {
          userId: rescuer.userId,
          role: 'admin'
        });
        expect(claimResp.status).toBe(200);
        expect(claimResp.data.data.members).toEqual([
          expect.objectContaining({ userId: rescuer.userId, role: 'admin' })
        ]);

        // Now a real member again -- ordinary reads/writes work.
        const getAfterResp = await rescuerClient.get(`/api/v1/projects/${projectMongoId}`);
        expect(getAfterResp.status).toBe(200);

        // Clean up via the rescuer -- the only identity with any authority
        // over this project by this point.
        await rescuerClient.delete(`/api/v1/projects/${projectMongoId}`);
      } finally {
        await rescuer.cleanup();
      }
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
