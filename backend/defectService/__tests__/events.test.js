// See backend/docker-compose.yml's redis port-mapping comment: 16379, not
// the default 6379 -- a stray native Homebrew redis-server was found
// shadowing the docker container on the host's 127.0.0.1:6379.
process.env.REDIS_URI = process.env.TEST_REDIS_URI || 'redis://localhost:16379';

const axios = require('axios');
const { execSync } = require('child_process');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { subscribe, PROJECT_ID_HEADER, CORRELATION_HEADER } = require('@srckube/service-core');

// WP-031 -- proves defectService's new publishEvent() producer
// (controllers/defects.js's createDefect/updateDefect) actually publishes a
// real 'defect-assigned' event, shaped correctly and carrying the
// originating request's correlationId, for a genuine authenticated
// assignment. Not EVENT_STREAMS.<something> -- this stream name is a plain
// string literal (not centralized in service-core/eventStreams.js, which is
// WP-032's concurrent territory this session, see controllers/defects.js's
// header comment), so it's spelled out here to match exactly.
//
// Reached directly (bypassing Kong), matching this service's own
// api.test.js/tenantIsolation.test.js convention.
//
// WP-043 UPDATE: this file's consumer group is created with '$' (only
// events published AFTER the group exists are delivered -- see
// service-core/events.js's ensureGroup()), so it was never reading stale
// history. But `npm test` runs every file in this directory in PARALLEL
// jest workers (no --runInBand in scripts/run-api-tests.sh), and the new
// defectService/__tests__/bulk.test.js also publishes to this exact same
// shared DEFECT_ASSIGNED_STREAM. Reproduced live: a run where bulk.test.js's
// worker published its own bulk-assign events in the ~300ms window between
// this test's consumer group being created and its own PUT firing, causing
// this test's consumer to legitimately receive those OTHER tests' events
// too (`received` had 5 entries: 4 from a concurrent bulk-assign, 1 from
// this test) -- a real product-of-success race (the stream is genuinely
// shared/concurrent now, exactly as it will be in production with two
// features both assigning defects around the same time), not a publishing
// bug. Fixed by filtering `received` to just this test's own `defectId`
// before every assertion, below -- the event CONTENT/shape/correlationId
// proof is unchanged, only the isolation assumption ("nothing else
// publishes to this stream while I'm listening") is corrected.

const DEFECT_ASSIGNED_STREAM = 'defect-assigned';
const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';
const DEFAULT_PROJECT_ID = 1;
const runId = Date.now();

