const { authorize } = require('../middleware/authorize');

// WP-022 unit tests for the authorize() middleware itself (composes with
// requireProjectScope() -- see projectScope.test.js for that half). Mirrors
// projectScope.test.js's req-building convention.

const ADMIN_MEMBER = { userId: 'user-admin', role: 'admin' };
const MANAGER_MEMBER = { userId: 'user-manager', role: 'manager' };
const CONTRIBUTOR_MEMBER = { userId: 'user-contrib', role: 'contributor' };
const VIEWER_MEMBER = { userId: 'user-viewer', role: 'viewer' };

const ACTIVE_PROJECT = {
  id: 1,
  name: 'Active',
  status: 'active',
  members: [ADMIN_MEMBER, MANAGER_MEMBER, CONTRIBUTOR_MEMBER, VIEWER_MEMBER]
};

const ARCHIVED_PROJECT = { ...ACTIVE_PROJECT, id: 2, status: 'archived' };

// WP-110 architecture (c): requireProjectScope() now resolves the caller's
// role server-side (userService's GET /api/v1/projects/scope/:projectId) and
// hands it over as scope.role. authorize() no longer receives a members[]
// array to scan, so this harness performs the same resolution the identity
// service does -- which keeps the persona x action matrix below exercising the
// real middleware rather than a reshaped fixture.
//
// `project` is deliberately the same MINIMAL object the middleware now
// attaches ({ id, status, organizationId }), so these tests would catch
// authorize() reaching for a field that no longer arrives.
function makeReq({ project = ACTIVE_PROJECT, sub = 'user-admin' } = {}) {
  const member = project.members.find((m) => m.userId === sub);
  return {
    projectScope: {
      projectId: project.id,
      role: member ? member.role : undefined,
      status: project.status,
      project: { id: project.id, status: project.status, organizationId: 'org-1' }
    },
    kauth: sub ? { grant: { access_token: { content: { sub } } } } : undefined
  };
}

describe('authorize()', () => {
  it('500s if requireProjectScope() has not run (no req.projectScope)', () => {
    const req = { kauth: { grant: { access_token: { content: { sub: 'user-admin' } } } } };
    const next = jest.fn();

    authorize('read')(req, {}, next);

    const err = next.mock.calls[0][0];
    expect(err.statusCode).toBe(500);
  });

  it('401s if no token identity is present', () => {
    // Explicit `null`, not `undefined` -- destructuring defaults in
    // makeReq() only kick in for `undefined`, so `sub: undefined` would
    // silently fall back to the default 'user-admin' and defeat this test.
    const req = makeReq({ sub: null });
    const next = jest.fn();

    authorize('read')(req, {}, next);

    expect(next.mock.calls[0][0].statusCode).toBe(401);
  });

  it('403s a caller who is not a member of the scoped project (defensive)', () => {
    const req = makeReq({ sub: 'not-a-member' });
    const next = jest.fn();

    authorize('read')(req, {}, next);

    expect(next.mock.calls[0][0].statusCode).toBe(403);
  });

  // Persona x action matrix, exercised through the real middleware (not
  // just roleCan() directly -- see permissions.test.js for that).
  const personaCases = [
    ['user-admin', 'read', true],
    ['user-admin', 'write', true],
    ['user-admin', 'delete', true],
    ['user-admin', 'manage_members', true],
    ['user-admin', 'manage_project', true],
    ['user-manager', 'read', true],
    ['user-manager', 'write', true],
    ['user-manager', 'delete', true],
    ['user-manager', 'manage_members', true],
    ['user-manager', 'manage_project', false],
    ['user-contrib', 'read', true],
    ['user-contrib', 'write', true],
    ['user-contrib', 'delete', false],
    ['user-contrib', 'manage_members', false],
    ['user-viewer', 'read', true],
    ['user-viewer', 'write', false],
    ['user-viewer', 'delete', false],
    ['user-viewer', 'manage_members', false],
    ['user-viewer', 'manage_project', false]
  ];

  it.each(personaCases)('sub=%s action=%s -> allowed=%s', (sub, action, allowed) => {
    const req = makeReq({ sub });
    const next = jest.fn();

    authorize(action)(req, {}, next);

    if (allowed) {
      expect(next).toHaveBeenCalledWith(); // no error arg
      expect(req.projectRole).toBeDefined();
    } else {
      const err = next.mock.calls[0][0];
      expect(err).toBeDefined();
      expect(err.statusCode).toBe(403);
    }
  });

  it('sets req.projectRole on success', () => {
    const req = makeReq({ sub: 'user-contrib' });
    const next = jest.fn();

    authorize('write')(req, {}, next);

    expect(req.projectRole).toBe('contributor');
  });

  describe('archived project (project-deletion-orphaning policy)', () => {
    it('allows read on an archived project for every role', () => {
      for (const sub of ['user-admin', 'user-manager', 'user-contrib', 'user-viewer']) {
        const req = makeReq({ project: ARCHIVED_PROJECT, sub });
        const next = jest.fn();
        authorize('read')(req, {}, next);
        expect(next).toHaveBeenCalledWith();
      }
    });

    it('denies write/delete/manage_members on an archived project even for admin', () => {
      for (const action of ['write', 'delete', 'manage_members']) {
        const req = makeReq({ project: ARCHIVED_PROJECT, sub: 'user-admin' });
        const next = jest.fn();
        authorize(action)(req, {}, next);
        expect(next.mock.calls[0][0].statusCode).toBe(403);
      }
    });

    it('still allows manage_project on an archived project for admin (needed to restore it)', () => {
      const req = makeReq({ project: ARCHIVED_PROJECT, sub: 'user-admin' });
      const next = jest.fn();
      authorize('manage_project')(req, {}, next);
      expect(next).toHaveBeenCalledWith();
    });

    it('denies manage_project on an archived project for a role that never has it (manager)', () => {
      const req = makeReq({ project: ARCHIVED_PROJECT, sub: 'user-manager' });
      const next = jest.fn();
      authorize('manage_project')(req, {}, next);
      expect(next.mock.calls[0][0].statusCode).toBe(403);
    });
  });

  // WP-032 -- API-key-authenticated requests already had their scope fully
  // decided by requireAuth() (middleware/apiKeyAuth.js) before authorize()
  // ever runs; there is no project.members[] role to look up for a machine
  // identity, so authorize() must short-circuit rather than 500 (no
  // req.projectScope.project) or wrongly deny.
  describe('req.apiKeyAuth short-circuit (WP-032)', () => {
    it('calls next() with no error when req.apiKeyAuth is set, even with no req.projectScope.project at all', () => {
      const req = { apiKeyAuth: { keyId: 'ak_x', projectId: 1, scopes: ['results:write'] } };
      const next = jest.fn();
      authorize('write')(req, {}, next);
      expect(next).toHaveBeenCalledWith();
    });

    it('does not fall through to the human-membership 500/403 path when req.apiKeyAuth is set', () => {
      // Deliberately no req.projectScope at all -- would 500 on the
      // human path (see the first test in this file) if the short-circuit
      // were missing or ordered after the requireProjectScope() guard.
      const req = { apiKeyAuth: { keyId: 'ak_x', projectId: 1, scopes: ['results:write'] } };
      const next = jest.fn();
      authorize('manage_project')(req, {}, next);
      expect(next).toHaveBeenCalledWith();
      expect(next).not.toHaveBeenCalledWith(expect.objectContaining({ statusCode: expect.anything() }));
    });
  });
});
