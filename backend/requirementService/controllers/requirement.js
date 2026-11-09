const {
  ErrorResponse,
  asyncHandler,
  createLogger,
  isValidTransition,
  LIFECYCLE_STATUSES,
  audit,
  publishEvent,
  EVENT_STREAMS,
  requireSearchTerm,
  resolveSearchLimit
} = require('@srckube/service-core');
const Requirement = require('../models/requirement');
const RequirementVersion = require('../models/RequirementVersion');

const logger = createLogger('requirementService');


// @desc      Get all users
// @route     GET /api/v1/auth/users
// @access    Private/Admin
// WP-021: res.advancedResults is already tenant-scoped -- advancedResults()
// (service-core) folds req.projectScope.projectId into its Mongo filter.
exports.getRequirements =  asyncHandler(async (req, res, next) => {
  const user = req.kauth.grant.access_token.content;
  const username = user;


  res.status(200).json(res.advancedResults);
})

// @desc      Get single user
// @route     GET /api/v1/auth/users/:id
// @access    Private/Admin
// WP-021: findById -> findOne({_id, projectId}) -- see
// testRepoService/controllers/testrepo.js#getTestCase for the full
// rationale (identical here): a document in a different project reads back
// as 404, not a cross-tenant leak.
exports.getRequirement = asyncHandler(async (req, res, next) => {
  const folder = await Requirement.findOne({ _id: req.params.id, projectId: req.projectScope.projectId });
  if (!folder) {
    return next(new ErrorResponse(`No requirement found with id ${req.params.id}`, 404));
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
exports.createRequirement = asyncHandler(async (req, res, next) => {
  const user = req.kauth.grant.access_token.content;
  const username = user;
  let reqdetails = req.body
  reqdetails['createdBy'] = username.sub
  reqdetails['updatedBy'] = username.sub
  reqdetails['projectId'] = req.projectScope.projectId
  const folder = await Requirement.create(reqdetails);

  await audit(req, {
    entityType: 'requirement',
    entityId: folder.reqId,
    action: 'create',
    after: { reqId: folder.reqId, requirementSummary: folder.requirementSummary }
  });

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
exports.updateRequirement = asyncHandler(async (req, res, next) => {
  const user = req.kauth.grant.access_token.content;
  const username = user;
  let reqdetails = req.body
  reqdetails['updatedBy'] = username.sub
  delete reqdetails.projectId
  const folder = await Requirement.findOneAndUpdate(
    { _id: req.params.id, projectId: req.projectScope.projectId },
    reqdetails,
    {
      new: true,
      runValidators: true,

    }
  );
  if (!folder) {
    return next(new ErrorResponse(`No requirement found with id ${req.params.id}`, 404));
  }

  await audit(req, {
    entityType: 'requirement',
    entityId: folder.reqId,
    action: 'update',
    after: reqdetails
  });

  res.status(200).json({
    success: true,
    data: folder
  });
});

exports.updateRequirementByParam = asyncHandler(async(req,res,next)=>{
console.log(req.query.reqid)
console.log(req.body)
  const reqBody = { ...req.body };
  delete reqBody.projectId;
  const folder = await Requirement.findOneAndUpdate(
    { reqId: req.query.reqid, projectId: req.projectScope.projectId },
    reqBody,
    {
      new: true,
      runValidators: true
    }
  );
  if (!folder) {
    return next(new ErrorResponse(`No requirement found with reqId ${req.query.reqid}`, 404));
  }

  await audit(req, {
    entityType: 'requirement',
    entityId: folder.reqId,
    action: 'update',
    after: reqBody
  });

  res.status(200).json({
    success: true,
    data: folder
  });
})

// @desc      Delete user
// @route     DELETE /api/v1/auth/users/:id
// @access    Private/Admin
// WP-021: findByIdAndDelete -> findOneAndDelete({_id, projectId}).
exports.deleteRequirement = asyncHandler(async (req, res, next) => {
  const deleted = await Requirement.findOneAndDelete({ _id: req.params.id, projectId: req.projectScope.projectId });
  if (!deleted) {
    return next(new ErrorResponse(`No requirement found with id ${req.params.id}`, 404));
  }

  await audit(req, {
    entityType: 'requirement',
    entityId: deleted.reqId,
    action: 'delete',
    before: { reqId: deleted.reqId, requirementSummary: deleted.requirementSummary, status: deleted.status }
  });

  res.status(200).json({
    success: true,
    data: {}
  });
});


// WP-104 — user input is escaped before it reaches $regex and the result
// set is capped.
//
// Escaping is a correctness fix first: unescaped, a search for "REQ1." also
// matched "REQ11", "." matched every document and "^" anchored. The cap is
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
      { reqId: { $regex: search, $options: 'i' } },
      { requirementSummary: { $regex: search, $options: 'i' } }
    ]
  }).limit(resolveSearchLimit());
  res.status(200).json({
    success: true,
    data: reqList
  });


})

