// initKeycloak caches a module-level instance, so each test needs a fresh
// module load (jest.resetModules) to actually exercise the validation logic
// rather than hitting the cache from a previous test.

const REQUIRED_VARS = [
  'KeyCloak_clientId',
  'KeyCloak_URI',
  'KeyCloak_Realm',
  'KeyCloak_Secret',
  'KeyCloak_publicKey'
];

const VALID_ENV = {
  KeyCloak_clientId: 'node-microservice',
  KeyCloak_URI: 'http://localhost:8080',
  KeyCloak_Realm: 'srckube',
  KeyCloak_Secret: 'test-secret',
  KeyCloak_publicKey: 'test-public-key'
};

describe('initKeycloak', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    REQUIRED_VARS.forEach((key) => delete process.env[key]);
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  // This is the direct regression test for TD-19/TD-20: the old per-service
  // keycloak-config.js files silently started with a wrong/stale config and
  // only surfaced as mysterious 403s in production. This must throw instead.
  it.each(REQUIRED_VARS)('throws when %s is missing instead of silently starting misconfigured', (missingVar) => {
    Object.assign(process.env, VALID_ENV);
    delete process.env[missingVar];

    const { initKeycloak } = require('../keycloak');

    expect(() => initKeycloak()).toThrow(missingVar);
  });

  it('constructs a Keycloak instance when fully configured', () => {
    Object.assign(process.env, VALID_ENV);

    const { initKeycloak } = require('../keycloak');

    expect(() => initKeycloak()).not.toThrow();
  });

  it('returns the same cached instance on a second call rather than reinitializing', () => {
    Object.assign(process.env, VALID_ENV);

    const { initKeycloak } = require('../keycloak');

    const first = initKeycloak();
    const second = initKeycloak();

    expect(first).toBe(second);
  });
});
