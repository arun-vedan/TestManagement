const crypto = require('crypto');
const Redis = require('ioredis');
const { createLogger } = require('./logger');

const logger = createLogger('service-core:events');

// WP-030 -- Async backbone (Redis Streams). ADR-004.
//
// Redis is already deployed in this stack (userService's existence-cache,
// backend/userService/controllers/users.js) -- underused, per ADR-004 --
// which is why Redis Streams was picked over adding another synchronous
// HTTP call or standing up a full broker (Kafka/RabbitMQ): lowest
// incremental operational cost, and consumer groups give at-least-once
// delivery + per-group cursors out of the box.
//
// FAIL-OPEN, DELIBERATELY, not fail-closed. Contrast this with WP-010's
// defectService -> istatusService call and WP-021's requireProjectScope(),
// which both fail CLOSED (503) -- correct there because they are
// correctness/security boundaries (an unauthenticated or unscoped write
// must not be allowed to proceed as if it were authorized). Publishing an
// event is not that: it is a side effect ABOUT a write that already
// succeeded (or, for a pure read-triggered event, one that was going to
// happen regardless), consumed by things that are useful-but-not-required
// for the request the caller is waiting on (notifications, reporting).
// Dropping a notification is a strictly smaller harm than refusing a user's
// otherwise-valid write because the event pipe happens to be down. So
// publishEvent() below mirrors audit()'s contract exactly (see audit.js):
// it NEVER throws, NEVER rejects, and never blocks the caller past a short
// bounded timeout -- every failure mode (Redis unreachable, command
// timeout, malformed input) is caught, logged, and resolved to null.
//
// Consumer-side (subscribe()) is a separate story: a long-lived background
// loop, not a request-path call, so it reconnects and keeps trying
// indefinitely rather than giving up after one bounded attempt.

const DLQ_SUFFIX = ':dlq';

function dlqStreamName(stream) {
  return `${stream}${DLQ_SUFFIX}`;
}

function resolveRedisUri() {
  return process.env.REDIS_URI || null;
}

// --- Publisher -------------------------------------------------------------
//
// A single cached, non-blocking client shared by every publishEvent() call
// in this process (mirrors audit.js's cachedConnection/cachedModel
// pattern). enableOfflineQueue:false + a bounded connectTimeout/
// commandTimeout are the load-bearing settings for the "broker down ->
// publisher degrades gracefully" acceptance criterion: without them,
// ioredis's default behavior is to silently queue commands issued while
// disconnected and replay them once it reconnects, which would make
// publishEvent() resolve only whenever Redis comes back -- exactly the
// "blocks/crashes the request path" failure mode this must NOT have.
// With them, a call issued while Redis is unreachable rejects almost
// immediately and falls into the catch below.
let cachedPublisher = null;

function getPublisherClient() {
  const uri = resolveRedisUri();
  if (!uri) {
    return null;
  }
  if (cachedPublisher) {
    return cachedPublisher;
  }
  cachedPublisher = new Redis(uri, {
    connectTimeout: 2000,
    commandTimeout: 2000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy(times) {
      // Capped backoff, retried forever in the background (this is the
      // connection-level reconnect loop, independent of
      // maxRetriesPerRequest which governs a single in-flight command) --
      // this is what makes "docker start redis" recovery automatic: the
      // client keeps trying on its own and flips back to status 'ready'
      // without any of this module's code needing to notice Redis went
      // away and re-create anything.
      return Math.min(times * 200, 2000);
    }
  });
  // A listener is required -- ioredis emits 'error' as a regular EventEmitter
  // event and an unhandled one crashes the process (the exact opposite of
  // "degrades gracefully"). Logging and swallowing it here is what makes a
  // stopped/unreachable Redis a log line instead of a process crash.
  cachedPublisher.on('error', (err) => {
    logger.error('redis publisher client error', { error: err.message });
  });
  return cachedPublisher;
}

// Resolves once `client` is ready to take commands, or rejects after
// `timeoutMs`. Needed because a freshly-created client (first publishEvent()
// call after this process started) is still in status 'connecting' for a
// few ms -- with enableOfflineQueue:false, issuing a command in that window
// fails immediately with "Stream isn't writeable" even though Redis is
// perfectly healthy and about to be ready. This gate makes that startup
// window a short bounded wait (steady-state calls after the first take the
// synchronous fast path below, status is already 'ready') while STILL
// bounding how long a genuinely-down Redis can hold up the caller.
function waitForReady(client, timeoutMs) {
  if (client.status === 'ready') {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      client.removeListener('ready', onReady);
      reject(new Error(`redis not ready within ${timeoutMs}ms (status=${client.status})`));
    }, timeoutMs);
    function onReady() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    }
    client.once('ready', onReady);
  });
}

