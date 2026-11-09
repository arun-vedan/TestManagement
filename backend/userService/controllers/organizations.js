const { asyncHandler, ErrorResponse, ORG_ROLES, orgRoleCan } = require('@srckube/service-core');
const Organization = require('../models/Organization');
const { Project } = require('../models/Project');
const { keycloakUserById } = require('../utils/keycloakAdmin');

// @desc      Get the organizations the caller belongs to
// @route     GET /api/v1/organizations
// @access    Private (Keycloak)
//
// WP-110: scoped, for the same reason GET /api/v1/projects now is. Returning
// every organization to every caller would hand back the tenant list this WP
// exists to close, one level up -- a caller could not read another org's
// projects but could still enumerate who else is on the platform.
exports.getOrganizations = asyncHandler(async (req, res, next) => {
  const tokenSub = req.kauth?.grant?.access_token?.content?.sub;
  if (!tokenSub) {
    return next(new ErrorResponse('Authenticated user identity not found on request', 401));
  }
  const organizations = await Organization.find({ 'members.userId': tokenSub });
  res.status(200).json({ success: true, count: organizations.length, data: organizations });
});

// @desc      Get single organization
// @route     GET /api/v1/organizations/:id
// @access    Private (Keycloak)
exports.getOrganization = asyncHandler(async (req, res, next) => {
  const organization = await Organization.findById(req.params.id);
  if (!organization) {
    return next(new ErrorResponse(`Organization not found with id of ${req.params.id}`, 404));
  }

  // Found while verifying WP-132's premises: this had NO membership check, so
  // any authenticated caller could read any organization by id -- its name,
  // key, createdBy, and its entire members[] list of Keycloak subs. GET
  // /api/v1/organizations is scoped (WP-110) precisely so the tenant list
  // cannot be enumerated; reading one directly by id walked around that.
  //
  // 404 rather than 403, matching the list endpoint's posture: whether an
  // organization exists at all is itself tenant information, and a 403 would
  // confirm the id is real.
  const tokenSub = req.kauth?.grant?.access_token?.content?.sub;
  if (!tokenSub) {
    return next(new ErrorResponse('Not authenticated', 401));
  }
  if (!(organization.members || []).some((m) => m.userId === tokenSub)) {
    return next(new ErrorResponse(`Organization not found with id of ${req.params.id}`, 404));
  }

  res.status(200).json({ success: true, data: organization });
});

// @desc      Create organization
// @route     POST /api/v1/organizations
// @access    Private (Keycloak)
//
// WP-020b: createdBy is derived from the Keycloak token's `sub`, never from
// the request body -- Organization.create(req.body) previously let any
// caller name an arbitrary createdBy. Same pattern as defectService's
// createDefect (backend/defectService/controllers/defects.js). The route is
// behind keycloak.protect(), so req.kauth.grant.access_token.content.sub
// should always be present; if it is somehow missing we fail loudly with a
// 401 rather than silently falling back to a client-suppliable value.
exports.createOrganization = asyncHandler(async (req, res, next) => {
  const tokenSub = req.kauth?.grant?.access_token?.content?.sub;
  if (!tokenSub) {
    return next(new ErrorResponse('Authenticated user identity not found on request', 401));
  }

  const { name, key, status } = req.body;
  // WP-110: the creator is enrolled as org_admin in the same write that
  // creates the organization. Without this every new organization would be
  // born ownerless -- nobody could add its first member, and (now that
  // GET /api/v1/projects is organization-scoped) its projects would be
  // invisible to everyone including the person who just created it.
  const organization = await Organization.create({
    name,
    key,
    status,
    createdBy: tokenSub,
    members: [{ userId: tokenSub, role: 'org_admin' }]
  });
  res.status(201).json({ success: true, data: organization });
});

