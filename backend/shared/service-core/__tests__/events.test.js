const Redis = require('ioredis');

// WP-030 -- plain Jest coverage of the Redis Streams wrapper's own logic
// (GR-6: black-box HTTP tests live in each service's __tests__ against the
// live compose stack; this file is the "plain Jest for the stream logic"
// half). Requires a real, reachable Redis -- there is no ioredis-mock in
// this repo's dependency tree, and the whole point of this suite (real
// consumer-group fan-out, real XPENDING/XACK bookkeeping) is not something
// a mock can stand in for without re-implementing Redis Streams itself.
// Defaults to the same container the rest of the stack uses
// (backend/docker-compose.yml maps 16379:6379 to the host -- deliberately
// NOT the default 6379, see that mapping's comment: a stray native
// Homebrew redis-server was found already listening on the host's
// 127.0.0.1:6379, silently shadowing the container for any host-side
// connection), overridable via TEST_REDIS_URI for CI/local variance.
const TEST_REDIS_URI = process.env.TEST_REDIS_URI || 'redis://localhost:16379';

let events;
let raw; // a second, plain ioredis client used only for test-side assertions/cleanup

function uniqueStreamName(label) {
  return `wp030-test-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

beforeAll(async () => {
  raw = new Redis(TEST_REDIS_URI);
  await raw.ping();
});

afterAll(async () => {
  await raw.quit();
});

beforeEach(() => {
  jest.resetModules();
  process.env.REDIS_URI = TEST_REDIS_URI;
  // eslint-disable-next-line global-require
  events = require('../events');
});

afterEach(async () => {
  events._resetEventsForTests();
  delete process.env.REDIS_URI;
});

describe('publishEvent()', () => {
  test('not configured (no REDIS_URI): resolves null, does not throw', async () => {
    delete process.env.REDIS_URI;
    jest.resetModules();
    // eslint-disable-next-line global-require
    const unconfigured = require('../events');
    await expect(unconfigured.publishEvent('some-stream', { a: 1 })).resolves.toBeNull();
  });

  test('invalid stream name: resolves null, does not throw', async () => {
    await expect(events.publishEvent(null, { a: 1 })).resolves.toBeNull();
    await expect(events.publishEvent(42, { a: 1 })).resolves.toBeNull();
  });

  test('invalid event: resolves null, does not throw', async () => {
    await expect(events.publishEvent('some-stream', null)).resolves.toBeNull();
    await expect(events.publishEvent('some-stream', 'not-an-object')).resolves.toBeNull();
  });

  test('healthy Redis: appends to the stream and returns a real stream ID', async () => {
    const stream = uniqueStreamName('publish');
    const id = await events.publishEvent(stream, { foo: 'bar', correlationId: 'corr-1' });

    expect(id).toEqual(expect.stringMatching(/^\d+-\d+$/));

    const entries = await raw.xrange(stream, '-', '+');
    expect(entries).toHaveLength(1);
    const fields = entries[0][1];
    const fieldsObj = {};
    for (let i = 0; i < fields.length; i += 2) fieldsObj[fields[i]] = fields[i + 1];
    const payload = JSON.parse(fieldsObj.payload);
    expect(payload).toMatchObject({ foo: 'bar', correlationId: 'corr-1' });
    expect(payload.publishedAt).toEqual(expect.any(String));
    expect(fieldsObj.correlationId).toBe('corr-1');

    await raw.del(stream);
  });

  test('Redis unreachable: degrades gracefully -- resolves null within a bounded time, never throws, never hangs', async () => {
    process.env.REDIS_URI = 'redis://127.0.0.1:19999'; // nothing listens here
    jest.resetModules();
    // eslint-disable-next-line global-require
    const downEvents = require('../events');

    const start = Date.now();
    const result = await downEvents.publishEvent('unreachable-stream', { correlationId: 'down-1' });
    const elapsedMs = Date.now() - start;

    expect(result).toBeNull();
    // Bounded: must not hang anywhere near a default HTTP client timeout.
    expect(elapsedMs).toBeLessThan(5000);

    downEvents._resetEventsForTests();
  }, 10000);
});

describe('subscribe() -- exactly-once within a consumer group', () => {
  test('two concurrent consumers in the SAME group each handle a disjoint share; every message handled exactly once, in total', async () => {
    const stream = uniqueStreamName('exactly-once');
    const group = 'shared-group';
    const MESSAGE_COUNT = 30;

    const perConsumerCounts = { 'consumer-a': 0, 'consumer-b': 0 };
    const handledIds = [];

    function makeHandler(consumerName) {
      return async (payload, meta) => {
        // Small artificial delay so both blocked consumers get a real
        // chance to interleave rather than one draining the whole backlog
        // before the other's XREADGROUP call even returns.
        await new Promise((resolve) => setTimeout(resolve, 15));
        perConsumerCounts[consumerName] += 1;
        handledIds.push(meta.id);
      };
    }

    const consumerA = events.subscribe(stream, group, makeHandler('consumer-a'), {
      blockMs: 500,
      batchSize: 1,
      consumerName: 'consumer-a'
    });
    const consumerB = events.subscribe(stream, group, makeHandler('consumer-b'), {
      blockMs: 500,
      batchSize: 1,
      consumerName: 'consumer-b'
    });

    // Let both consumers' ensureGroup() (XGROUP CREATE ... MKSTREAM) settle
    // before anything is published, so neither misses the backlog.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const publishedIds = [];
    for (let i = 0; i < MESSAGE_COUNT; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const id = await events.publishEvent(stream, { n: i, correlationId: `eo-${i}` });
      publishedIds.push(id);
    }

    const deadline = Date.now() + 15000;
    while (handledIds.length < MESSAGE_COUNT && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    await consumerA.stop();
    await consumerB.stop();

    // The headline claim: every published message was handled exactly
    // once IN TOTAL across the group -- not "each consumer saw everything"
    // (that would be pub/sub fan-out, the bug this test exists to catch)
    // and not "some were lost" (a naive two-single-consumer setup, or a
    // broken ack, could under- or over-count).
    expect(handledIds).toHaveLength(MESSAGE_COUNT);
    expect(new Set(handledIds).size).toBe(MESSAGE_COUNT); // no duplicates
    expect(new Set(handledIds)).toEqual(new Set(publishedIds)); // exactly the published set

    // Non-vacuousness: BOTH consumers actually did work -- a single-consumer
    // test (or a test where one consumer silently never got scheduled)
    // would prove nothing about group fan-out.
    expect(perConsumerCounts['consumer-a']).toBeGreaterThan(0);
    expect(perConsumerCounts['consumer-b']).toBeGreaterThan(0);
    expect(perConsumerCounts['consumer-a'] + perConsumerCounts['consumer-b']).toBe(MESSAGE_COUNT);

    // eslint-disable-next-line no-console
    console.log('WP-030 exactly-once evidence:', JSON.stringify(perConsumerCounts), 'total', handledIds.length);

    const pending = await raw.xpending(stream, group);
    expect(pending[0]).toBe(0); // nothing left un-acked

    await raw.del(stream);
  }, 20000);
});

describe('subscribe() -- dead-letter stream', () => {
  test('a handler that throws lands the message in the DLQ, and the original message is acked (not left pending, not silently dropped)', async () => {
    const stream = uniqueStreamName('dlq');
    const group = 'dlq-group';

    const consumer = events.subscribe(
      stream,
      group,
      async () => {
        throw new Error('simulated poison message');
      },
      { blockMs: 500 }
    );

    await new Promise((resolve) => setTimeout(resolve, 300));

    const publishedId = await events.publishEvent(stream, { correlationId: 'poison-1' });

    // Wait for the message to be processed (thrown, DLQ'd, acked).
    const deadline = Date.now() + 10000;
    let dlqEntries = [];
    while (dlqEntries.length === 0 && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      dlqEntries = await raw.xrange(events.dlqStreamName(stream), '-', '+');
      if (dlqEntries.length === 0) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    await consumer.stop();

    expect(dlqEntries).toHaveLength(1);
    const fields = dlqEntries[0][1];
    const fieldsObj = {};
    for (let i = 0; i < fields.length; i += 2) fieldsObj[fields[i]] = fields[i + 1];
    expect(fieldsObj.originalId).toBe(publishedId);
    expect(fieldsObj.stream).toBe(stream);
    expect(fieldsObj.group).toBe(group);
    expect(fieldsObj.error).toMatch(/simulated poison message/);
    expect(JSON.parse(fieldsObj.payload)).toMatchObject({ correlationId: 'poison-1' });

    // The poisoned message must not be stuck pending on the ORIGINAL
    // stream/group forever -- it was acked after being DLQ'd, per the
    // "does not block the group" contract in events.js.
    const pending = await raw.xpending(stream, group);
    expect(pending[0]).toBe(0);

    await raw.del(stream, events.dlqStreamName(stream));
  }, 15000);
});

describe('subscribe() -- not configured', () => {
  test('no REDIS_URI: subscribe() is a safe no-op, not a throw', async () => {
    delete process.env.REDIS_URI;
    jest.resetModules();
    // eslint-disable-next-line global-require
    const unconfigured = require('../events');

    const handler = jest.fn();
    const consumer = unconfigured.subscribe('some-stream', 'some-group', handler);
    expect(consumer.consumerName).toEqual(expect.any(String));
    await expect(consumer.stop()).resolves.toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });
});
