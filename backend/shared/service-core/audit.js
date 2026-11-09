const mongoose = require('mongoose');
const { createLogger } = require('./logger');

const logger = createLogger('service-core:audit');

// WP-024 — Audit log.
//
// HOME DECISION (recorded here, see also EXECUTION_LOG.md's WP-024 report):
// AuditEvent lives in commentsService's existing MongoDB database
// (srckube-comments), NOT a brand-new microservice. Reasoning:
//   1. commentsService already sits in the "Collaboration" group named by
//      the WP-024 brief, and this collection is exactly that kind of
//      cross-cutting, append-only, low-compute-need data -- it doesn't
//      justify its own service, Dockerfile, Kong service entry, and
//      compose block (an operational cost every one of the 15 existing
//      services already pays and this WP shouldn't add a 16th instance of).
//   2. Writing audit events from testRepoService/requirementService/
//      defectService/testPlanExecutionService controllers via a direct
//      Mongo connection (this file) avoids adding a synchronous
//      network hop + new failure mode to every write path just to record
//      that the write happened -- Mongo writes here are already wrapped so
//      a slow/unreachable audit store degrades to "no audit event", never
//      "the business write also failed" (see audit() below).
//   3. It reuses an already-provisioned database instead of standing up a
//      new one, and keeps the read API (commentsService's new
//      GET /api/v1/audit route) in the same service as the write-side
//      model definition, so there is exactly one schema, defined once,
//      here, and required by both sides.
//
// This is a SEPARATE Mongoose connection from each calling service's own
// primary `mongoose.connect()` (which targets that service's own database,
// e.g. srckube-testrepo) -- every service that calls audit() must be given
// its own AUDIT_MONGO_URI env var pointing at srckube-comments (same value
// as commentsService's own MONGO_URI; see backend/docker-compose.yml).
// Lazily created and cached at module scope so repeated audit() calls
// within one process reuse a single connection instead of opening a new one
// per call.
const AUDIT_COLLECTION = 'auditevents';

const AuditEventSchema = new mongoose.Schema(
  {
    ts: { type: Date, default: Date.now, required: true },
    // Token subject (Keycloak `sub`) -- see audit()'s comment below for why
    // this is NEVER taken from req.body. Required: an audit event with no
    // identifiable actor is worse than no event (WP-024 brief, verbatim).
    actor: { type: String, required: true },
    // Best-effort display name from the token (preferred_username/name),
    // purely a UI convenience -- `actor` (the sub) is the field anything
    // authorization- or forensics-relevant should key off.
    actorName: { type: String },
    organizationId: { type: mongoose.Schema.Types.Mixed },
    // Number, matching req.projectScope.projectId (WP-021) -- not required
    // at the schema level because a couple of write paths this WP audits
    // (testPlanExecutionService's TestPlan/TestExecution controllers) are
    // NOT yet on requireProjectScope() (a WP-021 exclusion, not something
    // this WP changes) and so have no verified projectId to stamp. See
    // EXECUTION_LOG.md's WP-024 report for the explicit decision on this
    // gap.
    projectId: { type: Number },
    entityType: { type: String, required: true },
    entityId: { type: String, required: true },
    action: { type: String, required: true },
    // Free-form before/after summary or diff -- deliberately Mixed. Callers
    // pass whatever subset of fields is meaningful for that entity/action
    // (e.g. a status transition passes {from, to}; a create passes the
    // created document's key fields). Not a full document dump by
    // convention (keeps events small and avoids duplicating the system of
    // record), though nothing here enforces that.
    summary: { type: mongoose.Schema.Types.Mixed },
    correlationId: { type: String }
  },
  {
    // No `updatedAt` -- audit events are append-only and never modified
    // after creation (enforced at the API layer: commentsService's
    // GET /api/v1/audit route is the ONLY route mounted against this
    // collection -- no PUT/PATCH/DELETE controller or route exists
    // anywhere in this repo that targets it). `createdAt` alone is kept
    // for operational/debugging convenience; `ts` is the authoritative
    // event time used by every read-side filter.
    timestamps: { createdAt: true, updatedAt: false },
    collection: AUDIT_COLLECTION
  }
);

AuditEventSchema.index({ projectId: 1, ts: -1 });
AuditEventSchema.index({ entityType: 1, entityId: 1, ts: -1 });
AuditEventSchema.index({ actor: 1, ts: -1 });

let cachedConnection = null;
let cachedModel = null;

function resolveAuditMongoUri() {
  return process.env.AUDIT_MONGO_URI || null;
}

