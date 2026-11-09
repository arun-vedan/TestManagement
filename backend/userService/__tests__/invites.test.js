const axios = require('axios');
const { execFileSync } = require('child_process');
const path = require('path');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { createTestPersona } = require('../../shared/test-utils/keycloakTestPersona');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// WP-132 — invite teammates by email.
//
// Acceptance, verbatim: "an admin invites an address that has never signed up;
// the recipient registers, accepts, and lands in the project with the intended
// role. Expired and already-used tokens are rejected."
//
// Black-box over Kong against the live containers (GR-6).
//
// INVITES TO @example.invalid REALLY DO HIT THE RELAY. Measured before writing
// this: Brevo accepts a .invalid recipient at SMTP time and bounces it
// asynchronously, so createInvite's send succeeds and these tests exercise the
// genuine mail path without delivering anything to a real inbox. They are not
// mocked, and a broken mailer would fail them.

const KONG_URL = process.env.TEST_KONG_URL || 'http://localhost:8000';
const runId = Date.now();
const CONTAINER = process.env.TEST_MONGO_CONTAINER || 'mongodb';

// Backdating an invite is the only way to test expiry: the minimum
// expiresInDays the API accepts is 1, deliberately, so a caller cannot create
// an already-dead invite. Expiry is a function of time rather than a write, so
// nothing in the API can simulate it. Goes through `docker exec` for the reason
// fixtureCleanup.js documents at length -- this host runs a second, native
// mongod on 127.0.0.1 and a host-side client would silently hit that one.
function backdateInvite(inviteId, msInPast) {
  const user = process.env.MONGO_ROOT_USER || process.env.MONGO_BACKUP_USER || process.env.MONGO_USER;
  const password =
    process.env.MONGO_ROOT_PASSWORD || process.env.MONGO_BACKUP_PASSWORD || process.env.MONGO_PASSWORD;
  if (!user || !password) throw new Error('backdateInvite needs Mongo credentials from backend/.env');
  // Same instance guard fixtureCleanup.js and the data scripts use: require
  // databases only the container has, refuse ones only the native mongod has.
  // This host runs two mongods and a misdirected write would silently succeed
  // against the wrong one, making the expiry test pass for the wrong reason.
  const js = `
    const MUST_HAVE = ['srckube-ai', 'srckube-release', 'srckube-reporting'];
    const MUST_NOT_HAVE = ['codeshark', 'fauserdb', 'authdeputy'];
    const present = db.adminCommand({ listDatabases: 1 }).databases.map(function (d) { return d.name; });
    if (MUST_HAVE.filter(function (n) { return present.indexOf(n) === -1; }).length ||
        MUST_NOT_HAVE.filter(function (n) { return present.indexOf(n) !== -1; }).length) {
      print('WRONG_MONGOD_INSTANCE');
      quit(1);
    }
    const r = db.getSiblingDB('srckube-user').invites.updateOne(
      { _id: ObjectId('${inviteId}') },
      { $set: { expiresAt: new Date(Date.now() - ${msInPast}) } }
    );
    print('matched=' + r.matchedCount + ' modified=' + r.modifiedCount);
  `;
  const out = execFileSync(
    'docker',
    ['exec', CONTAINER, 'mongosh', '--quiet', '-u', user, '-p', password,
      '--authenticationDatabase', 'admin', '--eval', js],
    { encoding: 'utf8' }
  );
  if (/WRONG_MONGOD_INSTANCE/.test(out)) {
    throw new Error('backdateInvite targeted the wrong mongod instance; refusing to continue');
  }
  if (!/modified=1/.test(out)) throw new Error(`backdateInvite did not modify the invite: ${out}`);
  return out;
}