// Sprint 2.1 (PB-04)
// @desc      Transition a requirement's lifecycle status, validating the transition
// @route     PUT /api/v1/requirement/:id/status
// @access    Private
// WP-021: both lookups scoped to req.projectScope.projectId.
exports.updateRequirementStatus = asyncHandler(async (req, res, next) => {
  const { status: nextStatus } = req.body;

  if (!LIFECYCLE_STATUSES.includes(nextStatus)) {
    return res.status(400).json({
      success: false,
      error: `Invalid status: ${nextStatus}. Must be one of ${LIFECYCLE_STATUSES.join(', ')}`
    });
  }

  const current = await Requirement.findOne({ _id: req.params.id, projectId: req.projectScope.projectId });
  if (!current) {
    return res.status(404).json({ success: false, error: 'Requirement not found' });
  }

  if (!isValidTransition(current.status, nextStatus)) {
    return res.status(400).json({
      success: false,
      error: `Cannot transition from '${current.status}' to '${nextStatus}'`
    });
  }

  const user = req.kauth.grant.access_token.content;
  const updated = await Requirement.findOneAndUpdate(
    { _id: req.params.id, projectId: req.projectScope.projectId },
    { status: nextStatus, updatedBy: user.sub },
    { new: true, runValidators: true }
  );

  logger.info('requirement status transitioned', {
    correlationId: req.correlationId,
    reqId: updated.reqId,
    from: current.status,
    to: nextStatus
  });

  await audit(req, {
    entityType: 'requirement',
    entityId: updated.reqId,
    action: 'status-change',
    before: { status: current.status },
    after: { status: nextStatus }
  });

  // WP-030: same call site as audit() above -- this is the one dedicated
  // lifecycle-transition endpoint for requirements, so it is the natural
  // producer for the shared 'status-changed' stream (also published from
  // testRepoService's mirror-image updateTestCaseStatus). correlationId
  // carried through so a consumer can join an event back to this request,
  // matching WP-024's audit events.
  await publishEvent(EVENT_STREAMS.STATUS_CHANGED, {
    entityType: 'requirement',
    entityId: updated.reqId,
    projectId: req.projectScope && req.projectScope.projectId,
    from: current.status,
    to: nextStatus,
    correlationId: req.correlationId
  });

  res.status(200).json({ success: true, data: updated });
});

// Sprint 2.1 (PB-04)
// @desc      Retrieve the immutable version history of a requirement, newest first
// @route     GET /api/v1/requirement/:id/versions
// @access    Private
// WP-021: parent lookup scoped to req.projectScope.projectId; version scope
// inherited transitively through the already-scoped parent's reqId (no
// separate projectId on RequirementVersion).
exports.getRequirementVersions = asyncHandler(async (req, res, next) => {
  const current = await Requirement.findOne({ _id: req.params.id, projectId: req.projectScope.projectId });
  if (!current) {
    return res.status(404).json({ success: false, error: 'Requirement not found' });
  }

  const versions = await RequirementVersion.find({ reqId: current.reqId }).sort({ version: -1 });

  res.status(200).json({
    success: true,
    count: versions.length,
    data: versions
  });
});

// WP-F03 -- bulk operations for requirements, mirroring
// testRepoService/controllers/testrepo.js:309-520. That file's header
// records the decisions inherited here verbatim: ALL-OR-NOTHING because
// this deployment's Mongo is standalone (no multi-document transaction to
// roll back with), validation of every id BEFORE any write, a compensating
// rollback if a write fails after validation passed, and exactly N audit
// events for N items (never one summary event).
//
// ONE DELIBERATE DIFFERENCE from the test-case version: there is no
// 'assign' action. Requirements carry no `assignedTo` field (verified
// against models/requirement.js), so offering one would be a 400 dressed
// up as a feature. (The lifecycle-transition check below is NOT a second
// difference -- it was simply missing here until WP-F03e's whole-branch
// review caught it; testrepo.js:389-400 always had it.)
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

