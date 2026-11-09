const Redis = require('ioredis');

// WP-050 -- plain Jest coverage of the per-user daily rate limiter's own
// logic, same pattern service-core's events.test.js uses for Redis Streams:
// requires a real, reachable Redis (no ioredis-mock in this repo's
// dependency tree) -- the container publishes on host port 16379
// (docker-compose.yml), deliberately not 6379 (a stray native
// redis-server was found already listening on the host's 127.0.0.1:6379,
// see that mapping's comment and CLAUDE.md's environment hazards).
// Overridable via TEST_REDIS_URI for CI/local variance.
const TEST_REDIS_URI = process.env.TEST_REDIS_URI || 'redis://localhost:16379';

let raw; // second, plain client used only for test-side assertions/cleanup
let rateLimiter;

function uniqueUserId(label) {
  return `wp050-test-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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
  rateLimiter = require('../lib/rateLimiter');
});

afterEach(async () => {
  rateLimiter._resetRateLimiterForTests();
  delete process.env.REDIS_URI;
  delete process.env.AI_DAILY_RATE_LIMIT;
});

describe('checkAndIncrementDailyUsage()', () => {
  it('allows the first call and increments a per-user-per-day counter in Redis', async () => {
    const userId = uniqueUserId('first');
    const result = await rateLimiter.checkAndIncrementDailyUsage(userId);
    expect(result).toEqual({ allowed: true, count: 1, limit: 50, degraded: false });

    const key = rateLimiter.dayKey(userId);
    expect(await raw.get(key)).toBe('1');
    // TTL set on first increment.
    expect(await raw.ttl(key)).toBeGreaterThan(0);
  });

  it('respects AI_DAILY_RATE_LIMIT and blocks once the limit is exceeded', async () => {
    process.env.AI_DAILY_RATE_LIMIT = '3';
    jest.resetModules();
    // eslint-disable-next-line global-require
    rateLimiter = require('../lib/rateLimiter');
    const userId = uniqueUserId('limit');

    const results = [];
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await rateLimiter.checkAndIncrementDailyUsage(userId));
    }

    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
    expect(results.map((r) => r.count)).toEqual([1, 2, 3, 4, 5]);
    expect(results.every((r) => r.limit === 3)).toBe(true);
  });

  it('two different users have independent counters', async () => {
    const userA = uniqueUserId('a');
    const userB = uniqueUserId('b');
    await rateLimiter.checkAndIncrementDailyUsage(userA);
    await rateLimiter.checkAndIncrementDailyUsage(userA);
    const bResult = await rateLimiter.checkAndIncrementDailyUsage(userB);
    expect(bResult.count).toBe(1);
  });

  it('fails open (never throws, allowed:true) when REDIS_URI is not configured', async () => {
    delete process.env.REDIS_URI;
    jest.resetModules();
    // eslint-disable-next-line global-require
    const unconfigured = require('../lib/rateLimiter');
    const result = await unconfigured.checkAndIncrementDailyUsage(uniqueUserId('unconfigured'));
    expect(result.allowed).toBe(true);
    expect(result.degraded).toBe(true);
  });

  it('fails open when Redis is configured but unreachable', async () => {
    process.env.REDIS_URI = 'redis://127.0.0.1:1'; // nothing listens here
    jest.resetModules();
    // eslint-disable-next-line global-require
    const unreachable = require('../lib/rateLimiter');
    const result = await unreachable.checkAndIncrementDailyUsage(uniqueUserId('unreachable'));
    expect(result.allowed).toBe(true);
    expect(result.degraded).toBe(true);
    unreachable._resetRateLimiterForTests();
  }, 10000);
});
