const {
  ErrorResponse,
  asyncHandler,
  requestWithRetry,
  CORRELATION_HEADER,
  createLogger
} = require('@srckube/service-core');
const Release = require('../models/Release');

const logger = createLogger('releaseService');

// Cross-service dependencies, reached by container name over the Docker
// network (never localhost — see backend/docker-compose.yml's releaseservice
// block), same "env var named after the target service" convention as
// defectService -> istatusService / every service -> userService (WP-021).
const TEST_PLAN_EXECUTION_SERVICE = process.env.testPlanExecutionService;
const DEFECT_SERVICE = process.env.defectService;
const ISTATUS_SERVICE = process.env.istatusService;

// -----------------------------------------------------------------------
// Plain CRUD
// -----------------------------------------------------------------------

// @desc      List releases (tenant-scoped via res.advancedResults)
// @route     GET /api/v1/releases
exports.getReleases = asyncHandler(async (req, res) => {
  res.status(200).json(res.advancedResults);
});

// @desc      Get single release
// @route     GET /api/v1/releases/:id
exports.getRelease = asyncHandler(async (req, res, next) => {
  const release = await Release.findOne({ _id: req.params.id, projectId: req.projectScope.projectId });
  if (!release) {
    return next(new ErrorResponse(`No release found with id ${req.params.id}`, 404));
  }
  res.status(200).json({ success: true, data: release });
});

// @desc      Create release
// @route     POST /api/v1/releases
exports.createRelease = asyncHandler(async (req, res, next) => {
  const user = req.kauth.grant.access_token.content;
  const payload = { ...req.body };
  payload.createdBy = user.sub;
  payload.updatedBy = user.sub;
  payload.projectId = req.projectScope.projectId;
  const release = await Release.create(payload);
  res.status(201).json({ success: true, data: release });
});

// @desc      Update release (name/targetDate/status/notes/qualityGates —
//            linkedTestPlanIds is also accepted here for a full replace,
//            but see the dedicated /:id/plans endpoints below for
//            add/remove-one, which is what the UI's "link plan" action uses)
// @route     PUT /api/v1/releases/:id
exports.updateRelease = asyncHandler(async (req, res, next) => {
  const user = req.kauth.grant.access_token.content;
  const payload = { ...req.body };
  payload.updatedBy = user.sub;
  delete payload.projectId;
  delete payload.id;
  delete payload.releaseId;
  const release = await Release.findOneAndUpdate(
    { _id: req.params.id, projectId: req.projectScope.projectId },
    payload,
    { new: true, runValidators: true }
  );
  if (!release) {
    return next(new ErrorResponse(`No release found with id ${req.params.id}`, 404));
  }
  res.status(200).json({ success: true, data: release });
});

// @desc      Delete release
// @route     DELETE /api/v1/releases/:id
exports.deleteRelease = asyncHandler(async (req, res, next) => {
  const deleted = await Release.findOneAndDelete({ _id: req.params.id, projectId: req.projectScope.projectId });
  if (!deleted) {
    return next(new ErrorResponse(`No release found with id ${req.params.id}`, 404));
  }
  res.status(200).json({ success: true, data: {} });
});

// @desc      Link a TestPlan to a release (idempotent add)
// @route     POST /api/v1/releases/:id/plans
// @body      { testPlanId: '<TestPlan Mongo _id>' }
exports.linkTestPlan = asyncHandler(async (req, res, next) => {
  const { testPlanId } = req.body;
  if (!testPlanId) {
    return next(new ErrorResponse('testPlanId is required', 400));
  }
  const release = await Release.findOne({ _id: req.params.id, projectId: req.projectScope.projectId });
  if (!release) {
    return next(new ErrorResponse(`No release found with id ${req.params.id}`, 404));
  }
  if (!release.linkedTestPlanIds.includes(testPlanId)) {
    release.linkedTestPlanIds.push(testPlanId);
    release.updatedBy = req.kauth.grant.access_token.content.sub;
    await release.save();
  }
  res.status(200).json({ success: true, data: release });
});

