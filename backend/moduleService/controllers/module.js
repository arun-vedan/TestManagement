const { ErrorResponse, asyncHandler } = require('@srckube/service-core');
const Module = require('../models/Module');

// WP-114 — every query below is scoped to req.projectScope.projectId.
//
// WHAT THIS ACTUALLY CLOSES. moduleService is a writable CRUD surface and
// nothing in the product reads it (the module taxonomy is compiled into
// frontend/src/workbench/modules.ts and hardcoded in
// linkIssueService/controllers/linkIssue.js). So the exposure was not a read
// leak but a WRITE one: any authenticated user could rename or delete the
// global `testcaserepo`/`requirementrepo` rows for everybody, cross-tenant.
//
// The doc comments here used to read "Get all users" / "/api/v1/auth/users" --
// copy-paste from a user-service template, the same way folderService's did.
// Corrected rather than left to mislead.

// @desc      Get all modules in the caller's project
// @route     GET /api/v1/modules
// @access    Private (read)
exports.getModules = asyncHandler(async (req, res, next) => {
  // advancedResults() folds req.projectScope.projectId into the filter, and
  // since WP-102 into the pagination count too.
  res.status(200).json(res.advancedResults);
});

// @desc      Get a single module
// @route     GET /api/v1/modules/:id
// @access    Private (read)
exports.getModule = asyncHandler(async (req, res, next) => {
  // Scoped lookup: a module in another project reads as not found.
  const module = await Module.findOne({ _id: req.params.id, projectId: req.projectScope.projectId });

  res.status(200).json({
    success: true,
    data: module
  });
});

// @desc      Create a module in the caller's project
// @route     POST /api/v1/modules
// @access    Private (write)
exports.createModule = asyncHandler(async (req, res, next) => {
  // projectId stamped from the verified scope, never trusted from the body.
  const module = await Module.create({ ...req.body, projectId: req.projectScope.projectId });

  res.status(201).json({
    success: true,
    data: module
  });
});

// @desc      Update a module
// @route     PUT /api/v1/modules/:id
// @access    Private (write)
exports.updateModule = asyncHandler(async (req, res, next) => {
  // projectId stripped from the payload: an update must never move a module
  // into another tenant.
  const { projectId, ...updates } = req.body;
  const module = await Module.findOneAndUpdate(
    { _id: req.params.id, projectId: req.projectScope.projectId },
    updates,
    { new: true, runValidators: true }
  );

  res.status(200).json({
    success: true,
    data: module
  });
});

// @desc      Delete a module
// @route     DELETE /api/v1/modules/:id
// @access    Private (delete)
exports.deleteModule = asyncHandler(async (req, res, next) => {
  await Module.findOneAndDelete({ _id: req.params.id, projectId: req.projectScope.projectId });
  res.status(200).json({
    success: true,
    data: {}
  });
});
