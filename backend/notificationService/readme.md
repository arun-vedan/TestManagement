# notificationService (WP-031)

Thin, service-core-pattern notification service. Consumes Redis Streams
events published elsewhere in the stack (WP-030's async backbone) and writes
per-recipient `Notification` documents; exposes a small REST surface for a
recipient to list their own notifications and mark them read.

## Consumes

- `execution-completed` (published by testPlanExecutionService, WP-030) ->
  notifies the test execution's `assignedTo` (v1 proxy for "plan owner" --
  see `consumers/notificationConsumer.js`'s header comment for why).
- `status-changed` (published by requirementService/testRepoService, WP-030)
  -> when `to === 'review'`, notifies every project member with role
  `manager` (resolved live from userService, see `utils/identityClient.js`).
- `defect-assigned` (new in this WP; published by defectService on
  create/update when `assignedTo` is set/changes) -> notifies the assignee.

A poisoned/malformed message on any of these streams is routed to that
stream's dead-letter stream (`<stream>:dlq`, service-core's `subscribe()`)
rather than blocking the consumer group -- see EXECUTION_LOG.md's WP-031
report for the live proof.

## REST

- `GET /api/v1/notifications` -- the caller's own notifications for the
  scoped project (`X-Project-Id` header, WP-021), newest first, plus an
  `unreadCount` for the bell badge. `?unreadOnly=true` filters to unread
  only; `?limit=` caps the page (default 50, max 200).
- `PATCH /api/v1/notifications/:id/read` -- marks one of the caller's own
  notifications read. Idempotent; 404s for a notification that isn't the
  caller's or isn't in the scoped project (never leaked).

Both routes: `keycloak.protect()` -> `requireProjectScope()` ->
`authorize('read')` (see `routes/notifications.js` for why `'read'`, not
`'write'`, gates the mark-read PATCH too).
