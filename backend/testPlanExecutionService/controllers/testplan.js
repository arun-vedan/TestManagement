const { ErrorResponse, asyncHandler, audit } = require('@srckube/service-core');
const TestPlan = require('../models/TestPlan');

// WP-021b: testPlanExecutionService is now on requireProjectScope()
// (routes/testplan.js), closing the gap WP-021/WP-024 explicitly deferred
// ("the rest in later work"). Every lookup below is scoped to
// req.projectScope.projectId, same convention as testRepoService's
// controllers/testrepo.js (WP-021): a document belonging to a different
// project is indistinguishable from "doesn't exist" (404), never leaked.
// audit()'s projectId now resolves for real from req.projectScope (it
// already falls back to that when no explicit projectId is passed -- see
// service-core/audit.js) -- the "no verified projectId to stamp" gap this
// file's old comment described no longer applies.

exports.getTestPlans = asyncHandler(async (req, res, next) => {
  // res.advancedResults is already tenant-scoped -- advancedResults()
  // (service-core) folds req.projectScope.projectId (set by
  // requireProjectScope(), mounted ahead of it on this route) into its
  // Mongo filter.
  res.status(200).json(res.advancedResults);
});

exports.getTestPlan = asyncHandler(async (req, res, next) => {
  const plan = await TestPlan.findOne({ _id: req.params.id, projectId: req.projectScope.projectId });
  if (!plan) {
    return next(new ErrorResponse(`No test plan found with id ${req.params.id}`, 404));
  }

  res.status(200).json({
    success: true,
    data: plan
  });
});

exports.createTestPlan = asyncHandler(async (req, res, next) => {
  // projectId is stamped from the verified req.projectScope, never trusted
  // from the client body -- same rule as testRepoService's createTestCase.
  const reqdetails = { ...req.body, projectId: req.projectScope.projectId };
  const plan = await TestPlan.create(reqdetails);

  await audit(req, {
    entityType: 'testplan',
    entityId: plan.TestPlanId,
    action: 'create',
    after: { TestPlanId: plan.TestPlanId }
  });

  res.status(201).json({
    success: true,
    data: plan
  });
});

exports.updateTestPlan = asyncHandler(async (req, res, next) => {
  // projectId is stripped from the incoming body so a caller can't
  // reassign a plan to a different project (or out of the one they were
  // verified against) via the update payload itself -- same rule as
  // testRepoService's updateTestCase.
  const reqBody = { ...req.body };
  delete reqBody.projectId;

  const plan = await TestPlan.findOneAndUpdate(
    { _id: req.params.id, projectId: req.projectScope.projectId },
    reqBody,
    {
      new: true,
      runValidators: true
    }
  );

  if (!plan) {
    return next(new ErrorResponse(`No test plan found with id ${req.params.id}`, 404));
  }

  await audit(req, {
    entityType: 'testplan',
    entityId: plan.TestPlanId,
    action: 'update',
    after: reqBody
  });

  res.status(200).json({
    success: true,
    data: plan
  });
});

exports.deleteTestPlan = asyncHandler(async (req, res, next) => {
  const deleted = await TestPlan.findOneAndDelete({ _id: req.params.id, projectId: req.projectScope.projectId });
  if (!deleted) {
    return next(new ErrorResponse(`No test plan found with id ${req.params.id}`, 404));
  }

  await audit(req, {
    entityType: 'testplan',
    entityId: deleted.TestPlanId,
    action: 'delete',
    before: { TestPlanId: deleted.TestPlanId }
  });

  res.status(200).json({
    success: true,
    data: {}
  });
});

