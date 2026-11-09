const { ErrorResponse, asyncHandler } = require('@srckube/service-core');
const Environment = require('../models/Environment');

// WP-025 — Environment CRUD. Same tenant-scoping shape as
// defectService/testRepoService/requirementService (WP-021): every
// controller here trusts only req.projectScope.projectId (set by
// requireProjectScope(), mounted in routes/environments.js), never a
// client-supplied projectId.

// @desc      List environments (tenant-scoped via res.advancedResults)
// @route     GET /api/v1/environments
exports.getEnvironments = asyncHandler(async (req, res) => {
  res.status(200).json(res.advancedResults);
});

// @desc      Get single environment
// @route     GET /api/v1/environments/:id
exports.getEnvironment = asyncHandler(async (req, res, next) => {
  const env = await Environment.findOne({ _id: req.params.id, projectId: req.projectScope.projectId });
  if (!env) {
    return next(new ErrorResponse(`No environment found with id ${req.params.id}`, 404));
  }
  res.status(200).json({ success: true, data: env });
});

// @desc      Create environment
// @route     POST /api/v1/environments
exports.createEnvironment = asyncHandler(async (req, res, next) => {
  const user = req.kauth.grant.access_token.content;
  const payload = { ...req.body };
  payload.createdBy = user.sub;
  payload.updatedBy = user.sub;
  payload.projectId = req.projectScope.projectId;
  const env = await Environment.create(payload);
  res.status(201).json({ success: true, data: env });
});

// @desc      Update environment
// @route     PUT /api/v1/environments/:id
exports.updateEnvironment = asyncHandler(async (req, res, next) => {
  const user = req.kauth.grant.access_token.content;
  const payload = { ...req.body };
  payload.updatedBy = user.sub;
  delete payload.projectId;
  const env = await Environment.findOneAndUpdate(
    { _id: req.params.id, projectId: req.projectScope.projectId },
    payload,
    { new: true, runValidators: true }
  );
  if (!env) {
    return next(new ErrorResponse(`No environment found with id ${req.params.id}`, 404));
  }
  res.status(200).json({ success: true, data: env });
});

// @desc      Delete environment
// @route     DELETE /api/v1/environments/:id
exports.deleteEnvironment = asyncHandler(async (req, res, next) => {
  const deleted = await Environment.findOneAndDelete({ _id: req.params.id, projectId: req.projectScope.projectId });
  if (!deleted) {
    return next(new ErrorResponse(`No environment found with id ${req.params.id}`, 404));
  }
  res.status(200).json({ success: true, data: {} });
});
