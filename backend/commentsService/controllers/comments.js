const { ErrorResponse, asyncHandler } = require('@srckube/service-core');
const Comments = require('../models/Comments');


// WP-115 — every query below is scoped to req.projectScope.projectId.
//
// The stale "Get all users" / "/api/v1/auth/users" doc comments were
// copy-paste from a user-service template, the same way folderService's and
// moduleService's were. Corrected rather than left to mislead.

// @desc      Get the comments in the caller's project
// @route     GET /api/v1/comments
// @access    Private (read)
exports.getComments = asyncHandler(async (req, res, next) => {
  // The tenant filter is applied by this service's LOCAL advancedResults
  // (middleware/advancedResults.js), which WP-115 taught to fold in
  // req.projectScope.projectId — it had missed the WP-021 addition that
  // service-core's copy got.
  res.status(200).json(res.advancedResults);
})

// @desc      Get a single comment
// @route     GET /api/v1/comments/:id
// @access    Private (read)
exports.getComment = asyncHandler(async (req, res, next) => {
  // Scoped lookup: a comment in another project reads as not found.
  const comment = await Comments.findOne({ _id: req.params.id, projectId: req.projectScope.projectId });

  res.status(200).json({
    success: true,
    data: comment
  });
});

// @desc      Create a comment in the caller's project
// @route     POST /api/v1/comments
// @access    Private (write)
exports.createComments = asyncHandler(async (req, res, next) => {
  const user = req.kauth.grant.access_token.content;
  const username = user; 
  let reqdetails = req.body
  reqdetails['createdByName'] = username.name
  reqdetails['updatedByName'] = username.name
  reqdetails['createdBy'] = username.sub
  reqdetails['updatedBy'] = username.sub
  reqdetails['isEdited'] = 0
  reqdetails['status'] = 1
  // projectId stamped from the verified scope, never trusted from the body.
  reqdetails['projectId'] = req.projectScope.projectId
  const comments = await Comments.create(reqdetails);

  res.status(201).json({
    success: true,
    data: comments
  });
});

// @desc      Update user
// @route     PUT /api/v1/auth/users/:id
// @access    Private/Admin
// exports.updateComments = asyncHandler(async (req, res, next) => {
//   const user = req.kauth.grant.access_token.content;
//   const username = user; 
//   let reqdetails = req.body
//   reqdetails['updatedBy'] = username.sub
//   const folder = await Comments.findByIdAndUpdate(req.params.id, reqdetails, {
//     new: true,
//     runValidators: true,
   
//   });

//   res.status(200).json({
//     success: true,
//     data: folder
//   });
// });

exports.updateCommentsByParam = asyncHandler(async(req,res,next)=>{
  const user = req.kauth.grant.access_token.content;
  let username = user;
  let reqdetails = req.body;
  reqdetails['updatedByName'] = username.name
  reqdetails['updatedBy'] = username.sub
  reqdetails['isEdited'] = 1;
  reqdetails['status'] = 1
  // WP-115: an update must not be able to move a comment between tenants.
  delete reqdetails.projectId
  const comments = await Comments.findOneAndUpdate({'_id': req.query.id, projectId: req.projectScope.projectId}, reqdetails, {
    new: true,
    runValidators: true
  });

  res.status(200).json({
    success: true,
    data: comments
  });
})

//updating the comment status to 0 to make inactive. soft delete
exports.deleteComment = asyncHandler(async(req,res,next)=>{
  const user = req.kauth.grant.access_token.content;
  let username = user;
  let reqdetails = req.body;
  reqdetails['updatedByName'] = username.name;
  reqdetails['updatedBy'] = username.sub;
  reqdetails['status'] = 0;
  reqdetails['updatedAt'] = new Date().toLocaleString();
  delete reqdetails.projectId
  const comments = await Comments.findOneAndUpdate({'_id': req.query.id, projectId: req.projectScope.projectId}, reqdetails, {
    new: true,
    runValidators: true
  });

  res.status(200).json({
    success: true,
    //data: comments
  });
})






// UNROUTED, but correct. Kept deliberately -- see below.
//
// CORRECTION (2026-10-18): this comment used to say the handler "references
// `Requirement`, which this file never imports -- so calling it would throw a
// ReferenceError, not delete anything", and EXECUTION_LOG.md's WP-115 entry
// recorded that as a candidate fix. That is no longer true: it deletes from
// `Comments`, which IS imported, and it is scoped on
// req.projectScope.projectId. The note outlived the code it described and
// would have sent the next reader hunting a bug that is not there.
//
// What remains true: routes/comments.js mounts no hard delete, so nothing
// reaches this. It is left in place rather than removed because it is a
// correct, scoped handler -- unlike the wildcardSearch handler deleted in
// 914ecc8, which interpolated an unescaped regex with no limit and was one
// uncommented line from being a live hazard. There is nothing to defuse here;
// routing it would simply work.
exports.deleteComments = asyncHandler(async (req, res, next) => {
  await Comments.findOneAndDelete({ _id: req.params.id, projectId: req.projectScope.projectId });
  res.status(200).json({
    success: true,
    data: {}
  }); 
});
