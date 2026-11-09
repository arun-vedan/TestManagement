const { ErrorResponse, asyncHandler } = require('@srckube/service-core');
const IssueStatus = require('../models/IssueStatus');


// ---------------------------------------------------------------------------
// WP-116 follow-up — seed a project's defect workflow.
//
// WHY THIS ENDPOINT EXISTS. WP-116 scoped this service, which made the defect
// status vocabulary per-project — correct for tenancy, but it left a hole:
// only project 1 had any statuses, and nothing created them for a new project.
// So a brand-new project could not transition a defect at all
// (defectService's updateDefectStatus validates every transition against this
// vocabulary and finds an empty graph). That is a broken feature for every
// tenant but the first, which matters a great deal now that Phase 2 is about
// strangers signing up and creating projects.
//
// WHY IT LIVES HERE rather than in userService. This service owns the data, so
// it owns the invariant. userService calls this one idempotent endpoint on
// project creation instead of writing to another service's database or
// issuing eight creates of its own — and because the endpoint is idempotent
// and separately callable, a project that missed it (created before this
// change, or created while this service was down) can be repaired by calling
// it again, with no special-case code anywhere.
//
// WHY THE VOCABULARY IS A CONSTANT rather than copied from project 1. Copying
// would propagate whatever project 1's workflow has drifted into; a new
// tenant should get the canonical workflow. This is that workflow, recovered
// and verified against real data in WP-010 (see EXECUTION_LOG.md: `parentId`
// lists the statuses a target is reachable FROM, which was confirmed against
// the live documents rather than assumed, and getting it backwards yields a
// graph that refuses every transition).
//
// `0` is the root marker — "reachable from nothing" — not a status id, which
// is why `New` carries [0].
//
// NOTE: "Deffered" is misspelled, and deliberately preserved. It is the
// existing vocabulary in project 1 and in defectService's own tests; silently
// renaming it here would make new projects inconsistent with old ones and
// change a user-visible value. Recorded as a candidate fix instead.
const DEFAULT_DEFECT_WORKFLOW = [
  { istatus: 'New', from: [0] },
  { istatus: 'Open', from: ['New'] },
  { istatus: 'Fixed', from: ['Open', 'Re-open'] },
  { istatus: 'Rejected', from: ['Open'] },
  { istatus: 'Deffered', from: ['Open'] },
  { istatus: 'Retest', from: ['Fixed'] },
  { istatus: 'Re-open', from: ['Retest'] },
  { istatus: 'Closed', from: ['Retest'] }
];

const DEFECT_MODULE_ID = 5;

// @desc      Seed the caller's project with the default defect workflow
// @route     POST /api/v1/issuestatus/seed
// @access    Private (write)
//
// Idempotent: a project that already has any status is left untouched and
// reported as such, never topped up or duplicated.
exports.seedProjectStatuses = asyncHandler(async (req, res, next) => {
  const projectId = req.projectScope.projectId;

  const existing = await IssueStatus.countDocuments({ projectId });
  if (existing > 0) {
    return res.status(200).json({
      success: true,
      seeded: false,
      reason: `project already has ${existing} status(es)`,
      data: []
    });
  }

  // Two passes: create every status first so each has its real id, then write
  // the graph. The alternative -- resolving names to ids while creating --
  // cannot work, because Fixed is reachable from Re-open, which does not exist
  // yet at the time Fixed is created.
  const created = [];
  for (const entry of DEFAULT_DEFECT_WORKFLOW) {
    // eslint-disable-next-line no-await-in-loop
    const doc = await IssueStatus.create({
      istatus: entry.istatus,
      moduleId: DEFECT_MODULE_ID,
      projectId,
      parentId: []
    });
    created.push(doc);
  }

  const idByName = created.reduce((acc, doc) => {
    acc[doc.istatus] = doc.id;
    return acc;
  }, {});

  for (const doc of created) {
    const entry = DEFAULT_DEFECT_WORKFLOW.find((e) => e.istatus === doc.istatus);
    doc.parentId = entry.from.map((f) => (f === 0 ? 0 : idByName[f]));
    // eslint-disable-next-line no-await-in-loop
    await doc.save();
  }

  res.status(201).json({
    success: true,
    seeded: true,
    data: created.map((d) => ({ id: d.id, istatus: d.istatus, parentId: d.parentId }))
  });
});

// @desc      Get all statuses
// @route     GET /api/v1/issuestatus
// @access    Private
exports.getIssueStatuses = asyncHandler(async (req, res, next) => {
  res.status(200).json(res.advancedResults);
});

// @desc      Get single status
// @route     GET /api/v1/issuestatus/:id
// @access    Private
exports.getIssueStatus = asyncHandler(async (req, res, next) => {
  // WP-116: scoped lookup — a status in another project reads as not found.
  const status = await IssueStatus.findOne({ _id: req.params.id, projectId: req.projectScope.projectId });

  res.status(200).json({
    success: true,
    data: status
  });
});

// @desc      Create status
// @route     POST /api/v1/issuestatus
// @access    Private
exports.createIssueStatus = asyncHandler(async (req, res, next) => {
  // WP-116: projectId stamped from the verified scope, never from the body.
  const status = await IssueStatus.create({ ...req.body, projectId: req.projectScope.projectId });

  res.status(201).json({
    success: true,
    data: status
  });
});

// @desc      Update status
// @route     PUT /api/v1/issuestatus/:id
// @access    Private
exports.updateIssueStatus = asyncHandler(async (req, res, next) => {
  // WP-116: scoped, and projectId stripped so an update cannot move a status
  // between tenants.
  const { projectId, ...updates } = req.body;
  const status = await IssueStatus.findOneAndUpdate({ _id: req.params.id, projectId: req.projectScope.projectId }, updates, {
    new: true,
    runValidators: true
  });

  res.status(200).json({
    success: true,
    data: status
  });
});

// @desc      Delete status
// @route     DELETE /api/v1/issuestatus/:id
// @access    Private
exports.deleteIssueStatus = asyncHandler(async (req, res, next) => {
  // WP-116: scoped delete.
  await IssueStatus.findOneAndDelete({ _id: req.params.id, projectId: req.projectScope.projectId });
  res.status(200).json({
    success: true,
    data: {}
  });
});
