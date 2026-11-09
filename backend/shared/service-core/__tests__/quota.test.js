// WP-135 (third bullet) — the generalised per-tenant quota helper.
//
// Generalised from aiService/lib/rateLimiter.js. The behaviour worth pinning
// is not the counting -- INCR is Redis's job -- it is:
//
//   - the FAILURE POSTURE, which has no default on purpose, because the two
//     quotas already in this codebase fail in opposite directions and both
//     are correct (see quota.js's header);
//   - that a missing subject id THROWS rather than metering every tenant into
//     one shared bucket, where one tenant's usage would deny another's;
//   - that a malformed limit falls back to the default rather than becoming
//     an absurd one, the same trap uploadService's caps hit with parseInt.

const mockRedis = {
    status: 'ready',
    incrby: jest.fn(),
    expire: jest.fn(),
    get: jest.fn(),
    on: jest.fn(),
    once: jest.fn(),
    removeListener: jest.fn(),
    disconnect: jest.fn()
};

jest.mock('ioredis', () => jest.fn(() => mockRedis));

const ORIGINAL = { ...process.env };

function load() {
    // eslint-disable-next-line global-require
    return require('../quota');
}

beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockRedis.status = 'ready';
    process.env.REDIS_URI = 'redis://localhost:6379';
    delete process.env.TEST_QUOTA_LIMIT;
});
afterAll(() => { process.env = ORIGINAL; });

describe('createQuota: construction', () => {
    it('REFUSES to be created without an explicit failure posture', () => {
        // The whole point. A default here would be a silent decision: an
        // unenforced cap costs money, an over-enforced one looks like an
        // outage, and which is correct depends entirely on what is metered.
        const { createQuota } = load();
        expect(() =>
            createQuota({ name: 'x', subject: 'user', window: 'day', defaultLimit: 10 })
        ).toThrow(/requires onFailure/);
        expect(() =>
            createQuota({ name: 'x', subject: 'user', window: 'day', defaultLimit: 10, onFailure: 'maybe' })
        ).toThrow(/requires onFailure/);
    });

    it('rejects an unknown window and a non-positive default limit', () => {
        const { createQuota } = load();
        expect(() =>
            createQuota({ name: 'x', window: 'fortnight', defaultLimit: 10, onFailure: 'allow' })
        ).toThrow(/unknown window/);
        expect(() => createQuota({ name: 'x', defaultLimit: 0, onFailure: 'allow' })).toThrow(/defaultLimit/);
        expect(() => createQuota({ name: 'x', defaultLimit: -5, onFailure: 'allow' })).toThrow(/defaultLimit/);
    });

    it('keys by name, subject kind and window bucket, so two quotas cannot collide', () => {
        const { createQuota } = load();
        const ai = createQuota({ name: 'ai-calls', subject: 'user', window: 'day', defaultLimit: 50, onFailure: 'allow' });
        const tests = createQuota({ name: 'tests-managed', subject: 'organization', window: 'total', defaultLimit: 100, onFailure: 'deny' });
        const d = new Date('2026-10-18T12:34:56Z');
        expect(ai.keyFor('u1', d)).toBe('quota:ai-calls:user:u1:2026-10-18');
        expect(tests.keyFor('o1', d)).toBe('quota:tests-managed:organization:o1:total');
        // Different quotas, different subjects, no shared bucket.
        expect(ai.keyFor('u1', d)).not.toBe(tests.keyFor('u1', d));
    });

    it('buckets by the window granularity', () => {
        const { createQuota } = load();
        const d = new Date('2026-10-18T12:34:56Z');
        const mk = (w) => createQuota({ name: 'q', window: w, defaultLimit: 1, onFailure: 'allow' }).keyFor('s', d);
        expect(mk('minute')).toContain('2026-10-18T12:34');
        expect(mk('hour')).toContain('2026-10-18T12');
        expect(mk('day')).toMatch(/2026-10-18$/);
        expect(mk('total')).toMatch(/total$/);
    });
});