// WP-110 — organization membership mutation.
//
// Gated locally rather than via @srckube/service-core's authorize(): that
// middleware composes with requireProjectScope(), which resolves PROJECT
// membership by calling userService over HTTP. Using it here would have
// userService call itself to authorize a question it owns the data for, and
// it answers about the wrong object anyway. Same reasoning as
// middleware/projectAuthorize.js's requireProjectAction(), and the same
// single source of truth for the verdict: orgRoleCan() from the shared
// permissions module, never a forked copy of the matrix.
async function loadOrgForOrgAction(req, action) {
  const tokenSub = req.kauth?.grant?.access_token?.content?.sub;
  if (!tokenSub) {
    return { error: new ErrorResponse('Authenticated user identity not found on request', 401) };
  }

  const organization = await Organization.findById(req.params.id);
  if (!organization) {
    return { error: new ErrorResponse(`Organization not found with id of ${req.params.id}`, 404) };
  }

  // Ownerless-organization recovery. Mirrors the project equivalent in
  // middleware/projectAuthorize.js and exists for the same reason: an
  // organization with zero members has, by construction, nobody who could
  // ever satisfy the check below, so it would be permanently unmanageable.
  // That state is reachable here -- every organization created before WP-110
  // has no members[] at all, and the backfill
  // (shared/scripts/backfillOrgMembers.mongo.js) is what normally repairs
  // them. Any authenticated caller may claim manage_org_members on an
  // ownerless organization, the same trust level as creating a new one
  // (nobody holds any pre-existing authority over it either way). Scoped
  // narrowly to manage_org_members, the only action that can add the first
  // member back.
  if (organization.members.length === 0 && action === 'manage_org_members') {
    return { organization, role: null };
  }

  const member = organization.members.find((m) => m.userId === tokenSub);
  if (!member) {
    return { error: new ErrorResponse('You are not a member of this organization', 403) };
  }
  if (!orgRoleCan(member.role, action)) {
    return {
      error: new ErrorResponse(
        `Org role '${member.role}' is not permitted to perform '${action}' on this organization`,
        403
      )
    };
  }
  return { organization, role: member.role };
}

// @desc      Add a member to an organization
// @route     POST /api/v1/organizations/:id/members
// @access    Private (Keycloak), org_admin of that organization
exports.addOrgMember = asyncHandler(async (req, res, next) => {
  const { error, organization } = await loadOrgForOrgAction(req, 'manage_org_members');
  if (error) {
    return next(error);
  }

  const { userId, role } = req.body;
  if (!userId || typeof userId !== 'string') {
    return next(new ErrorResponse('userId is required', 400));
  }
  if (!ORG_ROLES.includes(role)) {
    return next(new ErrorResponse(`role must be one of ${ORG_ROLES.join(', ')}`, 400));
  }
  if (organization.members.some((m) => m.userId === userId)) {
    return next(new ErrorResponse('That user is already a member of this organization', 409));
  }

  organization.members.push({ userId, role });
  await organization.save();
  res.status(201).json({ success: true, data: organization });
});

// @desc      Change a member's organization role
// @route     PUT /api/v1/organizations/:id/members/:userId
// @access    Private (Keycloak), org_admin of that organization
exports.updateOrgMemberRole = asyncHandler(async (req, res, next) => {
  const { error, organization } = await loadOrgForOrgAction(req, 'manage_org_members');
  if (error) {
    return next(error);
  }

  const { role } = req.body;
  if (!ORG_ROLES.includes(role)) {
    return next(new ErrorResponse(`role must be one of ${ORG_ROLES.join(', ')}`, 400));
  }

  const member = organization.members.find((m) => m.userId === req.params.userId);
  if (!member) {
    return next(new ErrorResponse('That user is not a member of this organization', 404));
  }

  member.role = role;
  await organization.save();
  res.status(200).json({ success: true, data: organization });
});

// @desc      Remove a member from an organization
// @route     DELETE /api/v1/organizations/:id/members/:userId
// @access    Private (Keycloak), org_admin of that organization
//
// Removing the last org_admin (including yourself) is ALLOWED, matching the
// project equivalent's documented decision rather than inventing a different
// rule here: the ownerless-organization recovery path above is what makes
// that recoverable, so guarding against it would add a special case without
// adding safety.
exports.removeOrgMember = asyncHandler(async (req, res, next) => {
  const { error, organization } = await loadOrgForOrgAction(req, 'manage_org_members');
  if (error) {
    return next(error);
  }

  const before = organization.members.length;
  organization.members = organization.members.filter((m) => m.userId !== req.params.userId);
  if (organization.members.length === before) {
    return next(new ErrorResponse('That user is not a member of this organization', 404));
  }

  await organization.save();
  res.status(200).json({ success: true, data: organization });
});

// @desc      Update organization
// @route     PUT /api/v1/organizations/:id
// @access    Private (Keycloak)
exports.updateOrganization = asyncHandler(async (req, res, next) => {
  const organization = await Organization.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
    runValidators: true
  });
  if (!organization) {
    return next(new ErrorResponse(`Organization not found with id of ${req.params.id}`, 404));
  }
  res.status(200).json({ success: true, data: organization });
});

