const {
  ErrorResponse,
  asyncHandler,
  requestWithRetry,
  CORRELATION_HEADER,
  PROJECT_ID_HEADER,
  createLogger,
  audit,
  publishEvent,
  requireSearchTerm,
  resolveSearchLimit
} = require('@srckube/service-core');
const Requirement = require('../models/defects');

const logger = createLogger('defectService');

// WP-010 (2.4.1): defectService -> istatusservice, same cross-service
// resilience pattern as testExecutionService -> testRepoService (Sprint
// 1.1/1.2) and linkIssueService -> requirementService/testRepoService
// (Sprint 2.2). Reached over the Docker network by container name+port via
// this env var (set in backend/docker-compose.yml's defectservice block),
// never by localhost — localhost inside a container is the container
// itself (the exact WP-012b regression class).
const ISTATUS_SERVICE = process.env.istatusService;

// WP-031: defect-assignment producer for notificationService. Not added to
// service-core/eventStreams.js's shared EVENT_STREAMS map -- that file
// lives under backend/shared/service-core/, which is WP-032's concurrent
// territory this session (adding its own auth middleware there) and is
// off-limits here. A plain string literal, spelled identically here and in
// backend/notificationService/consumers/notificationConsumer.js, carries
// exactly the risk eventStreams.js's own header comment already calls out
// for every other stream name (a typo silently drops the event on one side
// and leaves the consumer silently empty on the other) -- same trade, just
// not centralized in the shared map this time.
const DEFECT_ASSIGNED_STREAM = 'defect-assigned';


// @desc      Get all users
// @route     GET /api/v1/auth/users
// @access    Private/Admin
// WP-021: res.advancedResults is already tenant-scoped -- advancedResults()
// (service-core) folds req.projectScope.projectId into its Mongo filter.
exports.getDefects =  asyncHandler(async (req, res, next) => {
  //const user = req.kauth.grant.access_token.content;
  //const username = user;


  res.status(200).json(res.advancedResults);
})

// @desc      Get single user
// @route     GET /api/v1/auth/users/:id
// @access    Private/Admin
// WP-021: findById -> findOne({_id, projectId}) -- see
// testRepoService/controllers/testrepo.js#getTestCase for the full
// rationale (identical here): a document in a different project reads back
// as 404, not a cross-tenant leak.
exports.getDefect = asyncHandler(async (req, res, next) => {
  const folder = await Requirement.findOne({ _id: req.params.id, projectId: req.projectScope.projectId });
  if (!folder) {
    return next(new ErrorResponse(`No defect found with id ${req.params.id}`, 404));
  }

  res.status(200).json({
    success: true,
    data: folder
  });
});

// @desc      Create user
// @route     POST /api/v1/auth/users
// @access    Private/Admin
// WP-021: projectId stamped from the verified req.projectScope, never
// trusted from the client body.
exports.createDefect = asyncHandler(async (req, res, next) => {
  const user = req.kauth.grant.access_token.content;
  const username = user;
  let reqdetails = req.body
  reqdetails['createdBy'] = username.sub
  reqdetails['updatedBy'] = username.sub
  reqdetails['projectId'] = req.projectScope.projectId
  const folder = await Requirement.create(reqdetails);

  await audit(req, {
    entityType: 'defect',
    entityId: folder.defectId,
    action: 'create',
    after: { defectId: folder.defectId, summary: folder.summary }
  });

  // WP-031: a defect created with an assignee already set counts as an
  // assignment too -- see the matching, more detailed comment in
  // updateDefect below (same containment pattern, same reasoning).
  if (folder.assignedTo) {
    await publishEvent(DEFECT_ASSIGNED_STREAM, {
      entityType: 'defect',
      entityId: folder.defectId,
      defectId: folder.defectId,
      assignedTo: folder.assignedTo,
      previousAssignee: null,
      projectId: req.projectScope.projectId,
      correlationId: req.correlationId
    });
  }

  res.status(201).json({
    success: true,
    data: folder
  });
});