// Test-only escape hatch, same pattern as audit.js's
// _resetAuditConnectionForTests -- lets unit tests exercise "not
// configured", "configured but unreachable", and "configured and healthy"
// without leaking a client across cases.
function _resetEventsForTests() {
  if (cachedPublisher) {
    cachedPublisher.disconnect();
  }
  cachedPublisher = null;
}

// publishEvent(stream, event, options?) -- appends `event` (a plain object)
// to the named Redis Stream. `event.correlationId` should always be set by
// callers (see correlationId.js) so a consumed event can be traced back to
// the request that produced it -- matching WP-024's audit events, which
// carry the same field, for cross-referencing.
//
// CONTRACT: never throws, never rejects. Resolves to the new entry's stream
// ID on success, or null on any failure (not configured, unreachable,
// timed out, invalid input) -- logged in every case. Callers MAY `await`
// this for delivery-order convenience in tests, but exactly like audit(),
// MUST NOT wrap it in their own try/catch "just in case" -- that protection
// already lives here.
async function publishEvent(stream, event, options = {}) {
  try {
    if (!stream || typeof stream !== 'string') {
      logger.warn('publishEvent() called with an invalid stream name; dropping event', { stream });
      return null;
    }
    if (!event || typeof event !== 'object') {
      logger.warn('publishEvent() called with a non-object event; dropping event', { stream });
      return null;
    }

    const client = getPublisherClient();
    if (!client) {
      logger.warn('REDIS_URI not configured on this service; event dropped', {
        stream,
        correlationId: event.correlationId
      });
      return null;
    }

    await waitForReady(client, options.connectWaitMs || 2000);

    const enriched = { ...event, publishedAt: new Date().toISOString() };
    const maxLen = options.maxLen || 10000;

    // MAXLEN ~ caps unbounded stream growth (approximate trim -- cheap,
    // does not need to be exact for this use case) since nothing else in
    // this WP prunes these streams.
    const id = await client.xadd(
      stream,
      'MAXLEN',
      '~',
      maxLen,
      '*',
      'payload',
      JSON.stringify(enriched),
      'correlationId',
      event.correlationId || ''
    );

    logger.info('event published', { stream, id, correlationId: event.correlationId });
    return id;
  } catch (err) {
    logger.error('publishEvent() failed; continuing without failing the calling operation', {
      stream,
      error: err.message,
      correlationId: event && event.correlationId
    });
    return null;
  }
}

// --- Consumer ---------------------------------------------------------------

function fieldsToObject(fields) {
  const obj = {};
  for (let i = 0; i < fields.length; i += 2) {
    obj[fields[i]] = fields[i + 1];
  }
  return obj;
}

function decodeMessage(fields) {
  const raw = fieldsToObject(fields);
  if (raw.payload) {
    try {
      return JSON.parse(raw.payload);
    } catch (err) {
      logger.warn('subscribe() could not JSON-parse a message payload; delivering raw fields', {
        error: err.message
      });
    }
  }
  return raw;
}

async function ensureGroup(client, stream, group) {
  try {
    // '$' -- new consumer groups only see events published after they were
    // created, matching normal broker semantics (no group retroactively
    // drains a backlog it didn't ask to see). MKSTREAM creates the stream
    // itself if this is the very first group/producer to touch it.
    await client.xgroup('CREATE', stream, group, '$', 'MKSTREAM');
  } catch (err) {
    if (!/BUSYGROUP/.test(err.message)) {
      throw err;
    }
    // Group already exists -- expected on every call after the first.
  }
}