// @desc      Delete organization
// @route     DELETE /api/v1/organizations/:id
// @access    Private (Keycloak)
exports.deleteOrganization = asyncHandler(async (req, res, next) => {
  const organization = await Organization.findById(req.params.id);
  if (!organization) {
    return next(new ErrorResponse(`Organization not found with id of ${req.params.id}`, 404));
  }

  // WP-110 follow-up — REFERENTIAL INTEGRITY, and the fix for a measured
  // defect rather than a hypothetical one.
  //
  // This endpoint hard-deletes (deleteOne), while DELETE /api/v1/projects/:id
  // only SOFT-deletes (status:'archived', the deliberate
  // project-deletion-orphaning decision in EXECUTION_LOG.md's WP-022 entry).
  // The standard teardown every test suite performs -- delete the project,
  // then delete the organization -- therefore left the project sitting in the
  // collection with its organization GONE.
  //
  // That asymmetry is where this environment's 701 orphaned projects came
  // from. It is not a guess: at the time of this change 72 of 74 projects were
  // orphaned, and ALL 72 of them were `status: 'archived'` -- a 100% match with
  // the archive-then-delete-the-org path. Those orphans are also what made
  // WP-110 impossible to land safely until they were pruned, because
  // organization-scoping a project list cannot do anything sensible with a
  // project whose organization does not exist.
  //
  // So an organization that still owns projects cannot be deleted. Archived
  // projects count: an archived project still references its organization, and
  // archiving is explicitly reversible (manage_project can restore it), so
  // letting the organization go would orphan something a user is entitled to
  // get back.
  const owned = await Project.countDocuments({ organizationId: organization._id });
  if (owned > 0) {
    return next(
      new ErrorResponse(
        `Cannot delete organization '${organization.name}': it still owns ${owned} project(s), ` +
          'including archived ones. Remove or reassign them first — deleting the organization ' +
          'would leave those projects referencing an organization that no longer exists.',
        409
      )
    );
  }

  await organization.deleteOne();
  res.status(200).json({ success: true, data: {} });
});

// @desc      List an organization's members, with display details
// @route     GET /api/v1/organizations/:id/members
// @access    Private (Keycloak) — organization members only
//
// WP-132 — this exists to make the "add a teammate" picker possible.
//
// WHY NOT /api/v1/users/kcUsers, WHICH THE PLAN NAMED. That endpoint cannot do
// it, verified before building this. It takes ?id=<username> and performs a
// SINGLE-user lookup against the WHOLE realm, returning one Keycloak user
// representation; it is not a list, and it is not scoped to anything. Turning
// it into the picker's data source would have meant exposing a realm-wide user
// directory — every account on the platform, across every tenant — to any
// authenticated caller, to solve a UI problem.
//
// So the picker is backed by this instead: the members of ONE organization the
// caller themselves belongs to. Display details are resolved per member from
// Keycloak, which is a lookup the caller is already entitled to make about
// their own colleagues.
//
// A failed per-user lookup degrades to the bare userId rather than failing the
// whole list: a member whose Keycloak account was deleted out from under the
// organization should still be visible (and removable) in the UI, not render
// the panel unusable.
exports.listOrgMembers = asyncHandler(async (req, res, next) => {
  const organization = await Organization.findById(req.params.id);
  if (!organization) {
    return next(new ErrorResponse(`Organization not found with id of ${req.params.id}`, 404));
  }

  const tokenSub = req.kauth?.grant?.access_token?.content?.sub;
  if (!tokenSub) {
    return next(new ErrorResponse('Not authenticated', 401));
  }

  // Membership check, deliberately explicit. This endpoint returns other
  // people's names and email addresses, so "any authenticated caller" is not
  // an acceptable audience for it.
  const self = (organization.members || []).find((m) => m.userId === tokenSub);
  if (!self) {
    return next(new ErrorResponse('No access to this organization', 403));
  }

  const members = await Promise.all(
    (organization.members || []).map(async (m) => {
      let details = null;
      try {
        details = await keycloakUserById(m.userId);
      } catch (err) {
        details = null;
      }
      return {
        userId: m.userId,
        orgRole: m.role,
        username: details ? details.username : null,
        email: details ? details.email : null,
        firstName: details ? details.firstName : null,
        lastName: details ? details.lastName : null,
        // Tells the UI to show the raw id rather than an empty row.
        resolved: Boolean(details)
      };
    })
  );

  res.status(200).json({ success: true, count: members.length, data: members });
});