// @desc      Update user
// @route     PUT /api/v1/auth/users/:id
// @access    Private/Admin
// WP-021: findByIdAndUpdate -> findOneAndUpdate({_id, projectId}); projectId
// stripped from the incoming body so a caller can't reassign a document to
// a different project via the update payload.
exports.updateDefect = asyncHandler(async (req, res, next) => {
  const user = req.kauth.grant.access_token.content;
  const username = user;
  let reqdetails = req.body
  reqdetails['updatedBy'] = username.sub
  delete reqdetails.projectId

  // WP-031: fetch the pre-update document so a change in assignedTo can be
  // detected below -- findOneAndUpdate alone only ever returns the NEW
  // document, and telling "this write assigned the defect to someone new"
  // apart from any other field-only edit requires comparing against the
  // value before this write.
  const before = await Requirement.findOne({ _id: req.params.id, projectId: req.projectScope.projectId });
  if (!before) {
    return next(new ErrorResponse(`No defect found with id ${req.params.id}`, 404));
  }

  const folder = await Requirement.findOneAndUpdate(
    { _id: req.params.id, projectId: req.projectScope.projectId },
    reqdetails,
    {
      new: true,
      runValidators: true,

    }
  );
  if (!folder) {
    return next(new ErrorResponse(`No defect found with id ${req.params.id}`, 404));
  }

  await audit(req, {
    entityType: 'defect',
    entityId: folder.defectId,
    action: 'update',
    after: reqdetails
  });

  // WP-031: defect-assignment producer -- follows WP-030's exact
  // containment pattern (testPlanExecutionService/controllers/
  // testexecution.js's updateTestExecution: fire-and-forget, awaited only
  // for delivery-order convenience, never wrapped in a try/catch of our
  // own since publishEvent() already never throws/rejects -- see
  // service-core/events.js's header comment). Fires only when assignedTo is
  // present on this write AND actually differs from the pre-update value,
  // so a no-op re-save or an edit to unrelated fields doesn't spam a
  // duplicate "assigned" notification.
  if (reqdetails.assignedTo && reqdetails.assignedTo !== before.assignedTo) {
    await publishEvent(DEFECT_ASSIGNED_STREAM, {
      entityType: 'defect',
      entityId: folder.defectId,
      defectId: folder.defectId,
      assignedTo: reqdetails.assignedTo,
      previousAssignee: before.assignedTo || null,
      projectId: req.projectScope.projectId,
      correlationId: req.correlationId
    });
  }

  res.status(200).json({
    success: true,
    data: folder
  });
});

// @desc      Delete user
// @route     DELETE /api/v1/auth/users/:id
// @access    Private/Admin
// WP-021: findByIdAndDelete -> findOneAndDelete({_id, projectId}).
exports.deleteDefect = asyncHandler(async (req, res, next) => {
  const deleted = await Requirement.findOneAndDelete({ _id: req.params.id, projectId: req.projectScope.projectId });
  if (!deleted) {
    return next(new ErrorResponse(`No defect found with id ${req.params.id}`, 404));
  }

  await audit(req, {
    entityType: 'defect',
    entityId: deleted.defectId,
    action: 'delete',
    before: { defectId: deleted.defectId, summary: deleted.summary, Status: deleted.Status }
  });

  res.status(200).json({
    success: true,
    data: {}
  });
});

// WP-104 — user input is escaped before it reaches $regex and the result
// set is capped.
//
// Escaping is a correctness fix first: unescaped, a search for "DEF1." also
// matched "DEF11", "." matched every document and "^" anchored. The cap is
// what bounds the route -- it previously returned every match in the project,
// fully hydrated, in a single response (and accepted an empty search, which
// matched everything). A missing ?search= used to reach Mongo as
// {$regex: undefined} and surface as a 500; requireSearchTerm() makes that a
// 400, which is what bad input deserves.
exports.wildcardSearch = asyncHandler(async (req, res, next) => {
  const search = requireSearchTerm(req.query.search);

  const reqList = await Requirement.find({
    projectId: req.projectScope.projectId,
    $or: [
      { defectId: { $regex: search, $options: 'i' } },
      { summary: { $regex: search, $options: 'i' } }
    ]
  }).limit(resolveSearchLimit());
  res.status(200).json({
    success: true,
    data: reqList
  });
})

