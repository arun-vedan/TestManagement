const http = require('http');
const { execFileSync } = require('child_process');
const axios = require('axios');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { dlqStreamName, PROJECT_ID_HEADER, CORRELATION_HEADER } = require('@srckube/service-core');
const { trackProject, trackOrganization, purgeTrackedFixtures } = require('../../shared/test-utils/fixtureCleanup');
// WP-101 -- Mongo credentials come from backend/.env, not from source.
const { mongoUri } = require('../../shared/test-utils/mongoCredentials');

// Rule 3 and the DLQ test below need to put a message directly onto a
// Redis Stream from THIS test process (there is no real HTTP endpoint that
// publishes a bare 'status-changed'/poisoned 'defect-assigned' event on
// demand). Deliberately NOT service-core's own publishEvent() for this:
// that would open an ioredis connection IN THE TEST PROCESS with no public
// teardown hook (`_resetEventsForTests` is a test-only escape hatch used by
// service-core's own suite, not exported through index.js, and no sibling
// events.test.js in this repo reaches into service-core's internals to get
// at it -- every other one triggers publishEvent() indirectly, inside the
// already-running service container, via a real HTTP call). `docker exec
// redis redis-cli XADD` -- the same tool defectService's events.test.js
// already uses for XGROUP DESTROY -- writes the identical wire format
// events.js's publishEvent() does (see its header comment: `payload`,
// JSON.stringify(the event), `correlationId`) with no client-side
// connection to leak or clean up.
function xaddEvent(stream, event) {
  const enriched = { ...event, publishedAt: new Date().toISOString() };
  return execFileSync(
    'docker',
    ['exec', 'redis', 'redis-cli', 'XADD', stream, '*', 'payload', JSON.stringify(enriched), 'correlationId', event.correlationId || ''],
    { encoding: 'utf8' }
  ).trim();
}

// One shared, explicitly-destroyed keep-alive agent for every axios client
// in this file -- same open-handle fix, same rationale, as api.test.js in
// this same directory (see that file's header comment): this suite's axios
// (1.20.0, a runtime dependency of the service itself) leaves a TCPWRAP
// referenced past response completion, which --detectOpenHandles confirms
// here too (defectClient.delete/execClient.delete's afterAll calls, seen
// while developing this suite). Destroyed once, in this file's own
// top-level afterAll below.
const httpAgent = new http.Agent({ keepAlive: true });

// WP-031 -- live, end-to-end proof that notificationService's THREE v1
// rules (consumers/notificationConsumer.js) actually fire, plus the DLQ
// acceptance criterion (a poisoned message must not block the consumer
// group). api.test.js covers this service's own REST contract in
// isolation; this suite drives the real producing services (defectService,
// testPlanExecutionService, userService) through their real HTTP APIs and
// polls notificationService's real REST surface (or, for rule 3, real
// Mongo -- see that describe block's header comment for why) to prove the
// full pipeline: producer -> Redis Stream -> notificationService's live
// consumer (running inside the `notificationservice` container right now,
// not a test-only consumer instance) -> Notification document -> visible
// through the API.
//
// "Visible to the assignee's session token" (the WP's acceptance
// criterion) is proven LITERALLY for rule 2 below: this suite's one real
// Keycloak identity (the service-account token from getServiceToken())
// assigns a defect TO ITSELF, then reads its own notification back through
// the exact same kind of session token a real user's browser would carry.
// Rules 1 and 3 are asymmetric:
//   - Rule 1's recipient is also this identity (TestExecution.assignedTo is
//     stamped from the creating token, see testPlanExecutionService's
//     createTestExecution), so it gets the same literal, session-token
//     proof as rule 2.
//   - Rule 3's recipient is a PROJECT MANAGER, and this harness has exactly
//     one real, mintable identity, already 'admin' on the one real project
//     (id=1) -- there is no second real login this suite can authenticate
//     as to prove "visible to THEIR session token" the same way. Rule 3's
//     block below explains the ground-truth alternative used instead and
//     why (rather than mutating the shared identity's own role, which
//     WP-022's admin-escalation guard makes irreversible via the API once
//     downgraded -- see that block's comment).