describe('createQuota: counting', () => {
    function quota(onFailure = 'allow', extra = {}) {
        const { createQuota } = load();
        return createQuota({
            name: 'test-quota',
            subject: 'project',
            window: 'day',
            limitEnvVar: 'TEST_QUOTA_LIMIT',
            defaultLimit: 10,
            onFailure,
            ...extra
        });
    }

    it('allows while under the limit and reports what is left', async () => {
        mockRedis.incrby.mockResolvedValue(3);
        const result = await quota().consume('proj-1');
        expect(result).toEqual({ allowed: true, count: 3, limit: 10, remaining: 7, degraded: false });
    });

    it('is inclusive at the limit and denies past it', async () => {
        mockRedis.incrby.mockResolvedValue(10);
        expect((await quota().consume('p')).allowed).toBe(true);
        jest.resetModules();
        mockRedis.incrby.mockResolvedValue(11);
        const over = await quota().consume('p');
        expect(over.allowed).toBe(false);
        expect(over.remaining).toBe(0);
    });

    it('sets the TTL only on the first write of a window', async () => {
        mockRedis.incrby.mockResolvedValue(1);
        await quota().consume('p');
        expect(mockRedis.expire).toHaveBeenCalledWith(expect.any(String), 26 * 3600);

        jest.clearAllMocks();
        mockRedis.incrby.mockResolvedValue(2);
        await quota().consume('p');
        // Re-setting it on every call would slide the window forward forever
        // and the quota would never reset.
        expect(mockRedis.expire).not.toHaveBeenCalled();
    });

    it('never expires a "total" quota', async () => {
        mockRedis.incrby.mockResolvedValue(1);
        await quota('deny', { window: 'total' }).consume('p');
        expect(mockRedis.expire).not.toHaveBeenCalled();
    });

    it('meters cost units, not just calls', async () => {
        // What makes this usable for bytes or test counts rather than only
        // request counts.
        mockRedis.incrby.mockResolvedValue(5000);
        const result = await quota('deny', { defaultLimit: 10000 }).consume('p', 5000);
        expect(mockRedis.incrby).toHaveBeenCalledWith(expect.any(String), 5000);
        expect(result.count).toBe(5000);
    });

    it('THROWS on a missing subject rather than metering everyone together', async () => {
        // A shared bucket is worse than no metering: one tenant's usage would
        // deny another's.
        await expect(quota().consume(undefined)).rejects.toThrow(/subject id is required/);
        await expect(quota().consume('')).rejects.toThrow(/subject id is required/);
        await expect(quota().consume(null)).rejects.toThrow(/subject id is required/);
    });

    it('rejects a non-positive or fractional amount', async () => {
        await expect(quota().consume('p', 0)).rejects.toThrow(/positive integer/);
        await expect(quota().consume('p', -1)).rejects.toThrow(/positive integer/);
        await expect(quota().consume('p', 1.5)).rejects.toThrow(/positive integer/);
    });
});

describe('createQuota: the failure posture actually differs', () => {
    function quota(onFailure) {
        const { createQuota } = load();
        return createQuota({ name: 'q', subject: 'user', defaultLimit: 10, onFailure });
    }

    it("onFailure 'allow' keeps working when Redis is unreachable (a cost cap)", async () => {
        mockRedis.incrby.mockRejectedValue(new Error('connection lost'));
        const r = await quota('allow').consume('u1');
        expect(r.allowed).toBe(true);
        expect(r.degraded).toBe(true);
    });

    it("onFailure 'deny' refuses when Redis is unreachable (enforcement matters more)", async () => {
        mockRedis.incrby.mockRejectedValue(new Error('connection lost'));
        const r = await quota('deny').consume('u1');
        expect(r.allowed).toBe(false);
        expect(r.degraded).toBe(true);
    });

    it('applies the same posture when Redis is not configured at all', async () => {
        delete process.env.REDIS_URI;
        expect((await quota('allow').consume('u1')).allowed).toBe(true);
        jest.resetModules();
        delete process.env.REDIS_URI;
        expect((await quota('deny').consume('u1')).allowed).toBe(false);
    });

    it('always marks a degraded call, so a call site can log that the cap was not enforced', async () => {
        delete process.env.REDIS_URI;
        expect((await quota('allow').consume('u1')).degraded).toBe(true);
    });
});

describe('createQuota: the configured limit', () => {
    function quota() {
        const { createQuota } = load();
        return createQuota({
            name: 'q', limitEnvVar: 'TEST_QUOTA_LIMIT', defaultLimit: 10, onFailure: 'allow'
        });
    }

    it('honours an operator-supplied limit', () => {
        process.env.TEST_QUOTA_LIMIT = '250';
        expect(quota().limit()).toBe(250);
    });

    it.each([['garbage'], ['1e9'], ['50/day'], ['0'], ['-5'], ['2.5'], ['']])(
        'falls back to the default rather than an absurd limit for %p',
        (value) => {
            // parseInt would read '1e9' as 1 and '50/day' as 50 -- a plausible
            // typo installing a limit far from what was meant. Same trap
            // uploadService's caps hit.
            process.env.TEST_QUOTA_LIMIT = value;
            expect(quota().limit()).toBe(10);
        }
    );
});

describe('createQuota: peek', () => {
    it('reads usage without consuming', async () => {
        const { createQuota } = load();
        const q = createQuota({ name: 'q', defaultLimit: 10, onFailure: 'allow' });
        mockRedis.get.mockResolvedValue('4');
        const r = await q.peek('u1');
        expect(r).toEqual({ count: 4, limit: 10, remaining: 6, degraded: false });
        expect(mockRedis.incrby).not.toHaveBeenCalled();
    });

    it('treats an absent key as zero usage', async () => {
        const { createQuota } = load();
        const q = createQuota({ name: 'q', defaultLimit: 10, onFailure: 'allow' });
        mockRedis.get.mockResolvedValue(null);
        expect((await q.peek('u1')).count).toBe(0);
    });
});
