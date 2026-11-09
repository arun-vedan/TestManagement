// WP-117 — every query below is scoped to req.projectScope.projectId. create
// stamps it from the verified scope, never from the request body.
const { ErrorResponse, asyncHandler } = require('@srckube/service-core');
const TestCase = require('../models/automation');
const fs = require('fs')
// @desc      Get all users
// @route     GET /api/v1/auth/users
// @access    Private/Admin
exports.getTestCases = asyncHandler(async (req, res, next) => {
  res.status(200).json(res.advancedResults);
});

// @desc      Get single user
// @route     GET /api/v1/auth/users/:id
// @access    Private/Admin
exports.getTestCase = asyncHandler(async (req, res, next) => {
  const folder = await TestCase.findOne({ _id: req.params.id, projectId: req.projectScope.projectId });

  res.status(200).json({
    success: true,
    data: folder
  });
});

// @desc      Create user
// @route     POST /api/v1/auth/users
// @access    Private/Admin
exports.createTestCase = asyncHandler(async (req, res, next) => {
  const user = req.kauth.grant.access_token.content;
  const username = user; 
  let reqdetails = req.body
  reqdetails['createdBy'] = username.sub
  reqdetails['updatedBy'] = username.sub
  const folder = await TestCase.create({ ...reqdetails, projectId: req.projectScope.projectId });

  res.status(201).json({
    success: true,
    data: folder
  });
});

// @desc      Update user
// @route     PUT /api/v1/auth/users/:id
// @access    Private/Admin
exports.updateTestCase = asyncHandler(async (req, res, next) => {
  const user = req.kauth.grant.access_token.content;
  const username = user; 
  let reqdetails = req.body
  reqdetails['updatedBy'] = username.sub
  const folder = await TestCase.findOneAndUpdate({ _id: req.params.id, projectId: req.projectScope.projectId }, reqdetails, {
    new: true,
    runValidators: true
  });

  res.status(200).json({
    success: true,
    data: folder
  });
});

// @desc      Delete user
// @route     DELETE /api/v1/auth/users/:id
// @access    Private/Admin
exports.deleteTestCase = asyncHandler(async (req, res, next) => {
  await TestCase.findOneAndDelete({ _id: req.params.id, projectId: req.projectScope.projectId });
  res.status(200).json({
    success: true,
    data: {}
  }); 
});


exports.getStepDef = asyncHandler(async (req,res,next) => {
  let foldPath = './automationFramework/src/steps'
  let fileList = fs.readdirSync(foldPath)
  let responseData = []
  for(let cFile of fileList)
  { 
    let uri = `file:///tmp/${cFile}`
    let content = fs.readFileSync(`./automationFramework/src/steps/${cFile}`).toString()
    let fileDets = {uri,content}
    responseData.push(fileDets)
  }
  res.status(200).json({
    success: true,
    data: responseData
  }); 

})