const { ROLES, ACTIONS, PERMISSION_MATRIX, roleCan } = require('../permissions');

// WP-022 — release-blocking permission-matrix suite: persona (role) x
// action x expected allow/deny, exhaustive over every cell of the shared
// matrix. This is the single source of truth every service's authorize()
// call composes against (see middleware/authorize.js and
// backend/userService/middleware/projectAuthorize.js).

describe('WP-022 permission matrix', () => {
  it('is kept to exactly the four documented roles (resist proliferation)', () => {
    expect(ROLES).toEqual(['admin', 'manager', 'contributor', 'viewer']);
  });

  it('defines a row for every role and only the documented roles', () => {
    expect(Object.keys(PERMISSION_MATRIX).sort()).toEqual([...ROLES].sort());
  });

  it('every role row defines every action', () => {
    for (const role of ROLES) {
      for (const action of ACTIONS) {
        expect(typeof PERMISSION_MATRIX[role][action]).toBe('boolean');
      }
    }
  });

  // Exhaustive persona x action truth table -- the release-blocking
  // acceptance criterion from the WP-022 brief, spelled out explicitly
  // (not just derived from the matrix object) so a future edit to
  // PERMISSION_MATRIX that silently changes behavior fails a readable test.
  const EXPECTED = {
    admin: { read: true, write: true, delete: true, manage_members: true, manage_project: true },
    manager: { read: true, write: true, delete: true, manage_members: true, manage_project: false },
    contributor: { read: true, write: true, delete: false, manage_members: false, manage_project: false },
    viewer: { read: true, write: false, delete: false, manage_members: false, manage_project: false }
  };

  const cases = [];
  for (const role of Object.keys(EXPECTED)) {
    for (const action of Object.keys(EXPECTED[role])) {
      cases.push([role, action, EXPECTED[role][action]]);
    }
  }

  it.each(cases)('roleCan(%s, %s) === %s', (role, action, expected) => {
    expect(roleCan(role, action)).toBe(expected);
  });

  it('viewer can never do anything but read (acceptance: viewer = read-only everywhere)', () => {
    for (const action of ACTIONS) {
      if (action === 'read') {
        expect(roleCan('viewer', action)).toBe(true);
      } else {
        expect(roleCan('viewer', action)).toBe(false);
      }
    }
  });

  it('only admin can manage_project', () => {
    for (const role of ROLES) {
      expect(roleCan(role, 'manage_project')).toBe(role === 'admin');
    }
  });

  it('returns false, not throws, for an unknown role', () => {
    expect(roleCan('superuser', 'read')).toBe(false);
    expect(roleCan(undefined, 'read')).toBe(false);
    expect(roleCan(null, 'read')).toBe(false);
  });

  it('returns false, not throws, for an unknown action', () => {
    expect(roleCan('admin', 'nuke_the_database')).toBe(false);
    expect(roleCan('admin', undefined)).toBe(false);
  });
});
