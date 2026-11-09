const Redis = require('ioredis');
const { createLogger } = require('@srckube/service-core');

const logger = createLogger('aiService:rateLimiter');

// WP-050 -- per-user daily AI rate limit.
//
// DISTINCT from applyStandardSecurity()'s per-service HTTP rate limiter
// (RATE_LIMIT_MAX, service-core/security.js): that one bounds request
// VOLUME per service instance regardless of caller (100 req/10min in
// production, 100000 locally). This one bounds COST per human being per
// calendar day -- a completely different axis. One user hammering
// /api/v1/ai/complete well under the service-wide HTTP ceiling could still
// run up a real provider bill; that is exactly the failure mode this
// exists to cap.
//
// STORAGE: Redis, not Mongo -- and the choice is deliberate, not just
// "Redis is already there":
//   - A counter-with-expiry is EXACTLY Redis's INCR+EXPIRE primitive: one
//     atomic round trip per request, no read-then-write.
//   - Mongo would need either a read-modify-write (the exact class of bug
//     WP-020c diagnosed in Project/testRepo/defect's numeric `id`
//     generator -- read current value, +1, write, racy under concurrency)
//     or a findOneAndUpdate({key}, {$inc:{count:1}}, {upsert:true}), which
//     is atomic but still needs a SECOND mechanism for expiry that Mongo
//     doesn't give for free the way Redis's key TTL does.
//   - Redis is already deployed and used by this exact codebase for a
//     conceptually similar job (WP-030's event streams, service-core/
//     events.js) -- no new infrastructure to stand up.
//
// FAILS OPEN when Redis is unreachable/unconfigured -- deliberately, the
// same call WP-030's publishEvent() makes for the same class of reason
// (see events.js's header comment). This counter is a COST safety net, not
// a security/tenant-isolation boundary -- contrast requireProjectScope(),
// which fails CLOSED (503) because a wrong answer there leaks cross-tenant
// data. If Redis has a blip, the correct behavior is "AI still works, the
// cost cap is briefly unenforced" -- NOT "the entire AI feature goes down
// because its bookkeeping counter can't be reached." A provider outage is
// what should make AI unavailable (see controllers/ai.js's
// runProviderCall()); a Redis blip on an unrelated counter must not read
// as the same thing.
function resolveDailyLimit() {
  const raw = process.env.AI_DAILY_RATE_LIMIT;
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 50;
}

function resolveRedisUri() {
  return process.env.REDIS_URI || null;
}

let cachedClient = null;

function getClient() {
  const uri = resolveRedisUri();
  if (!uri) {
    return null;
  }
  if (cachedClient) {
    return cachedClient;
  }
  cachedClient = new Redis(uri, {
    connectTimeout: 2000,
    commandTimeout: 2000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy(times) {
      return Math.min(times * 200, 2000);
    }
  });
  cachedClient.on('error', (err) => {
    logger.error('redis rate-limit client error', { error: err.message });
  });
  return cachedClient;
}

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

function dayKey(userId, date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  return `ai:ratelimit:${userId}:${day}`;
}

// Resolves to { allowed, count, limit, degraded }. NEVER throws/rejects --
// see the header comment for the fail-open rationale. `degraded: true`
// means the limit was NOT enforced this call (Redis not configured or
// unreachable) -- logged at call sites for observability even though the
// caller still proceeds.
async function checkAndIncrementDailyUsage(userId) {
  const limit = resolveDailyLimit();
  const client = getClient();
  if (!client) {
    logger.warn('REDIS_URI not configured; AI daily rate limit is not enforced', { userId });
    return { allowed: true, count: 0, limit, degraded: true };
  }
  try {
    await waitForReady(client, 2000);
    const key = dayKey(userId);
    const count = await client.incr(key);
    if (count === 1) {
      // 26h, not 24h -- deliberate slack so a key created just before
      // midnight UTC still expires comfortably after that calendar day's
      // window closes, rather than racing a re-INCR at exactly 24h.
      await client.expire(key, 26 * 60 * 60);
    }
    return { allowed: count <= limit, count, limit, degraded: false };
  } catch (err) {
    logger.error('AI daily rate limit check failed; failing open', { userId, error: err.message });
    return { allowed: true, count: 0, limit, degraded: true };
  }
}

function _resetRateLimiterForTests() {
  if (cachedClient) {
    cachedClient.disconnect();
  }
  cachedClient = null;
}

module.exports = { checkAndIncrementDailyUsage, resolveDailyLimit, dayKey, _resetRateLimiterForTests };
