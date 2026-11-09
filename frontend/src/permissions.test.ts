import { ROLES, ACTIONS, roleCan } from './permissions';

// WP-022 — frontend mirror of backend/shared/service-core/permissions.js's
// own exhaustive persona x action truth table (see that package's
// __tests__/permissions.test.js). Keeping the two suites structurally
// identical makes a future drift between the two copies show up as a
// visibly different assertion in this file, not just a UI bug someone
// notices by clicking around.

describe('WP-022 frontend permission matrix mirror', () => {
  it('is kept to exactly the four documented roles', () => {
    expect(ROLES).toEqual(['admin', 'manager', 'contributor', 'viewer']);
  });

  const EXPECTED: Record<string, Record<string, boolean>> = {
    admin: { read: true, write: true, delete: true, manage_members: true, manage_project: true },
    manager: { read: true, write: true, delete: true, manage_members: true, manage_project: false },
    contributor: { read: true, write: true, delete: false, manage_members: false, manage_project: false },
    viewer: { read: true, write: false, delete: false, manage_members: false, manage_project: false }
  };

  const cases: [string, string, boolean][] = [];
  for (const role of Object.keys(EXPECTED)) {
    for (const action of Object.keys(EXPECTED[role])) {
      cases.push([role, action, EXPECTED[role][action]]);
    }
  }

  it.each(cases)('roleCan(%s, %s) === %s', (role, action, expected) => {
    expect(roleCan(role as any, action as any)).toBe(expected);
  });

  it('viewer can never do anything but read', () => {
    for (const action of ACTIONS) {
      expect(roleCan('viewer', action)).toBe(action === 'read');
    }
  });

  it('returns false, not throws, for a null/undefined role', () => {
    expect(roleCan(null, 'read')).toBe(false);
    expect(roleCan(undefined, 'read')).toBe(false);
  });
});
