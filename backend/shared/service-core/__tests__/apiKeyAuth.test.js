jest.mock('../httpClient', () => ({ requestWithRetry: jest.fn() }));
jest.mock('../keycloak', () => ({
  initKeycloak: jest.fn()
}));

const { requestWithRetry } = require('../httpClient');
const { initKeycloak } = require('../keycloak');
const { requireAuth } = require('../middleware/apiKeyAuth');
const { PROJECT_ID_HEADER } = require('../middleware/projectScope');

// WP-032 unit tests for requireAuth() -- the dual-credential (Keycloak
// bearer OR API key) middleware. Covers: delegation to keycloak.protect()
// when no X-Api-Key header is present, malformed header, invalid/revoked
// key (identity service says valid:false), scope mismatch (positive
// enumeration), project-binding mismatch (including a MISSING
// X-Project-Id header -- fails closed, does not silently default to the
// key's own project), identity-service-unavailable (fail closed, 503,
// no cache), and the success path setting req.apiKeyAuth +
// req.projectScope.

function makeReq(headers = {}) {
  return { headers, correlationId: 'corr-1' };
}

describe('requireAuth() (WP-032 dual-auth middleware)', () => {
  let protectMiddleware;

  beforeEach(() => {
    requestWithRetry.mockReset();
    protectMiddleware = jest.fn((req, res, next) => next());
    initKeycloak.mockReturnValue({ protect: () => protectMiddleware });
    process.env.userService = 'userservice:3000';
  });

  it('delegates to keycloak.protect() when no X-Api-Key header is present', async () => {
    const req = makeReq({});
    const next = jest.fn();

    await requireAuth('results:write')(req, {}, next);

    expect(protectMiddleware).toHaveBeenCalledWith(req, {}, next);
    expect(requestWithRetry).not.toHaveBeenCalled();
  });

  it('rejects a malformed X-Api-Key header (no separator)', async () => {
    const req = makeReq({ 'x-api-key': 'not-well-formed' });
    const next = jest.fn();

    await requireAuth('results:write')(req, {}, next);

    expect(next.mock.calls[0][0].statusCode).toBe(401);
    expect(requestWithRetry).not.toHaveBeenCalled();
  });

  it('rejects when the identity service says the key is invalid/revoked', async () => {
    requestWithRetry.mockResolvedValue({ data: { valid: false } });
    const req = makeReq({ 'x-api-key': 'ak_x.secret', [PROJECT_ID_HEADER]: '1' });
    const next = jest.fn();

    await requireAuth('results:write')(req, {}, next);

    expect(next.mock.calls[0][0].statusCode).toBe(401);
  });

  it('rejects (403) when the key lacks the required scope -- positive enumeration, not a denylist', async () => {
    requestWithRetry.mockResolvedValue({
      data: { valid: true, keyId: 'ak_x', projectId: 1, scopes: ['results:read'] }
    });
    const req = makeReq({ 'x-api-key': 'ak_x.secret', [PROJECT_ID_HEADER]: '1' });
    const next = jest.fn();

    await requireAuth('results:write')(req, {}, next);

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(403);
    expect(err.message).toMatch(/results:write/);
  });

  it('rejects (403) when X-Project-Id is missing entirely -- fails closed, does not default to the key\'s own project', async () => {
    requestWithRetry.mockResolvedValue({
      data: { valid: true, keyId: 'ak_x', projectId: 1, scopes: ['results:write'] }
    });
    const req = makeReq({ 'x-api-key': 'ak_x.secret' }); // no X-Project-Id at all
    const next = jest.fn();

    await requireAuth('results:write')(req, {}, next);

    expect(next.mock.calls[0][0].statusCode).toBe(403);
    expect(req.apiKeyAuth).toBeUndefined();
  });

  it('rejects (403) when X-Project-Id does not match the key\'s bound project, even though it is well-formed', async () => {
    requestWithRetry.mockResolvedValue({
      data: { valid: true, keyId: 'ak_x', projectId: 1, scopes: ['results:write'] }
    });
    const req = makeReq({ 'x-api-key': 'ak_x.secret', [PROJECT_ID_HEADER]: '2' });
    const next = jest.fn();

    await requireAuth('results:write')(req, {}, next);

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(403);
    expect(err.message).toMatch(/not authorized for this project/i);
  });

  it('succeeds: sets req.apiKeyAuth and a pre-satisfied req.projectScope, calls next() with no error', async () => {
    requestWithRetry.mockResolvedValue({
      data: { valid: true, keyId: 'ak_x', projectId: 1, scopes: ['results:write', 'results:read'] }
    });
    const req = makeReq({ 'x-api-key': 'ak_x.thesecret', [PROJECT_ID_HEADER]: '1' });
    const next = jest.fn();

    await requireAuth('results:write')(req, {}, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.apiKeyAuth).toEqual({ keyId: 'ak_x', projectId: 1, scopes: ['results:write', 'results:read'] });
    expect(req.projectScope).toEqual({ projectId: 1, project: null });

    // Verifies the (keyId, secret) split -- a secret containing dots must
    // not be truncated (only the FIRST "." is the separator).
    const call = requestWithRetry.mock.calls[0][0];
    expect(call.data).toEqual({ keyId: 'ak_x', secret: 'thesecret' });
  });

  it('fails closed (503) when the identity service is unreachable -- never silently lets the request through', async () => {
    requestWithRetry.mockRejectedValue(new Error('ECONNREFUSED'));
    const req = makeReq({ 'x-api-key': 'ak_x.secret', [PROJECT_ID_HEADER]: '1' });
    const next = jest.fn();

    await requireAuth('results:write')(req, {}, next);

    expect(next.mock.calls[0][0].statusCode).toBe(503);
  });

  it('a secret containing "." characters is preserved intact (split on first "." only)', async () => {
    requestWithRetry.mockResolvedValue({
      data: { valid: true, keyId: 'ak_x', projectId: 1, scopes: ['results:write'] }
    });
    const req = makeReq({ 'x-api-key': 'ak_x.abc.def.ghi', [PROJECT_ID_HEADER]: '1' });
    const next = jest.fn();

    await requireAuth('results:write')(req, {}, next);

    expect(requestWithRetry.mock.calls[0][0].data).toEqual({ keyId: 'ak_x', secret: 'abc.def.ghi' });
    expect(next).toHaveBeenCalledWith();
  });
});