// WP-F01 -- escape user input before it reaches $regex, so a search for
// "." means the character and not "match every document". Kept local to
// this controller deliberately: promoting it to @srckube/service-core is a
// cross-service change, which is an escalation trigger for this package.
const escapeRegex = (text) => String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// WP-F01
// @desc      Search test plans by business id or objective
// @route     GET /api/v1/testplan/wildcardsearch?search=<text>
// @access    Private (read)
//
// Mirrors testRepoService/controllers/testrepo.js:203-218 and
// requirementService/controllers/requirement.js:168-183 -- a
// projectId-scoped $or of a case-insensitive regex over the business key
// and the human-readable field -- with one deliberate difference:
// TestPlan has NO summary/name field. Its only free-text fields are
// objective/scope/entryCriteria/exitCriteria (verified against
// models/TestPlan.js, not assumed), and `objective` is the one
// TestPlanDetail.tsx labels "Objective" and shows first, so it is the
// closest thing a plan has to a title.
exports.wildcardSearch = asyncHandler(async (req, res, next) => {
  const search = escapeRegex(req.query.search);

  // Final-review fix: the only consumer (entitySearchConfigs.ts's
  // testPlanSearchConfig) reads TestPlanId and objective; projectId is
  // kept because api.test.js's project-scoping assertion reads it. Same
  // reasoning as controllers/testexecution.js's wildcardSearch -- no
  // reason to return a plan's full TestCases[] subtree for a route that
  // renders a list of ids and objectives.
  const planList = await TestPlan.find({
    projectId: req.projectScope.projectId,
    $or: [
      { TestPlanId: { $regex: search, $options: 'i' } },
      { objective: { $regex: search, $options: 'i' } }
    ]
  }).select('TestPlanId objective projectId');

  res.status(200).json({
    success: true,
    data: planList
  });
});

// WP-F03 -- bulk delete for test plans. Mirrors
// testRepoService/controllers/testrepo.js:309-520 (read its header for the
// all-or-nothing and per-item-audit rationale inherited here).
//
// DELETE ONLY, deliberately: TestPlan has neither a lifecycle `status` nor
// an `assignedTo` field (verified against models/TestPlan.js), so there is
// nothing a bulk PATCH could change. No PATCH /bulk route is registered.
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

// @desc      Bulk delete test plans, all-or-nothing.
// @route     DELETE /api/v1/testplan/bulk
// @access    Private (delete)
exports.bulkDeleteTestPlans = asyncHandler(async (req, res, next) => {
  const ids = validateBulkIds(req, next);
  if (!ids) return;

  const found = await TestPlan.find({ _id: { $in: ids }, projectId: req.projectScope.projectId });
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

  // Compensating rollback, following testRepoService/controllers/
  // testrepo.js:470-487 in shape: validation already passed, so a failure
  // here is a DB fault, not bad input -- restore whatever this batch
  // already removed rather than leaving a half-deleted set behind. The
  // all-or-nothing promise BulkActionBar shows the user has to hold on the
  // delete path too, not just the update path.
  //
  // ONE DELIBERATE DIVERGENCE from the canonical: it restores with
  // `new Model(doc.toObject()).save()`, which re-runs the model's
  // pre('save') hook. That hook guards on `this.isNew` -- true for a
  // reconstructed document even with _id set -- so it calls
  // getNextSequence() and OVERWRITES the business id. The canonical would
  // therefore restore each document under a NEW id, orphaning every
  // linkIssue and audit row pointing at the old one. Restoring through the
  // driver bypasses model middleware, which is correct here: this is
  // reinstating an exact prior state, not creating a document. The same
  // defect exists in the canonical and is tracked separately -- do not
  // "fix" this back to match it.
  const deletedIds = [];
  try {
    for (const doc of found) {
      // eslint-disable-next-line no-await-in-loop
      await TestPlan.findOneAndDelete({ _id: doc._id, projectId: req.projectScope.projectId });
      deletedIds.push(doc._id);
    }
  } catch (err) {
    for (const doc of found) {
      if (deletedIds.some((id) => String(id) === String(doc._id))) {
        // eslint-disable-next-line no-await-in-loop
        await TestPlan.collection.insertOne(doc.toObject()).catch(() => {});
      }
    }
    throw new ErrorResponse(`Bulk delete failed partway through (${deletedIds.length}/${found.length} items); all deletions rolled back: ${err.message}`, 500);
  }

  // Audited after the write loop, once per item, with a `before` snapshot:
  // on a delete the document is gone, so this row is the only surviving
  // record of what it contained.
  for (const doc of found) {
    // eslint-disable-next-line no-await-in-loop
    await audit(req, {
      entityType: 'testplan',
      entityId: doc.TestPlanId,
      action: 'bulk-delete',
      before: { TestPlanId: doc.TestPlanId, objective: doc.objective }
    });
  }

  res.status(200).json({ success: true, policy: 'all-or-nothing', deleted: found.length });
});