// WP-010 (Sprint 2.4) — Defect status workflow
//
// @desc      Transition a defect's Status, validated against istatusservice's
//            real parentId graph (not a hardcoded list)
// @route     PUT /api/v1/defects/:id/status
// @access    Private
//
// Transition-graph semantics (verified directly against the live
// srckube-issuestatus.staus collection, not assumed — see EXECUTION_LOG.md
// for the raw documents): each IssueStatus document's `parentId` array lists
// the ids of the statuses you may come FROM to reach it, i.e. it is a
// "valid predecessors" list, not a "valid successors" list. E.g. istatus
// "Fixed" (id 3) has parentId [2, 7] -- reachable from "Open" (id 2) or
// "Re-open" (id 7), matching the real recovered workflow
// New -> Open -> Fixed/Rejected/Deferred -> Retest -> Re-open/Closed, with
// Re-open looping back to Fixed. So: transition current -> target is valid
// iff target.parentId includes current's numeric id.
//
// istatusservice-unavailable behavior: FAIL CLOSED (503). A defect status
// transition is a workflow-integrity operation -- if we can't fetch the
// real graph, we cannot tell a legal transition from an illegal one, and
// silently allowing the write would let bad transitions through exactly
// when validation matters most (an outage). requestWithRetry already
// absorbs transient network blips/5xxs with backoff before we give up.
//
// WP-021: the defect lookup is scoped to req.projectScope.projectId (same
// rationale as getDefect/updateDefect above) -- the istatusservice
// transition-graph validation below is unrelated to tenant scope and is
// unchanged.
exports.updateDefectStatus = asyncHandler(async (req, res, next) => {
  const requestedStatus = req.body.status || req.body.Status;
  if (!requestedStatus) {
    return next(new ErrorResponse('status is required in the request body', 400));
  }

  const defect = await Requirement.findOne({ _id: req.params.id, projectId: req.projectScope.projectId });
  if (!defect) {
    return next(new ErrorResponse(`No defect found with id ${req.params.id}`, 404));
  }

  if (!ISTATUS_SERVICE) {
    logger.error('istatusService env var not configured; failing closed', {
      correlationId: req.correlationId
    });
    return next(new ErrorResponse('Status service is not configured; cannot validate transition', 503));
  }

  // WP-116 — istatusservice is now project-scoped, so the caller's verified
  // project must be forwarded or this fetch 403s and the transition fails
  // CLOSED with 503 "Status service unreachable".
  //
  // This is the same class of stale assumption WP-111 found in
  // reportingService (three sites that stripped X-Project-Id because
  // linkIssueService "carries no project-scoping concept"): a header subset
  // that was correct while the dependency was global, and silently wrong the
  // moment it was scoped. The defect-status workflow WP-010 built depends on
  // this fetch, so leaving it out would have broken a live feature.
  const headers = {
    Authorization: `${req.headers.authorization}`,
    [PROJECT_ID_HEADER]: String(req.projectScope.projectId),
    [CORRELATION_HEADER]: req.correlationId
  };

  let statusList;
  try {
    const statusResp = await requestWithRetry({
      method: 'get',
      url: `http://${ISTATUS_SERVICE}/api/v1/issuestatus?limit=1000`,
      headers
    });
    statusList = statusResp.data.data;
  } catch (err) {
    logger.error('istatusservice unreachable; failing closed on status transition', {
      correlationId: req.correlationId,
      defectId: req.params.id,
      error: err.message
    });
    return next(new ErrorResponse('Unable to validate status transition: status service unavailable', 503));
  }

  const byName = (name) =>
    statusList.find((s) => (s.istatus || '').toLowerCase() === (name || '').toLowerCase());

  const targetStatus = byName(requestedStatus);
  if (!targetStatus) {
    return next(new ErrorResponse(
      `'${requestedStatus}' is not a recognized status. Valid statuses: ${statusList.map((s) => s.istatus).join(', ')}`,
      400
    ));
  }

  // A defect created with no Status (the workbench draft flow never sets
  // one) sits at the graph's root: id 0, the parentId istatusservice gives
  // its start state(s). Treat it as that root so it can enter the workflow
  // instead of being stuck behind the "unrecognized status" rejection
  // below. The frontend's DefectStatus.tsx applies the same rule.
  const hasNoStatus = !defect.Status || !String(defect.Status).trim();
  const currentStatus = hasNoStatus ? { id: 0, istatus: '(none)' } : byName(defect.Status);
  if (!currentStatus) {
    // The defect's current Status doesn't match any known istatusservice
    // vocabulary entry -- most likely a pre-existing free-text value from
    // before this workflow existed (defectService.Status had no enum/
    // validation prior to this WP). We can't compute a valid predecessor
    // set for an unrecognized current state, so this dedicated,
    // graph-enforcing endpoint fails closed rather than guessing. The
    // original unconstrained PUT /api/v1/defects/:id remains available for
    // freeform correction of such legacy records.
    return next(new ErrorResponse(
      `Current status '${defect.Status}' is not part of the recognized workflow, so this transition cannot be validated. Use PUT /api/v1/defects/${req.params.id} to correct it directly.`,
      400
    ));
  }

  const validFrom = targetStatus.parentId || [];
  if (!validFrom.includes(currentStatus.id)) {
    const validNextNames = statusList
      .filter((s) => (s.parentId || []).includes(currentStatus.id))
      .map((s) => s.istatus);
    return next(new ErrorResponse(
      `Invalid transition: cannot move from '${currentStatus.istatus}' to '${targetStatus.istatus}'. ` +
      `Valid next status(es) from '${currentStatus.istatus}': ${validNextNames.length ? validNextNames.join(', ') : 'none'}`,
      400
    ));
  }

  const user = req.kauth.grant.access_token.content;
  const previousStatus = defect.Status;

  defect.Status = targetStatus.istatus;
  defect.updatedBy = user.sub;
  defect.statusHistory.push({
    from: previousStatus,
    to: targetStatus.istatus,
    changedBy: user.sub,
    changedAt: new Date(),
    correlationId: req.correlationId
  });

  await defect.save();

  logger.info('defect status transitioned', {
    correlationId: req.correlationId,
    defectId: defect.defectId,
    from: previousStatus,
    to: targetStatus.istatus,
    changedBy: user.sub
  });

  await audit(req, {
    entityType: 'defect',
    entityId: defect.defectId,
    action: 'status-change',
    before: { status: previousStatus },
    after: { status: targetStatus.istatus }
  });

  res.status(200).json({
    success: true,
    data: defect
  });
});