const NOTIFICATION_BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000'; // through Kong, matches api.test.js
const DEFECT_BASE_URL = process.env.TEST_DEFECT_BASE_URL || 'http://localhost:8000';
const TESTEXEC_BASE_URL = process.env.TEST_TESTEXEC_BASE_URL || 'http://localhost:8000';
const USER_SERVICE_URL = process.env.TEST_USER_SERVICE_URL || 'http://localhost:8000';
const DEFAULT_PROJECT_ID = 1;
const DEFECT_ASSIGNED_STREAM = 'defect-assigned'; // plain string literal -- see notificationConsumer.js's header comment for why this isn't in service-core/eventStreams.js
const STATUS_CHANGED_STREAM = 'status-changed';
const runId = Date.now();

function decodeJwtPayload(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Polls `fn` (any async predicate returning a truthy match or undefined)
// until it returns truthy or `timeoutMs` elapses -- needed everywhere here
// because the live consumer's read loop is a background BLOCK 5000ms poll
// (notificationConsumer.js's startNotificationConsumers -> subscribe()'s
// default blockMs), not synchronous with the HTTP write that published the
// triggering event.
async function pollFor(fn, { timeoutMs = 15000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    last = await fn();
    if (last) return last;
    if (Date.now() >= deadline) return last;
    // eslint-disable-next-line no-await-in-loop
    await sleep(intervalMs);
  }
}

// Ground-truth Mongo read for rule 3 (see that describe block). Per this
// session's own environment-hazard notes: a host-side Mongo client on the
// default 27017 is unreliable (a stray native mongod shadows the same
// port) -- `docker exec` into the real container is the only trustworthy
// path, so this shells out rather than using a `mongoose`/driver
// connection from the test process.
const MONGO_URI_IN_CONTAINER =
  mongoUri('srckube-notifications', 'localhost:27017');

function findNotificationInMongo(filter) {
  const script = `JSON.stringify(db.notifications.findOne(${JSON.stringify(filter)}))`;
  const out = execFileSync(
    'docker',
    ['exec', 'mongodb', 'mongosh', MONGO_URI_IN_CONTAINER, '--quiet', '--eval', script],
    { encoding: 'utf8' }
  ).trim();
  return out === 'null' || out === '' ? null : JSON.parse(out);
}

describe('WP-031: notificationService live rule-firing (producer -> Redis Stream -> live consumer -> Notification -> REST)', () => {
  let token;
  let sub;

  beforeAll(async () => {
    token = await getServiceToken();
    sub = decodeJwtPayload(token).sub;
  });

  afterAll(() => {
    httpAgent.destroy();
  });

  describe('Rule 2 (PB-11 v1): defect assigned -> notify the assignee', () => {
    let defectClient;
    let notifClient;
    let defectMongoId;
    let notificationId;

    beforeAll(() => {
      defectClient = axios.create({
        baseURL: DEFECT_BASE_URL,
        httpAgent,
        headers: { Authorization: `Bearer ${token}`, [PROJECT_ID_HEADER]: String(DEFAULT_PROJECT_ID) },
        validateStatus: () => true
      });
      notifClient = axios.create({
        baseURL: NOTIFICATION_BASE_URL,
        httpAgent,
        headers: { Authorization: `Bearer ${token}`, [PROJECT_ID_HEADER]: String(DEFAULT_PROJECT_ID) },
        validateStatus: () => true
      });
    });

    afterAll(async () => {
      if (defectMongoId) {
        await defectClient.delete(`/api/v1/defects/${defectMongoId}`);
      }
    });

    test('assigning a defect to self is visible as a notification through this identity\'s own session token, and mark-read persists', async () => {
      const corrId = `wp031-events-defect-${runId}`;

      const createResp = await defectClient.post('/api/v1/defects', {
        summary: `WP-031 events rule-2 defect ${runId}`,
        Priority: 'Low',
        Severity: 'Minor',
        description: 'notificationService events acceptance suite',
        Status: 'New'
      });
      expect(createResp.status).toBe(201);
      defectMongoId = createResp.data.data._id;
      const defectId = createResp.data.data.defectId;

      const assignResp = await defectClient.put(
        `/api/v1/defects/${defectMongoId}`,
        { assignedTo: sub },
        { headers: { [CORRELATION_HEADER]: corrId } }
      );
      expect(assignResp.status).toBe(200);

      const found = await pollFor(async () => {
        const listResp = await notifClient.get('/api/v1/notifications', { params: { unreadOnly: 'true' } });
        expect(listResp.status).toBe(200);
        return listResp.data.data.find(
          (n) => n.type === 'defect-assigned' && n.entityRef && n.entityRef.entityId === defectId
        );
      });

      expect(found).toBeDefined();
      notificationId = found._id;
      expect(found.userId).toBe(sub);
      expect(found.message).toContain(defectId);
      expect(found.correlationId).toBe(corrId);
      expect(found.read).toBe(false);

      // Mark-read, then a SEPARATE, fresh GET (not the same response object)
      // to prove the flip actually persisted server-side, not just that the
      // PATCH's own response echoed read:true.
      const markResp = await notifClient.patch(`/api/v1/notifications/${notificationId}/read`);
      expect(markResp.status).toBe(200);
      expect(markResp.data.data.read).toBe(true);

      const reGet = await notifClient.get('/api/v1/notifications');
      expect(reGet.status).toBe(200);
      const again = reGet.data.data.find((n) => n._id === notificationId);
      expect(again).toBeDefined();
      expect(again.read).toBe(true);
    }, 20000);
  });

  describe('Rule 1 (PB-11 v1): execution-completed -> notify the plan owner (TestExecution.assignedTo proxy)', () => {
    let execClient;
    let notifClient;
    let execMongoId;

    beforeAll(() => {
      // WP-021b: testPlanExecutionService is now tenant-scoped too --
      // X-Project-Id: 1 required, same Default Project every other client
      // in this file uses.
      execClient = axios.create({
        baseURL: TESTEXEC_BASE_URL,
        httpAgent,
        headers: { Authorization: `Bearer ${token}`, [PROJECT_ID_HEADER]: String(DEFAULT_PROJECT_ID) },
        validateStatus: () => true
      });
      notifClient = axios.create({
        baseURL: NOTIFICATION_BASE_URL,
        httpAgent,
        headers: { Authorization: `Bearer ${token}`, [PROJECT_ID_HEADER]: String(DEFAULT_PROJECT_ID) },
        validateStatus: () => true
      });
    });

    afterAll(async () => {
      if (execMongoId) {
        await execClient.delete(`/api/v1/testexecution/${execMongoId}`);
      }
    });

    test('creating then updating a TestExecution (assignedTo stamped from the token) notifies that same identity', async () => {
      const corrId = `wp031-events-exec-${runId}`;

      // createTestExecution stamps assignedTo from the CREATING token's sub
      // (testPlanExecutionService/controllers/testexecution.js) -- no
      // publishEvent() call on create, only on the PUT below (see that
      // controller's WP-030 comment: no dedicated status-transition
      // endpoint, so any update is treated as the completion signal).
      const createResp = await execClient.post('/api/v1/testexecution', {
        TestCases: []
      });
      expect(createResp.status).toBe(201);
      execMongoId = createResp.data.data._id;
      const testExecutionId = createResp.data.data.TestExecutionId;
      expect(createResp.data.data.assignedTo).toBe(sub);

      const updateResp = await execClient.put(
        `/api/v1/testexecution/${execMongoId}`,
        { TestCases: [] },
        { headers: { [CORRELATION_HEADER]: corrId } }
      );
      expect(updateResp.status).toBe(200);

      // WP-021b: testPlanExecutionService now stamps a real projectId on
      // this event (see controllers/testexecution.js's updateTestExecution
      // publishEvent() call) -- previously it had none, and
      // controllers/notifications.js's scopedFilter $or accepted that as a
      // missing-projectId match. Both paths of that $or still work: this
      // event now has the SAME real projectId (1) as the scoped read below,
      // so it also matches as an exact hit, not just the "missing" branch.
      const found = await pollFor(async () => {
        const listResp = await notifClient.get('/api/v1/notifications', { params: { unreadOnly: 'true' } });
        expect(listResp.status).toBe(200);
        return listResp.data.data.find(
          (n) => n.type === 'execution-completed' && n.entityRef && n.entityRef.entityId === testExecutionId
        );
      });

      expect(found).toBeDefined();
      expect(found.userId).toBe(sub);
      expect(found.message).toContain(testExecutionId);
      expect(found.correlationId).toBe(corrId);
    }, 20000);
  });

  // Rule 3 verification strategy, explained plainly:
  //
  // This harness has exactly ONE real, mintable Keycloak identity (the
  // service-account token from getServiceToken(), always 'admin' on the
  // one real project, id=1 -- see EXECUTION_LOG.md's earlier WPs). Proving
  // "a project manager gets notified" the same literal way as rules 1/2
  // ("read it back through THEIR OWN session token") would require a
  // second real login this suite cannot obtain.
  //
  // Two alternatives were considered and rejected:
  //   1. Downgrade this identity's OWN role on a project from 'admin' to
  //      'manager' to receive the notification itself, then read it back
  //      via its own token. Rejected: WP-022's addMember/updateMemberRole
  //      escalation guard (backend/userService/controllers/projects.js's
  //      requiresAdminActor()) requires the ACTOR to already be 'admin' to
  //      grant/hold 'admin' -- once downgraded via the API, this identity
  //      could never re-promote itself back to 'admin' via the API on that
  //      project. Even scoped to a disposable throwaway project, that
  //      trades a clean test for a permanently stranded fixture project
  //      this suite could no longer delete either (manage_project is
  //      admin-only).
  //   2. Add a synthetic/fake userId as the 'manager'. Rejected:
  //      addMember() calls keycloakUserExists() and 400s on any userId
  //      that isn't a real Keycloak user.
  //
  // Instead: this identity stays 'admin' throughout (so the throwaway
  // project it creates can be fully cleaned up afterward, same as
  // tenantIsolation.test.js's WP-021 pattern elsewhere in this repo), and
  // an EXISTING real Keycloak user id is added as this throwaway project's
  // 'manager'. NOTE: the real Default Project's (id=1) 'contributor'
  // members listed via GET /api/v1/projects were tried first and turned
  // out to be STALE -- addMember's keycloakUserExists() 400s on them (the
  // underlying Keycloak accounts no longer exist, a pre-existing data
  // inconsistency unrelated to this WP, not investigated further since
  // project 1 is out of this suite's scope to fix). Queried Keycloak's own
  // admin API directly instead (GET /admin/realms/srckube/users) and
  // picked a real, currently-existing, clearly-a-test-fixture account
  // ('testuser1') that is not a member of any project this suite touches
  // elsewhere. It is real enough to pass keycloakUserExists(), but this
  // suite has no credentials to log in as it, so the resulting notification
  // is verified via ground-truth Mongo (docker exec, per this session's
  // environment-hazard notes on why a host-side client on the default Mongo
  // port is untrustworthy here), not a session-token GET. No data belonging
  // to that user is read, modified, or asserted on beyond confirming their
  // own notification document was created.
  describe('Rule 3 (PB-11 v1): status transition to "review" -> notify every project manager', () => {
    const BORROWED_MANAGER_USER_ID = 'b8c153e0-1230-4990-908e-aa6bf98e4587'; // 'testuser1', verified live via Keycloak admin API this session
    let userServiceClient;
    let orgId;
    let projectMongoId;
    let projectNumericId;

    beforeAll(async () => {
      userServiceClient = axios.create({
        baseURL: USER_SERVICE_URL,
        httpAgent,
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true
      });

      const orgResp = await userServiceClient.post('/api/v1/organizations', {
        name: `WP-031 rule-3 org ${runId}`,
        key: `wp031-rule3-org-${runId}`
      });
      expect(orgResp.status).toBe(201);
      orgId = orgResp.data.data._id;
      trackOrganization(orgId);

      const projResp = await userServiceClient.post('/api/v1/projects', {
        name: `WP-031 rule-3 project ${runId}`,
        key: `wp031-rule3-proj-${runId}`,
        organizationId: orgId
      });
      expect(projResp.status).toBe(201);
      projectMongoId = projResp.data.data._id;
      trackProject(projectMongoId);
      projectNumericId = projResp.data.data.id;
      trackProject(projectNumericId);

      const addResp = await userServiceClient.post(`/api/v1/projects/${projectMongoId}/members`, {
        userId: BORROWED_MANAGER_USER_ID,
        role: 'manager'
      });
      expect(addResp.status).toBe(200);
    }, 20000);

    afterAll(async () => {
      // This identity was never downgraded (see the block comment above),
      // so it is still 'admin' here and can clean up fully, same as
      // tenantIsolation.test.js's convention.
      if (projectMongoId) {
        await userServiceClient.delete(`/api/v1/projects/${projectMongoId}`);
      }
      if (orgId) {
        await userServiceClient.delete(`/api/v1/organizations/${orgId}`);
      }
    });

    test('a status-changed(to: review) event scoped to this project creates a status-review notification for the manager', async () => {
      const corrId = `wp031-rule3-${runId}`;
      const entityId = `WP031-REQ-${runId}`;

      const publishedId = xaddEvent(STATUS_CHANGED_STREAM, {
        entityType: 'requirement',
        entityId,
        projectId: projectNumericId,
        from: 'draft',
        to: 'review',
        correlationId: corrId
      });
      // xaddEvent() returns the new entry's stream id (a non-empty string)
      // on success -- confirms Redis actually accepted the write before
      // this test ever polls for the consumer's side effect.
      expect(publishedId).toBeTruthy();

      const deadline = Date.now() + 15000;
      let doc = null;
      while (!doc && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        doc = findNotificationInMongo({
          userId: BORROWED_MANAGER_USER_ID,
          projectId: projectNumericId,
          type: 'status-review'
        });
        if (!doc) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(500);
        }
      }

      expect(doc).toBeTruthy();
      expect(doc.entityRef.entityId).toBe(entityId);
      expect(doc.correlationId).toBe(corrId);
      expect(doc.read).toBe(false);
    }, 20000);
  });

  // WP-031 DLQ acceptance criterion: a poisoned message must reach the DLQ
  // rather than block the consumer group. Publishes a 'defect-assigned'
  // message that passes handleDefectAssigned's early-return guard
  // (assignedTo is present) but is missing entityId/defectId entirely --
  // Notification's entityRef.entityId is required (models/Notification.js),
  // so Notification.create() throws a real Mongoose ValidationError, which
  // service-core's subscribe() (events.js's handleOne) is contracted to
  // catch, write to `${stream}:dlq`, and THEN ack on the original stream
  // (never leaving it pending forever) -- see events.js's header comment.
  // This exercises the LIVE consumer group actually running in the
  // `notificationservice` container, not a test-only subscriber.
  describe('Poisoned message -> DLQ (WP-031 acceptance criterion)', () => {
    test('a defect-assigned message missing entityId/defectId lands in the DLQ, and the original stream is not left with a stuck pending entry', async () => {
      const corrId = `wp031-dlq-poison-${runId}`;
      const poisonUserId = `wp031-dlq-poison-user-${runId}`;

      const publishedId = xaddEvent(DEFECT_ASSIGNED_STREAM, {
        entityType: 'defect',
        assignedTo: poisonUserId,
        projectId: DEFAULT_PROJECT_ID,
        correlationId: corrId
        // deliberately no entityId/defectId
      });
      expect(publishedId).toBeTruthy();

      const dlqStream = dlqStreamName(DEFECT_ASSIGNED_STREAM);
      const deadline = Date.now() + 15000;
      let dlqOutput = '';
      while (Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        dlqOutput = execFileSync('docker', ['exec', 'redis', 'redis-cli', 'XREVRANGE', dlqStream, '+', '-', 'COUNT', '20'], {
          encoding: 'utf8'
        });
        if (dlqOutput.includes(corrId)) break;
        // eslint-disable-next-line no-await-in-loop
        await sleep(500);
      }

      expect(dlqOutput).toContain(corrId);
      expect(dlqOutput).toContain('entityRef.entityId'); // the actual Mongoose validation error, proving it's a real failure being routed, not a coincidental match
      expect(dlqOutput).toContain(DEFECT_ASSIGNED_STREAM);

      // XPENDING summary form's first line is the pending count for this
      // group on this stream -- confirms the poisoned entry was acked
      // (routed to the DLQ AND removed from the original stream's pending
      // list), not stuck blocking the rest of the group's progress.
      const pendingOutput = execFileSync(
        'docker',
        ['exec', 'redis', 'redis-cli', 'XPENDING', DEFECT_ASSIGNED_STREAM, 'notificationservice'],
        { encoding: 'utf8' }
      );
      expect(pendingOutput.trim().split('\n')[0].trim()).toBe('0');
    }, 20000);
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