// @desc      Bulk status-change, all-or-nothing.
// @route     PATCH /api/v1/requirement/bulk
// @body      { ids: string[], action: 'status', status: string }
// @access    Private (write)
exports.bulkUpdateRequirements = asyncHandler(async (req, res, next) => {
  const ids = validateBulkIds(req, next);
  if (!ids) return;

  const { action, status: nextStatus } = req.body;
  if (action !== 'status') {
    return next(new ErrorResponse("action must be 'status' (requirements have no assignedTo field)", 400));
  }
  if (!LIFECYCLE_STATUSES.includes(nextStatus)) {
    return next(new ErrorResponse(`Invalid status: ${nextStatus}. Must be one of ${LIFECYCLE_STATUSES.join(', ')}`, 400));
  }

  const found = await Requirement.find({ _id: { $in: ids }, projectId: req.projectScope.projectId });
  const foundIds = found.map((d) => String(d._id));
  const missingIds = ids.filter((id) => !foundIds.includes(String(id)));
  if (missingIds.length > 0) {
    return res.status(422).json({
      success: false,
      policy: 'all-or-nothing',
      error: 'No requirement was changed: some ids were not found in this project',
      missingIds
    });
  }

  // Fix 1 (WP-F03e final review, CRITICAL): mirrors testrepo.js:389-400
  // exactly. Without this, bulk status change let a caller skip the
  // lifecycle state machine entirely (draft -> approved, or out of the
  // terminal 'archived' state) even though the single-item PUT /:id/status
  // path (updateRequirementStatus, above) has always enforced it via this
  // same isValidTransition() import. `invalidIds` uses `reqId`, matching
  // how this service identifies requirements everywhere else (audit
  // entityId, missingIds's sibling in testrepo.js uses TestCaseId the same
  // way) -- and is already parsed by frontend/src/api/bulkApi.ts's
  // BulkPolicyError, which until now had nothing to parse.
  const invalidTransitions = found.filter((d) => !isValidTransition(d.status, nextStatus));
  if (invalidTransitions.length > 0) {
    return res.status(422).json({
      success: false,
      policy: 'all-or-nothing',
      error: `${invalidTransitions.length} of ${found.length} item(s) cannot transition to '${nextStatus}'; nothing was changed`,
      invalidIds: invalidTransitions.map((d) => d.reqId)
    });
  }

  const previous = new Map(found.map((d) => [String(d._id), d.status]));
  const applied = [];
  try {
    for (const doc of found) {
      const fromStatus = doc.status;
      await Requirement.findOneAndUpdate(
        { _id: doc._id, projectId: req.projectScope.projectId },
        { status: nextStatus, updatedBy: req.kauth?.grant?.access_token?.content?.sub }
      );
      applied.push(String(doc._id));
      await audit(req, {
        entityType: 'requirement',
        entityId: doc.reqId,
        // Fix 2 (WP-F03e final review, Important): was 'bulk-status',
        // diverging from the canonical 'bulk-status-change'
        // (testrepo.js:428) and this same service's own single-item
        // 'status-change' (updateRequirementStatus, above).
        // commentsService/controllers/audit.js's GET /api/v1/audit filters
        // on an exact `action` match, so the wrong name silently omitted
        // every requirement bulk-status event from
        // ?action=bulk-status-change forever (audit rows are append-only,
        // no update path exists anywhere in the repo).
        action: 'bulk-status-change',
        after: { status: nextStatus }
      });

      // Fix 3 (WP-F03e final review, Important): publish STATUS_CHANGED
      // per item, same payload shape as updateRequirementStatus's call
      // site above (single dedicated producer for this stream --
      // notificationConsumer.js:76-79 turns a transition INTO 'review'
      // into a project-manager notification). Without this, bulk-moving
      // N requirements into review notified nobody, while doing the exact
      // same N transitions one-at-a-time notified managers N times.
      // Per-item, not one summary event, for the identical reason the
      // audit convention above is per-item.
      await publishEvent(EVENT_STREAMS.STATUS_CHANGED, {
        entityType: 'requirement',
        entityId: doc.reqId,
        projectId: req.projectScope && req.projectScope.projectId,
        from: fromStatus,
        to: nextStatus,
        correlationId: req.correlationId
      });
    }
  } catch (err) {
    for (const id of applied) {
      await Requirement.findOneAndUpdate(
        { _id: id, projectId: req.projectScope.projectId },
        { status: previous.get(id) }
      );
    }
    return next(err);
  }

  res.status(200).json({ success: true, policy: 'all-or-nothing', updated: applied.length });
});

