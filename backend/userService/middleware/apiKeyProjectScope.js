const { asyncHandler, ErrorResponse, roleCan } = require('@srckube/service-core');
const { Project } = require('../models/Project');

// WP-032 — local equivalent of @srckube/service-core's requireProjectScope()
// + authorize(action), for userService's OWN /api/v1/apikeys routes.
//
// Same reasoning as middleware/projectAuthorize.js's requireProjectAction()
// (WP-022): using the cross-service requireProjectScope() here would mean
// userService calling itself over HTTP (via the `userService` env var
// pointing at its own container) just to resolve a project it can already
// read straight out of its own database. This reads the numeric project id
// from the same X-Project-Id header every other service's requireProjectScope()
// uses (so the API-key management endpoints follow the same convention as
// every project-scoped route elsewhere), looks the Project up by its
// numeric `id` field directly, checks membership + roleCan(action) exactly
// like requireProjectAction()/service-core's authorize() do, and sets
// req.projectScope = { projectId, project } so controllers/apikeys.js can
// read req.projectScope.projectId identically to how a cross-service
// controller would.
const PROJECT_ID_HEADER = 'x-project-id';

function requireProjectScopeLocal(action) {
  return asyncHandler(async (req, res, next) => {
    const tokenSub = req.kauth?.grant?.access_token?.content?.sub;
    if (!tokenSub) {
      return next(new ErrorResponse('Authenticated user identity not found on request', 401));
    }

    const raw = req.headers[PROJECT_ID_HEADER];
    if (!raw) {
      return next(new ErrorResponse(`Missing required ${PROJECT_ID_HEADER} header`, 403));
    }
    const projectId = Number(raw);
    if (!Number.isInteger(projectId)) {
      return next(new ErrorResponse(`Invalid ${PROJECT_ID_HEADER} header: must be an integer`, 403));
    }

    const project = await Project.findOne({ id: projectId });
    if (!project) {
      return next(new ErrorResponse(`Unknown projectId '${projectId}'`, 403));
    }

    const member = project.members.find((m) => m.userId === tokenSub);
    if (!member) {
      return next(new ErrorResponse(`User is not a member of project '${projectId}'`, 403));
    }

    if (project.status === 'archived' && action !== 'read' && action !== 'manage_project') {
      return next(new ErrorResponse('Project is archived; it is read-only until restored', 403));
    }

    if (!roleCan(member.role, action)) {
      return next(
        new ErrorResponse(`Role '${member.role}' is not permitted to perform '${action}' on this project`, 403)
      );
    }

    req.projectScope = { projectId, project };
    req.projectRole = member.role;
    next();
  });
}

module.exports = { requireProjectScopeLocal };
