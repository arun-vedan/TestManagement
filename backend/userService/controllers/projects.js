const {
  asyncHandler,
  ErrorResponse,
  audit,
  requestWithRetry,
  PROJECT_ID_HEADER,
  CORRELATION_HEADER,
  createLogger
} = require('@srckube/service-core');
const { Project, ROLES } = require('../models/Project');
const Organization = require('../models/Organization');
const { keycloakUserExists } = require('../utils/keycloakAdmin');

const logger = createLogger('userService');


// WP-119 — membership and project-lifecycle auditing.
//
// audit() was called from 11 controllers across 5 services and NONE of them
// was userService, so granting someone admin on a project produced no audit
// event at all. That is the first thing an auditor asks about, which is why
// this WP exists.
//
// PROJECT CONTEXT IS PASSED EXPLICITLY, and that detail is load-bearing.
// audit() normally resolves projectId/organizationId from req.projectScope,
// which @srckube/service-core's requireProjectScope() sets. These routes do
// NOT use that middleware — they use userService's own
// requireProjectAction() (middleware/projectAuthorize.js), which answers the
// same question from the local DB instead of calling this service over HTTP,
// and sets req.project / req.projectRole. So without passing projectId and
// organizationId here, every event would be written with neither — landing in
// exactly the un-scoped population that this same WP removes the
// `$exists: false` accommodation for in commentsService/controllers/audit.js.
function projectAuditContext(project) {
  return { projectId: project.id, organizationId: project.organizationId };
}

// @desc      Get the projects in the organizations the caller belongs to
// @route     GET /api/v1/projects
// @access    Private (Keycloak)
//
// WP-110 — THIS ENDPOINT IS NOW ORGANIZATION-SCOPED. It was deliberately
// unfiltered before, and the reason is worth keeping on the record because it
// is what made WP-110 the keystone rather than a one-line filter:
//
//   requireProjectScope() in 12 services used to answer "is this caller a
//   member of project X" by fetching THIS response and caching it once,
//   globally, shared across every caller. Filtering per caller would have made
//   that single shared cache wrong for everyone else. So the
//   tenant-enumeration hole (every authenticated user could read every
//   project's id, name and full members[] array) was load-bearing, and the
//   previous comment here recorded it as an accepted trade for exactly that
//   reason.
//
// That dependency is gone: requireProjectScope() now calls
// GET /api/v1/projects/scope/:projectId (below), which answers per caller.
// So this list is free to be what it should always have been.
//
// SCOPED BY ORGANIZATION, NOT BY PROJECT MEMBERSHIP. A caller sees every
// project in any organization they belong to, including projects they are not
// a member of. That is the tenant boundary WP-110 defines ("a user in org A
// receives zero of org B's projects"), and it is not a weaker check than it
// looks: seeing that a project exists inside your own organization is
// different from being able to read it. Access to a project's CONTENTS is
// still decided per project by requireProjectScope() + authorize() in each
// resource service, which this endpoint has no part in any more.
//
// A caller in no organization at all receives an empty list, not every
// project. Failing open here would reinstate the hole this WP closes.
exports.getProjects = asyncHandler(async (req, res, next) => {
  const tokenSub = req.kauth?.grant?.access_token?.content?.sub;
  if (!tokenSub) {
    return next(new ErrorResponse('Authenticated user identity not found on request', 401));
  }

  const myOrgIds = await Organization.find({ 'members.userId': tokenSub }).distinct('_id');
  if (myOrgIds.length === 0) {
    return res.status(200).json({ success: true, count: 0, data: [] });
  }

  const filter = { organizationId: { $in: myOrgIds } };

  // ?organizationId= still works, but only ever NARROWS the caller's own
  // organizations -- it can never be used to reach outside them. Passing
  // another organization's id yields an empty list rather than its projects.
  if (req.query.organizationId) {
    const requested = String(req.query.organizationId);
    const permitted = myOrgIds.some((id) => String(id) === requested);
    if (!permitted) {
      return res.status(200).json({ success: true, count: 0, data: [] });
    }
    filter.organizationId = req.query.organizationId;
  }

  const projects = await Project.find(filter).sort({ id: 1 });
  res.status(200).json({ success: true, count: projects.length, data: projects });
});