// @desc      Bulk delete, all-or-nothing.
// @route     DELETE /api/v1/requirement/bulk
// @body      { ids: string[] }
// @access    Private (delete)
exports.bulkDeleteRequirements = asyncHandler(async (req, res, next) => {
  const ids = validateBulkIds(req, next);
  if (!ids) return;

  const found = await Requirement.find({ _id: { $in: ids }, projectId: req.projectScope.projectId });
  const foundIds = found.map((d) => String(d._id));
  const missingIds = ids.filter((id) => !foundIds.includes(String(id)));
  if (missingIds.length > 0) {
    return res.status(422).json({
      success: false,
      policy: 'all-or-nothing',
      error: 'Nothing was deleted: some ids were not found in this project',
      missingIds
    });
  }

  // Fix round 1 (task review): this loop had no try/catch even though the
  // header comment above promises a compensating rollback for every bulk
  // op. deleteOne per item, and on any failure mid-loop re-insert every
  // document this batch already deleted, so a transient Mongo error on
  // item 2 of 3 can't leave item 1 permanently gone while the caller sees
  // a bare 500.
  //
  // Fix round 2 (task review): the re-insert deliberately does NOT mirror
  // the canonical testRepoService/controllers/testrepo.js:470-487, which
  // uses `new TestCase(doc.toObject()).save()`. That construction is
  // isNew === true regardless of the `_id`/reqId already present in the
  // object, so it re-triggers this model's `pre('save')` hook
  // (models/requirement.js:97-115), which is guarded on `this.isNew` and
  // unconditionally calls getNextSequence(...) -- overwriting BOTH `id`
  // and `reqId` with a freshly consumed sequence value. A rollback is
  // reinstating an exact prior state, not creating a new document, and
  // `reqId` is the key linkIssueService links point at and every audit
  // row records; silently renaming the entity a rollback restores is
  // worse than the partial delete it's undoing. `Requirement.collection.
  // insertOne(...)` goes through the MongoDB driver directly, bypassing
  // Mongoose document middleware entirely, so the document comes back
  // byte-identical (same `_id`, same `reqId`, no sequence consumed).
  // testrepo.js's `new TestCase(doc.toObject()).save()` has this exact
  // same defect against TestCase's own identically-guarded pre('save')
  // hook (testRepoService/models/testrepo.js:127-136) -- tracked
  // separately, deliberately NOT fixed here (out of scope for this WP).
  const deletedIds = [];
  try {
    for (const doc of found) {
      await Requirement.findOneAndDelete({ _id: doc._id, projectId: req.projectScope.projectId });
      deletedIds.push(String(doc._id));
    }
  } catch (err) {
    for (const doc of found) {
      if (deletedIds.includes(String(doc._id))) {
        await Requirement.collection.insertOne(doc.toObject()).catch(() => {});
      }
    }
    return next(new ErrorResponse(`Bulk delete failed partway through (${deletedIds.length}/${found.length} items); all deletions rolled back: ${err.message}`, 500));
  }

  // Fix round 1 (task review, Minor but addressed alongside Fix 1): audit
  // a delete with a `before` snapshot of the document's identifying
  // fields, same shape as the other audit() call sites in this file
  // (updateRequirementStatus, deleteRequirement) and the canonical
  // testrepo.js:489-497 -- without it the audit trail says something was
  // destroyed but not what, and by the time anyone reads the trail the
  // document itself is gone.
  for (const doc of found) {
    await audit(req, {
      entityType: 'requirement',
      entityId: doc.reqId,
      action: 'bulk-delete',
      before: { reqId: doc.reqId, requirementSummary: doc.requirementSummary, status: doc.status }
    });
  }

  res.status(200).json({ success: true, policy: 'all-or-nothing', deleted: found.length });
});
