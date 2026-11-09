const Redis = require('ioredis');
const {
  createHealthzHandler,
  pingMongoConnection,
  pingRedisUri,
  _resetHealthRedisClientsForTests
} = require('../health');

// WP-061 -- plain Jest coverage of the shared /healthz building block.
// pingRedisUri() is exercised against the real Redis container (same
// TEST_REDIS_URI convention as events.test.js) since there is no
// ioredis-mock in this repo's dependency tree; pingMongoConnection() and
// createHealthzHandler() are exercised with hand-built fakes since they
// only need a mongoose-connection-shaped object / plain check functions,
// not a real database.
const TEST_REDIS_URI = process.env.TEST_REDIS_URI || 'redis://localhost:16379';

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

afterEach(() => {
  _resetHealthRedisClientsForTests();
});

describe('pingMongoConnection()', () => {
  test('null/undefined connection: false', async () => {
    await expect(pingMongoConnection(null)).resolves.toBe(false);
    await expect(pingMongoConnection(undefined)).resolves.toBe(false);
  });

  test('readyState !== 1 (not connected): false, without calling db.admin()', async () => {
    const admin = jest.fn();
    const connection = { readyState: 0, db: { admin: () => ({ ping: admin }) } };
    await expect(pingMongoConnection(connection)).resolves.toBe(false);
    expect(admin).not.toHaveBeenCalled();
  });

  test('readyState === 1 and ping() resolves: true', async () => {
    const connection = {
      readyState: 1,
      db: { admin: () => ({ ping: jest.fn().mockResolvedValue({ ok: 1 }) }) }
    };
    await expect(pingMongoConnection(connection)).resolves.toBe(true);
  });

  test('readyState === 1 but ping() rejects (server up, DB unreachable): false, not a throw', async () => {
    const connection = {
      readyState: 1,
      db: { admin: () => ({ ping: jest.fn().mockRejectedValue(new Error('server selection timed out')) }) }
    };
    await expect(pingMongoConnection(connection)).resolves.toBe(false);
  });
});

describe('pingRedisUri()', () => {
  test('no URI configured: false, no client created', async () => {
    await expect(pingRedisUri(null)).resolves.toBe(false);
    await expect(pingRedisUri(undefined)).resolves.toBe(false);
  });

  test('real, reachable Redis: true', async () => {
    await expect(pingRedisUri(TEST_REDIS_URI)).resolves.toBe(true);
  });

  test('unreachable Redis (nothing listening on this port): false, not a throw/hang', async () => {
    await expect(pingRedisUri('redis://127.0.0.1:19999')).resolves.toBe(false);
  }, 10000);
});

describe('createHealthzHandler()', () => {
  test('all required + optional checks pass: 200, status "ok"', async () => {
    const handler = createHealthzHandler('svc', {
      required: { mongo: async () => true },
      optional: { redis: async () => true }
    });
    const res = fakeRes();
    await handler({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      service: 'svc',
      checks: { mongo: 'ok', redis: 'ok' }
    });
    expect(typeof res.body.timestamp).toBe('string');
  });

  test('required check fails: 503, status "down" -- THE degraded-path proof', async () => {
    const handler = createHealthzHandler('svc', {
      required: { mongo: async () => false },
      optional: { redis: async () => true }
    });
    const res = fakeRes();
    await handler({}, res);
    expect(res.statusCode).toBe(503);
    expect(res.body.status).toBe('down');
    expect(res.body.checks.mongo).toBe('down');
  });

  test('required check THROWS: treated as down (503), not an unhandled rejection', async () => {
    const handler = createHealthzHandler('svc', {
      required: { mongo: async () => { throw new Error('boom'); } }
    });
    const res = fakeRes();
    await expect(handler({}, res)).resolves.toBeUndefined();
    expect(res.statusCode).toBe(503);
    expect(res.body.checks.mongo).toBe('down');
  });

  test('required ok, optional fails: 200 but status "degraded" -- NOT silently green', async () => {
    const handler = createHealthzHandler('svc', {
      required: { mongo: async () => true },
      optional: { redis: async () => false }
    });
    const res = fakeRes();
    await handler({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('degraded');
    expect(res.body.checks).toEqual({ mongo: 'ok', redis: 'down' });
  });

  test('no checks configured at all: 200, status "ok", empty checks', async () => {
    const handler = createHealthzHandler('svc', {});
    const res = fakeRes();
    await handler({}, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks).toEqual({});
  });
});