// @desc      Resolve the CALLING user's scope on one project
// @route     GET /api/v1/projects/scope/:projectId
// @access    Private (Keycloak); any authenticated caller may ask about
//            themselves, and learns nothing about anyone else
//
// WP-110 architecture (c) — this replaces the global project-list cache that
// @srckube/service-core's requireProjectScope() used to rely on.
//
// WHY THIS EXISTS. requireProjectScope() in 12 services used to answer "is
// this caller a member of project X" by GETting the unfiltered
// GET /api/v1/projects and caching the whole response ONCE, GLOBALLY, shared
// across every caller (see middleware/projectScope.js, and the previous
// comment on getProjects below). That made the list endpoint simultaneously a
// tenant-enumeration hole and a load-bearing internal contract: it could not
// be filtered per caller without making the shared cache wrong for everyone
// else. This endpoint dissolves that coupling — it answers the membership
// question directly, per caller, so the list endpoint is free to be scoped.
//
// It returns the three fields that are actually consumed downstream, and
// nothing more (verified by survey, not assumed — service-core's
// authorize.js reads the caller's own role and the project status, and
// audit.js reads organizationId; no controller in any service reads the
// project document at all). In particular it does NOT return members[], so a
// caller can no longer learn who else is on a project, or that any other
// project exists, in order to have its own access checked.
//
// `:projectId` is the NUMERIC Project.id, not the Mongo _id the sibling
// /:id routes use — requireProjectScope() works from the X-Project-Id header,
// which carries the numeric id. The route is mounted before /:id so
// "scope" is never swallowed as an _id (see routes/projects.js).
//
// 403 (never 404) for both "no such project" and "not a member", matching
// requireProjectScope()'s existing contract: this endpoint must not confirm
// or deny the existence of a project the caller has no access to.
exports.getProjectScope = asyncHandler(async (req, res, next) => {
  const tokenSub = req.kauth?.grant?.access_token?.content?.sub;
  if (!tokenSub) {
    return next(new ErrorResponse('Authenticated user identity not found on request', 401));
  }

  const projectId = Number(req.params.projectId);
  if (!Number.isInteger(projectId)) {
    return next(new ErrorResponse('Invalid projectId: must be an integer', 400));
  }

  const project = await Project.findOne({ id: projectId });
  if (!project) {
    return next(new ErrorResponse(`No access to project '${projectId}'`, 403));
  }

  const member = project.members.find((m) => m.userId === tokenSub);
  if (!member) {
    return next(new ErrorResponse(`No access to project '${projectId}'`, 403));
  }

  res.status(200).json({
    success: true,
    data: {
      projectId: project.id,
      role: member.role,
      status: project.status,
      organizationId: project.organizationId
    }
  });
});

// @desc      Get single project
// @route     GET /api/v1/projects/:id
// @access    Private (Keycloak), member of the project (WP-022:
//            requireProjectAction('read') on the route)
exports.getProject = asyncHandler(async (req, res) => {
  // req.project set by requireProjectAction() middleware -- no second fetch.
  res.status(200).json({ success: true, data: req.project });
});


// WP-116 follow-up — give a new project a usable defect workflow.
//
// WP-116 made the status vocabulary per-project, which is right for tenancy
// and left a hole: only project 1 had any statuses, so a brand-new project
// could not transition a defect at all (defectService validates every
// transition against that vocabulary and finds an empty graph). Phase 2 is
// about strangers signing up and creating projects, so "new project, dead
// defect workflow" is not a gap worth carrying into it.
//
// istatusservice owns the vocabulary, so it owns the seeding: this calls its
// one idempotent POST /api/v1/issuestatus/seed rather than writing to another
// service's database or issuing eight creates from here.
//
// BEST EFFORT, DELIBERATELY. Project creation must not fail because a
// secondary service is unreachable — the project is real, the membership is
// real, and an unseeded workflow is repairable by calling the same endpoint
// again (it is idempotent) or by running
// shared/scripts/seedProjectStatuses.mongo.js. So a failure is logged and
// reported to the caller in the response as `statusWorkflowSeeded: false`
// rather than swallowed: the caller learns the project is usable but its
// defect workflow needs attention, which is strictly more useful than a 201
// that quietly hides it.
//
// The caller's own Authorization is forwarded, and the creator was just made
// an admin member of this project, so istatusservice's requireProjectScope()
// admits them. There is no stale-cache risk: the (caller, project) cache key
// is brand new.
async function seedDefaultStatusWorkflow(req, project) {
  const target = process.env.istatusService;
  if (!target) {
    logger.warn('istatusService not configured; new project has no defect workflow', {
      projectId: project.id,
      correlationId: req.correlationId
    });
    return false;
  }

  try {
    const resp = await requestWithRetry(
      {
        method: 'post',
        url: `http://${target}/api/v1/issuestatus/seed`,
        headers: {
          Authorization: req.headers.authorization,
          [PROJECT_ID_HEADER]: String(project.id),
          [CORRELATION_HEADER]: req.correlationId
        },
        data: {}
      },
      { retries: 1, timeout: 5000 }
    );
    return Boolean(resp.data && resp.data.success);
  } catch (err) {
    logger.error('could not seed the default defect workflow for a new project', {
      projectId: project.id,
      error: err.message,
      correlationId: req.correlationId
    });
    return false;
  }
}

