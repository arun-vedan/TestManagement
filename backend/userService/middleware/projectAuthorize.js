const { asyncHandler, ErrorResponse, roleCan } = require('@srckube/service-core');
const { Project } = require('../models/Project');

// WP-022 — userService's own project/member-management routes can't use
// @srckube/service-core's authorize() directly: that middleware composes
// with requireProjectScope(), which itself calls OUT to userService's own
// GET /api/v1/projects to resolve membership (WP-021) -- wiring it onto
// userService's own routes would mean userService calling itself over HTTP
// to authorize a request it can just answer locally from the DB it already
// owns. So this is a local equivalent that reaches the same verdict the
// same way (same roleCan() import from @srckube/service-core --
// deliberately NOT a second/forked copy of the matrix, see
// backend/shared/service-core/permissions.js's own comment on this) but by
// loading the Project directly instead of over HTTP.
//
// requireProjectAction(action) loads Project by req.params.id (the Mongo
// _id path param every /api/v1/projects/:id... route already uses),
// confirms the caller is a member, applies the same archived-project
// read-only rule as service-core's authorize() (see
// EXECUTION_LOG.md's project-deletion-orphaning decision), and checks
// roleCan(role, action). On success it sets req.project (so the controller
// doesn't need to re-fetch) and req.projectRole.
function requireProjectAction(action) {
  return asyncHandler(async (req, res, next) => {
    const tokenSub = req.kauth?.grant?.access_token?.content?.sub;
    if (!tokenSub) {
      return next(new ErrorResponse('Authenticated user identity not found on request', 401));
    }

    const project = await Project.findById(req.params.id);
    if (!project) {
      return next(new ErrorResponse(`Project not found with id of ${req.params.id}`, 404));
    }

    // Ownerless-project recovery: a project with ZERO members has, by
    // construction, no one who could ever satisfy the membership check
    // below -- it would be permanently unmanageable via this API forever
    // (not even by re-creating it, since the id/data still exist). This
    // can legitimately happen (e.g. the sole admin removes their own
    // membership -- see controllers/projects.js's removeMember/
    // updateMemberRole comments on why that is allowed, not guarded
    // against). Any authenticated caller may claim manage_members on such
    // a project, same trust level as creating a brand-new one (nobody has
    // any pre-existing authority over it either way). Scoped narrowly to
    // manage_members (the only action that can ever add the first member
    // back) -- read/write/delete/manage_project on an ownerless project
    // still correctly fall through to the "not a member" 403 below.
    if (project.members.length === 0 && action === 'manage_members') {
      req.project = project;
      req.projectRole = null;
      return next();
    }

    const member = project.members.find((m) => m.userId === tokenSub);
    if (!member) {
      return next(new ErrorResponse('You are not a member of this project', 403));
    }

    if (project.status === 'archived' && action !== 'read' && action !== 'manage_project') {
      return next(new ErrorResponse('Project is archived; it is read-only until restored', 403));
    }

    if (!roleCan(member.role, action)) {
      return next(
        new ErrorResponse(`Role '${member.role}' is not permitted to perform '${action}' on this project`, 403)
      );
    }

    req.project = project;
    req.projectRole = member.role;
    next();
  });
}

module.exports = { requireProjectAction };
