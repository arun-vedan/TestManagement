// WP-022 — RBAC permission matrix. Single source of truth: every service
// that imports @srckube/service-core enforces against this exact table, so
// "contributor can create a test case" means the same thing in
// testRepoService as it will in any future service that adopts
// authorize(). Do not fork/copy this table into an individual service --
// import ROLES/roleCan from here (see backend/userService/models/Project.js
// and backend/userService/middleware/projectAuthorize.js, which both do
// exactly that, so userService's own project/member-management routes and
// the cross-service authorize() middleware below can never disagree about
// what a role is allowed to do).

// Project-scoped roles (stored on Project.members[].role, WP-020). Kept to
// four, deliberately -- the WP-022 brief calls out resisting proliferation.
// No org_admin: WP-020/WP-021 never built an org-level membership/auth path
// (Organization has no members[] of its own), so an "optional org_admin"
// would have nothing to attach to today; adding it is future work if/when
// org-level membership exists.
const ROLES = ['admin', 'manager', 'contributor', 'viewer'];

// WP-110 — organization-level roles. The comment above said org_admin was
// absent because "Organization has no members[] of its own, so an optional
// org_admin would have nothing to attach to today". WP-110 gives it something
// to attach to, so it exists now.
//
// DELIBERATELY A SEPARATE LIST, not four-plus-one entries in ROLES. ROLES is
// the enum backing Project.members[].role (userService/models/Project.js
// imports it for exactly that) and the key set of PERMISSION_MATRIX below.
// Adding 'org_admin' there would make it a settable PROJECT role, so someone
// could be given 'org_admin' on a single project, where the matrix would then
// have to answer what that means for read/write/delete. It means nothing:
// these are roles over a different object, with a different action set.
const ORG_ROLES = ['org_admin', 'org_member'];

// Org actions are about the organization itself, not its projects. Project
// access stays entirely governed by Project.members[] + PERMISSION_MATRIX --
// being an org_admin does NOT grant access to a project's contents, and that
// is intentional: it keeps the blast radius of org administration to
// administration. What org membership decides is which projects you can
// SEE listed (userService/controllers/projects.js's getProjects), which is
// the tenant boundary WP-110 is about.
const ORG_ACTIONS = ['read', 'manage_org_members'];

const ORG_PERMISSION_MATRIX = {
  org_admin: { read: true, manage_org_members: true },
  org_member: { read: true, manage_org_members: false }
};

function orgRoleCan(role, action) {
  const row = ORG_PERMISSION_MATRIX[role];
  return Boolean(row && row[action]);
}

// Actions, not per-resource verbs. Every write endpoint across
// testRepoService/requirementService/defectService (create/update/status
// transitions) maps to 'write'; every delete endpoint maps to 'delete'.
// 'manage_members' and 'manage_project' are userService-only (project
// membership mutation, and project rename/archive/restore respectively) --
// listed here anyway so the matrix stays one shared table instead of two.
const ACTIONS = ['read', 'write', 'delete', 'manage_members', 'manage_project'];

// - viewer: read-only everywhere (WP-022 acceptance criterion, verbatim).
// - contributor: day-to-day content work (create/update test cases,
//   requirements, defects) but no delete and no project/membership admin.
// - manager: contributor's content powers + delete + manage_members
//   (team/content administration day-to-day) but NOT manage_project --
//   renaming/archiving/restoring the project itself stays admin-only. Note
//   the matrix alone cannot express "manager can manage members but must
//   not grant/revoke the 'admin' role itself" -- that additional
//   escalation guard lives in backend/userService/controllers/projects.js
//   (addMember/updateMemberRole/removeMember), documented there and in
//   EXECUTION_LOG.md's WP-022 report.
// - admin: everything.
const PERMISSION_MATRIX = {
  admin: { read: true, write: true, delete: true, manage_members: true, manage_project: true },
  manager: { read: true, write: true, delete: true, manage_members: true, manage_project: false },
  contributor: { read: true, write: true, delete: false, manage_members: false, manage_project: false },
  viewer: { read: true, write: false, delete: false, manage_members: false, manage_project: false }
};

function roleCan(role, action) {
  const row = PERMISSION_MATRIX[role];
  return Boolean(row && row[action] === true);
}

module.exports = { ROLES, ACTIONS, PERMISSION_MATRIX, roleCan,
  ORG_ROLES,
  ORG_ACTIONS,
  ORG_PERMISSION_MATRIX,
  orgRoleCan
};
