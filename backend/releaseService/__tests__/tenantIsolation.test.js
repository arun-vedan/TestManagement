const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { PROJECT_ID_HEADER } = require('@srckube/service-core');
// WP-022 landed concurrently with this suite's original version and added a
// "last remaining admin of a project can't be demoted/removed" guard to
// userService's removeMember (backend/userService/controllers/projects.js,
// commit c3531ea) -- a real, deliberate business rule, not a bug. This
// suite's section 2 needs to fully revoke the test identity's membership in
// Project B, which is impossible if it's B's only (and therefore last)
// admin. Fixed by adding a second, real, disposable Keycloak persona as a
// co-admin of B before the revoke, using the test infrastructure WP-022
// built for exactly this kind of need (read-only import of their shared
// test-utils module, no modification to it).
const { createTestPersona } = require('../../shared/test-utils/keycloakTestPersona');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

// WP-025 — Multi-tenancy isolation suite for releaseService, built
// project-scoped from birth (dispatch brief). Same design as
// backend/{testRepoService,requirementService,defectService}/__tests__/
// tenantIsolation.test.js (WP-021): only one real Keycloak identity is
// available to this harness, so isolation is proven along two independent
// axes -- query-level filtering (member of both projects) and
// membership-level authorization (member of only one).
//
// Project A = the seeded Default Project (id=1, WP-020 backfill).
// Project B = a fresh Organization+Project created by this suite and torn
// down in afterAll (org AND project both deleted -- the WP-021 suite this
// is modeled on left orphaned fixture documents behind in a past run per
// EXECUTION_LOG.md's hazard notes; this suite deletes both, not just
// revokes membership).

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';
const USER_SERVICE_URL = process.env.TEST_USER_SERVICE_URL || 'http://localhost:8000';
const DUMMY_ID = '000000000000000000000000';
const runId = Date.now();

function decodeJwtPayload(token) {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}

// requireProjectScope()'s in-process project-list cache is global to the
// container, not per-request. When this suite's file and a sibling
// __tests__ file run as concurrent Jest workers against the same container,
// a project this suite just created can momentarily be invisible to a
// request if the cache was populated a moment before this suite's create
// call landed. Retry a handful of times, well within the local/test TTL
// (2000ms, backend/.env), rather than flake on that race -- same fix as
// WP-021's isolation suites.
async function postWithCacheRetry(axiosClient, url, body, headers, { retries = 8, delayMs = 400 } = {}) {
  let resp;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    resp = await axiosClient.post(url, body, headers);
    if (resp.status !== 403) return resp;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return resp;
}

// Same cache race, but for afterAll's cleanup DELETE: section 2 revokes this
// identity's membership in B and waits out the cache TTL so the "not a
// member" state is genuinely cached; the outer afterAll's re-grant can then
// race against that same cache still holding the stale "not a member"
// snapshot for up to another TTL window, silently 403-ing the cleanup
// delete with nothing asserting on it. Retrying (like postWithCacheRetry)
// instead of a single best-effort call is what actually prevents an
// unreachable orphaned document once its project is deleted next — found by
// exactly this happening once during development of this suite (see
// EXECUTION_LOG.md's WP-025 report for the manual mongosh cleanup that was
// needed as a result).
async function deleteWithCacheRetry(axiosClient, url, headers, { retries = 8, delayMs = 400 } = {}) {
  let resp;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    resp = await axiosClient.delete(url, headers);
    if (resp.status !== 403) return resp;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return resp;
}

