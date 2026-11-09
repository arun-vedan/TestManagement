const { asyncHandler, ErrorResponse } = require('@srckube/service-core');
const Notification = require('../models/Notification');

// WP-031 — read side. A notification is per-user by construction (see
// models/Notification.js's header comment: one document per (rule,
// recipient) pair) -- every query below filters on the CALLING token's own
// `sub`, never a client-supplied userId, so there is no way for one
// authenticated caller to list or mark-read another user's notifications
// even within the same project. Combined with requireProjectScope() (routes
// below), this is what makes "assigning a defect creates a notification
// visible to the assignee's session token" true: it's visible to that
// session specifically because the query is `{userId: <this token's sub>,
// projectId: <this token's scoped project>}`, not a broader project-wide
// list.
//
// Project-scope matching also accepts a MISSING projectId, not just an
// exact match -- verified live (see EXECUTION_LOG.md): testPlanExecutionService
// is not on requireProjectScope() (a pre-existing, documented WP-021
// deferral, unrelated to this WP -- see that service's controllers/
// testplan.js), so its execution-completed events carry no projectId at
// all, and a Notification derived from one has none either
// (models/Notification.js declares it optional for exactly this reason).
// An exact-match-only filter would make every execution-completed
// notification permanently invisible through this scoped API. Same
// accommodation, same rationale, as commentsService's GET /api/v1/audit
// (backend/commentsService/controllers/audit.js's matching comment).
function scopedFilter(userId, projectId) {
  return { userId, $or: [{ projectId }, { projectId: { $exists: false } }] };
}

// @desc      List the caller's notifications for the scoped project,
//            newest first, plus an unread count for the bell badge.
// @route     GET /api/v1/notifications
// @access    Private (any project role -- notifications are personal, not
//            project-content, so 'read' -- universal per
//            service-core/permissions.js -- is the right gate; see routes/
//            notifications.js for the full rationale).
exports.getNotifications = asyncHandler(async (req, res) => {
  const grant = req.kauth.grant.access_token.content;
  const userId = grant.sub;
  const base = scopedFilter(userId, req.projectScope.projectId);

  const filter = req.query.unreadOnly === 'true' ? { ...base, read: false } : base;

  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);

  const [data, unreadCount] = await Promise.all([
    Notification.find(filter).sort({ ts: -1 }).limit(limit).lean(),
    Notification.countDocuments({ ...base, read: false })
  ]);

  res.status(200).json({
    success: true,
    count: data.length,
    unreadCount,
    data
  });
});

// @desc      Mark one of the caller's own notifications read. Idempotent --
//            marking an already-read notification read again is a no-op
//            200, not an error.
// @route     PATCH /api/v1/notifications/:id/read
// @access    Private (same 'read' gate as the list route above -- marking
//            YOUR OWN notification acknowledged is not a project-content
//            mutation gated behind the write/contributor+ RBAC tier; every
//            role, including viewer, can dismiss their own notifications).
exports.markNotificationRead = asyncHandler(async (req, res, next) => {
  const grant = req.kauth.grant.access_token.content;
  const userId = grant.sub;

  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, ...scopedFilter(userId, req.projectScope.projectId) },
    { read: true },
    { new: true, runValidators: true }
  );

  if (!notification) {
    // Matches the WP-021 convention used everywhere else in this codebase
    // (e.g. testRepoService/defectService's scoped findOne): a notification
    // belonging to a different user, or a different project, reads back as
    // 404 -- never leaked, never a 403 that would confirm it exists.
    return next(new ErrorResponse(`No notification found with id ${req.params.id}`, 404));
  }

  res.status(200).json({
    success: true,
    data: notification
  });
});