// @desc      Create project
// @route     POST /api/v1/projects
// @access    Private (Keycloak)
//
// WP-020b: createdBy is derived from the Keycloak token's `sub`, never from
// the request body.
//
// WP-022 (closes the members[] privilege hole flagged by the orchestrator):
// any client-supplied `members` in the request body is now IGNORED
// entirely, not merged/trusted. Before this fix, POST { members: [{userId:
// "ARBITRARY-OUTSIDER", role: "admin"}] } stored exactly that -- an
// arbitrary, unauthorized, possibly-nonexistent userId granted 'admin' on
// a brand-new project, with no authorization check at all (there could be
// none: nobody has any role on a project that doesn't exist yet). The only
// safe policy for a bootstrap operation like this is "the creator becomes
// the project's sole admin; everyone else is added afterward through the
// dedicated, now-authorized member endpoints below" -- which also
// guarantees RBAC never locks the creator out of their own project.
exports.createProject = asyncHandler(async (req, res, next) => {
  const tokenSub = req.kauth?.grant?.access_token?.content?.sub;
  if (!tokenSub) {
    return next(new ErrorResponse('Authenticated user identity not found on request', 401));
  }

  const { name, key, organizationId, status } = req.body;

  if (!organizationId) {
    return next(new ErrorResponse('organizationId is required', 400));
  }
  const organization = await Organization.findById(organizationId);
  if (!organization) {
    return next(new ErrorResponse(`Organization not found with id of ${organizationId}`, 404));
  }

  const project = await Project.create({
    name,
    key,
    organizationId,
    createdBy: tokenSub,
    status,
    members: [{ userId: tokenSub, role: 'admin' }]
  });

  const statusWorkflowSeeded = await seedDefaultStatusWorkflow(req, project);

  await audit(req, {
    entityType: 'project',
    entityId: String(project.id),
    action: 'create',
    after: { id: project.id, name: project.name, key: project.key },
    ...projectAuditContext(project)
  });

  res.status(201).json({ success: true, data: project, statusWorkflowSeeded });
});

// @desc      Update project (name/key/status only — members are managed via
//            the dedicated member endpoints below, and `id` is immutable)
// @route     PUT /api/v1/projects/:id
// @access    Private (Keycloak), requireProjectAction('manage_project')
exports.updateProject = asyncHandler(async (req, res, next) => {
  const updates = { ...req.body };
  delete updates.members;
  delete updates.id;
  delete updates._id;

  const project = await Project.findByIdAndUpdate(req.params.id, updates, {
    new: true,
    runValidators: true
  });
  if (!project) {
    return next(new ErrorResponse(`Project not found with id of ${req.params.id}`, 404));
  }
  res.status(200).json({ success: true, data: project });
});

