const ErrorResponse = require('../utils/errorResponse');
const { roleCan } = require('../permissions');

// WP-022 — authorize(action). Composes with requireProjectScope() (WP-021):
// requireProjectScope() establishes WHICH project and THAT the caller is a
// member of it (req.projectScope = { projectId, project }); authorize()
// decides WHAT that membership lets the caller do. Mount it immediately
// after requireProjectScope() on every route, per the WP brief ("write
// routes first, then reads -- viewer = read-only everywhere").
//
// WP-110 architecture (c): reads the caller's role from
// req.projectScope.role. It used to re-derive it by scanning
// req.projectScope.project.members[] for the caller's own entry -- that array
// no longer reaches this process, because requireProjectScope() now resolves
// scope through userService's per-caller
// GET /api/v1/projects/scope/:projectId, which deliberately returns the
// caller's own role and nothing about anyone else's membership.
//
// The property the old comment was defending is preserved and arguably
// strengthened: `role` is still not "something an earlier middleware happened
// to leave on req" -- it is the value the identity service just returned as
// the authoritative answer for this caller and this project, in the same
// resolution step that established membership at all. There is still no
// second identity-service round trip here.
function authorize(action) {
  return function authorizeMiddleware(req, res, next) {
    // WP-032: an API-key-authenticated request's authorization is already
    // fully decided by requireAuth(requiredScope) in
    // middleware/apiKeyAuth.js -- the route's exact required scope was
    // checked against the key's scopes[] there (positive allow-list, see
    // that file's header comment). There is no project.members[] role to
    // look up for a machine identity, so this human-RBAC path does not
    // apply; short-circuit as already-authorized.
    if (req.apiKeyAuth) {
      return next();
    }

    const scope = req.projectScope;
    if (!scope || !scope.project) {
      // Programmer error, not a client error: authorize() requires
      // requireProjectScope() to have run first on this route. Fail loudly
      // (500) rather than silently allowing/denying based on absent data.
      return next(
        new ErrorResponse('authorize() requires requireProjectScope() to run first on this route', 500)
      );
    }

    const grant = req.kauth && req.kauth.grant && req.kauth.grant.access_token && req.kauth.grant.access_token.content;
    const userSub = grant && grant.sub;
    if (!userSub) {
      return next(new ErrorResponse('Authenticated user identity not found on request', 401));
    }

    const role = scope.role;
    if (!role) {
      // Defensive only -- requireProjectScope() sets `role` in the same step
      // that establishes membership, so reaching here means this route is
      // wired without it (or something downstream overwrote req.projectScope).
      return next(new ErrorResponse('You are not a member of this project', 403));
    }

    // Project-deletion-orphaning decision (see EXECUTION_LOG.md, WP-022):
    // projects are soft-deleted (status: 'archived'), never hard-removed
    // via the API. An archived project stays fully readable (so its
    // testRepo/requirement/defect data is never orphaned/unreachable) but
    // is read-only for every role except the one action that can restore
    // it (manage_project, i.e. flipping status back to 'active').
    if (scope.project.status === 'archived' && action !== 'read' && action !== 'manage_project') {
      return next(new ErrorResponse('Project is archived; it is read-only until restored', 403));
    }

    if (!roleCan(role, action)) {
      return next(
        new ErrorResponse(`Role '${role}' is not permitted to perform '${action}' on this project`, 403)
      );
    }

    req.projectRole = role;
    next();
  };
}

module.exports = { authorize };