// @desc      Unlink a TestPlan from a release
// @route     DELETE /api/v1/releases/:id/plans/:testPlanId
exports.unlinkTestPlan = asyncHandler(async (req, res, next) => {
  const release = await Release.findOne({ _id: req.params.id, projectId: req.projectScope.projectId });
  if (!release) {
    return next(new ErrorResponse(`No release found with id ${req.params.id}`, 404));
  }
  release.linkedTestPlanIds = release.linkedTestPlanIds.filter((id) => id !== req.params.testPlanId);
  release.updatedBy = req.kauth.grant.access_token.content.sub;
  await release.save();
  res.status(200).json({ success: true, data: release });
});

// -----------------------------------------------------------------------
// Quality gate evaluation
// -----------------------------------------------------------------------

// istatusservice's `parentId` graph (see defectService/controllers/
// defects.js#updateDefectStatus for the fuller explanation of that shape:
// parentId lists *predecessor* status ids, not successors) lets us compute
// which statuses are terminal/dead-ends — no other status names them as a
// predecessor — without hardcoding status names. Verified against the live
// graph (EXECUTION_LOG.md, WP-010): New->Open->{Fixed,Rejected,Deffered},
// Fixed->Retest->{Re-open,Closed}, Re-open->Fixed. Rejected/Deffered/Closed
// have no outgoing edges, i.e. no other status lists them in its parentId —
// those are exactly "resolved, nothing left to do" states, which is the
// working definition of "not open" used below. Computed fresh on every gate
// evaluation (not cached) since it's cheap (8 rows) and the whole point of
// this endpoint is live data.
function computeTerminalStatusIds(statusList) {
  const referenced = new Set();
  statusList.forEach((s) => (s.parentId || []).forEach((p) => referenced.add(p)));
  return new Set(statusList.filter((s) => !referenced.has(s.id)).map((s) => s.id));
}

// defectService's `Status` field is inconsistent across its history (see
// EXECUTION_LOG.md's WP-025 survey): some documents store the istatus
// numeric id (as a Number OR as a String, e.g. 1, '8'), others store the
// istatus name (e.g. 'New') written by the dedicated status-transition
// endpoint (WP-010). Resolve either representation to an istatus id so
// terminal-status membership can be checked uniformly.
function resolveStatusId(rawStatus, statusList) {
  if (rawStatus === undefined || rawStatus === null || rawStatus === '') {
    return null;
  }
  const asNumber = Number(rawStatus);
  if (Number.isInteger(asNumber) && statusList.some((s) => s.id === asNumber)) {
    return asNumber;
  }
  const byName = statusList.find((s) => (s.istatus || '').toLowerCase() === String(rawStatus).toLowerCase());
  return byName ? byName.id : null;
}

// minPassRate: fetches every TestExecution linked to each of the release's
// TestPlans (one call per plan — release scope is small, N is a handful of
// plans, not worth a batched $in query), flattens their TestCases[], and
// computes passed/total across ALL of them combined.
//
// No executions/test cases anywhere in the linked plans -> the rule is
// UNMET (not vacuously passed). A release claiming a pass-rate gate is
// "green" with zero underlying data would be misleading, and this endpoint
// is explicitly about evaluating against live/real data (WP-025 spec) —
// silently treating "nothing to measure" as "target met" would be the
// wrong default for a release-blocking gate.
async function evaluateMinPassRate(rule, release, headers) {
  if (!TEST_PLAN_EXECUTION_SERVICE) {
    throw new ServiceUnavailableError('testPlanExecutionService is not configured');
  }
  let totalCases = 0;
  let passedCases = 0;
  for (const testPlanId of release.linkedTestPlanIds) {
    const resp = await requestWithRetry({
      method: 'get',
      url: `http://${TEST_PLAN_EXECUTION_SERVICE}/api/v1/testexecution`,
      params: { TestPlanId: testPlanId, limit: 1000 },
      headers
    });
    const executions = (resp.data && resp.data.data) || [];
    executions.forEach((execution) => {
      (execution.TestCases || []).forEach((tc) => {
        totalCases += 1;
        if ((tc.TestStatus || '').toLowerCase() === 'pass') {
          passedCases += 1;
        }
      });
    });
  }
  const actual = totalCases > 0 ? Math.round((passedCases / totalCases) * 10000) / 100 : 0;
  const passed = totalCases > 0 && actual >= rule.threshold;
  return {
    type: rule.type,
    threshold: rule.threshold,
    actual,
    passed,
    details: {
      totalTestCases: totalCases,
      passedTestCases: passedCases,
      note: totalCases === 0 ? 'no executed test cases found in linked test plans — rule cannot be met' : undefined
    }
  };
}