// @desc      Delete project
// @route     DELETE /api/v1/projects/:id
// @access    Private (Keycloak), requireProjectAction('manage_project')
//
// WP-022 project-deletion-orphaning decision (see EXECUTION_LOG.md for the
// full write-up): this used to be `project.deleteOne()`. The orchestrator's
// probe showed exactly what that does -- DELETE returns 200 while every
// testRepo/requirement/defect document that carried this project's id
// (via req.projectScope, WP-021) becomes permanently unreachable, with no
// warning. That's data loss wearing a success code.
//
// Policy chosen: SOFT delete. Flip `status` to 'archived' (a field this
// schema already had, previously unused by this route) instead of removing
// the document. An archived project:
//   - stays in GET /api/v1/projects (so requireProjectScope() in every
//     other service can still resolve it -- see that middleware's own
//     comment on why this list must never be filtered) and so its data
//     stays reachable, never orphaned;
//   - becomes read-only for every role except manage_project (the one
//     action needed to restore it), enforced by both authorize()
//     (service-core) and requireProjectAction() (this file) -- see both of
//     those middlewares' archived-project checks.
// A real hard-delete-with-cascade, or a "refuse while data references the
// project" guard, would both require this route to reach into three other
// services' collections (existence checks and/or cascading deletes across
// service/database boundaries) -- a materially bigger, cross-service
// coordination job with its own partial-failure modes (a cascade that
// fails halfway through one of three services). Soft-delete closes the
// demonstrated data-loss bug immediately, is trivially reversible (GR-3:
// one-line revert -- PUT { status: 'active' }), and needs no cross-service
// calls. A true cascade/guard is left as explicit future work for whoever
// owns project data-lifecycle policy next (WP-024, if that WP exists by
// the time this is read) -- not silently skipped.
exports.deleteProject = asyncHandler(async (req, res, next) => {
  const project = req.project; // set by requireProjectAction()
  if (project.status === 'archived') {
    return res.status(200).json({ success: true, data: project, message: 'Project already archived' });
  }
  project.status = 'archived';
  await project.save();

  // WP-119: archiving is this product's delete (projects are never hard-
  // removed via the API -- the WP-022 project-deletion-orphaning decision), so
  // it is the lifecycle event an auditor cares about.
  await audit(req, {
    entityType: 'project',
    entityId: String(project.id),
    action: 'archive',
    before: { status: 'active' },
    after: { status: 'archived', name: project.name },
    ...projectAuditContext(project)
  });

  res.status(200).json({ success: true, data: project });
});

// WP-022: only an existing admin may grant or revoke the 'admin' role
// itself. roleCan('manager', 'manage_members') is true (a manager can add/
// remove/update ordinary members day-to-day), but manage_members alone
// would let a manager hand themselves or anyone else 'admin' -- a
// privilege-escalation path the flat action-matrix can't express (it only
// answers "can this role perform this action", not "on a target of what
// resulting privilege"). This extra guard is deliberately here, in the
// controller, rather than in the shared matrix.
function requiresAdminActor(...roles) {
  return roles.some((r) => r === 'admin');
}

// @desc      Add a member, or update their role if already a member
// @route     POST /api/v1/projects/:id/members
// @access    Private (Keycloak), requireProjectAction('manage_members')
exports.addMember = asyncHandler(async (req, res, next) => {
  const { userId, role } = req.body;
  if (!userId || !role) {
    return next(new ErrorResponse('userId and role are required', 400));
  }
  if (!ROLES.includes(role)) {
    return next(new ErrorResponse(`role must be one of: ${ROLES.join(', ')}`, 400));
  }

  const project = req.project; // set by requireProjectAction()
  const existing = project.members.find((m) => m.userId === userId);

  // WP-022: closes the members[] privilege-escalation gap -- granting or
  // already holding 'admin' requires the ACTOR to already be an admin, not
  // just hold manage_members (see requiresAdminActor()'s comment above).
  // Exception: an ownerless project (zero members -- req.projectRole is
  // null, see projectAuthorize.js's bootstrap-recovery case) has no
  // existing admin to defer to, same as project creation itself.
  if (project.members.length > 0 && requiresAdminActor(role, existing?.role) && req.projectRole !== 'admin') {
    return next(new ErrorResponse("Only an existing admin may grant or change the 'admin' role", 403));
  }

  // WP-022: closes the "is this even a real identity" half of the
  // members[] hole -- verify userId is a real Keycloak user before it is
  // ever stored as a project member (see utils/keycloakAdmin.js).
  const exists = await keycloakUserExists(userId);
  if (!exists) {
    return next(new ErrorResponse(`No Keycloak user found with id '${userId}'`, 400));
  }

  const previousRole = existing ? existing.role : null;
  if (existing) {
    existing.role = role;
  } else {
    project.members.push({ userId, role });
  }
  await project.save();

  // WP-119: this one handler does two different things, so it emits two
  // different actions rather than one vague "member changed" — an auditor
  // asking "who gave this person admin" needs to see a role change as a role
  // change, not as an add.
  await audit(req, {
    entityType: 'project_member',
    entityId: userId,
    action: existing ? 'member_role_change' : 'member_add',
    ...(existing ? { before: { userId, role: previousRole } } : {}),
    after: { userId, role },
    ...projectAuditContext(project)
  });

  res.status(200).json({ success: true, data: project });
});

