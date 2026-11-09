jest.mock('../httpClient', () => ({ requestWithRetry: jest.fn() }));

const { requestWithRetry } = require('../httpClient');
const { requireProjectScope, PROJECT_ID_HEADER, _resetProjectCacheForTests } = require('../middleware/projectScope');

// WP-021 unit tests, rewritten for WP-110 architecture (c).
//
// WHAT CHANGED AND WHY THESE TESTS LOOK DIFFERENT: this middleware used to
// resolve membership by fetching userService's unfiltered
// GET /api/v1/projects (a LIST of every project, with every project's full
// members[] array) and caching it once, globally, for all callers. It now
// calls GET /api/v1/projects/scope/:projectId, which answers for the CALLING
// user only and returns { projectId, role, status, organizationId } — no
// members[], nothing about any other project.
//
// So the mock returns a single scope object rather than a project list, and
// the cache assertions are keyed per (caller, project) instead of global. The
// behavioural contract the old suite pinned is unchanged and still asserted:
// missing/non-integer header -> 403, non-member -> 403, unknown project ->
// 403 (indistinguishable from non-member), identity service unreachable ->
// 503 fail-closed, API-key short-circuit.

const SCOPE_A = { projectId: 1, role: 'admin', status: 'active', organizationId: 'org-1' };
const SCOPE_B = { projectId: 2, role: 'viewer', status: 'active', organizationId: 'org-1' };

function okResponse(scope) {
  return { data: { data: scope } };
}

// userService answers a definite "no access" with 403, which axios (and so
// requestWithRetry) surfaces as a thrown error carrying err.response.status.
function denied(status = 403) {
  const err = new Error(`Request failed with status code ${status}`);
  err.response = { status, data: { success: false, error: 'No access' } };
  return err;
}

function makeReq({ headers = {}, sub = 'user-a' } = {}) {
  return {
    headers,
    correlationId: 'corr-123',
    kauth: sub ? { grant: { access_token: { content: { sub } } } } : undefined
  };
}

