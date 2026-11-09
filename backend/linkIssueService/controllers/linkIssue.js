const { ErrorResponse, asyncHandler, requestWithRetry, CORRELATION_HEADER, PROJECT_ID_HEADER, createLogger, audit } = require('@srckube/service-core');
const LinkIssue = require('../models/linkIssue');
const { normalizeCreate, normalizeUpdate } = require('../utils/externalLink');

// WP-141: the external-link rules throw an Error carrying statusCode 400.
function validated(normalize, body, next) {
  try {
    return normalize(body || {});
  } catch (err) {
    if (err.statusCode === 400) {
      next(new ErrorResponse(err.message, 400));
      return null;
    }
    throw err;
  }
}

const logger = createLogger('linkIssueService');

// Sprint 2.2 (PB-05): coverage queries need to know every requirement/test
// case ID that exists, which linkIssueService's own database can't answer —
// it only knows about links, not the entities on either end. Cross-service
// calls to requirementService/testRepoService, same resilience pattern as
// testExecutionService -> testRepoService (Sprint 1.1/1.2).
const REQUIREMENT_SERVICE = process.env.requirementService;
const TESTREPO_SERVICE = process.env.testRepoService;

// WP-111 — this service is now project-scoped, so the two coverage endpoints
// below forward the CALLER'S verified project (req.projectScope.projectId),
// not a hardcoded one.
//
// What used to be here: DEFAULT_PROJECT_ID = '1', because requirementService
// and testRepoService require a scoped X-Project-Id header (WP-021) while this
// service had no per-request project concept of its own to forward. WP-104
// audited that shim and deliberately kept it -- unlike reportingService's
// sibling guard, whose premise had become false, this one's was still true.
// WP-111 removes the premise rather than the comment.

// @desc      Get all links
// @route     GET /api/v1/linkIssue
// @access    Private
exports.getLinks =  asyncHandler(async (req, res, next) => {
  res.status(200).json(res.advancedResults);
})

// @desc      Get a single link
// @route     GET /api/v1/linkIssue/:id
// @access    Private
exports.getLink = asyncHandler(async (req, res, next) => {
  // WP-111: scoped lookup, not findById -- an id from another project must
  // read as "not found", never as someone else's document.
  const link = await LinkIssue.findOne({ _id: req.params.id, projectId: req.projectScope.projectId });

  res.status(200).json({
    success: true,
    data: link
  });
});

// @desc      Create a link
// @route     POST /api/v1/linkIssue
// @access    Private
exports.createLink = asyncHandler(async (req, res, next) => {
  const user = req.kauth.grant.access_token.content;
  // WP-141: validates an external-issue link and derives its destinationId;
  // an internal link passes through unchanged.
  let reqdetails = validated(normalizeCreate, req.body, next)
  if (!reqdetails) return
  reqdetails['createdBy'] = user.sub
  reqdetails['updatedBy'] = user.sub
  // WP-111: stamped from the verified scope, never from the client body --
  // same rule as testRepoService's createTestCase.
  reqdetails['projectId'] = req.projectScope.projectId
  const link = await LinkIssue.create(reqdetails);

  // WP-119 — the traceability graph is auditable.
  //
  // This is the second half of what an auditor actually asks about: not just
  // "who got access" (userService, membership) but "who asserted that this
  // test covers this requirement, and when". A coverage claim that nobody can
  // attribute is worth very little in a regulated review, and link create /
  // delete were previously invisible.
  //
  // projectId/organizationId resolve from req.projectScope, which
  // requireProjectScope() sets on every route here since WP-111 — no explicit
  // context needed, unlike userService's locally-authorized routes.
  await audit(req, {
    entityType: 'link',
    entityId: link.linkId,
    action: 'create',
    after: {
      linkId: link.linkId,
      linkType: link.linkType,
      sourceId: link.sourceId,
      destinationId: link.destinationId
    }
  });

  res.status(201).json({
    success: true,
    data: link
  });
});

// @desc      Update a link
// @route     PUT /api/v1/linkIssue/:id
// @access    Private
exports.updateLink = asyncHandler(async (req, res, next) => {
  const user = req.kauth.grant.access_token.content;
  // WP-111: the filter carries projectId, so an update can never reach across
  // tenants even with a valid _id. The BODY must not carry it either: a
  // projectId there re-homed the link into another project (found in WP-141).
  // WP-141 generalises that: an update may change what a link says (its type,
  // its summary) but never what it connects -- so projectId, both ends, both
  // modules and the external issue are all dropped from the body.
  let reqdetails = normalizeUpdate(req.body || {})
  reqdetails['updatedBy'] = user.sub
  const link = await LinkIssue.findOneAndUpdate({ _id: req.params.id, projectId: req.projectScope.projectId }, reqdetails, {
    new: true,
    runValidators: true,
  });

  res.status(200).json({
    success: true,
    data: link
  });
});

// @desc      Delete a link
// @route     DELETE /api/v1/linkIssue/:id
// @access    Private
exports.deleteLink = asyncHandler(async (req, res, next) => {
  // WP-111: scoped delete. WP-119: audited, and the document is read first so
  // the event can record WHAT was deleted -- an audit row saying only "a link
  // was deleted" cannot answer "what coverage did we lose".
  const deleted = await LinkIssue.findOneAndDelete({ _id: req.params.id, projectId: req.projectScope.projectId });
  if (deleted) {
    await audit(req, {
      entityType: 'link',
      entityId: deleted.linkId,
      action: 'delete',
      before: {
        linkId: deleted.linkId,
        linkType: deleted.linkType,
        sourceId: deleted.sourceId,
        destinationId: deleted.destinationId
      }
    });
  }
  res.status(200).json({
    success: true,
    data: {}
  });
});

