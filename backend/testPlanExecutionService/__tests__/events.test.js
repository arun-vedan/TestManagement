// Host-run jest reaches the `redis` container via the port
// docker-compose.yml maps to the host (16379:6379 -- deliberately NOT the
// default 6379: a stray native Homebrew redis-server was found already
// listening on the host's 127.0.0.1:6379, silently shadowing the
// container for any host-side connection -- see the port mapping's
// comment in backend/docker-compose.yml for the full investigation).
// Never `redis` here (that hostname only resolves inside the compose
// network) -- same container-name-vs-localhost distinction WP-012b's
// regression was about, just from the opposite direction (this is host
// code, not container code). Must be set before requiring
// @srckube/service-core/events.js, which reads it lazily on first use but
// caches the client for the life of the process.
process.env.REDIS_URI = process.env.TEST_REDIS_URI || 'redis://localhost:16379';

const axios = require('axios');
const { execSync } = require('child_process');
const Redis = require('ioredis');
const { getServiceToken } = require('../../shared/test-utils/getServiceToken');
const {
  subscribe,
  startLogOnlyConsumer,
  EVENT_STREAMS,
  CORRELATION_HEADER,
  PROJECT_ID_HEADER
} = require('@srckube/service-core');

// WP-030 -- live acceptance tests for the async backbone, run against the
// REAL compose stack through Kong (not a direct-to-container bypass, and
// not a synthetic publishEvent() call) -- see
// backend/shared/service-core/__tests__/events.test.js for the
// stream-mechanics-level Jest coverage (DLQ, "not configured", bounded
// unreachable-Redis timing). This file proves the two acceptance criteria
// the WP names explicitly, driven by genuine HTTP writes:
//   1. an event published on a REAL execution update (PUT
//      /api/v1/testexecution/:id through Kong) is consumed exactly once by
//      a registered group, tested with two concurrent consumers in that
//      group (one of them literally the log-only consumer,
//      startLogOnlyConsumer, proving that first-consumer requirement at
//      the same time).
//   2. stopping the `redis` container does not break the write path (the
//      PUT still returns 200), and publishing recovers once redis is back.
//
// Per GR-1's investigation (see EXECUTION_LOG.md's WP-030 report): the only
// other consumer of this Redis instance is userService's unrelated
// existence-cache (plain string GET/SET, different keyspace, no session
// store anywhere uses Redis) -- stopping the container for this test does
// not clobber another WP's data, and is restored in a `finally` regardless
// of assertion outcome.

const KONG_URL = process.env.TEST_KONG_URL || 'http://localhost:8000';

const rawRedis = new Redis(process.env.REDIS_URI);

let client;
const createdExeIds = [];
const createdGroups = []; // [group name] -- destroyed on EVENT_STREAMS.EXECUTION_COMPLETED in afterAll

beforeAll(async () => {
  const token = await getServiceToken();
  // WP-021b: this service is now tenant-scoped; X-Project-Id: 1 (Default
  // Project) matches every fixture this suite creates and cleans up.
  client = axios.create({
    baseURL: KONG_URL,
    headers: { Authorization: `Bearer ${token}`, [PROJECT_ID_HEADER]: '1' },
    validateStatus: () => true
  });
});

afterAll(async () => {
  for (const id of createdExeIds) {
    // eslint-disable-next-line no-await-in-loop
    await client.delete(`/api/v1/testexecution/${id}`);
  }
  for (const group of createdGroups) {
    // eslint-disable-next-line no-await-in-loop
    await rawRedis.xgroup('DESTROY', EVENT_STREAMS.EXECUTION_COMPLETED, group).catch(() => {});
  }
  await rawRedis.quit();
});

async function createExecution() {
  const resp = await client.post('/api/v1/testexecution', {
    TestPlanId: '000000000000000000000000',
    TestCases: []
  });
  expect(resp.status).toBe(201);
  createdExeIds.push(resp.data.data._id);
  return resp.data.data; // { _id, TestExecutionId, ... }
}

async function updateExecution(execId, body, correlationId) {
  const headers = correlationId ? { [CORRELATION_HEADER]: correlationId } : {};
  return client.put(`/api/v1/testexecution/${execId}`, body, { headers });
}