describe('WP-031: defectService publishes defect-assigned on assignment', () => {
  let client;
  let sub;
  const createdDefectIds = [];

  beforeAll(async () => {
    const token = await getServiceToken();
    sub = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')).sub;
    client = axios.create({
      baseURL: BASE_URL,
      headers: { Authorization: `Bearer ${token}`, [PROJECT_ID_HEADER]: String(DEFAULT_PROJECT_ID) },
      validateStatus: () => true
    });
  });

  afterAll(async () => {
    for (const id of createdDefectIds) {
      // eslint-disable-next-line no-await-in-loop
      await client.delete(`/api/v1/defects/${id}`);
    }
  });

  test('assigning a defect via PUT /:id publishes defect-assigned carrying entityType, entityId, assignedTo, previousAssignee, projectId, and the request correlationId', async () => {
    const group = `wp031-defect-assigned-update-${runId}`;
    const received = [];
    const consumer = subscribe(
      DEFECT_ASSIGNED_STREAM,
      group,
      async (payload) => {
        received.push(payload);
      },
      { blockMs: 500 }
    );
    await new Promise((resolve) => setTimeout(resolve, 300)); // let XGROUP CREATE settle

    try {
      const createResp = await client.post('/api/v1/defects', {
        summary: `WP-031 events defect ${runId}`,
        Priority: 'Low',
        Severity: 'Minor',
        description: 'events acceptance suite',
        Status: 'New'
      });
      expect(createResp.status).toBe(201);
      const defectMongoId = createResp.data.data._id;
      const defectId = createResp.data.data.defectId; // used only to assert the matched event's own content below, never as a filter key (see comment on `mine` below)
      createdDefectIds.push(defectMongoId);
      // create carried no assignedTo -- no event yet, confirmed implicitly:
      // if createDefect's own (assignedTo-on-create) branch fired here too,
      // `received` would already be non-empty before the PUT below, which
      // the exact-length assertion after the PUT would catch.

      const corrId = `wp031-defect-assign-${runId}`;
      const putResp = await client.put(
        `/api/v1/defects/${defectMongoId}`,
        { assignedTo: sub },
        { headers: { [CORRELATION_HEADER]: corrId } }
      );
      expect(putResp.status).toBe(200);

      // Scoped to this test's own explicit correlationId, NOT entityId/
      // defectId (see the header comment above, WP-043 update) --
      // defectService's defectId is assigned by findOne().sort({id:-1})+1
      // (models/defects.js) and gets REUSED after a delete (reproduced
      // live: a concurrently-running test's deleted defect freed up the
      // same "Bug-N" number this test's own create then got assigned),
      // so entityId is not a safe filter key across concurrent test
      // files. correlationId is unique per HTTP request and cannot
      // collide.
      const mine = () => received.filter((e) => e.correlationId === corrId);

      const deadline = Date.now() + 10000;
      while (mine().length === 0 && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      expect(mine()).toHaveLength(1);
      expect(mine()[0]).toMatchObject({
        entityType: 'defect',
        entityId: defectId,
        defectId,
        assignedTo: sub,
        previousAssignee: null,
        projectId: DEFAULT_PROJECT_ID,
        correlationId: corrId
      });
    } finally {
      await consumer.stop();
      // Fixture cleanup (hazard #5): destroy this test's scratch consumer
      // group so repeat runs don't accumulate groups on the shared, real
      // 'defect-assigned' stream (the stream itself is left alone -- same
      // pattern as WP-030's requirementService/testRepoService
      // events.test.js).
      execSync(`docker exec redis redis-cli XGROUP DESTROY ${DEFECT_ASSIGNED_STREAM} ${group}`, { stdio: 'pipe' });
    }
  }, 15000);

  test('re-assigning to the SAME user does not publish a duplicate event, but assigning to someone else does', async () => {
    const group = `wp031-defect-assigned-noop-${runId}`;
    const received = [];
    const consumer = subscribe(
      DEFECT_ASSIGNED_STREAM,
      group,
      async (payload) => {
        received.push(payload);
      },
      { blockMs: 500 }
    );
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Scoped to this test's own explicit correlationIds, NOT entityId/
    // defectId (see the header comment above, WP-043 update, and test 1's
    // matching comment) -- defectId gets reused after a delete under
    // concurrent test files, so it is not a safe filter key here.
    // correlationId is unique per HTTP request and cannot collide; every
    // request this test makes sets one explicitly so `mine()` can filter
    // against a known set as the test progresses.
    const myCorrelationIds = new Set();
    const mine = () => received.filter((e) => myCorrelationIds.has(e.correlationId));

    try {
      const createCorrId = `wp031-defect-noop-create-${runId}`;
      myCorrelationIds.add(createCorrId);
      const createResp = await client.post(
        '/api/v1/defects',
        {
          summary: `WP-031 events defect noop ${runId}`,
          Priority: 'Low',
          Severity: 'Minor',
          description: 'events acceptance suite',
          Status: 'New',
          assignedTo: sub // assigned AT CREATE this time -- exercises createDefect's producer branch
        },
        { headers: { [CORRELATION_HEADER]: createCorrId } }
      );
      expect(createResp.status).toBe(201);
      const defectMongoId = createResp.data.data._id;
      createdDefectIds.push(defectMongoId);

      // Wait for the create-time event first, so the noop-update assertion
      // below isn't racing it.
      const createDeadline = Date.now() + 10000;
      while (mine().length === 0 && Date.now() < createDeadline) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(mine()).toHaveLength(1);
      expect(mine()[0]).toMatchObject({ assignedTo: sub, previousAssignee: null });

      // A PUT that re-sends the SAME assignedTo must not publish again.
      const noopCorrId = `wp031-defect-noop-put-${runId}`;
      const noopResp = await client.put(
        `/api/v1/defects/${defectMongoId}`,
        { assignedTo: sub, Priority: 'High' },
        { headers: { [CORRELATION_HEADER]: noopCorrId } }
      );
      expect(noopResp.status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(mine()).toHaveLength(1); // still just the create-time event (noopCorrId published nothing)

      // A PUT that assigns to someone ELSE must publish again, with the
      // correct previousAssignee.
      const otherUser = `wp031-other-user-${runId}`;
      const reassignCorrId = `wp031-defect-noop-reassign-${runId}`;
      myCorrelationIds.add(reassignCorrId);
      const reassignResp = await client.put(
        `/api/v1/defects/${defectMongoId}`,
        { assignedTo: otherUser },
        { headers: { [CORRELATION_HEADER]: reassignCorrId } }
      );
      expect(reassignResp.status).toBe(200);

      const reassignDeadline = Date.now() + 10000;
      while (mine().length < 2 && Date.now() < reassignDeadline) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      expect(mine()).toHaveLength(2);
      expect(mine()[1]).toMatchObject({ assignedTo: otherUser, previousAssignee: sub });
    } finally {
      await consumer.stop();
      execSync(`docker exec redis redis-cli XGROUP DESTROY ${DEFECT_ASSIGNED_STREAM} ${group}`, { stdio: 'pipe' });
    }
  }, 20000);
});
