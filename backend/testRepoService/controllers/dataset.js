const {
  ErrorResponse,
  asyncHandler,
  createLogger,
  audit
} = require('@srckube/service-core');
const Dataset = require('../models/Dataset');
const TestCase = require('../models/testrepo');

const logger = createLogger('testRepoService');

// @desc      Get all datasets
// @route     GET /api/v1/dataset
// @access    Private (read)
exports.getDatasets = asyncHandler(async (req, res, next) => {
  // advancedResults() (service-core) folds req.projectScope.projectId (set
  // by requireProjectScope(), mounted ahead of it on this route) into its
  // Mongo filter -- same contract as testrepo's getTestCases.
  res.status(200).json(res.advancedResults);
});

// @desc      Get single dataset
// @route     GET /api/v1/dataset/:id
// @access    Private (read)
exports.getDataset = asyncHandler(async (req, res, next) => {
  const dataset = await Dataset.findOne({ _id: req.params.id, projectId: req.projectScope.projectId });
  if (!dataset) {
    return next(new ErrorResponse(`Dataset not found with id of ${req.params.id}`, 404));
  }

  res.status(200).json({
    success: true,
    data: dataset
  });
});

// @desc      Create a dataset
// @route     POST /api/v1/dataset
// @access    Private (write)
//
// projectId is stamped from the verified req.projectScope, never trusted
// from the client body -- same contract as testrepo's createTestCase.
exports.createDataset = asyncHandler(async (req, res, next) => {
  const user = req.kauth.grant.access_token.content;
  let reqdetails = req.body;
  reqdetails['createdBy'] = user.sub;
  reqdetails['updatedBy'] = user.sub;
  reqdetails['projectId'] = req.projectScope.projectId;
  const dataset = await Dataset.create(reqdetails);

  await audit(req, {
    entityType: 'dataset',
    entityId: dataset.DatasetId,
    action: 'create',
    after: { DatasetId: dataset.DatasetId, title: dataset.title }
  });

  res.status(201).json({
    success: true,
    data: dataset
  });
});

// @desc      Update a dataset
// @route     PUT /api/v1/dataset/:id
// @access    Private (write)
exports.updateDataset = asyncHandler(async (req, res, next) => {
  const user = req.kauth.grant.access_token.content;
  let reqdetails = req.body;
  reqdetails['updatedBy'] = user.sub;
  delete reqdetails.projectId;

  const dataset = await Dataset.findOneAndUpdate(
    { _id: req.params.id, projectId: req.projectScope.projectId },
    reqdetails,
    { new: true, runValidators: true }
  );
  if (!dataset) {
    return next(new ErrorResponse(`Dataset not found with id of ${req.params.id}`, 404));
  }

  await audit(req, {
    entityType: 'dataset',
    entityId: dataset.DatasetId,
    action: 'update',
    after: reqdetails
  });

  res.status(200).json({
    success: true,
    data: dataset
  });
});

// The single source of truth for "which test cases reference this
// dataset", used by both the usage route and the delete guard so they can
// never disagree. `TestCaseRepo.datasetId` is the reference field added in
// Task 1 (moved forward from Task 2 -- see models/testrepo.js); a string
// _id is cast by Mongoose against the ObjectId path.
const findUsage = async (datasetId, projectId) => {
  const testCases = await TestCase.find(
    { projectId, datasetId },
    'TestCaseId TestCaseSummary'
  ).lean();
  return { count: testCases.length, testCases };
};

// @desc    Which test cases reference this dataset
// @route   GET /api/v1/dataset/:id/usage
// @access  Private (read)
exports.getDatasetUsage = asyncHandler(async (req, res, next) => {
  const { projectId } = req.projectScope;
  const dataset = await Dataset.findOne({ _id: req.params.id, projectId });
  if (!dataset) {
    return next(new ErrorResponse(`Dataset not found with id of ${req.params.id}`, 404));
  }
  const usage = await findUsage(dataset._id, projectId);
  res.status(200).json({ success: true, data: usage });
});

// @desc    Delete a dataset
// @route   DELETE /api/v1/dataset/:id
// @access  Private (delete)
//
// WP-F07a: an in-use dataset is NOT deleted and NOT cascaded. Cascading
// would unbind every referencing test case with no way back; deleting the
// document while leaving dangling references would make those cases fail
// to resolve their placeholders at run time. Refusing with the usage
// payload lets the caller show exactly what is in the way.
exports.deleteDataset = asyncHandler(async (req, res, next) => {
  const { projectId } = req.projectScope;
  const dataset = await Dataset.findOne({ _id: req.params.id, projectId });
  if (!dataset) {
    return next(new ErrorResponse(`Dataset not found with id of ${req.params.id}`, 404));
  }
  const usage = await findUsage(dataset._id, projectId);
  if (usage.count > 0) {
    // A refused delete is the one outcome here an operator may need to
    // explain later ("why can't I remove DS-3?"), and it is invisible in
    // the audit trail because nothing was deleted. audit() records what
    // happened; this records what was prevented.
    logger.info('dataset delete refused -- still referenced', {
      correlationId: req.correlationId,
      projectId,
      DatasetId: dataset.DatasetId,
      count: usage.count
    });
    return res.status(409).json({
      success: false,
      error: `${dataset.DatasetId} is used by ${usage.count} test case(s) and cannot be deleted`,
      data: usage,
    });
  }
  await dataset.deleteOne();
  await audit(req, { entityType: 'dataset', entityId: dataset.DatasetId, action: 'delete',
    before: { DatasetId: dataset.DatasetId, title: dataset.title } });
  res.status(200).json({ success: true, data: {} });
});
