const { asyncHandler, getAuditEventModel } = require('@srckube/service-core');

// WP-024 — read side of the audit log.
//
// Lives in commentsService alongside the write-side schema/connection
// helper (backend/shared/service-core/audit.js) since this is where the
// AuditEvent collection is homed (see that file's header comment for the
// full home-decision reasoning). This route is the ONLY place in the
// entire repo that reads the AuditEvent collection back out, and there is
// no PUT/PATCH/DELETE controller anywhere targeting it -- append-only is
// enforced simply by never writing one.
//
// Mounted (routes/audit.js) behind keycloak.protect() + requireProjectScope()
// + authorize('read'), the same WP-021/WP-022 chain every other project-
// scoped read route uses -- 'read' is the one action every role (including
// viewer) is permitted (see service-core/permissions.js's PERMISSION_MATRIX),
// so an Auditor persona with only viewer membership can read this without
// being able to write anything else in the project either.
//
// @desc      List audit events for the caller's project, filterable by
//            entity/actor/date/action, newest first.
// @route     GET /api/v1/audit
// @access    Private (any project role -- read is universal)
exports.getAuditEvents = asyncHandler(async (req, res, next) => {
  const AuditEvent = getAuditEventModel();
  if (!AuditEvent) {
    // AUDIT_MONGO_URI not configured on this deployment -- same "degrade,
    // don't crash" posture as the write side, but a read endpoint can and
    // should say so explicitly rather than silently returning an empty list
    // (an empty list would be indistinguishable from "no audit events yet").
    return res.status(503).json({
      success: false,
      error: 'Audit store is not configured on this deployment'
    });
  }

  // WP-119 — strictly this project's own events.
  //
  // This used to be
  //   { $or: [{ projectId: <caller's> }, { projectId: { $exists: false } }] }
  // and the accommodation was reasoned, not careless. WP-024's comment
  // justified it like this: testPlanExecutionService "was never rolled onto
  // requireProjectScope() (WP-021 deferred it), so its TestPlan/TestExecution
  // documents carry no projectId of their own either -- they are already
  // effectively ungated by project in this deployment. Excluding their audit
  // events here would not restore isolation that doesn't exist upstream."
  //
  // That premise is now FALSE, twice over. WP-103 established that
  // testPlanExecutionService IS scoped (TestExecution.projectId and
  // TestPlan.projectId are both required+indexed and every route there mounts
  // requireProjectScope()), and WP-111..118 scoped the remaining eight
  // services. There is no longer an upstream gap for this clause to
  // accommodate -- so all it does now is hand every project member, INCLUDING
  // VIEWERS, the events of every other tenant.
  //
  // Measured before removal: 45 775 audit events, 41 199 carrying a projectId
  // and 4 576 without. Those 4 576 were visible to everyone. They are historical
  // (written before their services were scoped) and are now unreachable through
  // this API, which is the correct trade: an audit API that answers only for
  // the caller's own tenant is worth more than one that is complete and leaky.
  // They remain in the store for an operator with direct access, and
  // EXECUTION_LOG.md's WP-119 entry records the count so nobody mistakes their
  // disappearance for data loss.
  const conditions = [{ projectId: req.projectScope.projectId }];

  if (req.query.entityType) {
    conditions.push({ entityType: req.query.entityType });
  }
  if (req.query.entityId) {
    conditions.push({ entityId: req.query.entityId });
  }
  if (req.query.actor) {
    conditions.push({ actor: req.query.actor });
  }
  if (req.query.action) {
    conditions.push({ action: req.query.action });
  }
  if (req.query.dateFrom || req.query.dateTo) {
    const ts = {};
    if (req.query.dateFrom) {
      ts.$gte = new Date(req.query.dateFrom);
    }
    if (req.query.dateTo) {
      ts.$lte = new Date(req.query.dateTo);
    }
    conditions.push({ ts });
  }

  const filter = conditions.length === 1 ? conditions[0] : { $and: conditions };

  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);

  const [data, total] = await Promise.all([
    AuditEvent.find(filter)
      .sort({ ts: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    AuditEvent.countDocuments(filter)
  ]);

  res.status(200).json({
    success: true,
    count: data.length,
    total,
    page,
    limit,
    data
  });
});