exports.deleteLinks = asyncHandler(async (req, res, next) => {
  // WP-111: both directions scoped to the caller's project.
  const projectId = req.projectScope.projectId;
  // WP-119: both directions audited. This is the route the UI's unlink action
  // calls, so it is where a coverage claim actually disappears in practice --
  // auditing only the single-id delete above would have left the common path
  // unrecorded.
  const removed = [];
  const forward = await LinkIssue.findOneAndDelete({
    projectId,
    "sourceId":req.query.srcId,
    "destinationId":req.query.destId
  });
  if (forward) removed.push(forward);
  const reverse = await LinkIssue.findOneAndDelete({
    projectId,
    "destinationId":req.query.srcId,
    "sourceId":req.query.destId
  });
  if (reverse) removed.push(reverse);

  for (const link of removed) {
    // eslint-disable-next-line no-await-in-loop
    await audit(req, {
      entityType: 'link',
      entityId: link.linkId,
      action: 'delete',
      before: {
        linkId: link.linkId,
        linkType: link.linkType,
        sourceId: link.sourceId,
        destinationId: link.destinationId
      }
    });
  }
  res.status(200).json({
    success: true,
    data: {}
  });
});

// linkIssueService's module ids for the two entity types these two
// coverage endpoints care about -- same numbering reportingService/
// services/coverage.js's own MODULE map uses (module 1 = test case,
// module 2 = requirement).
const MODULE = { TEST_CASE: 1, REQUIREMENT: 2 };

// WP-F13 final fix round, Finding 2 -- R1 (reportingService/services/
// coverage.js: "tested" means ANY requirement<->test-case LinkIssue row,
// any linkType, either direction) applies here too. This query used to be
// `{linkType: 'tests', srcModule: <fixed side>}` -- the exact wrong gate
// coverage.js was fixed away from in WP-F13 Task 1, except this copy was
// never touched, so it kept marking every requirement/case in the product
// untested/orphaned (23 of 23 live link rows are 'relates-to') while the
// reports page, one navigation away, read the same rows correctly.
// `linkType` is a label on the relationship, not a gate on whether it
// counts, and bidirectionality is a client-side double write (not a
// backend guarantee), so a row counts if EITHER side's module tags read
// requirement<->test-case, not just one hardcoded direction.
function requirementCaseLinksQuery(projectId) {
  return {
    projectId,
    $or: [
      { srcModule: MODULE.REQUIREMENT, destinationModule: MODULE.TEST_CASE },
      { srcModule: MODULE.TEST_CASE, destinationModule: MODULE.REQUIREMENT }
    ]
  };
}

// Sprint 2.2 (PB-05), WP-F13 final fix round Finding 2
// @desc      Requirements with no requirement<->test-case link at all
//            (any linkType, either direction -- see requirementCaseLinksQuery above)
// @route     GET /api/v1/linkIssue/coverage/untested-requirements
// @access    Private
exports.getUntestedRequirements = asyncHandler(async (req, res, next) => {
  const headers = {
    'Authorization': `${req.headers.authorization}`,
    [CORRELATION_HEADER]: req.correlationId,
    [PROJECT_ID_HEADER]: String(req.projectScope.projectId),
  };

  const reqResp = await requestWithRetry({
    method: 'get',
    url: `http://${REQUIREMENT_SERVICE}/api/v1/requirement?select=reqId,requirementSummary&limit=10000`,
    headers
  });
  const allRequirements = reqResp.data.data;

  const links = await LinkIssue.find(requirementCaseLinksQuery(req.projectScope.projectId), 'sourceId destinationId srcModule');
  const testedReqIds = new Set(links.map((l) => (l.srcModule === MODULE.REQUIREMENT ? l.sourceId : l.destinationId)));

  const untested = allRequirements.filter((r) => !testedReqIds.has(r.reqId));

  logger.info('computed untested requirements', {
    correlationId: req.correlationId,
    totalRequirements: allRequirements.length,
    untestedCount: untested.length
  });

  res.status(200).json({
    success: true,
    count: untested.length,
    data: untested
  });
});

// Sprint 2.2 (PB-05), WP-F13 final fix round Finding 2
// @desc      Test cases with no requirement<->test-case link at all
//            (any linkType, either direction -- see requirementCaseLinksQuery above)
// @route     GET /api/v1/linkIssue/coverage/orphan-testcases
// @access    Private
exports.getOrphanTestCases = asyncHandler(async (req, res, next) => {
  const headers = {
    'Authorization': `${req.headers.authorization}`,
    [CORRELATION_HEADER]: req.correlationId,
    [PROJECT_ID_HEADER]: String(req.projectScope.projectId),
  };

  const tcResp = await requestWithRetry({
    method: 'get',
    url: `http://${TESTREPO_SERVICE}/api/v1/testrepo?select=TestCaseId,TestCaseSummary&limit=10000`,
    headers
  });
  const allTestCases = tcResp.data.data;

  const links = await LinkIssue.find(requirementCaseLinksQuery(req.projectScope.projectId), 'sourceId destinationId srcModule');
  const linkedTcIds = new Set(links.map((l) => (l.srcModule === MODULE.TEST_CASE ? l.sourceId : l.destinationId)));

  const orphans = allTestCases.filter((tc) => !linkedTcIds.has(tc.TestCaseId));

  logger.info('computed orphan test cases', {
    correlationId: req.correlationId,
    totalTestCases: allTestCases.length,
    orphanCount: orphans.length
  });

  res.status(200).json({
    success: true,
    count: orphans.length,
    data: orphans
  });
});