// subscribe(stream, group, handler, options?) -- registers `consumerName`
// (default: derived, unique per call) as a reader in `group` on `stream`
// and starts a background read loop. Returns { consumerName, stop() }.
//
// Delivery contract:
//   - Redis Streams consumer groups guarantee each message is delivered to
//     exactly ONE consumer within a given group (that is the mechanism, not
//     something this wrapper adds) -- two consumers registered under the
//     same group name share the stream's backlog rather than each seeing
//     every message.
//   - handler(payload, meta) is awaited. If it resolves, the message is
//     explicitly XACKed (removed from the group's pending-entries list) --
//     this is the "explicit ack" the WP calls for: XREADGROUP here is never
//     called with NOACK, so a message is only ever considered handled once
//     this code says so.
//   - If handler throws/rejects, the message is written to this stream's
//     dead-letter stream (`${stream}:dlq`, carrying the original id,
//     stream, group, error, and payload) and THEN acked on the original
//     stream. Acking a poisoned message (rather than leaving it pending
//     forever) is deliberate: Redis Streams consumer groups process a
//     given consumer's pending entries roughly in order, so one message
//     nobody acks would eventually block that consumer's progress rather
//     than just that one message being lost -- the DLQ is where a poisoned
//     message ends up instead of either silently vanishing (never written
//     anywhere) or blocking the group.
function subscribe(stream, group, handler, options = {}) {
  const consumerName = options.consumerName || `${group}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const blockMs = options.blockMs || 5000;
  const batchSize = options.batchSize || 10;

  const uri = resolveRedisUri();
  if (!uri) {
    logger.warn('REDIS_URI not configured; subscribe() is a no-op', { stream, group });
    return { consumerName, stop: async () => {} };
  }

  // Deliberately a dedicated client, separate from the publisher's: this
  // one issues a long-lived BLOCKing read, which must never share a
  // connection with request-path publishEvent() calls. Unlike the
  // publisher, this client keeps retrying indefinitely (maxRetriesPerRequest:
  // null is ioredis's documented way to mean "retry forever") -- a
  // subscriber is a background process, not something a user request is
  // waiting on, so blocking/retrying here is the correct trade-off.
  const client = new Redis(uri, { maxRetriesPerRequest: null });
  client.on('error', (err) => {
    logger.error('redis consumer client error', { stream, group, consumerName, error: err.message });
  });

  let stopped = false;

  const ready = ensureGroup(client, stream, group).catch((err) => {
    logger.error('subscribe() failed to create/verify consumer group', {
      stream,
      group,
      error: err.message
    });
    throw err;
  });

  async function ackSafely(id) {
    try {
      await client.xack(stream, group, id);
    } catch (err) {
      logger.error('subscribe() failed to ack message', { stream, group, id, error: err.message });
    }
  }

  async function handleOne(id, fields) {
    const payload = decodeMessage(fields);
    try {
      await handler(payload, { id, stream, group, consumerName });
      await ackSafely(id);
    } catch (err) {
      logger.error('subscribe() handler threw; routing message to dead-letter stream', {
        stream,
        group,
        id,
        error: err.message
      });
      try {
        await client.xadd(
          dlqStreamName(stream),
          '*',
          'originalId',
          id,
          'stream',
          stream,
          'group',
          group,
          'error',
          err.message,
          'payload',
          JSON.stringify(payload)
        );
      } catch (dlqErr) {
        logger.error('subscribe() failed to write to dead-letter stream', {
          stream,
          group,
          id,
          error: dlqErr.message
        });
      }
      // Ack regardless of whether the DLQ write itself succeeded -- see the
      // function-level comment above for why a poisoned message must not
      // stay pending forever.
      await ackSafely(id);
    }
  }

  async function loop() {
    try {
      await ready;
    } catch (err) {
      return; // already logged in ensureGroup's catch above
    }
    while (!stopped) {
      let results;
      try {
        results = await client.xreadgroup(
          'GROUP',
          group,
          consumerName,
          'COUNT',
          batchSize,
          'BLOCK',
          blockMs,
          'STREAMS',
          stream,
          '>'
        );
      } catch (err) {
        if (stopped) {
          return;
        }
        logger.error('subscribe() read error; retrying', { stream, group, error: err.message });
        await new Promise((resolve) => setTimeout(resolve, 500));
        continue;
      }
      if (stopped) {
        return;
      }
      if (!results) {
        continue; // BLOCK window elapsed with nothing new -- loop again
      }
      for (const [, messages] of results) {
        for (const [id, fields] of messages) {
          await handleOne(id, fields);
        }
      }
    }
  }

  const loopPromise = loop();

  return {
    consumerName,
    async stop() {
      stopped = true;
      // Force-disconnect rather than quit(): a blocking XREADGROUP may be
      // in flight for up to blockMs, and quit() waits for the current
      // reply before closing -- disconnect() aborts it immediately so
      // stop() is not itself a slow operation.
      client.disconnect();
      await loopPromise.catch(() => {});
    }
  };
}

module.exports = {
  publishEvent,
  subscribe,
  dlqStreamName,
  _resetEventsForTests
};