describe('requireProjectScope', () => {
  const OLD_ENV = process.env.userService;

  beforeEach(() => {
    _resetProjectCacheForTests();
    requestWithRetry.mockReset();
    process.env.userService = 'userservice:3000';
  });

  afterAll(() => {
    process.env.userService = OLD_ENV;
  });

  it('allows a valid member through and sets req.projectScope', async () => {
    requestWithRetry.mockResolvedValue(okResponse(SCOPE_A));
    const req = makeReq({ headers: { [PROJECT_ID_HEADER]: '1' }, sub: 'user-a' });
    const next = jest.fn();

    await requireProjectScope()(req, {}, next);

    expect(next).toHaveBeenCalledWith(); // called with no error arg
    expect(req.projectScope).toEqual({
      projectId: 1,
      role: 'admin',
      status: 'active',
      project: { id: 1, status: 'active', organizationId: 'org-1' }
    });
  });

  it('asks only about the project in the header, scoped to the calling user', async () => {
    requestWithRetry.mockResolvedValue(okResponse(SCOPE_B));
    const req = makeReq({ headers: { [PROJECT_ID_HEADER]: '2' }, sub: 'user-b' });

    await requireProjectScope()(req, {}, jest.fn());

    expect(requestWithRetry).toHaveBeenCalledTimes(1);
    const sent = requestWithRetry.mock.calls[0][0];
    expect(sent.url).toBe('http://userservice:3000/api/v1/projects/scope/2');
    // The caller's own bearer token is forwarded; identity comes from it,
    // never from a parameter this middleware invents.
    expect(sent.method).toBe('get');
  });

  it('never receives or exposes any other member of the project', async () => {
    requestWithRetry.mockResolvedValue(okResponse(SCOPE_A));
    const req = makeReq({ headers: { [PROJECT_ID_HEADER]: '1' }, sub: 'user-a' });

    await requireProjectScope()(req, {}, jest.fn());

    // The whole point of architecture (c): members[] is not part of the
    // contract any more, so it cannot leak through req.
    expect(req.projectScope.project.members).toBeUndefined();
    expect(JSON.stringify(req.projectScope)).not.toMatch(/members/);
  });

  it('rejects a non-member of the claimed project with 403', async () => {
    requestWithRetry.mockRejectedValue(denied(403));
    const req = makeReq({ headers: { [PROJECT_ID_HEADER]: '2' }, sub: 'user-a' });
    const next = jest.fn();

    await requireProjectScope()(req, {}, next);

    const err = next.mock.calls[0][0];
    expect(err).toBeDefined();
    expect(err.statusCode).toBe(403);
    expect(req.projectScope).toBeUndefined();
  });

  it('rejects a request with no x-project-id header with 403', async () => {
    const req = makeReq({ headers: {} });
    const next = jest.fn();

    await requireProjectScope()(req, {}, next);

    expect(next.mock.calls[0][0].statusCode).toBe(403);
    expect(requestWithRetry).not.toHaveBeenCalled();
  });

  it('rejects a non-integer x-project-id header with 403', async () => {
    const req = makeReq({ headers: { [PROJECT_ID_HEADER]: 'abc' } });
    const next = jest.fn();

    await requireProjectScope()(req, {}, next);

    expect(next.mock.calls[0][0].statusCode).toBe(403);
    expect(requestWithRetry).not.toHaveBeenCalled();
  });

  it('rejects an unknown/foreign projectId with 403, indistinguishable from a non-member', async () => {
    // userService answers 403 for both cases precisely so this middleware
    // cannot confirm or deny that a project exists.
    requestWithRetry.mockRejectedValue(denied(403));
    const req = makeReq({ headers: { [PROJECT_ID_HEADER]: '999999' }, sub: 'user-a' });
    const next = jest.fn();

    await requireProjectScope()(req, {}, next);

    expect(next.mock.calls[0][0].statusCode).toBe(403);
    expect(req.projectScope).toBeUndefined();
  });

  it('treats a 400 from the identity service as a denial, not an outage', async () => {
    requestWithRetry.mockRejectedValue(denied(400));
    const req = makeReq({ headers: { [PROJECT_ID_HEADER]: '1' }, sub: 'user-a' });
    const next = jest.fn();

    await requireProjectScope()(req, {}, next);

    expect(next.mock.calls[0][0].statusCode).toBe(403);
  });

  it('fails closed with 503 when the identity service is unreachable', async () => {
    requestWithRetry.mockRejectedValue(new Error('ECONNREFUSED'));
    const req = makeReq({ headers: { [PROJECT_ID_HEADER]: '1' }, sub: 'user-a' });
    const next = jest.fn();

    await requireProjectScope()(req, {}, next);

    expect(next.mock.calls[0][0].statusCode).toBe(503);
    expect(req.projectScope).toBeUndefined();
  });

  it('fails closed with 503 on a 5xx from the identity service (an outage, not a denial)', async () => {
    requestWithRetry.mockRejectedValue(denied(500));
    const req = makeReq({ headers: { [PROJECT_ID_HEADER]: '1' }, sub: 'user-a' });
    const next = jest.fn();

    await requireProjectScope()(req, {}, next);

    expect(next.mock.calls[0][0].statusCode).toBe(503);
  });

  it('fails closed with 503 on a malformed response body', async () => {
    requestWithRetry.mockResolvedValue({ data: { data: { nonsense: true } } });
    const req = makeReq({ headers: { [PROJECT_ID_HEADER]: '1' }, sub: 'user-a' });
    const next = jest.fn();

    await requireProjectScope()(req, {}, next);

    expect(next.mock.calls[0][0].statusCode).toBe(503);
  });

  it('fails closed with 503 when the userService env var is not configured', async () => {
    delete process.env.userService;
    const req = makeReq({ headers: { [PROJECT_ID_HEADER]: '1' }, sub: 'user-a' });
    const next = jest.fn();

    await requireProjectScope()(req, {}, next);

    expect(next.mock.calls[0][0].statusCode).toBe(503);
    expect(requestWithRetry).not.toHaveBeenCalled();
  });

  it('returns 401 if there is no authenticated identity on the request (wired in before keycloak.protect())', async () => {
    const req = makeReq({ headers: { [PROJECT_ID_HEADER]: '1' }, sub: undefined });
    // Explicit, not redundant: passing `sub: undefined` triggers makeReq's
    // destructuring DEFAULT ('user-a'), so the request would otherwise carry a
    // perfectly good identity and this test would assert nothing.
    req.kauth = undefined;
    const next = jest.fn();

    await requireProjectScope()(req, {}, next);

    expect(next.mock.calls[0][0].statusCode).toBe(401);
    expect(requestWithRetry).not.toHaveBeenCalled();
  });

  describe('caching — keyed per (caller, project), which is the WP-110 fix', () => {
    it('reuses a cached answer for the same caller and project within the TTL', async () => {
      requestWithRetry.mockResolvedValue(okResponse(SCOPE_A));
      const next = jest.fn();

      await requireProjectScope()(makeReq({ headers: { [PROJECT_ID_HEADER]: '1' }, sub: 'user-a' }), {}, next);
      await requireProjectScope()(makeReq({ headers: { [PROJECT_ID_HEADER]: '1' }, sub: 'user-a' }), {}, next);

      expect(requestWithRetry).toHaveBeenCalledTimes(1);
    });

    // The defect architecture (c) exists to make impossible: under the old
    // single global cache, the first caller's answer was served to everyone.
    it('does NOT serve one caller\'s answer to a different caller', async () => {
      requestWithRetry.mockResolvedValueOnce(okResponse(SCOPE_A)); // user-a is admin on 1
      requestWithRetry.mockRejectedValueOnce(denied(403)); // user-z is not a member of 1

      const reqA = makeReq({ headers: { [PROJECT_ID_HEADER]: '1' }, sub: 'user-a' });
      const nextA = jest.fn();
      await requireProjectScope()(reqA, {}, nextA);
      expect(nextA).toHaveBeenCalledWith();
      expect(reqA.projectScope.role).toBe('admin');

      const reqZ = makeReq({ headers: { [PROJECT_ID_HEADER]: '1' }, sub: 'user-z' });
      const nextZ = jest.fn();
      await requireProjectScope()(reqZ, {}, nextZ);

      // A second lookup happened for the second caller, and it was denied.
      expect(requestWithRetry).toHaveBeenCalledTimes(2);
      expect(nextZ.mock.calls[0][0].statusCode).toBe(403);
      expect(reqZ.projectScope).toBeUndefined();
    });

    it('does not serve one project\'s answer for a different project', async () => {
      requestWithRetry.mockResolvedValueOnce(okResponse(SCOPE_A));
      requestWithRetry.mockResolvedValueOnce(okResponse(SCOPE_B));

      const r1 = makeReq({ headers: { [PROJECT_ID_HEADER]: '1' }, sub: 'user-a' });
      const r2 = makeReq({ headers: { [PROJECT_ID_HEADER]: '2' }, sub: 'user-a' });
      await requireProjectScope()(r1, {}, jest.fn());
      await requireProjectScope()(r2, {}, jest.fn());

      expect(requestWithRetry).toHaveBeenCalledTimes(2);
      expect(r1.projectScope.role).toBe('admin');
      expect(r2.projectScope.role).toBe('viewer');
    });

    it('caches a denial too, so a non-member cannot amplify load onto the identity service', async () => {
      requestWithRetry.mockRejectedValue(denied(403));

      await requireProjectScope()(makeReq({ headers: { [PROJECT_ID_HEADER]: '9' }, sub: 'user-a' }), {}, jest.fn());
      await requireProjectScope()(makeReq({ headers: { [PROJECT_ID_HEADER]: '9' }, sub: 'user-a' }), {}, jest.fn());
      await requireProjectScope()(makeReq({ headers: { [PROJECT_ID_HEADER]: '9' }, sub: 'user-a' }), {}, jest.fn());

      expect(requestWithRetry).toHaveBeenCalledTimes(1);
    });

    it('re-fetches once PROJECT_SCOPE_CACHE_TTL_MS has elapsed (override honored)', async () => {
      process.env.PROJECT_SCOPE_CACHE_TTL_MS = '10';
      requestWithRetry.mockResolvedValue(okResponse(SCOPE_A));

      await requireProjectScope()(makeReq({ headers: { [PROJECT_ID_HEADER]: '1' }, sub: 'user-a' }), {}, jest.fn());
      await new Promise((resolve) => setTimeout(resolve, 20));
      await requireProjectScope()(makeReq({ headers: { [PROJECT_ID_HEADER]: '1' }, sub: 'user-a' }), {}, jest.fn());

      expect(requestWithRetry).toHaveBeenCalledTimes(2);
      delete process.env.PROJECT_SCOPE_CACHE_TTL_MS;
    });
  });

  // WP-032 -- requireAuth() (middleware/apiKeyAuth.js) already fully
  // resolved and verified project binding for an API-key-authenticated
  // request before requireProjectScope() ever runs; re-running the
  // membership lookup here would be both wrong (an API key is never a member
  // of Project.members[]) and an unnecessary extra identity-service round
  // trip.
  it('short-circuits with no identity-service call when req.apiKeyAuth is already set', async () => {
    const req = makeReq({ headers: {}, sub: undefined }); // no X-Project-Id header, no kauth either
    req.apiKeyAuth = { keyId: 'ak_x', projectId: 1, scopes: ['results:write'] };
    req.projectScope = { projectId: 1, project: null };
    const next = jest.fn();

    await requireProjectScope()(req, {}, next);

    expect(next).toHaveBeenCalledWith();
    expect(requestWithRetry).not.toHaveBeenCalled();
    expect(req.projectScope).toEqual({ projectId: 1, project: null });
  });
});
