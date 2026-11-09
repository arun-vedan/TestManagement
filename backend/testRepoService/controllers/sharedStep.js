const {
  ErrorResponse,
  asyncHandler,
  createLogger,
  audit
} = require('@srckube/service-core');
const SharedStep = require('../models/SharedStep');
const TestCase = require('../models/testrepo');

const logger = createLogger('testRepoService');

// @desc      Get all shared steps
// @route     GET /api/v1/sharedstep
// @access    Private (read)
exports.getSharedSteps = asyncHandler(async (req, res, next) => {
  // advancedResults() (service-core) folds req.projectScope.projectId (set
  // by requireProjectScope(), mounted ahead of it on this route) into its
  // Mongo filter -- same contract as testrepo's getTestCases.
  res.status(200).json(res.advancedResults);
});

// @desc      Get single shared step
// @route     GET /api/v1/sharedstep/:id
// @access    Private (read)
exports.getSharedStep = asyncHandler(async (req, res, next) => {
  const sharedStep = await SharedStep.findOne({ _id: req.params.id, projectId: req.projectScope.projectId });
  if (!sharedStep) {
    return next(new ErrorResponse(`Shared step not found with id of ${req.params.id}`, 404));
  }

  res.status(200).json({
    success: true,
    data: sharedStep
  });
});

// @desc      Create a shared step
// @route     POST /api/v1/sharedstep
// @access    Private (write)
//
// projectId is stamped from the verified req.projectScope, never trusted
// from the client body -- same contract as testrepo's createTestCase.
exports.createSharedStep = asyncHandler(async (req, res, next) => {
  const user = req.kauth.grant.access_token.content;
  let reqdetails = req.body;
  reqdetails['createdBy'] = user.sub;
  reqdetails['updatedBy'] = user.sub;
  reqdetails['projectId'] = req.projectScope.projectId;
  const sharedStep = await SharedStep.create(reqdetails);

  await audit(req, {
    entityType: 'sharedstep',
    entityId: sharedStep.SharedStepId,
    action: 'create',
    after: { SharedStepId: sharedStep.SharedStepId, title: sharedStep.title }
  });

  res.status(201).json({
    success: true,
    data: sharedStep
  });
});

// @desc      Update a shared step
// @route     PUT /api/v1/sharedstep/:id
// @access    Private (write)
exports.updateSharedStep = asyncHandler(async (req, res, next) => {
  const user = req.kauth.grant.access_token.content;
  let reqdetails = req.body;
  reqdetails['updatedBy'] = user.sub;
  delete reqdetails.projectId;

  const sharedStep = await SharedStep.findOneAndUpdate(
    { _id: req.params.id, projectId: req.projectScope.projectId },
    reqdetails,
    { new: true, runValidators: true }
  );
  if (!sharedStep) {
    return next(new ErrorResponse(`Shared step not found with id of ${req.params.id}`, 404));
  }

  await audit(req, {
    entityType: 'sharedstep',
    entityId: sharedStep.SharedStepId,
    action: 'update',
    after: reqdetails
  });

  res.status(200).json({
    success: true,
    data: sharedStep
  });
});

// The single source of truth for "which test cases reference this shared
// step", used by both the usage route and the delete guard so they can
// never disagree. `TestSteps.sharedStepId` is the reference field added in
// Task 2 (moved forward one line to Task 1 -- see models/testrepo.js); a
// string _id is cast by Mongoose against the ObjectId path.
const findUsage = async (sharedStepId, projectId) => {
  const testCases = await TestCase.find(
    { projectId, 'TestSteps.sharedStepId': sharedStepId },
    'TestCaseId TestCaseSummary'
  ).lean();
  return { count: testCases.length, testCases };
};

// @desc    Which test cases reference this shared step
// @route   GET /api/v1/sharedstep/:id/usage
// @access  Private (read)
exports.getSharedStepUsage = asyncHandler(async (req, res, next) => {
  const { projectId } = req.projectScope;
  const sharedStep = await SharedStep.findOne({ _id: req.params.id, projectId });
  if (!sharedStep) {
    return next(new ErrorResponse(`Shared step not found with id of ${req.params.id}`, 404));
  }
  const usage = await findUsage(sharedStep._id, projectId);
  res.status(200).json({ success: true, data: usage });
});

// @desc    Delete a shared step
// @route   DELETE /api/v1/sharedstep/:id
// @access  Private (delete)
//
// WP-F06 R4: an in-use shared step is NOT deleted and NOT cascaded.
// Cascading would blank the steps of every referencing test case with no
// way back; deleting the document while leaving dangling references would
// make those cases render empty rows. Refusing with the usage payload lets
// the caller show exactly what is in the way.
exports.deleteSharedStep = asyncHandler(async (req, res, next) => {
  const { projectId } = req.projectScope;
  const sharedStep = await SharedStep.findOne({ _id: req.params.id, projectId });
  if (!sharedStep) {
    return next(new ErrorResponse(`Shared step not found with id of ${req.params.id}`, 404));
  }
  const usage = await findUsage(sharedStep._id, projectId);
  if (usage.count > 0) {
    // A refused delete is the one outcome here an operator may need to
    // explain later ("why can't I remove SS-3?"), and it is invisible in
    // the audit trail because nothing was deleted. audit() records what
    // happened; this records what was prevented.
    logger.info('shared step delete refused -- still referenced', {
      correlationId: req.correlationId,
      projectId,
      SharedStepId: sharedStep.SharedStepId,
      count: usage.count
    });
    return res.status(409).json({
      success: false,
      error: `${sharedStep.SharedStepId} is used by ${usage.count} test case(s) and cannot be deleted`,
      data: usage,
    });
  }
  await sharedStep.deleteOne();
  await audit(req, { entityType: 'sharedstep', entityId: sharedStep.SharedStepId, action: 'delete',
    before: { SharedStepId: sharedStep.SharedStepId, title: sharedStep.title } });
  res.status(200).json({ success: true, data: {} });
});
