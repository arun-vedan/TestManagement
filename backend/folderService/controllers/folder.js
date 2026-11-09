const { ErrorResponse, asyncHandler } = require('@srckube/service-core');
const Folder = require('../models/Folder');

// WP-113 — every query below is scoped to req.projectScope.projectId.
//
// Before this WP the model had a `required` projectId that NO controller
// referenced: create took it from req.body unverified, and no read filtered on
// it. The field implied a tenant guarantee the code never made.
//
// The doc comments on these handlers used to read "Get all users" /
// "/api/v1/auth/users" -- copy-paste from a user-service template. Corrected
// on the handlers touched here rather than left to mislead the next reader.

// @desc      Get all folders in the caller's project
// @route     GET /api/v1/folders
// @access    Private (read)
exports.getFolders = asyncHandler(async (req, res, next) => {
  // advancedResults() folds req.projectScope.projectId into the filter (and,
  // since WP-102, into the pagination count too), so the tenant filter is
  // applied before this handler runs.
  res.status(200).json(res.advancedResults);
});

// @desc      Get a single folder
// @route     GET /api/v1/folders/:id
// @access    Private (read)
exports.getFolder = asyncHandler(async (req, res, next) => {
  // Scoped lookup: a folder in another project reads as not found rather than
  // being returned.
  const folder = await Folder.findOne({ _id: req.params.id, projectId: req.projectScope.projectId });

  res.status(200).json({
    success: true,
    data: folder
  });
});

// WP-113 — a folder's parent must live in the SAME project.
//
// parentFolder is a plain Number, so without this a client could graft a
// folder onto a parent in another tenant. Nothing would visibly break at write
// time: the child would simply appear in a tree whose parent the caller cannot
// see, leaving a dangling node that is hard to explain and harder to fix. 0
// means "root", which is how every top-level folder is stored.
async function assertParentInProject(req, next) {
  const parent = req.body.parentFolder;
  if (parent === undefined || parent === null || Number(parent) === 0) {
    return true;
  }
  const exists = await Folder.exists({ id: Number(parent), projectId: req.projectScope.projectId });
  if (!exists) {
    next(new ErrorResponse(`Parent folder '${parent}' does not exist in this project`, 400));
    return false;
  }
  return true;
}

// @desc      Create a folder in the caller's project
// @route     POST /api/v1/folders
// @access    Private (write)
exports.createFolder = asyncHandler(async (req, res, next) => {
  if (!(await assertParentInProject(req, next))) {
    return undefined;
  }

  // projectId stamped from the verified scope, never trusted from the body --
  // the same rule testRepoService's createTestCase follows.
  const folder = await Folder.create({ ...req.body, projectId: req.projectScope.projectId });

  return res.status(201).json({
    success: true,
    data: folder
  });
});

// @desc      Update a folder
// @route     PUT /api/v1/folders/:id
// @access    Private (write)
exports.updateFolder = asyncHandler(async (req, res, next) => {
  if (!(await assertParentInProject(req, next))) {
    return undefined;
  }

  // projectId is stripped from the payload: an update must never be able to
  // move a folder into another tenant.
  const { projectId, ...updates } = req.body;
  const folder = await Folder.findOneAndUpdate(
    { _id: req.params.id, projectId: req.projectScope.projectId },
    updates,
    { new: true, runValidators: true }
  );

  return res.status(200).json({
    success: true,
    data: folder
  });
});

// @desc      Update a folder by its numeric business id
// @route     PUT /api/v1/folders/updatebyparam/:id
// @access    Private (write)
exports.updateFolderByParam = asyncHandler(async (req, res, next) => {
  if (!(await assertParentInProject(req, next))) {
    return undefined;
  }

  const { projectId, ...updates } = req.body;
  const folder = await Folder.findOneAndUpdate(
    { id: parseInt(req.params.id, 10), projectId: req.projectScope.projectId },
    updates,
    { new: true, runValidators: true }
  );

  return res.status(200).json({
    success: true,
    data: folder
  });
});

// @desc      Delete a folder
// @route     DELETE /api/v1/folders/:id
// @access    Private (delete)
exports.deleteFolder = asyncHandler(async (req, res, next) => {
  await Folder.findOneAndDelete({ _id: req.params.id, projectId: req.projectScope.projectId });
  res.status(200).json({
    success: true,
    data: {}
  });
});
