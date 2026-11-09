const { ErrorResponse, asyncHandler } = require('@srckube/service-core');
const Folder = require('../models/field');

// @desc      Get all fields (tenant-scoped via advancedResults + req.projectScope)
// @route     GET /api/v1/fields
// @access    Private (read)
exports.getFields = asyncHandler(async (req, res, next) => {
  res.status(200).json(res.advancedResults);
});

// Wave A-1 -- findById -> findOne({_id, projectId}), mirroring
// requirementService/controllers/requirement.js's getRequirement /
// updateRequirement / deleteRequirement (the reference pattern named in
// this WP's brief). A field belonging to a different project must 404
// exactly like a nonexistent id -- never a distinguishable 403/leak of
// "this id exists, just not for you".
// @desc      Get single field, scoped to the requesting project
// @route     GET /api/v1/fields/:id
// @access    Private (read)
exports.getField = asyncHandler(async (req, res, next) => {
  const folder = await Folder.findOne({ _id: req.params.id, projectId: req.projectScope.projectId });

  if (!folder) {
    return next(new ErrorResponse(`No field found with id ${req.params.id}`, 404));
  }

  res.status(200).json({
    success: true,
    data: folder
  });
});

// Wave A-1 -- projectId is stamped from the verified req.projectScope, never
// trusted from the client body (a caller could otherwise write a foreign
// projectId into req.body and create a field under another tenant).
// @desc      Create field, stamped with the requesting project
// @route     POST /api/v1/fields
// @access    Private (write)
exports.createField = asyncHandler(async (req, res, next) => {
  const fieldDetails = { ...req.body, projectId: req.projectScope.projectId };
  const folder = await Folder.create(fieldDetails);

  res.status(201).json({
    success: true,
    data: folder
  });
});

// Wave A-1 -- findByIdAndUpdate -> findOneAndUpdate({_id, projectId});
// projectId is also stripped from the update payload so a request cannot
// reassign a field to a different project after the fact.
// @desc      Update field, scoped to the requesting project
// @route     PUT /api/v1/fields/:id
// @access    Private (write)
exports.updateField = asyncHandler(async (req, res, next) => {
  const fieldDetails = { ...req.body };
  delete fieldDetails.projectId;

  const folder = await Folder.findOneAndUpdate(
    { _id: req.params.id, projectId: req.projectScope.projectId },
    fieldDetails,
    {
      new: true,
      runValidators: true
    }
  );

  if (!folder) {
    return next(new ErrorResponse(`No field found with id ${req.params.id}`, 404));
  }

  res.status(200).json({
    success: true,
    data: folder
  });
});

// Wave A-1 -- findByIdAndDelete -> findOneAndDelete({_id, projectId}).
// @desc      Delete field, scoped to the requesting project
// @route     DELETE /api/v1/fields/:id
// @access    Private (delete)
exports.deleteField = asyncHandler(async (req, res, next) => {
  const deleted = await Folder.findOneAndDelete({ _id: req.params.id, projectId: req.projectScope.projectId });

  if (!deleted) {
    return next(new ErrorResponse(`No field found with id ${req.params.id}`, 404));
  }

  res.status(200).json({
    success: true,
    data: {}
  });
});