// Test-only escape hatch, same pattern as projectScope.js's
// _resetProjectCacheForTests -- lets unit tests exercise "not configured"
// and "freshly configured" without leaking a real connection across cases.
function _resetAuditConnectionForTests() {
  if (cachedConnection) {
    cachedConnection.close().catch(() => {});
  }
  cachedConnection = null;
  cachedModel = null;
}

// Returns the AuditEvent model bound to the dedicated audit connection, or
// null if AUDIT_MONGO_URI isn't configured on this service (audit() treats
// null as "audit store unavailable, log and continue" -- never a throw).
// Exported so commentsService's read-side controller can query the exact
// same schema/collection this file defines, without a second definition to
// drift out of sync.
function getAuditEventModel() {
  const uri = resolveAuditMongoUri();
  if (!uri) {
    return null;
  }
  if (cachedModel) {
    return cachedModel;
  }

  cachedConnection = mongoose.createConnection(uri, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    useCreateIndex: true,
    useFindAndModify: false,
    // Bounded server selection so a write-side caller of audit() never
    // hangs a business request on an unreachable audit store for longer
    // than this -- errors out and falls into audit()'s catch instead.
    serverSelectionTimeoutMS: 3000
  });
  cachedConnection.on('error', (err) => {
    logger.error('audit store connection error', { error: err.message });
  });

  cachedModel = cachedConnection.model('AuditEvent', AuditEventSchema);
  return cachedModel;
}

// audit(req, {...}) — the write-path helper every controller calls after a
// create/update/delete/status-change succeeds.
//
// actor is ALWAYS derived from the verified token (req.kauth.grant.
// access_token.content.sub), never from req.body or any caller-supplied
// field. This is the exact class of bug WP-020b fixed for
// organization/project controllers (a forgeable `createdBy` taken from the
// request body) -- an audit log is the one place where that mistake is
// worst, because a forgeable actor manufactures false forensic confidence
// instead of just a wrong display value. There is deliberately no
// `actor`/`actorId` key in the `details` param this function accepts; even
// if a caller passed one, it would be ignored.
//
// CONTRACT: audit() never throws and never rejects. Every failure mode
// (audit store not configured, connection error, write error, malformed
// input) is caught internally, logged, and resolved to `null`. Callers are
// expected to `await audit(req, {...})` for read-after-write consistency
// (so an acceptance test can create/update/delete and immediately query the
// read API without a retry loop) but MUST NOT wrap it in their own
// try/catch to "protect" the business operation -- that protection is
// already inside this function. See
// backend/shared/service-core/__tests__/audit.test.js's "does not throw
// when the write fails" case for the proof.
async function audit(req, { entityType, entityId, action, before, after, summary, projectId, organizationId } = {}) {
  try {
    if (!entityType || !entityId || !action) {
      logger.warn('audit() called with missing entityType/entityId/action; skipping', {
        entityType,
        entityId,
        action,
        correlationId: req && req.correlationId
      });
      return null;
    }

    const grant =
      req && req.kauth && req.kauth.grant && req.kauth.grant.access_token && req.kauth.grant.access_token.content;
    const actor = grant && grant.sub;
    if (!actor) {
      logger.warn('audit() called without an authenticated actor (req.kauth) on the request; skipping', {
        entityType,
        entityId,
        action,
        correlationId: req && req.correlationId
      });
      return null;
    }

    const model = getAuditEventModel();
    if (!model) {
      logger.warn('AUDIT_MONGO_URI not configured on this service; audit event dropped', {
        entityType,
        entityId,
        action,
        correlationId: req && req.correlationId
      });
      return null;
    }

    const resolvedProjectId =
      projectId !== undefined ? projectId : req && req.projectScope && req.projectScope.projectId;
    const resolvedOrganizationId =
      organizationId !== undefined
        ? organizationId
        : req && req.projectScope && req.projectScope.project && req.projectScope.project.organizationId;

    const doc = await model.create({
      actor,
      actorName: grant.preferred_username || grant.name,
      organizationId: resolvedOrganizationId,
      projectId: resolvedProjectId,
      entityType,
      entityId: String(entityId),
      action,
      summary: summary !== undefined ? summary : { before, after },
      correlationId: req && req.correlationId
    });

    return doc;
  } catch (err) {
    // Failures to audit must never fail the business operation this is
    // called from (WP-024 brief, verbatim) -- log and continue.
    logger.error('audit() failed to write an audit event; continuing without failing the calling operation', {
      error: err.message,
      entityType,
      entityId,
      action,
      correlationId: req && req.correlationId
    });
    return null;
  }
}

module.exports = { audit, getAuditEventModel, AuditEventSchema, AUDIT_COLLECTION, _resetAuditConnectionForTests };
