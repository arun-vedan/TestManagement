// WP-101 — resolveSessionSecret().
//
// The point of this helper is that a missing secret must NEVER silently become
// a shared constant, which is the defect it replaces. So the tests assert the
// three outcomes that matter, including the refusal.
//
// Each test re-requires the module via jest.resetModules() because the helper
// memoises its generated value and its one-time warning on purpose.

describe('resolveSessionSecret (WP-101)', () => {
  const ORIGINAL = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    delete process.env.SESSION_SECRET;
    delete process.env.NODE_ENV;
  });

  afterAll(() => {
    process.env = ORIGINAL;
  });

  function load() {
    // eslint-disable-next-line global-require
    return require('../sessionSecret').resolveSessionSecret;
  }

  it('uses SESSION_SECRET when it is set', () => {
    process.env.SESSION_SECRET = 'a-real-secret-from-env';
    expect(load()()).toBe('a-real-secret-from-env');
  });

  it('uses SESSION_SECRET in production too, without warning', () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = 'prod-secret';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    expect(load()()).toBe('prod-secret');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('REFUSES to start in production when unset — the whole point', () => {
    process.env.NODE_ENV = 'production';
    expect(() => load()()).toThrow(/SESSION_SECRET/);
    // The message must tell the operator how to fix it, not just what is wrong.
    expect(() => load()()).toThrow(/randomBytes/);
  });

  it('treats a whitespace-only value as unset rather than as a secret', () => {
    process.env.NODE_ENV = 'production';
    process.env.SESSION_SECRET = '   ';
    expect(() => load()()).toThrow(/SESSION_SECRET/);
  });

  it('outside production, generates a random secret and warns once', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const resolve = load();
    const first = resolve();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(warn).toHaveBeenCalledTimes(1);

    // Stable within the process: express-session is configured once at boot,
    // but anything re-reading it must not get a different key.
    expect(resolve()).toBe(first);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('does not reuse the same generated secret across processes', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const a = load()();
    jest.resetModules();
    const b = load()();
    // If these were ever equal, the fallback would itself be a shared constant
    // — exactly the defect WP-101 removes.
    expect(a).not.toBe(b);
    warn.mockRestore();
  });

  it('never returns the values it replaced', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const got = load()();
    expect(got).not.toBe('mySecret');
    expect(got).not.toBe('test');
    warn.mockRestore();
  });
});
