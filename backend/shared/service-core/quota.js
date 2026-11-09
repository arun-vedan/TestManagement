const Redis = require('ioredis');
const { createLogger } = require('./logger');

// WP-135 (third bullet) — a per-tenant quota helper, generalised from
// aiService/lib/rateLimiter.js's Redis INCR+EXPIRE counter.
//
// WHAT WAS ALREADY THERE, and why it needed generalising rather than copying.
// WP-050 built exactly this for one axis: AI calls per USER per calendar day.
// The next three things that need metering are not that shape:
//
//   WP-134  automated tests under management, per ORGANIZATION, no window
//   WP-135  attachment bytes, per PROJECT (a storage total, not a rate)
//   WP-135  registration attempts, per source, per hour
//
// They differ in subject, in window, and in what a single call costs. A fourth
// copy of the same INCR+EXPIRE block with a different key prefix is how four
// subtly different cost caps end up in a codebase, so the axes are parameters
// here.
//
// THE FAILURE POSTURE IS A REQUIRED ARGUMENT, NOT A DEFAULT. This is the part
// worth reading. The two quotas that already exist in this codebase fail in
// OPPOSITE directions, both correctly:
//
//   aiService's daily limit fails OPEN. It is a cost safety net. If Redis
//   blips, "AI still works and the cap is briefly unenforced" is right, and
//   "the AI feature is down because its bookkeeping counter is unreachable"
//   is wrong -- a provider outage is what should make AI unavailable.
//
//   uploadService's storage ceiling fails CLOSED. It is backed by the same
//   database the upload is about to be written to, so if the usage figure
//   cannot be read the write probably cannot succeed either, and letting
//   uploads through unmetered during a database problem is how a disk fills.
//
// Getting that backwards is silent in both directions -- an unenforced cap
// costs money, an over-enforced one looks like an outage -- so `onFailure`
// has no default and a caller that omits it gets an error at construction
// rather than a guess at runtime.
//
// WHY REDIS. Unchanged from WP-050's reasoning: a counter-with-expiry is
// exactly INCR+EXPIRE, one atomic round trip, no read-modify-write. Mongo
// would need either the racy read-then-write pattern WP-020c diagnosed, or an
// atomic $inc plus a second mechanism for expiry that Redis gives for free as
// a key TTL. Note the deliberate exception: uploadService's storage quota does
// NOT use this helper, because its figure is derived by aggregating the files
// that actually exist rather than counted as it goes -- a counter there could
// drift from reality after a failed write, and the authoritative number is
// cheap to compute from an indexed field.

const WINDOWS = {
  // The TTL carries slack past the nominal window so a key created just before
  // a boundary expires comfortably after that window closes, rather than
  // racing a re-INCR at exactly the boundary. WP-050's 26h for a day, same
  // reasoning applied per window.
  minute: { seconds: 60, ttl: 90, bucket: (d) => d.toISOString().slice(0, 16) },
  hour: { seconds: 3600, ttl: 4500, bucket: (d) => d.toISOString().slice(0, 13) },
  day: { seconds: 86400, ttl: 26 * 3600, bucket: (d) => d.toISOString().slice(0, 10) },
  // No window: a running total with no expiry, for "how much of your plan
  // allowance have you used" rather than a rate. Nothing expires it, so the
  // caller owns resetting or recomputing it.
  total: { seconds: null, ttl: null, bucket: () => 'total' }
};

let cachedClient = null;

function getClient(logger) {
  const uri = process.env.REDIS_URI || null;
  if (!uri) return null;
  if (cachedClient) return cachedClient;
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
    logger.error('redis quota client error', { error: err.message });
  });
  return cachedClient;
}