// @desc      Update a member's role
// @route     PUT /api/v1/projects/:id/members/:userId
// @access    Private (Keycloak), requireProjectAction('manage_members')
exports.updateMemberRole = asyncHandler(async (req, res, next) => {
  const { role } = req.body;
  if (!role || !ROLES.includes(role)) {
    return next(new ErrorResponse(`role must be one of: ${ROLES.join(', ')}`, 400));
  }

  const project = req.project; // set by requireProjectAction()
  const member = project.members.find((m) => m.userId === req.params.userId);
  if (!member) {
    return next(new ErrorResponse(`Member not found with userId of ${req.params.userId}`, 404));
  }

  // WP-022: same admin-escalation guard as addMember -- granting 'admin' or
  // changing an existing admin's role both require the actor to already be
  // an admin.
  //
  // Deliberately NOT also guarding against demoting/removing the LAST
  // remaining admin (considered and dropped): that would make it
  // impossible for a project's sole admin to ever fully vacate their own
  // membership -- a legitimate operation (abandoning a project, or, as
  // WP-021's tenantIsolation.test.js does, a test suite revoking its own
  // fixture identity's membership to prove non-member behavior). A project
  // with zero admins is a real, permitted state; it is not this route's
  // job to prevent it, any more than deleteProject is prevented from
  // archiving a project nobody can then act on.
  const previousRole = member.role;
  member.role = role;
  await project.save();

  await audit(req, {
    entityType: 'project_member',
    entityId: req.params.userId,
    action: 'member_role_change',
    before: { userId: req.params.userId, role: previousRole },
    after: { userId: req.params.userId, role },
    ...projectAuditContext(project)
  });

  res.status(200).json({ success: true, data: project });
});

// @desc      Remove a member
// @route     DELETE /api/v1/projects/:id/members/:userId
// @access    Private (Keycloak), requireProjectAction('manage_members')
exports.removeMember = asyncHandler(async (req, res, next) => {
  const project = req.project; // set by requireProjectAction()
  const target = project.members.find((m) => m.userId === req.params.userId);
  if (!target) {
    return next(new ErrorResponse(`Member not found with userId of ${req.params.userId}`, 404));
  }

  // WP-022: removing an admin is itself an admin-only action (same
  // escalation class as granting one -- a non-admin manager must not be
  // able to remove the project's admins).
  if (target.role === 'admin' && req.projectRole !== 'admin') {
    return next(new ErrorResponse("Only an existing admin may remove an 'admin' member", 403));
  }
  // Deliberately NOT also guarding against removing the LAST remaining
  // admin -- see updateMemberRole's comment on this exact point (dropped
  // after it broke WP-021's tenantIsolation.test.js, which legitimately
  // revokes its own fixture identity's sole-admin membership to test
  // non-member behavior).
  project.members = project.members.filter((m) => m.userId !== req.params.userId);
  await project.save();

  await audit(req, {
    entityType: 'project_member',
    entityId: req.params.userId,
    action: 'member_remove',
    // The removed member's role is recorded: "X was removed" is far less
    // useful to an auditor than "X was removed, and they were an admin".
    before: { userId: req.params.userId, role: target.role },
    ...projectAuditContext(project)
  });

  res.status(200).json({ success: true, data: project });
});

// WP-132: exported so controllers/invites.js enforces the SAME escalation
// guard rather than restating it. An invite that grants 'admin' is exactly
// as sensitive as addMember() granting it directly, and a second copy of
// this rule is a second place for it to drift.
exports.requiresAdminActor = requiresAdminActor;