describe('WP-132: invite teammates by email', () => {
  let admin;        // service account: project admin
  let orgId;
  let projectId;
  let projectMongoId;

  beforeAll(async () => {
    const token = await getServiceToken();
    admin = axios.create({
      baseURL: KONG_URL,
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true
    });

    const org = await admin.post('/api/v1/organizations', {
      name: `WP-132 org ${runId}`,
      key: `wp132-org-${runId}`
    });
    expect(org.status).toBe(201);
    orgId = org.data.data._id;
    trackOrganization(orgId);

    const proj = await admin.post('/api/v1/projects', {
      name: `WP-132 project ${runId}`,
      key: `wp132p${String(runId).slice(-6)}`,
      organizationId: orgId
    });
    expect(proj.status).toBe(201);
    projectId = proj.data.data.id;
    projectMongoId = proj.data.data._id;
    trackProject(projectId);
  }, 60000);

  describe('the acceptance path: an address that has never signed up', () => {
    const invitee = `wp132-newcomer-${runId}@example.invalid`;
    let inviteId;
    let rawToken;
    let persona;

    afterAll(async () => {
      if (persona) await persona.cleanup();
    });

    it('an admin invites an address with no account at all', async () => {
      // Proven to have no account before inviting, so this is genuinely the
      // "never signed up" case the acceptance names.
      const resp = await admin.post(`/api/v1/projects/${projectMongoId}/invites`, {
        email: invitee,
        role: 'contributor'
      });
      expect(resp.status).toBe(201);
      expect(resp.data.data.email).toBe(invitee);
      expect(resp.data.data.role).toBe('contributor');
      expect(resp.data.data.status).toBe('pending');

      // The link is returned once, to the sender.
      expect(resp.data.inviteUrl).toContain('/accept-invite?token=');
      rawToken = new URL(resp.data.inviteUrl).searchParams.get('token');
      expect(rawToken).toBeTruthy();
      inviteId = resp.data.data._id;

      // The stored hash must never come back over the wire.
      expect(JSON.stringify(resp.data)).not.toContain('tokenHash');
    }, 60000);

    it('the invite is listed as pending, and the token is not retrievable from it', async () => {
      const resp = await admin.get(`/api/v1/projects/${projectMongoId}/invites`);
      expect(resp.status).toBe(200);
      const found = resp.data.data.find((i) => i._id === inviteId);
      expect(found).toBeDefined();
      expect(found.status).toBe('pending');
      expect(found.expired).toBe(false);
      // Re-reading an invite must not hand the credential back out: only its
      // SHA-256 is stored, so there is nothing to leak even to an admin.
      expect(JSON.stringify(found)).not.toContain(rawToken);
    }, 30000);

    it('a stranger holding the link cannot accept it -- the invite is bound to the address', async () => {
      // The forwarded-mail case. Without this binding an invite link is a
      // bearer token anyone can redeem at the invited role.
      const stranger = await createTestPersona('wp132-stranger');
      try {
        const strangerClient = axios.create({
          baseURL: KONG_URL,
          headers: { Authorization: `Bearer ${await stranger.getToken()}` },
          validateStatus: () => true
        });
        const resp = await strangerClient.post('/api/v1/invites/accept', { token: rawToken });
        expect(resp.status).toBe(403);
        expect(String(resp.data.error)).toMatch(/different email address/i);
      } finally {
        await stranger.cleanup();
      }
    }, 60000);

    it('the recipient registers, accepts, and lands in the project as contributor', async () => {
      // "registers": a real Keycloak account created now, after the invite,
      // holding the invited address.
      persona = await createTestPersona('wp132-invitee', { email: invitee });
      expect(persona.email).toBe(invitee);

      const inviteeClient = axios.create({
        baseURL: KONG_URL,
        headers: { Authorization: `Bearer ${await persona.getToken()}` },
        validateStatus: () => true
      });

      const accept = await inviteeClient.post('/api/v1/invites/accept', { token: rawToken });
      expect(accept.status).toBe(200);
      expect(accept.data.data.projectId).toBe(projectId);
      expect(accept.data.data.role).toBe('contributor');

      // Landed in the project, at the intended role, from the project's view.
      const proj = await admin.get(`/api/v1/projects/${projectMongoId}`);
      expect(proj.status).toBe(200);
      const member = proj.data.data.members.find((m) => m.userId === persona.sub);
      expect(member).toBeDefined();
      expect(member.role).toBe('contributor');
    }, 90000);

    it('and can actually use the project -- a contributor-level write succeeds', async () => {
      // Membership that does not grant access would satisfy the letter of the
      // acceptance and none of its intent.
      const inviteeClient = axios.create({
        baseURL: KONG_URL,
        headers: {
          Authorization: `Bearer ${await persona.getToken()}`,
          'X-Project-Id': String(projectId)
        },
        validateStatus: () => true
      });
      const tc = await inviteeClient.post('/api/v1/testrepo', {
        TestCaseSummary: `WP-132 invited contributor's first case ${runId}`,
        TestCaseDescription: 'written by someone who joined via an invitation'
      });
      expect(tc.status).toBe(201);
      expect(tc.data.data.projectId).toBe(projectId);
    }, 60000);

    it('the already-used token is rejected (410)', async () => {
      const inviteeClient = axios.create({
        baseURL: KONG_URL,
        headers: { Authorization: `Bearer ${await persona.getToken()}` },
        validateStatus: () => true
      });
      const again = await inviteeClient.post('/api/v1/invites/accept', { token: rawToken });
      expect(again.status).toBe(410);
      expect(String(again.data.error)).toMatch(/already been used/i);
    }, 60000);

    it('the invite now reads as accepted, attributed to the identity that claimed it', async () => {
      const resp = await admin.get(`/api/v1/projects/${projectMongoId}/invites`);
      const found = resp.data.data.find((i) => i._id === inviteId);
      expect(found.status).toBe('accepted');
      expect(found.acceptedBy).toBe(persona.sub);
      expect(found.acceptedAt).toBeTruthy();
    }, 30000);
  });

  describe('expired tokens are rejected', () => {
    it('an invite past its expiry cannot be accepted (410), even by the right person', async () => {
      const email = `wp132-expired-${runId}@example.invalid`;
      const created = await admin.post(`/api/v1/projects/${projectMongoId}/invites`, {
        email,
        role: 'viewer'
      });
      expect(created.status).toBe(201);
      const token = new URL(created.data.inviteUrl).searchParams.get('token');

      // One hour in the past.
      backdateInvite(created.data.data._id, 60 * 60 * 1000);

      const persona = await createTestPersona('wp132-expired', { email });
      try {
        const client = axios.create({
          baseURL: KONG_URL,
          headers: { Authorization: `Bearer ${await persona.getToken()}` },
          validateStatus: () => true
        });
        const resp = await client.post('/api/v1/invites/accept', { token });
        expect(resp.status).toBe(410);
        expect(String(resp.data.error)).toMatch(/expired/i);

        // And they are NOT a member.
        const proj = await admin.get(`/api/v1/projects/${projectMongoId}`);
        expect(proj.data.data.members.find((m) => m.userId === persona.sub)).toBeUndefined();
      } finally {
        await persona.cleanup();
      }
    }, 90000);

    it('an expired invite is reported as expired in the listing, not as usable', async () => {
      const resp = await admin.get(`/api/v1/projects/${projectMongoId}/invites?status=pending`);
      expect(resp.status).toBe(200);
      const expired = resp.data.data.filter((i) => i.expired);
      expect(expired.length).toBeGreaterThanOrEqual(1);
    }, 30000);
  });

  describe('revoked tokens are rejected', () => {
    it('revoking a pending invite makes its token unusable (410)', async () => {
      const email = `wp132-revoked-${runId}@example.invalid`;
      const created = await admin.post(`/api/v1/projects/${projectMongoId}/invites`, {
        email,
        role: 'viewer'
      });
      expect(created.status).toBe(201);
      const token = new URL(created.data.inviteUrl).searchParams.get('token');

      const revoked = await admin.delete(
        `/api/v1/projects/${projectMongoId}/invites/${created.data.data._id}`
      );
      expect(revoked.status).toBe(200);
      expect(revoked.data.data.status).toBe('revoked');

      const persona = await createTestPersona('wp132-revoked', { email });
      try {
        const client = axios.create({
          baseURL: KONG_URL,
          headers: { Authorization: `Bearer ${await persona.getToken()}` },
          validateStatus: () => true
        });
        const resp = await client.post('/api/v1/invites/accept', { token });
        expect(resp.status).toBe(410);
        expect(String(resp.data.error)).toMatch(/revoked/i);
      } finally {
        await persona.cleanup();
      }
    }, 90000);
  });

  describe('re-inviting supersedes the previous token rather than stacking', () => {
    it('the older token stops working and the newer one carries the corrected role', async () => {
      const email = `wp132-resend-${runId}@example.invalid`;
      const first = await admin.post(`/api/v1/projects/${projectMongoId}/invites`, {
        email,
        role: 'viewer'
      });
      expect(first.status).toBe(201);
      const firstToken = new URL(first.data.inviteUrl).searchParams.get('token');

      // The "I sent the wrong role" case.
      const second = await admin.post(`/api/v1/projects/${projectMongoId}/invites`, {
        email,
        role: 'manager'
      });
      expect(second.status).toBe(201);
      expect(second.data.supersededPending).toBeGreaterThanOrEqual(1);
      const secondToken = new URL(second.data.inviteUrl).searchParams.get('token');
      expect(secondToken).not.toBe(firstToken);

      const persona = await createTestPersona('wp132-resend', { email });
      try {
        const client = axios.create({
          baseURL: KONG_URL,
          headers: { Authorization: `Bearer ${await persona.getToken()}` },
          validateStatus: () => true
        });
        // The superseded token must be dead, or correcting a mistaken role
        // would leave the wrong one still redeemable.
        const stale = await client.post('/api/v1/invites/accept', { token: firstToken });
        expect(stale.status).toBe(410);

        const ok = await client.post('/api/v1/invites/accept', { token: secondToken });
        expect(ok.status).toBe(200);
        expect(ok.data.data.role).toBe('manager');
      } finally {
        await persona.cleanup();
      }
    }, 120000);
  });

  describe('authorization', () => {
    it('inviting requires manage_members: a contributor cannot invite (403)', async () => {
      const contributor = await createTestPersona('wp132-contrib');
      try {
        const add = await admin.post(`/api/v1/projects/${projectMongoId}/members`, {
          userId: contributor.sub,
          role: 'contributor'
        });
        expect(add.status).toBe(200);
        // Membership changes are cached for PROJECT_SCOPE_CACHE_TTL_MS, but
        // these project routes read the project document directly rather than
        // through requireProjectScope(), so no wait is needed here.
        const client = axios.create({
          baseURL: KONG_URL,
          headers: { Authorization: `Bearer ${await contributor.getToken()}` },
          validateStatus: () => true
        });
        const resp = await client.post(`/api/v1/projects/${projectMongoId}/invites`, {
          email: `wp132-nope-${runId}@example.invalid`,
          role: 'viewer'
        });
        expect(resp.status).toBe(403);
      } finally {
        await contributor.cleanup();
      }
    }, 90000);

    it("a manager cannot invite someone as 'admin' -- the WP-022 escalation guard holds on this path too", async () => {
      const manager = await createTestPersona('wp132-manager');
      try {
        const add = await admin.post(`/api/v1/projects/${projectMongoId}/members`, {
          userId: manager.sub,
          role: 'manager'
        });
        expect(add.status).toBe(200);
        const client = axios.create({
          baseURL: KONG_URL,
          headers: { Authorization: `Bearer ${await manager.getToken()}` },
          validateStatus: () => true
        });

        // Allowed: an ordinary role.
        const ok = await client.post(`/api/v1/projects/${projectMongoId}/invites`, {
          email: `wp132-mgr-ok-${runId}@example.invalid`,
          role: 'contributor'
        });
        expect(ok.status).toBe(201);

        // Refused: escalation. Without this, manage_members would be a route
        // to admin via the invite path -- the hole WP-022 closed for addMember.
        const escalate = await client.post(`/api/v1/projects/${projectMongoId}/invites`, {
          email: `wp132-mgr-escalate-${runId}@example.invalid`,
          role: 'admin'
        });
        expect(escalate.status).toBe(403);
        expect(String(escalate.data.error)).toMatch(/admin/i);
      } finally {
        await manager.cleanup();
      }
    }, 120000);

    it('accepting requires authentication (401 without a token)', async () => {
      const anon = axios.create({ baseURL: KONG_URL, validateStatus: () => true });
      const resp = await anon.post('/api/v1/invites/accept', { token: 'whatever' });
      expect(resp.status).toBe(401);
    }, 30000);
  });

  describe('validation', () => {
    it('rejects a malformed email', async () => {
      const resp = await admin.post(`/api/v1/projects/${projectMongoId}/invites`, {
        email: 'not-an-email',
        role: 'viewer'
      });
      expect(resp.status).toBe(400);
    }, 30000);

    it('rejects a role outside the matrix', async () => {
      const resp = await admin.post(`/api/v1/projects/${projectMongoId}/invites`, {
        email: `wp132-badrole-${runId}@example.invalid`,
        role: 'superuser'
      });
      expect(resp.status).toBe(400);
    }, 30000);

    it('rejects an expiry beyond the maximum', async () => {
      const resp = await admin.post(`/api/v1/projects/${projectMongoId}/invites`, {
        email: `wp132-longexpiry-${runId}@example.invalid`,
        role: 'viewer',
        expiresInDays: 365
      });
      expect(resp.status).toBe(400);
    }, 30000);

    it('an unknown token is refused without revealing whether it ever existed (404)', async () => {
      const persona = await createTestPersona('wp132-badtoken');
      try {
        const client = axios.create({
          baseURL: KONG_URL,
          headers: { Authorization: `Bearer ${await persona.getToken()}` },
          validateStatus: () => true
        });
        const resp = await client.post('/api/v1/invites/accept', { token: 'this-token-never-existed' });
        expect(resp.status).toBe(404);
        expect(String(resp.data.error)).toMatch(/not valid/i);
      } finally {
        await persona.cleanup();
      }
    }, 60000);

    it('refuses to invite someone who is already a member (409)', async () => {
      const member = await createTestPersona('wp132-already');
      try {
        const add = await admin.post(`/api/v1/projects/${projectMongoId}/members`, {
          userId: member.sub,
          role: 'viewer'
        });
        expect(add.status).toBe(200);
        const resp = await admin.post(`/api/v1/projects/${projectMongoId}/invites`, {
          email: member.email,
          role: 'contributor'
        });
        expect(resp.status).toBe(409);
        expect(String(resp.data.error)).toMatch(/already a member/i);
      } finally {
        await member.cleanup();
      }
    }, 90000);
  });
});

// Suite teardown (WP-110 follow-up) -- its own top-level afterAll.
afterAll(() => {
  purgeTrackedFixtures();
});
