// See backend/docker-compose.yml's redis port-mapping comment: 16379, not
// the default 6379 -- a stray native Homebrew redis-server was found
// shadowing the docker container on the host's 127.0.0.1:6379.
process.env.REDIS_URI = process.env.TEST_REDIS_URI || 'redis://localhost:16379';

const axios = require('axios');
const { execSync } = require('child_process');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const { subscribe, EVENT_STREAMS, PROJECT_ID_HEADER, CORRELATION_HEADER } = require('@srckube/service-core');

// WP-030 -- proves testRepoService's updateTestCaseStatus producer
// (controllers/testrepo.js) actually publishes a real 'status-changed'
// event, shaped correctly and carrying the originating request's
// correlationId, for a genuine authenticated status transition. Mirrors
// requirementService/__tests__/events.test.js exactly; see that file's
// header comment for why the exactly-once/two-consumer mechanics are not
// re-proven here (already covered with strong evidence elsewhere).
//
// Reached directly (bypassing Kong), matching this service's own
// api.test.js/tenantIsolation.test.js/rbacMatrix.test.js convention.

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:8000';
const DEFAULT_PROJECT_ID = 1;
const runId = Date.now();

describe('WP-030: testRepoService publishes status-changed on a real status transition', () => {
  let client;
  const createdTestCaseIds = [];

  beforeAll(async () => {
    const token = await getServiceToken();
    client = axios.create({
      baseURL: BASE_URL,
      headers: { Authorization: `Bearer ${token}`, [PROJECT_ID_HEADER]: String(DEFAULT_PROJECT_ID) },
      validateStatus: () => true
    });
  });

  afterAll(async () => {
    for (const id of createdTestCaseIds) {
      // eslint-disable-next-line no-await-in-loop
      await client.delete(`/api/v1/testrepo/${id}`);
    }
  });

  test('draft -> review through PUT /:id/status publishes a status-changed event carrying entityType, from/to, projectId, and the request correlationId', async () => {
    const group = `wp030-testcase-status-${runId}`;
    const received = [];
    const consumer = subscribe(
      EVENT_STREAMS.STATUS_CHANGED,
      group,
      async (payload) => {
        received.push(payload);
      },
      { blockMs: 500 }
    );
    await new Promise((resolve) => setTimeout(resolve, 300)); // let XGROUP CREATE settle

    try {
      const createResp = await client.post('/api/v1/testrepo', {
        TestCaseSummary: `WP-030 events test case ${runId}`,
        TestCaseDescription: 'events acceptance suite'
      });
      expect(createResp.status).toBe(201);
      const testCaseId = createResp.data.data._id;
      const TestCaseId = createResp.data.data.TestCaseId;
      createdTestCaseIds.push(testCaseId);

      const corrId = `wp030-tc-status-${runId}`;
      const statusResp = await client.put(
        `/api/v1/testrepo/${testCaseId}/status`,
        { status: 'review' },
        { headers: { [CORRELATION_HEADER]: corrId } }
      );
      expect(statusResp.status).toBe(200);

      const deadline = Date.now() + 10000;
      while (received.length === 0 && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        entityType: 'testcase',
        entityId: TestCaseId,
        projectId: DEFAULT_PROJECT_ID,
        from: 'draft',
        to: 'review',
        correlationId: corrId
      });
    } finally {
      await consumer.stop();
      // Fixture cleanup (hazard #5): destroy this test's consumer group so
      // repeat runs don't accumulate scratch groups on the shared, real
      // 'status-changed' production stream (the stream itself is left
      // alone -- mirrors requirementService/__tests__/events.test.js).
      execSync(`docker exec redis redis-cli XGROUP DESTROY ${EVENT_STREAMS.STATUS_CHANGED} ${group}`, {
        stdio: 'pipe'
      });
    }
  }, 15000);
});
