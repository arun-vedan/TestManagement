// WP-061 (ADR-006) -- shared /healthz building block.
//
// GOAL: a health check that actually exercises the dependency, not one
// that returns 200 unconditionally (the ask, verbatim: "a health check
// that is green while Mongo is down is worse than none").
//
// REQUIRED vs OPTIONAL checks, and why that split exists:
//   - Mongo is REQUIRED for every service here -- there is no service in
//     this codebase that can do anything useful with its own database
//     down, so a failing Mongo check flips the HTTP status to 503 and the
//     body's top-level `status` to "down".
//   - Redis, where a service uses it at all, is treated as OPTIONAL --
//     reported in the body, but never drops the HTTP status below 200.
//     This mirrors a decision already made and DOCUMENTED elsewhere in
//     this codebase, not a new opinion invented for this healthz: WP-030's
//     publishEvent() (service-core/events.js) is explicitly FAIL-OPEN
//     ("Dropping a notification is a strictly smaller harm than refusing a
//     user's otherwise-valid write because the event pipe happens to be
//     down"), and aiService's per-user rate limiter (aiService/lib/
//     rateLimiter.js) is explicitly FAIL-OPEN for the same class of
//     reason. A healthz that reported those services "down" because Redis
//     hiccuped would contradict the fail-open contract those modules
//     already committed to -- an orchestrator restarting/draining a
//     service over a dependency that service itself is designed to
//     tolerate losing would be actively wrong. So: Redis down => body says
//     `status: "degraded"`, `checks.redis: "down"`, HTTP stays 200
//     (Mongo permitting). This is a deliberate, three-state model (ok /
//     degraded / down), not a shortcut.
//
// USAGE (per service, in server.js):
//   const mongoose = require('mongoose');
//   const { createHealthzHandler, pingMongoConnection, pingRedisUri } =
//     require('@srckube/service-core');
//   app.get('/healthz', createHealthzHandler('aiService', {
//     required: { mongo: () => pingMongoConnection(mongoose.connection) },
//     optional: { redis: () => pingRedisUri(process.env.REDIS_URI) }
//   }));
// Mount this BEFORE session/keycloak/applyStandardSecurity so a health
// probe never depends on auth machinery, rate limiting, or CORS -- see
// each service's server.js for the exact mount point (right after
// correlationId).

const Redis = require('ioredis');

// A dedicated, short-timeout, cached-per-URI Redis client used ONLY for
// health pings -- deliberately separate from any service's own
// request-path Redis client (events.js's publisher, aiService's rate
// limiter, userService's existence-cache), so a slow/misbehaving health
// probe can never contend with real traffic on the same connection, and a
// service's own client's error handlers/retry strategy are never touched
// by this module.
const healthRedisClients = new Map();

function getHealthRedisClient(uri) {
  if (!uri) {
    return null;
  }
  if (healthRedisClients.has(uri)) {
    return healthRedisClients.get(uri);
  }
  const client = new Redis(uri, {
    connectTimeout: 1500,
    commandTimeout: 1500,
    maxRetriesPerRequest: 1,
    // NOT enableOfflineQueue:false, unlike events.js's publisher -- that
    // client sits on the request path and must fail fast; this one is a
    // background/health-probe client where waiting out the FIRST call's
    // brief 'connecting' window (a few ms) is fine, and simpler than
    // reimplementing events.js's waitForReady() gate here for a single
    // command. connectTimeout still bounds the absolute worst case.
    retryStrategy(times) {
      return Math.min(times * 200, 2000);
    }
  });
  // Required listener -- ioredis throws on an unhandled 'error' event
  // otherwise. pingRedisUri()'s try/catch is what actually surfaces the
  // failure to the caller; this listener just prevents a process crash.
  client.on('error', () => {});
  healthRedisClients.set(uri, client);
  return client;
}

// Pings a mongoose connection's ACTUAL server (db.admin().ping()), not
// just its cached readyState -- readyState can lag reality for a few
// seconds after the underlying TCP connection actually drops, and a
// stale "connected" flag is exactly the false-green this healthz exists
// to avoid.
async function pingMongoConnection(connection) {
  if (!connection || connection.readyState !== 1 || !connection.db) {
    return false;
  }
  try {
    await connection.db.admin().ping();
    return true;
  } catch (err) {
    return false;
  }
}

async function pingRedisUri(uri) {
  const client = getHealthRedisClient(uri);
  if (!client) {
    return false;
  }
  try {
    const reply = await client.ping();
    return reply === 'PONG';
  } catch (err) {
    return false;
  }
}

async function safeCheck(fn) {
  try {
    return await fn();
  } catch (err) {
    return false;
  }
}

// createHealthzHandler(serviceName, { required, optional })
//   required / optional: { [checkName]: () => Promise<boolean> }
// Returns an Express handler. Every check function is awaited with a
// try/catch guard (safeCheck) so a check that itself throws is treated as
// "down", never as an unhandled rejection that would 500 the health
// endpoint -- an exception from a broken check must never look like "no
// opinion", it must look like "down".
function createHealthzHandler(serviceName, { required = {}, optional = {} } = {}) {
  return async function healthz(req, res) {
    const checks = {};
    let requiredHealthy = true;
    let anyOptionalDown = false;

    for (const [name, fn] of Object.entries(required)) {
      const ok = await safeCheck(fn);
      checks[name] = ok ? 'ok' : 'down';
      if (!ok) {
        requiredHealthy = false;
      }
    }

    for (const [name, fn] of Object.entries(optional)) {
      const ok = await safeCheck(fn);
      checks[name] = ok ? 'ok' : 'down';
      if (!ok) {
        anyOptionalDown = true;
      }
    }

    const status = !requiredHealthy ? 'down' : anyOptionalDown ? 'degraded' : 'ok';
    const httpStatus = requiredHealthy ? 200 : 503;

    res.status(httpStatus).json({
      status,
      service: serviceName,
      timestamp: new Date().toISOString(),
      checks
    });
  };
}

// Test-only escape hatch (same pattern as events.js's
// _resetEventsForTests / audit.js's _resetAuditConnectionForTests) so a
// unit test exercising "Redis unreachable" doesn't leak a client, and a
// changed REDIS_URI between test cases isn't served a stale cached client.
function _resetHealthRedisClientsForTests() {
  for (const client of healthRedisClients.values()) {
    client.disconnect();
  }
  healthRedisClients.clear();
}

module.exports = {
  createHealthzHandler,
  pingMongoConnection,
  pingRedisUri,
  _resetHealthRedisClientsForTests
};