// WP-043 -- Bulk operations on defects: assign and delete only.
//
// Bulk STATUS-change was deliberately NOT implemented here: updateDefectStatus
// (above) validates every transition against istatusservice's live
// parentId graph via a real network call per item (requestWithRetry, fail
// -closed on outage -- see that function's header comment). Doing that
// safely for a batch means either N sequential cross-service round trips
// inside one request (a real latency/partial-outage risk this WP's proven
// need -- bulk-assign, per the acceptance criteria -- does not require) or
// caching the graph across the batch (a correctness risk if it changes
// mid-batch). Out of scope; stated here rather than silently half-built.
// Bulk assign/delete need no such external validation, so they follow the
// exact all-or-nothing pattern testRepoService's bulk endpoints use (see
// that file's header comment for the full policy writeup -- identical
// reasoning, not repeated here).
const BULK_MAX_ITEMS = 500;

function validateBulkIds(req, next) {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    next(new ErrorResponse('ids must be a non-empty array', 400));
    return null;
  }
  if (ids.length > BULK_MAX_ITEMS) {
    next(new ErrorResponse(`Bulk operations are limited to ${BULK_MAX_ITEMS} items at a time (got ${ids.length})`, 400));
    return null;
  }
  return ids;
}

// @desc      Bulk-assign defects, all-or-nothing.
// @route     PATCH /api/v1/defects/bulk
// @body      { ids: string[], action: 'assign', assignedTo: string }
// @access    Private (write)
exports.bulkUpdateDefects = asyncHandler(async (req, res, next) => {
  const ids = validateBulkIds(req, next);
  if (!ids) return;

  const { action, assignedTo } = req.body;
  if (action !== 'assign') {
    return next(new ErrorResponse("action must be 'assign' (bulk status-change is not supported for defects -- see this file's header comment)", 400));
  }
  if (!assignedTo) {
    return next(new ErrorResponse('assignedTo is required for action "assign"', 400));
  }

  const projectId = req.projectScope.projectId;
  const docs = await Requirement.find({ _id: { $in: ids }, projectId });

  if (docs.length !== ids.length) {
    const foundIds = new Set(docs.map((d) => String(d._id)));
    const missingIds = ids.filter((id) => !foundIds.has(String(id)));
    return res.status(422).json({
      success: false,
      policy: 'all-or-nothing',
      error: `${missingIds.length} of ${ids.length} item(s) were not found in this project; nothing was changed`,
      missingIds
    });
  }

  const user = req.kauth.grant.access_token.content;
  const applied = [];
  let results;
  try {
    results = [];
    for (const doc of docs) {
      const before = { assignedTo: doc.assignedTo };
      const updated = await Requirement.findOneAndUpdate(
        { _id: doc._id, projectId },
        { assignedTo, updatedBy: user.sub },
        { new: true, runValidators: true }
      );
      applied.push({ id: doc._id, before });
      results.push(updated);
    }
  } catch (err) {
    for (const a of applied) {
      // eslint-disable-next-line no-await-in-loop
      await Requirement.findOneAndUpdate({ _id: a.id, projectId }, a.before).catch(() => {});
    }
    throw new ErrorResponse(`Bulk assign failed partway through (${applied.length}/${docs.length} items); all changes rolled back: ${err.message}`, 500);
  }

  for (const updated of results) {
    // eslint-disable-next-line no-await-in-loop
    await audit(req, {
      entityType: 'defect',
      entityId: updated.defectId,
      action: 'bulk-assign',
      after: { assignedTo: updated.assignedTo }
    });
  }

  // WP-031: same defect-assignment producer plain updateDefect fires,
  // one event per item -- notificationService's consumer already
  // de-dupes/handles these individually, no batch variant needed.
  for (let i = 0; i < results.length; i += 1) {
    const updated = results[i];
    const before = applied[i].before;
    if (updated.assignedTo !== before.assignedTo) {
      // eslint-disable-next-line no-await-in-loop
      await publishEvent(DEFECT_ASSIGNED_STREAM, {
        entityType: 'defect',
        entityId: updated.defectId,
        defectId: updated.defectId,
        assignedTo: updated.assignedTo,
        previousAssignee: before.assignedTo || null,
        projectId,
        correlationId: req.correlationId
      });
    }
  }

  logger.info('bulk defect assign succeeded', {
    correlationId: req.correlationId,
    projectId,
    count: results.length
  });

  res.status(200).json({
    success: true,
    policy: 'all-or-nothing',
    updated: results.length,
    data: results
  });
});