describe('releaseService tenant isolation (WP-025)', () => {
  let token;
  let sub;
  let client; // authed client for releaseService, no default X-Project-Id
  let userServiceClient;
  let projectAId;
  let projectBId;
  let projectBMongoId;
  let orgBId;
  let foreignReleaseId; // _id of a release created under project B
  let coAdmin; // real disposable Keycloak persona, co-admin of B (see the require() comment above)
  let coAdminClient; // authed as coAdmin, for actions `sub` can no longer perform on B after being revoked

  const withScope = (projectId) => ({ headers: { [PROJECT_ID_HEADER]: String(projectId) } });

  beforeAll(async () => {
    token = await getServiceToken();
    sub = decodeJwtPayload(token).sub;

    client = axios.create({
      baseURL: BASE_URL,
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true
    });
    userServiceClient = axios.create({
      baseURL: USER_SERVICE_URL,
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true
    });

    const listResp = await userServiceClient.get('/api/v1/projects');
    expect(listResp.status).toBe(200);
    const projectA = listResp.data.data.find((p) => p.id === 1);
    expect(projectA).toBeDefined();
    projectAId = projectA.id;
    const addToA = await userServiceClient.post(`/api/v1/projects/${projectA._id}/members`, {
      userId: sub,
      role: 'admin'
    });
    expect(addToA.status).toBe(200);

    const orgResp = await userServiceClient.post('/api/v1/organizations', {
      name: `WP-025 isolation org (release) ${runId}`,
      key: `wp025-iso-org-rel-${runId}`
    });
    expect(orgResp.status).toBe(201);
    orgBId = orgResp.data.data._id;
    trackOrganization(orgBId);

    const projResp = await userServiceClient.post('/api/v1/projects', {
      name: `WP-025 isolation project B (release) ${runId}`,
      key: `wp025-iso-proj-b-rel-${runId}`,
      organizationId: orgBId
    });
    expect(projResp.status).toBe(201);
    projectBId = projResp.data.data.id;
    trackProject(projectBId);
    projectBMongoId = projResp.data.data._id;
    trackProject(projectBMongoId);
    expect(projectBId).not.toBe(projectAId);

    // WP-022's members[] fix (commit c3531ea) means POST /api/v1/projects
    // ignores any client-supplied `members` -- only the token-derived
    // creator (`sub`) is seeded as admin. Add a second, real, disposable
    // admin so section 2 can fully revoke `sub`'s own membership later
    // without tripping WP-022's "last remaining admin can't be
    // demoted/removed" guard.
    coAdmin = await createTestPersona('release-iso');
    const addCoAdmin = await userServiceClient.post(`/api/v1/projects/${projectBMongoId}/members`, {
      userId: coAdmin.sub,
      role: 'admin'
    });
    expect(addCoAdmin.status).toBe(200);
    // A client authenticated as coAdmin -- used for the afterAll re-grant
    // below. `sub`'s OWN token can't do that re-grant: WP-022's escalation
    // guard requires the ACTOR to already be an admin of the target
    // project, and by the time afterAll runs, section 2 has removed `sub`
    // from B entirely. coAdmin is never revoked, so it can always let `sub`
    // back in.
    coAdminClient = axios.create({
      baseURL: USER_SERVICE_URL,
      headers: { Authorization: `Bearer ${await coAdmin.getToken()}` },
      validateStatus: () => true
    });

    const createResp = await postWithCacheRetry(
      client,
      '/api/v1/releases',
      { name: `WP-025 foreign release ${runId}` },
      withScope(projectBId)
    );
    expect(createResp.status).toBe(201);
    expect(createResp.data.data.projectId).toBe(projectBId);
    foreignReleaseId = createResp.data.data._id;
    // Membership in B is intentionally left in place here -- section 1
    // below needs it. Revoked in section 2's own beforeAll.
  }, 20000);

  afterAll(async () => {
    if (projectBMongoId && coAdminClient) {
      // Re-grant via coAdmin (see the beforeAll comment) so the cleanup
      // calls below (scoped to B, using `sub`'s own token) can authenticate
      // again -- `sub`'s own token can't perform this specific re-grant
      // once section 2 has revoked it from B.
      const regrant = await coAdminClient.post(`/api/v1/projects/${projectBMongoId}/members`, {
        userId: sub,
        role: 'admin'
      });
      if (regrant.status !== 200) {
        // eslint-disable-next-line no-console
        console.error(
          `WP-025 tenantIsolation cleanup: failed to re-grant 'sub' membership in project B ` +
          `(status ${regrant.status}) -- the release-delete cleanup below will likely 403 and leak ` +
          `a fixture document.`
        );
      }
      // requireProjectScope()'s cache may still hold "sub is not a member"
      // from section 2 -- give it a moment past the local/test TTL before
      // relying on the regrant taking effect on releaseService's side.
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    if (foreignReleaseId) {
      const delResp = await deleteWithCacheRetry(client, `/api/v1/releases/${foreignReleaseId}`, withScope(projectBId));
      if (delResp.status !== 200) {
        // Deleting project B below would make this document permanently
        // unreachable through the API (its projectId would no longer
        // resolve). Surface that loudly instead of silently leaking a
        // fixture — see the comment on deleteWithCacheRetry above.
        // eslint-disable-next-line no-console
        console.error(
          `WP-025 tenantIsolation cleanup: failed to delete foreign release ${foreignReleaseId} ` +
          `(status ${delResp.status}) before deleting its project -- this document is now orphaned ` +
          `and needs manual cleanup (see EXECUTION_LOG.md's hazard notes).`
        );
      }
    }
    if (projectBMongoId) {
      await userServiceClient.delete(`/api/v1/projects/${projectBMongoId}`);
    }
    if (orgBId) {
      await userServiceClient.delete(`/api/v1/organizations/${orgBId}`);
    }
    if (coAdmin) {
      await coAdmin.cleanup();
    }
  });

  describe('1. Query-level isolation (member of both A and B)', () => {
    it("GET list scoped to A does not include B's release", async () => {
      const resp = await client.get('/api/v1/releases', withScope(projectAId));
      expect(resp.status).toBe(200);
      expect(resp.data.data.some((r) => r._id === foreignReleaseId)).toBe(false);
    });

    it("GET list scoped to B DOES include B's release (positive control)", async () => {
      const resp = await client.get('/api/v1/releases', withScope(projectBId));
      expect(resp.status).toBe(200);
      expect(resp.data.data.some((r) => r._id === foreignReleaseId)).toBe(true);
    });

    it("GET single, scoped to A, 404s on B's release (not found, not leaked)", async () => {
      const resp = await client.get(`/api/v1/releases/${foreignReleaseId}`, withScope(projectAId));
      expect(resp.status).toBe(404);
      expect(resp.data.success).toBe(false);
    });

    it("PUT, scoped to A, cannot modify B's release", async () => {
      const resp = await client.put(
        `/api/v1/releases/${foreignReleaseId}`,
        { name: 'HIJACKED from project A' },
        withScope(projectAId)
      );
      expect(resp.status).toBe(404);

      const verify = await client.get(`/api/v1/releases/${foreignReleaseId}`, withScope(projectBId));
      expect(verify.data.data.name).toBe(`WP-025 foreign release ${runId}`);
    });

    it("gate-status, scoped to A, 404s on B's release", async () => {
      const resp = await client.get(`/api/v1/releases/${foreignReleaseId}/gate-status`, withScope(projectAId));
      expect(resp.status).toBe(404);
    });

    it("DELETE, scoped to A, cannot delete B's release", async () => {
      const resp = await client.delete(`/api/v1/releases/${foreignReleaseId}`, withScope(projectAId));
      expect(resp.status).toBe(404);

      const verify = await client.get(`/api/v1/releases/${foreignReleaseId}`, withScope(projectBId));
      expect(verify.status).toBe(200); // still there
    });
  });

  describe('2. Membership-level authorization (identity is NOT a member of B)', () => {
    beforeAll(async () => {
      const removeResp = await userServiceClient.delete(`/api/v1/projects/${projectBMongoId}/members/${sub}`);
      expect(removeResp.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }, 20000);

    it('claiming scope B outright is rejected with 403, not 404', async () => {
      const resp = await client.get('/api/v1/releases', withScope(projectBId));
      expect(resp.status).toBe(403);
      expect(resp.data.success).toBe(false);
    });

    it('a write attempt claiming scope B is rejected with 403', async () => {
      const resp = await client.post('/api/v1/releases', { name: 'should never be created' }, withScope(projectBId));
      expect(resp.status).toBe(403);
    });

    it('missing X-Project-Id header is rejected with 403', async () => {
      const resp = await client.get('/api/v1/releases');
      expect(resp.status).toBe(403);
    });

    it('an unknown projectId is rejected with 403', async () => {
      const resp = await client.get('/api/v1/releases', withScope(999999));
      expect(resp.status).toBe(403);
    });

    it('a non-integer projectId is rejected with 403', async () => {
      const resp = await client.get('/api/v1/releases', { headers: { [PROJECT_ID_HEADER]: 'not-a-number' } });
      expect(resp.status).toBe(403);
    });

    it(`GET /${DUMMY_ID} with valid scope A still 404s cleanly for a nonexistent id`, async () => {
      const resp = await client.get(`/api/v1/releases/${DUMMY_ID}`, withScope(projectAId));
      expect(resp.status).toBe(404);
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
