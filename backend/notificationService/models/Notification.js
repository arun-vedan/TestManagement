const mongoose = require('mongoose');

// WP-031 — Notification service. See EXECUTION_LOG.md for the full report.
//
// One Notification document per (rule, recipient) pair -- e.g. a
// status-changed(to: 'review') event fanning out to 3 project managers
// writes 3 documents, not 1 with a recipients[] array, so "mark read"
// (controllers/notifications.js) is a plain per-user, per-document flip with
// no array-element update semantics to get wrong.
const NotificationSchema = new mongoose.Schema(
  {
    // The Keycloak `sub` this notification is FOR. Every read/write in
    // controllers/notifications.js filters on this plus the caller's own
    // token sub -- a notification is never visible to, or markable-read by,
    // anyone but its recipient (see getNotifications/markNotificationRead).
    userId: {
      type: String,
      required: [true, 'userId is required'],
      index: true
    },
    // Numeric project id (WP-020/WP-021 convention -- matches
    // req.projectScope.projectId elsewhere in the codebase), carried on
    // every producer event this service consumes (execution-completed,
    // status-changed, defect-assigned).
    projectId: {
      type: Number,
      index: true
    },
    type: {
      type: String,
      required: [true, 'type is required'],
      enum: ['execution-completed', 'defect-assigned', 'status-review']
    },
    message: {
      type: String,
      required: [true, 'message is required']
    },
    // Which entity this notification is about. entityId is REQUIRED --
    // deliberately: a notification with no way to point back at its source
    // entity is not useful for a "go look at it" click-through, and
    // requiring it here (rather than tolerating an absent one) is what lets
    // a malformed/poisoned producer event be caught by Mongoose validation
    // and routed to the stream's dead-letter queue by service-core's
    // subscribe() (see consumers/notificationConsumer.js and
    // EXECUTION_LOG.md's DLQ proof) instead of silently writing a useless
    // document.
    entityRef: {
      entityType: { type: String, required: [true, 'entityRef.entityType is required'] },
      entityId: { type: String, required: [true, 'entityRef.entityId is required'] }
    },
    read: {
      type: Boolean,
      default: false,
      index: true
    },
    ts: {
      type: Date,
      default: Date.now,
      index: true
    },
    // WP-030/WP-024 convention: carried through from the originating
    // producer event (itself carried from the original HTTP request that
    // triggered it) so a notification, its event, and the request that
    // caused it can all be joined in logs.
    correlationId: {
      type: String
    },
    // The Redis Stream entry id that produced this notification (meta.id
    // from subscribe()'s handler callback) -- debugging aid only, not used
    // for idempotency (see notificationConsumer.js's header comment on
    // at-least-once delivery).
    sourceEventId: {
      type: String
    }
  },
  {
    timestamps: true
  }
);

// Every list/count query in controllers/notifications.js filters by
// {userId, projectId} and sorts by ts desc -- this compound index covers
// both the plain list and the read:false unread-count query.
NotificationSchema.index({ userId: 1, projectId: 1, read: 1, ts: -1 });

module.exports = mongoose.model('Notification', NotificationSchema);
