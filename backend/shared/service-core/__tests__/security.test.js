const { applyStandardSecurity, resolveRateLimitMax } = require('../security');

// Sprint 2.1: requirementService's original rate limit (10000) was
// deliberately different from the otherwise-universal 100 found across every
// other service — confirmed by reading its server.js before migrating it,
// not assumed. This test exists so that difference can't silently regress if
// this function's default ever changes.
describe('applyStandardSecurity', () => {
  it('registers middleware for each piece of the standard stack', () => {
    const app = { use: jest.fn(), options: jest.fn() };

    applyStandardSecurity(app);

    // fileupload, mongoSanitize, helmet, xss, rateLimit, hpp, cors = 7 app.use calls
    expect(app.use).toHaveBeenCalledTimes(7);
    expect(app.options).toHaveBeenCalledWith('*', expect.any(Function));
  });

  it('accepts a rateLimitMax override without throwing (regression test for the requirementService 10000 case)', () => {
    const app = { use: jest.fn(), options: jest.fn() };

    expect(() => applyStandardSecurity(app, { rateLimitMax: 10000 })).not.toThrow();
    expect(app.use).toHaveBeenCalledTimes(7);
  });
});

// WP-002c: RATE_LIMIT_MAX env override and its precedence against an
// explicit call-site rateLimitMax argument. resolveRateLimitMax() is the
// pure decision function applyStandardSecurity() delegates to for the
// rate-limiter's `max` option, so it's tested directly here rather than by
// trying to reach into the express-rate-limit instance's internals.
describe('resolveRateLimitMax', () => {
  const ORIGINAL_ENV = process.env.RATE_LIMIT_MAX;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.RATE_LIMIT_MAX;
    } else {
      process.env.RATE_LIMIT_MAX = ORIGINAL_ENV;
    }
  });

  it('defaults to the production value of 100 when nothing is set (must never move)', () => {
    delete process.env.RATE_LIMIT_MAX;
    expect(resolveRateLimitMax(undefined)).toBe(100);
  });

  it('stays at the production default of 100 when RATE_LIMIT_MAX is unset, even with an empty-string value (unset docker-compose substitution)', () => {
    process.env.RATE_LIMIT_MAX = '';
    expect(resolveRateLimitMax(undefined)).toBe(100);
  });

  it('falls back to the production default of 100 when RATE_LIMIT_MAX is not a valid positive integer', () => {
    process.env.RATE_LIMIT_MAX = 'not-a-number';
    expect(resolveRateLimitMax(undefined)).toBe(100);

    process.env.RATE_LIMIT_MAX = '-5';
    expect(resolveRateLimitMax(undefined)).toBe(100);

    process.env.RATE_LIMIT_MAX = '0';
    expect(resolveRateLimitMax(undefined)).toBe(100);
  });

  it('honours RATE_LIMIT_MAX when the call site leaves rateLimitMax unset (local/test override)', () => {
    process.env.RATE_LIMIT_MAX = '100000';
    expect(resolveRateLimitMax(undefined)).toBe(100000);
  });

  it('lets an explicit call-site rateLimitMax win over RATE_LIMIT_MAX (existing per-service overrides must not change behavior)', () => {
    process.env.RATE_LIMIT_MAX = '100000';
    // requirementService/linkIssueService/defectService's real call-site value
    expect(resolveRateLimitMax(10000)).toBe(10000);
    // userService's real call-site value
    expect(resolveRateLimitMax(1000)).toBe(1000);
  });

  it('lets an explicit call-site rateLimitMax win even when RATE_LIMIT_MAX is unset', () => {
    delete process.env.RATE_LIMIT_MAX;
    expect(resolveRateLimitMax(10000)).toBe(10000);
  });
});

// Confirms the resolved value actually reaches express-rate-limit's `max`
// option from applyStandardSecurity() itself, not just from
// resolveRateLimitMax() in isolation.
describe('applyStandardSecurity + RATE_LIMIT_MAX integration', () => {
  const ORIGINAL_ENV = process.env.RATE_LIMIT_MAX;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.RATE_LIMIT_MAX;
    } else {
      process.env.RATE_LIMIT_MAX = ORIGINAL_ENV;
    }
    jest.resetModules();
    jest.unmock('express-rate-limit');
  });

  function loadSecurityWithMockedRateLimit() {
    jest.resetModules();
    const rateLimitMock = jest.fn(() => (req, res, next) => next());
    jest.doMock('express-rate-limit', () => rateLimitMock);
    // eslint-disable-next-line global-require
    const { applyStandardSecurity: apply } = require('../security');
    return { apply, rateLimitMock };
  }

  it('passes the production default (100) to express-rate-limit when RATE_LIMIT_MAX is unset', () => {
    delete process.env.RATE_LIMIT_MAX;
    const { apply, rateLimitMock } = loadSecurityWithMockedRateLimit();
    const app = { use: jest.fn(), options: jest.fn() };

    apply(app);

    expect(rateLimitMock).toHaveBeenCalledWith(expect.objectContaining({ max: 100 }));
  });

  it('passes the RATE_LIMIT_MAX env value to express-rate-limit when the call site leaves rateLimitMax unset', () => {
    process.env.RATE_LIMIT_MAX = '100000';
    const { apply, rateLimitMock } = loadSecurityWithMockedRateLimit();
    const app = { use: jest.fn(), options: jest.fn() };

    apply(app);

    expect(rateLimitMock).toHaveBeenCalledWith(expect.objectContaining({ max: 100000 }));
  });

  it('passes the explicit call-site rateLimitMax to express-rate-limit even when RATE_LIMIT_MAX is set (existing overrides unaffected)', () => {
    process.env.RATE_LIMIT_MAX = '100000';
    const { apply, rateLimitMock } = loadSecurityWithMockedRateLimit();
    const app = { use: jest.fn(), options: jest.fn() };

    apply(app, { rateLimitMax: 10000 });

    expect(rateLimitMock).toHaveBeenCalledWith(expect.objectContaining({ max: 10000 }));
  });
});
