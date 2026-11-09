// WP-050 -- proves the adapter selection seam itself: getProvider() returns
// a DIFFERENT, independently-implemented module depending on AI_PROVIDER,
// both satisfying the same complete()/completeStructured() interface. This
// is the direct test for "a real abstraction, implemented at least twice"
// (WP-050 ground rule #1) -- not just each provider's own behavior
// (mockProvider.test.js / openaiProvider.test.js), but that the factory
// actually swaps implementations.
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('providers/index.getProvider()', () => {
  it('defaults to mock when AI_PROVIDER is unset', () => {
    delete process.env.AI_PROVIDER;
    // eslint-disable-next-line global-require
    const { getProvider } = require('../providers');
    // eslint-disable-next-line global-require
    const mockProvider = require('../providers/mockProvider');
    expect(getProvider()).toBe(mockProvider);
  });

  it('selects mock explicitly', () => {
    process.env.AI_PROVIDER = 'mock';
    // eslint-disable-next-line global-require
    const { getProvider } = require('../providers');
    // eslint-disable-next-line global-require
    const mockProvider = require('../providers/mockProvider');
    expect(getProvider()).toBe(mockProvider);
  });

  it('selects the independently-implemented openai provider -- a genuinely different module', () => {
    process.env.AI_PROVIDER = 'openai';
    // eslint-disable-next-line global-require
    const { getProvider } = require('../providers');
    // eslint-disable-next-line global-require
    const openaiProvider = require('../providers/openaiProvider');
    // eslint-disable-next-line global-require
    const mockProvider = require('../providers/mockProvider');
    const resolved = getProvider();
    expect(resolved).toBe(openaiProvider);
    expect(resolved).not.toBe(mockProvider);
    // Both implementations satisfy the exact same shape.
    expect(typeof resolved.complete).toBe('function');
    expect(typeof resolved.completeStructured).toBe('function');
  });

  it('an unknown AI_PROVIDER throws a normalised ProviderError, not a raw error', () => {
    process.env.AI_PROVIDER = 'not-a-real-provider';
    // eslint-disable-next-line global-require
    const { getProvider } = require('../providers');
    // eslint-disable-next-line global-require
    const { ProviderError } = require('../providers/errors');
    expect(() => getProvider()).toThrow(ProviderError);
  });
});