describe('WP-030: async backbone -- real execution updates through Kong', () => {
  test(
    'N real PUT /api/v1/testexecution/:id writes each produce exactly one execution-completed event, ' +
      'consumed exactly once in total by two concurrent consumers (one of them the log-only consumer) in one group',
    async () => {
      const group = `wp030-live-exactly-once-${Date.now()}`;
      createdGroups.push(group);

      const perConsumer = { logOnly: 0, subscribeDirect: 0 };
      const handledExecutionIds = [];
      const correlationIdsSeen = [];

      function record(name) {
        return async (payload) => {
          // Small artificial delay so both blocked consumers get a genuine
          // chance to interleave.
          await new Promise((resolve) => setTimeout(resolve, 15));
          perConsumer[name] += 1;
          handledExecutionIds.push(payload.entityId);
          correlationIdsSeen.push(payload.correlationId);
        };
      }

      // Consumer 1: the actual startLogOnlyConsumer helper (WP-030's "first
      // consumer" requirement) -- its normal job is just logging, exercised
      // here with the onEvent test hook so this suite can assert on what it
      // received without scraping stdout.
      const logOnlyConsumer = startLogOnlyConsumer(EVENT_STREAMS.EXECUTION_COMPLETED, group, {
        consumerName: 'wp030-live-log-only',
        blockMs: 500,
        batchSize: 1,
        onEvent: record('logOnly')
      });
      // Consumer 2: subscribe() called directly, same group.
      const directConsumer = subscribe(EVENT_STREAMS.EXECUTION_COMPLETED, group, record('subscribeDirect'), {
        consumerName: 'wp030-live-direct',
        blockMs: 500,
        batchSize: 1
      });

      // Let both consumers' XGROUP CREATE ... MKSTREAM settle before any
      // write happens, so neither misses part of the backlog.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const N = 6;
      const sentExecutionIds = [];
      const sentCorrelationIds = [];
      for (let i = 0; i < N; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const exec = await createExecution();
        const correlationId = `wp030-live-${Date.now()}-${i}`;
        // eslint-disable-next-line no-await-in-loop
        const updateResp = await updateExecution(exec._id, { assignedTo: 'wp030-live-test' }, correlationId);
        expect(updateResp.status).toBe(200);
        sentExecutionIds.push(exec.TestExecutionId);
        sentCorrelationIds.push(correlationId);
      }

      const deadline = Date.now() + 20000;
      while (handledExecutionIds.length < N && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      await logOnlyConsumer.stop();
      await directConsumer.stop();

      // The headline claim: every event produced by a real write was
      // handled exactly once IN TOTAL across the group.
      expect(handledExecutionIds).toHaveLength(N);
      expect(new Set(handledExecutionIds).size).toBe(N);
      expect(new Set(handledExecutionIds)).toEqual(new Set(sentExecutionIds));

      // Non-vacuousness: both consumers actually did work.
      expect(perConsumer.logOnly).toBeGreaterThan(0);
      expect(perConsumer.subscribeDirect).toBeGreaterThan(0);
      expect(perConsumer.logOnly + perConsumer.subscribeDirect).toBe(N);

      // correlationId propagation -- WP-024-style joinability back to the
      // request that produced the write.
      expect(new Set(correlationIdsSeen)).toEqual(new Set(sentCorrelationIds));

      // eslint-disable-next-line no-console
      console.log(
        'WP-030 live exactly-once evidence (real HTTP writes through Kong):',
        JSON.stringify(perConsumer),
        'total handled:',
        handledExecutionIds.length
      );

      const pending = await rawRedis.xpending(EVENT_STREAMS.EXECUTION_COMPLETED, group);
      expect(pending[0]).toBe(0); // nothing left un-acked in this group
    },
    30000
  );
});

describe('WP-030: broker-down graceful degradation (live, real redis container)', () => {
  test(
    'docker stop redis: the execution-update write path still returns 200; docker start redis: publishing recovers',
    async () => {
      const execBeforeDown = await createExecution();

      execSync('docker stop redis', { stdio: 'pipe' });
      try {
        // Give the running service containers' already-open ioredis
        // connections a moment to actually notice the TCP close and flip
        // out of status 'ready' before the request that's supposed to
        // prove degradation -- not required for correctness (publishEvent
        // would still bound-timeout either way), just avoids racing the
        // very first request against a connection that hasn't dropped yet.
        await new Promise((resolve) => setTimeout(resolve, 500));

        const start = Date.now();
        const updateResp = await updateExecution(execBeforeDown._id, { assignedTo: 'wp030-redis-down-test' });
        const elapsedMs = Date.now() - start;

        // THE assertion: the request path is unaffected by the broker
        // being down. publishEvent()'s internal contract never throws, so
        // this would already be true even if it hung -- the elapsedMs
        // bound below is what actually proves "doesn't crash/hang the
        // request path" rather than merely "didn't throw."
        expect(updateResp.status).toBe(200);
        expect(elapsedMs).toBeLessThan(10000);

        // eslint-disable-next-line no-console
        console.log(`WP-030 redis-down write: HTTP ${updateResp.status} in ${elapsedMs}ms`);
      } finally {
        execSync('docker start redis', { stdio: 'pipe' });
      }

      // Wait for redis to actually be reachable again before asserting
      // recovery (docker start returning does not mean the server inside
      // is accepting connections yet).
      const probe = new Redis(process.env.REDIS_URI, {
        retryStrategy: () => null,
        maxRetriesPerRequest: 1,
        lazyConnect: true
      });
      let up = false;
      const upDeadline = Date.now() + 20000;
      while (!up && Date.now() < upDeadline) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await probe.connect();
          // eslint-disable-next-line no-await-in-loop
          await probe.ping();
          up = true;
        } catch (err) {
          probe.disconnect();
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      await probe.quit().catch(() => probe.disconnect());
      expect(up).toBe(true);

      // Recovery proof: a fresh write after redis is back up publishes and
      // is actually delivered -- not just "redis responds to PING" but the
      // full publisher -> broker -> consumer path working again.
      const group = `wp030-recovery-${Date.now()}`;
      createdGroups.push(group);
      const received = [];
      const consumer = subscribe(
        EVENT_STREAMS.EXECUTION_COMPLETED,
        group,
        async (payload) => {
          received.push(payload);
        },
        { blockMs: 500 }
      );
      await new Promise((resolve) => setTimeout(resolve, 500));

      const execAfterUp = await createExecution();
      const recoveryResp = await updateExecution(execAfterUp._id, { assignedTo: 'wp030-recovery-test' });
      expect(recoveryResp.status).toBe(200);

      const deadline = Date.now() + 10000;
      while (received.length === 0 && Date.now() < deadline) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      await consumer.stop();

      expect(received).toHaveLength(1);
      expect(received[0].entityId).toBe(execAfterUp.TestExecutionId);
    },
    60000
  );
});