function waitForReady(client, timeoutMs) {
  if (client.status === 'ready') return Promise.resolve();
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

function resolveLimit(limitEnvVar, defaultLimit) {
  const raw = limitEnvVar ? process.env[limitEnvVar] : undefined;
  if (raw === undefined || String(raw).trim() === '') return defaultLimit;
  const text = String(raw).trim();
  // Digits only, for the reason uploadService's caps document: parseInt('1e9')
  // is 1 and parseInt('50/day') is 50, so a plausible operator typo would
  // install an absurd limit rather than be rejected.
  if (!/^[0-9]+$/.test(text)) return defaultLimit;
  const parsed = parseInt(text, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : defaultLimit;
}

// createQuota({ name, subject, window, limitEnvVar, defaultLimit, onFailure })
//
//   name          identifies the quota in keys and logs, e.g. 'ai-calls'
//   subject       what is being metered: 'user' | 'project' | 'organization'
//                 (used only for key shape and log clarity)
//   window        'minute' | 'hour' | 'day' | 'total'
//   limitEnvVar   env var an operator overrides the limit with
//   defaultLimit  used when that is unset or unreadable
//   onFailure     'allow' | 'deny' -- REQUIRED, see the header
function createQuota(options) {
  const { name, subject, window = 'day', limitEnvVar, defaultLimit, onFailure } = options || {};

  if (!name) throw new Error('createQuota requires a name');
  if (!WINDOWS[window]) {
    throw new Error(`createQuota: unknown window '${window}'. Use one of: ${Object.keys(WINDOWS).join(', ')}`);
  }
  if (!Number.isInteger(defaultLimit) || defaultLimit <= 0) {
    throw new Error('createQuota requires a positive integer defaultLimit');
  }
  if (onFailure !== 'allow' && onFailure !== 'deny') {
    // Deliberately no default. See the header: the two quotas already in this
    // codebase fail in opposite directions and both are correct, so this is a
    // decision the caller has to make rather than inherit.
    throw new Error(
      `createQuota({ name: '${name}' }) requires onFailure: 'allow' (a cost cap -- keep working if the ` +
        "counter is unreachable) or 'deny' (a limit whose enforcement matters more than availability). " +
        'There is no default on purpose.'
    );
  }

  const logger = createLogger(`quota:${name}`);
  const spec = WINDOWS[window];

  function keyFor(id, date = new Date()) {
    return `quota:${name}:${subject || 'subject'}:${id}:${spec.bucket(date)}`;
  }

  // Consumes `amount` units and reports whether the caller is within limit.
  // NEVER throws: the outcome of an infrastructure failure is decided by
  // `onFailure` and reported as `degraded: true` so a call site can log it.
  async function consume(id, amount = 1) {
    const limit = resolveLimit(limitEnvVar, defaultLimit);
    if (id === undefined || id === null || id === '') {
      // A missing subject would otherwise meter everybody into one shared
      // bucket, which is worse than not metering: one tenant's usage would
      // deny another's.
      throw new Error(`quota '${name}': a subject id is required`);
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error(`quota '${name}': amount must be a positive integer`);
    }

    const client = getClient(logger);
    const degradedResult = {
      allowed: onFailure === 'allow',
      count: 0,
      limit,
      remaining: onFailure === 'allow' ? limit : 0,
      degraded: true
    };

    if (!client) {
      logger.warn('REDIS_URI not configured; quota is not enforced', { subject: id, onFailure });
      return degradedResult;
    }

    try {
      await waitForReady(client, 2000);
      const key = keyFor(id);
      const count = await client.incrby(key, amount);
      // Only on first write, and only for a windowed quota. 'total' has no
      // expiry by design.
      if (count === amount && spec.ttl) {
        await client.expire(key, spec.ttl);
      }
      return {
        allowed: count <= limit,
        count,
        limit,
        remaining: Math.max(0, limit - count),
        degraded: false
      };
    } catch (err) {
      logger[onFailure === 'allow' ? 'error' : 'warn'](
        `quota check failed; failing ${onFailure === 'allow' ? 'open' : 'closed'}`,
        { subject: id, error: err.message }
      );
      return degradedResult;
    }
  }

  // Reads usage without consuming, for showing an allowance in a UI.
  async function peek(id) {
    const limit = resolveLimit(limitEnvVar, defaultLimit);
    const client = getClient(logger);
    if (!client) return { count: 0, limit, remaining: limit, degraded: true };
    try {
      await waitForReady(client, 2000);
      const raw = await client.get(keyFor(id));
      const count = raw ? parseInt(raw, 10) : 0;
      return { count, limit, remaining: Math.max(0, limit - count), degraded: false };
    } catch (err) {
      logger.warn('quota peek failed', { subject: id, error: err.message });
      return { count: 0, limit, remaining: limit, degraded: true };
    }
  }

  return { consume, peek, keyFor, limit: () => resolveLimit(limitEnvVar, defaultLimit), window };
}

function _resetQuotaClientForTests() {
  if (cachedClient) cachedClient.disconnect();
  cachedClient = null;
}

module.exports = { createQuota, _resetQuotaClientForTests, WINDOWS };