// maxOpenDefects: fetches every defect in the release's project (defectService
// is already tenant-scoped, WP-021, so the X-Project-Id header this
// controller forwards does the filtering), resolves each one's status via
// istatusservice's live graph, and counts how many are NOT in a terminal
// status (optionally filtered to a single severity).
async function evaluateMaxOpenDefects(rule, headers) {
  if (!DEFECT_SERVICE) {
    throw new ServiceUnavailableError('defectService is not configured');
  }
  if (!ISTATUS_SERVICE) {
    throw new ServiceUnavailableError('istatusService is not configured');
  }

  const [defectsResp, statusResp] = await Promise.all([
    requestWithRetry({
      method: 'get',
      url: `http://${DEFECT_SERVICE}/api/v1/defects`,
      params: { limit: 1000 },
      headers
    }),
    requestWithRetry({
      method: 'get',
      url: `http://${ISTATUS_SERVICE}/api/v1/issuestatus`,
      params: { limit: 1000 },
      headers
    })
  ]);

  const defects = (defectsResp.data && defectsResp.data.data) || [];
  const statusList = (statusResp.data && statusResp.data.data) || [];
  const terminalIds = computeTerminalStatusIds(statusList);

  const matching = defects.filter((d) => {
    if (rule.severity && (d.Severity || '').toLowerCase() !== rule.severity.toLowerCase()) {
      return false;
    }
    const statusId = resolveStatusId(d.Status, statusList);
    // A status that doesn't resolve to any known istatus vocabulary entry
    // (pre-workflow legacy free text, per defectService's own
    // updateDefectStatus comment) is conservatively counted as open — we
    // cannot prove it is resolved, and a gate should not undercount.
    return statusId === null || !terminalIds.has(statusId);
  });

  const actual = matching.length;
  const passed = actual <= rule.threshold;
  return {
    type: rule.type,
    threshold: rule.threshold,
    severity: rule.severity || null,
    actual,
    passed,
    details: {
      openDefectIds: matching.map((d) => d.defectId)
    }
  };
}

class ServiceUnavailableError extends Error {}

// @desc      Evaluate this release's quality gates against live data
// @route     GET /api/v1/releases/:id/gate-status
//
// Fail-closed on a dependency outage (same convention as
// requireProjectScope() / defectService's status-transition endpoint,
// WP-021/WP-010): if a rule type configured on this release needs a
// dependency that is unreachable, the WHOLE request 503s rather than
// silently reporting a partial/possibly-wrong gate result. A dependency this
// release's rules don't actually use is never contacted, so e.g. a release
// with only maxOpenDefects rules is unaffected by testPlanExecutionService
// being down.
exports.getGateStatus = asyncHandler(async (req, res, next) => {
  const release = await Release.findOne({ _id: req.params.id, projectId: req.projectScope.projectId });
  if (!release) {
    return next(new ErrorResponse(`No release found with id ${req.params.id}`, 404));
  }

  const headers = {
    Authorization: req.headers.authorization,
    'x-project-id': String(req.projectScope.projectId),
    [CORRELATION_HEADER]: req.correlationId
  };

  const rules = [];
  try {
    for (const rule of release.qualityGates) {
      if (rule.type === 'minPassRate') {
        rules.push(await evaluateMinPassRate(rule, release, headers));
      } else if (rule.type === 'maxOpenDefects') {
        rules.push(await evaluateMaxOpenDefects(rule, headers));
      }
    }
  } catch (err) {
    if (err instanceof ServiceUnavailableError) {
      logger.error('gate evaluation dependency unavailable; failing closed', {
        correlationId: req.correlationId,
        releaseId: release.releaseId,
        error: err.message
      });
      return next(new ErrorResponse(`Unable to evaluate gate status: ${err.message}`, 503));
    }
    logger.error('gate evaluation dependency call failed; failing closed', {
      correlationId: req.correlationId,
      releaseId: release.releaseId,
      error: err.message
    });
    return next(new ErrorResponse('Unable to evaluate gate status: a dependency call failed or was unreachable', 503));
  }

  const overallPassed = rules.every((r) => r.passed);

  res.status(200).json({
    success: true,
    data: {
      releaseId: release.releaseId,
      status: release.status,
      overall: overallPassed ? 'green' : 'red',
      passed: overallPassed,
      rules
    }
  });
});