// @desc      Bulk delete defects, all-or-nothing.
// @route     DELETE /api/v1/defects/bulk
// @body      { ids: string[] }
// @access    Private (delete)
exports.bulkDeleteDefects = asyncHandler(async (req, res, next) => {
  const ids = validateBulkIds(req, next);
  if (!ids) return;

  const projectId = req.projectScope.projectId;
  const docs = await Requirement.find({ _id: { $in: ids }, projectId });

  if (docs.length !== ids.length) {
    const foundIds = new Set(docs.map((d) => String(d._id)));
    const missingIds = ids.filter((id) => !foundIds.has(String(id)));
    return res.status(422).json({
      success: false,
      policy: 'all-or-nothing',
      error: `${missingIds.length} of ${ids.length} item(s) were not found in this project; nothing was deleted`,
      missingIds
    });
  }

  const deletedIds = [];
  try {
    for (const doc of docs) {
      // eslint-disable-next-line no-await-in-loop
      await Requirement.deleteOne({ _id: doc._id, projectId });
      deletedIds.push(doc._id);
    }
  } catch (err) {
    for (const doc of docs) {
      if (deletedIds.some((id) => String(id) === String(doc._id))) {
        // eslint-disable-next-line no-await-in-loop
        await new Requirement(doc.toObject()).save().catch(() => {});
      }
    }
    throw new ErrorResponse(`Bulk delete failed partway through (${deletedIds.length}/${docs.length} items); all deletions rolled back: ${err.message}`, 500);
  }

  for (const doc of docs) {
    // eslint-disable-next-line no-await-in-loop
    await audit(req, {
      entityType: 'defect',
      entityId: doc.defectId,
      action: 'bulk-delete',
      before: { defectId: doc.defectId, summary: doc.summary, Status: doc.Status }
    });
  }

  logger.info('bulk defect delete succeeded', {
    correlationId: req.correlationId,
    projectId,
    count: docs.length
  });

  res.status(200).json({
    success: true,
    policy: 'all-or-nothing',
    deleted: docs.length
  });
});
