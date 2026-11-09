const { subscribe, EVENT_STREAMS, createLogger } = require('@srckube/service-core');
const Notification = require('../models/Notification');
const { resolveProjectManagers } = require('../utils/identityClient');

const logger = createLogger('notificationService:consumer');

// WP-031 — "defect assigned" has no producer yet as of WP-030 (only
// execution-completed and status-changed exist -- see
// service-core/eventStreams.js). Added here as
// backend/defectService/controllers/defects.js's new publishEvent() call
// site, following that file's exact containment pattern (fire-and-forget,
// never throws into the request path).
//
// NOT added to service-core/eventStreams.js's shared EVENT_STREAMS map:
// that file lives under backend/shared/service-core/, which is WP-032's
// concurrent territory this session (adding its own auth middleware there)
// and is explicitly off-limits to this WP. A plain string literal, spelled
// identically here and in defectService/controllers/defects.js, carries
// exactly the risk eventStreams.js's own header comment already calls out
// for every other stream name ("a typo'd stream name here is a
// silently-dropped event on one side and a silently-empty consumer on the
// other") -- same trade, just not centralized in the shared map this time.
const DEFECT_ASSIGNED_STREAM = 'defect-assigned';

// One shared consumer group name across all three streams this service
// subscribes to -- each subscribe() call creates/joins a group scoped to
// its OWN stream (service-core's ensureGroup() calls XGROUP CREATE per
// stream), so reusing the same group string across streams is safe: Redis
// namespaces consumer groups per-stream, not globally.
const CONSUMER_GROUP = 'notificationservice';

// Rule 1 (PB-11 v1): execution-completed -> notify the plan owner.
//
// TestPlan (testPlanExecutionService/models/TestPlan.js) has a `createdBy`
// field declared as mongoose.Schema.Types.ObjectId -- which cannot even
// hold a Keycloak `sub` (a UUID, not a 24-hex ObjectId) -- and it is unset
// on every one of the 7 real TestPlan documents in this deployment
// (dump-checked 2026-08-29, see EXECUTION_LOG.md). There is, in practice,
// no populated "plan owner" to notify via that field today. The one real,
// consistently-populated actor identity the execution-completed event
// itself carries is TestExecution.assignedTo (verified against the live
// payload shape, also in EXECUTION_LOG.md) -- used here as the v1 "plan
// owner" proxy instead of adding a synchronous cross-service call
// (notificationService -> testPlanExecutionService) to fetch a field that
// would come back empty for every existing plan anyway. Revisit once
// TestPlan gets a real, populated owner field.
async function handleExecutionCompleted(payload, meta) {
  if (!payload || !payload.assignedTo) {
    logger.warn('execution-completed event has no assignedTo; nothing to notify', { payload });
    return;
  }

  await Notification.create({
    userId: payload.assignedTo,
    projectId: payload.projectId,
    type: 'execution-completed',
    message: `Test execution ${payload.TestExecutionId || payload.entityId} ${
      payload.TestPlanId ? `(plan ${payload.TestPlanId})` : ''
    } completed`.trim(),
    entityRef: {
      entityType: payload.entityType || 'testexecution',
      entityId: payload.entityId || payload.TestExecutionId
    },
    correlationId: payload.correlationId,
    sourceEventId: meta && meta.id
  });
}

// Rule 3 (PB-11 v1): a status transition INTO 'review' -> notify every
// project manager (role === 'manager', service-core/permissions.js's
// ROLES). Fires for BOTH producers of EVENT_STREAMS.STATUS_CHANGED
// (requirementService and testRepoService both publish the same shape --
// {entityType, entityId, projectId, from, to, correlationId}, see
// eventStreams.js's header comment) since the rule only cares about `to`,
// not which entity type transitioned.
async function handleStatusChanged(payload, meta) {
  if (!payload || payload.to !== 'review') {
    return; // v1 rule only fires on a transition INTO review, not out of it
  }
  if (payload.projectId === undefined || payload.projectId === null) {
    logger.warn('status-changed(review) event carries no projectId; cannot resolve project managers', {
      payload
    });
    return;
  }

  let managers;
  try {
    managers = await resolveProjectManagers(payload.projectId, payload.correlationId);
  } catch (err) {
    // FAIL OPEN, deliberately -- same posture as publishEvent()/audit() (see
    // service-core/events.js's header comment): a temporarily unreachable
    // identity service must not turn a best-effort notification derivation
    // into a lost/DLQ'd event. Log and return normally (the message is
    // still acked, not retried/DLQ'd) rather than throwing, which would
    // route this genuinely-fine event to the dead-letter stream for a
    // transient dependency outage that has nothing to do with the event
    // itself being malformed.
    logger.error('resolveProjectManagers failed; skipping manager notifications for this event', {
      projectId: payload.projectId,
      correlationId: payload.correlationId,
      error: err.message
    });
    return;
  }

  if (managers.length === 0) {
    logger.warn('status-changed(review) event: no project managers found to notify', { payload });
    return;
  }

  await Promise.all(
    managers.map((userId) =>
      Notification.create({
        userId,
        projectId: payload.projectId,
        type: 'status-review',
        message: `${payload.entityType} ${payload.entityId} moved to review`,
        entityRef: { entityType: payload.entityType, entityId: payload.entityId },
        correlationId: payload.correlationId,
        sourceEventId: meta && meta.id
      })
    )
  );
}

// Rule 2 (PB-11 v1): defect assigned -> notify the assignee.
async function handleDefectAssigned(payload, meta) {
  if (!payload || !payload.assignedTo) {
    logger.warn('defect-assigned event has no assignedTo; nothing to notify', { payload });
    return;
  }

  // Notification.create() below throws (Mongoose ValidationError) if
  // entityRef.entityId ends up undefined -- e.g. a malformed/poisoned event
  // missing `entityId`/`defectId` entirely. That throw is intentional and
  // load-bearing: it is what lets service-core's subscribe() route the
  // message to defect-assigned:dlq instead of silently writing a useless,
  // unreferenceable notification (see EXECUTION_LOG.md's DLQ proof).
  await Notification.create({
    userId: payload.assignedTo,
    projectId: payload.projectId,
    type: 'defect-assigned',
    message: `Defect ${payload.defectId || payload.entityId} assigned to you`,
    entityRef: { entityType: 'defect', entityId: payload.entityId || payload.defectId },
    correlationId: payload.correlationId,
    sourceEventId: meta && meta.id
  });
}

// Starts all three subscribe() loops. Each is independent (its own consumer
// group cursor on its own stream) -- a poisoned message or a slow handler on
// one stream never blocks the others. Returns { consumers, stop() } so
// server.js can shut them down cleanly on SIGTERM.
function startNotificationConsumers(options = {}) {
  const consumers = [
    subscribe(EVENT_STREAMS.EXECUTION_COMPLETED, CONSUMER_GROUP, handleExecutionCompleted, options),
    subscribe(EVENT_STREAMS.STATUS_CHANGED, CONSUMER_GROUP, handleStatusChanged, options),
    subscribe(DEFECT_ASSIGNED_STREAM, CONSUMER_GROUP, handleDefectAssigned, options)
  ];

  return {
    consumers,
    async stop() {
      await Promise.all(consumers.map((c) => c.stop()));
    }
  };
}

module.exports = {
  startNotificationConsumers,
  handleExecutionCompleted,
  handleStatusChanged,
  handleDefectAssigned,
  DEFECT_ASSIGNED_STREAM,
  CONSUMER_GROUP
};
