const { ErrorResponse, asyncHandler } = require('@srckube/service-core');
const { Project } = require('../models/Project');
const { toDisplayIdentity, sharesTenantWith } = require('../utils/identityVisibility');
const { keycloakUserById, keycloakUsersByUsername } = require('../utils/keycloakAdmin');
const Redis = require('ioredis');
const dotenv = require('dotenv');
dotenv.config({ path: './config/config.env' });
const redis = new Redis({
  host: process.env.Redis_URI, // or use '127.0.0.1'
  port: 6379,
});


// @desc      Resolve one Keycloak identity to its display details
// @route     GET /api/v1/users/kcUser?id=<sub>
// @access    Private (Keycloak) — callers may only resolve identities they
//            share a tenant with. See utils/identityVisibility.js for the
//            disclosure this closes and why the rule is co-membership.
//
// Was: any signed-in caller, any user in the realm, full Keycloak
// representation including email. Now: narrowed shape, co-membership required.
exports.getKeycloakUser = asyncHandler(async (req, res, next) => {
  const userId = req.query.id;
  if (!userId) {
    return next(new ErrorResponse('id is required', 400));
  }

  const callerSub = req.kauth?.grant?.access_token?.content?.sub;
  if (!callerSub) {
    return next(new ErrorResponse('Not authenticated', 401));
  }

  // Authorization BEFORE the cache read. Checking afterwards would let the
  // cache answer for a caller who is not entitled to the record — the
  // original cache key is the target's id with no caller in it, so a cached
  // entry populated by a legitimate colleague would have served everyone.
  if (!(await sharesTenantWith(callerSub, userId))) {
    // Deliberately the same answer as a genuinely unknown user: distinguishing
    // them turns this into an oracle for "does this account exist".
    return next(new ErrorResponse('Keycloak user not found', 404));
  }

  const cacheKey = `kcidentity:${userId}`;
  const cached = await redis.get(cacheKey);
  if (cached) {
    return res.status(200).json({ success: true, data: JSON.parse(cached) });
  }

  let kcUser;
  try {
    kcUser = await keycloakUserById(userId);
  } catch (err) {
    return next(new ErrorResponse('Keycloak admin API error', 502));
  }
  if (!kcUser) {
    // WP-012b: propagate not-found as 404 rather than letting it fall through
    // to the errorHandler's 500 default, where it was indistinguishable from
    // a real outage.
    return next(new ErrorResponse('Keycloak user not found', 404));
  }

  const identity = toDisplayIdentity(kcUser);
  // The cache now holds only the narrowed shape, so even a cache dump carries
  // no email addresses or account metadata.
  await redis.set(cacheKey, JSON.stringify(identity), 'EX', 3600);
  res.status(200).json({ success: true, data: identity });
});

// @desc      Look up identities by exact username
// @route     GET /api/v1/users/kcUsers?id=<username>
// @access    Private (Keycloak) — co-membership required, as above.
//
// The empty-filter case is GONE. It previously returned EVERY user in the
// realm to any signed-in caller, which is how the assignee picker was built.
// Callers that want a list now use GET /api/v1/users/directory, which is
// scoped to one project's members — also the more correct answer for an
// assignee picker, since work should not be assignable to a non-member.
exports.getKeycloakUsers = asyncHandler(async (req, res, next) => {
  const username = req.query.id;
  const callerSub = req.kauth?.grant?.access_token?.content?.sub;
  if (!callerSub) {
    return next(new ErrorResponse('Not authenticated', 401));
  }
  if (!username) {
    return next(
      new ErrorResponse(
        'id is required. To list the people on a project, use GET /api/v1/users/directory ' +
          'with the X-Project-Id header.',
        400
      )
    );
  }

  let matches = [];
  try {
    matches = await keycloakUsersByUsername(username);
  } catch (err) {
    return next(new ErrorResponse('Keycloak admin API error', 502));
  }

  // Filtered to those the caller shares a tenant with, so this cannot be used
  // to confirm whether an arbitrary username exists on the platform.
  const visible = [];
  for (const kcUser of matches) {
    // eslint-disable-next-line no-await-in-loop
    if (await sharesTenantWith(callerSub, kcUser.id)) {
      visible.push(toDisplayIdentity(kcUser));
    }
  }
  res.status(200).json({ success: true, count: visible.length, data: visible });
});

// @desc      The people on one project — backs every assignee picker
// @route     GET /api/v1/users/directory   (X-Project-Id header)
// @access    Private (Keycloak) — members of that project only
//
// Replaces "every user in the realm", which is what the assignee picker used
// to read. Two things improve at once: the realm is no longer enumerable, and
// work can no longer be assigned to somebody who is not on the project.
//
// Resolved locally against Project.members rather than through
// requireProjectScope(): that middleware resolves scope by calling THIS
// service over HTTP, so using it here would have userService calling itself.
exports.getUserDirectory = asyncHandler(async (req, res, next) => {
  const callerSub = req.kauth?.grant?.access_token?.content?.sub;
  if (!callerSub) {
    return next(new ErrorResponse('Not authenticated', 401));
  }

  const headerName = (process.env.PROJECT_ID_HEADER || 'x-project-id').toLowerCase();
  const rawProjectId = req.headers[headerName];
  const projectId = Number(rawProjectId);
  if (!rawProjectId || !Number.isFinite(projectId)) {
    return next(new ErrorResponse('A numeric X-Project-Id header is required', 400));
  }

  const project = await Project.findOne({ id: projectId });
  if (!project) {
    return next(new ErrorResponse(`No access to project '${projectId}'`, 403));
  }
  if (!(project.members || []).some((m) => m.userId === callerSub)) {
    // Same answer as a nonexistent project: whether a project exists is itself
    // tenant information.
    return next(new ErrorResponse(`No access to project '${projectId}'`, 403));
  }

  const people = await Promise.all(
    (project.members || []).map(async (m) => {
      let kcUser = null;
      try {
        kcUser = await keycloakUserById(m.userId);
      } catch (err) {
        kcUser = null;
      }
      // A member whose Keycloak account is gone still appears, by id, so the
      // picker shows something actionable rather than a blank entry.
      return {
        ...(toDisplayIdentity(kcUser) || { id: m.userId, username: null, firstName: null, lastName: null }),
        projectRole: m.role,
        resolved: Boolean(kcUser)
      };
    })
  );

  res.status(200).json({ success: true, count: people.length, data: people });
});
  


