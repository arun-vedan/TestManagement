const {
  ErrorResponse,
  asyncHandler,
  audit
} = require('@srckube/service-core');
const CaseTemplate = require('../models/CaseTemplate');

// @desc      Get all case templates
// @route     GET /api/v1/casetemplate
// @access    Private (read)
exports.getCaseTemplates = asyncHandler(async (req, res, next) => {
  // advancedResults() (service-core) folds req.projectScope.projectId (set
  // by requireProjectScope(), mounted ahead of it on this route) into its
  // Mongo filter -- same contract as sharedStep's getSharedSteps.
  res.status(200).json(res.advancedResults);
});

// @desc      Get single case template
// @route     GET /api/v1/casetemplate/:id
// @access    Private (read)
exports.getCaseTemplate = asyncHandler(async (req, res, next) => {
  const caseTemplate = await CaseTemplate.findOne({ _id: req.params.id, projectId: req.projectScope.projectId });
  if (!caseTemplate) {
    return next(new ErrorResponse(`Case template not found with id of ${req.params.id}`, 404));
  }

  res.status(200).json({
    success: true,
    data: caseTemplate
  });
});

// @desc      Create a case template
// @route     POST /api/v1/casetemplate
// @access    Private (write)
//
// projectId is stamped from the verified req.projectScope, never trusted
// from the client body -- same contract as sharedStep's createSharedStep.
exports.createCaseTemplate = asyncHandler(async (req, res, next) => {
  const user = req.kauth.grant.access_token.content;
  let reqdetails = req.body;
  reqdetails['createdBy'] = user.sub;
  reqdetails['updatedBy'] = user.sub;
  reqdetails['projectId'] = req.projectScope.projectId;
  const caseTemplate = await CaseTemplate.create(reqdetails);

  await audit(req, {
    entityType: 'casetemplate',
    entityId: caseTemplate.CaseTemplateId,
    action: 'create',
    after: { CaseTemplateId: caseTemplate.CaseTemplateId, name: caseTemplate.name, moduleId: caseTemplate.moduleId }
  });

  res.status(201).json({
    success: true,
    data: caseTemplate
  });
});

// @desc      Update a case template
// @route     PUT /api/v1/casetemplate/:id
// @access    Private (write)
exports.updateCaseTemplate = asyncHandler(async (req, res, next) => {
  const user = req.kauth.grant.access_token.content;
  let reqdetails = req.body;
  reqdetails['updatedBy'] = user.sub;
  delete reqdetails.projectId;

  const caseTemplate = await CaseTemplate.findOneAndUpdate(
    { _id: req.params.id, projectId: req.projectScope.projectId },
    reqdetails,
    { new: true, runValidators: true }
  );
  if (!caseTemplate) {
    return next(new ErrorResponse(`Case template not found with id of ${req.params.id}`, 404));
  }

  await audit(req, {
    entityType: 'casetemplate',
    entityId: caseTemplate.CaseTemplateId,
    action: 'update',
    after: reqdetails
  });

  res.status(200).json({
    success: true,
    data: caseTemplate
  });
});

// @desc    Delete a case template
// @route   DELETE /api/v1/casetemplate/:id
// @access  Private (delete)
//
// WP-F08 R5: deliberately no usage query and no delete guard here, unlike
// SharedStep/Dataset in this same service. A template is a one-time-copied
// snapshot (R4) -- nothing references it after creation, so there is
// nothing a delete could leave dangling. See the header comment on
// models/CaseTemplate.js for the full reasoning; this is a decision, not
// an omission a future reviewer should "fix" by adding one.
exports.deleteCaseTemplate = asyncHandler(async (req, res, next) => {
  const { projectId } = req.projectScope;
  const caseTemplate = await CaseTemplate.findOne({ _id: req.params.id, projectId });
  if (!caseTemplate) {
    return next(new ErrorResponse(`Case template not found with id of ${req.params.id}`, 404));
  }
  await caseTemplate.deleteOne();
  await audit(req, { entityType: 'casetemplate', entityId: caseTemplate.CaseTemplateId, action: 'delete',
    before: { CaseTemplateId: caseTemplate.CaseTemplateId, name: caseTemplate.name } });
  res.status(200).json({ success: true, data: {} });
});
