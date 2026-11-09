const {
  ErrorResponse,
  asyncHandler,
  createLogger,
  isValidTransition,
  LIFECYCLE_STATUSES,
  audit,
  publishEvent,
  EVENT_STREAMS,
  requireSearchTerm,
  resolveSearchLimit
} = require('@srckube/service-core');
const TestCase = require('../models/testrepo');
const TestCaseVersion = require('../models/TestCaseVersion');
const Dataset = require('../models/Dataset');
const { expandSteps } = require('../utils/expandSteps');
const { extractPlaceholders } = require('../utils/placeholders');
const { substituteSteps } = require('../utils/substituteSteps');

const logger = createLogger('testRepoService');

// WP-F07a Task 2 -- a datasetId is a foreign reference into another
// collection (unlike every other field on this schema), so Mongoose's own
// validators can't check it exists: an ObjectId path validates only that
// the shape is a valid ObjectId, not that a document with that _id is
// actually there. Without this check, a typo'd or stale datasetId would be
// stored silently, and every later /parameters or substitution (Task 3)
// call against that case would just see an empty dataset with no
// indication why -- so this is checked explicitly, here, on every write
// that touches datasetId, before the write happens.
//
// Returns nothing on success. On failure calls next(...) and returns true,
// so the caller can `if (await rejectInvalidDatasetBinding(...)) return;`
// and stop -- mirroring this file's existing validateBulkIds() early-return
// shape rather than throwing (asyncHandler would translate a thrown
// ErrorResponse into the same response, but an explicit bool keeps the
// caller's control flow visible at the call site).
//
// Fix round 1 (review): a malformed (non-ObjectId-shaped) datasetId and a
// genuine "no such document" both mean the same thing -- reject with 400,
// since neither can ever refer to a real dataset. But those are NOT the
// same claim as a lookup that failed for some other reason (a DB blip, a
// timeout) -- collapsing every rejected findOne() into "invalid dataset"
// would tell the caller their reference is bad when the truth is the
// lookup itself never completed. Only Mongoose's CastError (malformed id)
// is treated as "not found"; anything else propagates to next(err), which
// service-core's error handler turns into a 500, not a misleading 400.
async function rejectInvalidDatasetBinding(datasetId, projectId, next) {
  let dataset;
  try {
    dataset = await Dataset.findOne({ _id: datasetId, projectId });
  } catch (err) {
    if (err.name !== 'CastError') {
      next(err);
      return true;
    }
    dataset = null;
  }
  if (!dataset) {
    next(new ErrorResponse(`No dataset found with id ${datasetId} in this project`, 400));
    return true;
  }
  return false;
}

// WP-F07a Task 3 -- resolves `?substitute=<rowIndex>` into the {columns,
// row} pair substituteSteps() (utils/substituteSteps.js) needs. Lives here
// rather than in that file because it needs DB access (the bound Dataset)
// and req-shaped validation -- substituteSteps() itself stays a pure
// string pass with no collaborators, the same separation this file
// already keeps between expandSteps() (a pure transform) and the
// controller code that decides whether/how to call it.
//
// Every failure here is the CALLER's mistake (a malformed index, a case
// with no dataset bound, an index the dataset doesn't have) and is thrown
// as an ErrorResponse(..., 400) -- asyncHandler (wrapping every exported
// handler below) catches it and forwards to next(), same as every other
// validation failure in this file. Never a silent empty substitution: an
// out-of-range row or a missing binding is exactly the kind of mistake R5
// already establishes must stay visible for an unresolved placeholder
// name, and the same principle applies to the index that selects the row
// in the first place.
//
// Fix round 1 (review, Important): `Number(rawIndex)` accepts far more
// than a row index should ever mean -- '' (Number('') is 0, not NaN),
// '0x1' (parsed as hex 1), '+0', '  3  ' (whitespace-trimmed) all coerce
// to a valid-looking integer, so a client bug like an unset dropdown
// sending `?substitute=` would silently substitute row 0 with no error at
// all -- exactly the "silent empty substitution" this function's own
// comment above says must never happen, just one layer up from the index
// range check. This regex accepts ONLY a canonical non-negative decimal
// integer string: '0' or a non-zero digit followed by more digits -- no
// sign, no leading zeros, no hex, no decimal point, no whitespace. '0'
// itself matches the first alternative explicitly, so a legitimate row 0
// is not swallowed by any falsy-style check (there isn't one: this is a
// string-shape test, never `!rowIndex`).
const CANONICAL_ROW_INDEX = /^(0|[1-9][0-9]*)$/;

async function resolveSubstitutionRow(testCase, rawIndex, projectId) {
  const label = testCase.TestCaseId || testCase._id;
  if (typeof rawIndex !== 'string' || !CANONICAL_ROW_INDEX.test(rawIndex)) {
    throw new ErrorResponse(
      `Invalid substitute row index '${rawIndex}': must be a canonical non-negative integer (e.g. '0', '1', '12') -- no sign, no leading zeros, no hex, no decimal point`,
      400
    );
  }
  const rowIndex = Number(rawIndex);
  if (!testCase.datasetId) {
    throw new ErrorResponse(`Test case ${label} has no dataset bound; cannot substitute`, 400);
  }
  const dataset = await Dataset.findOne({ _id: testCase.datasetId, projectId }, 'columns rows').lean();
  // Can't actually happen through this service's own write paths (every
  // create/update already validates the binding via
  // rejectInvalidDatasetBinding above) -- but a broken binding is still
  // the caller's problem to fix, not a server fault, so this degrades to
  // the same 400 rather than a 500 if it somehow did.
  if (!dataset) {
    throw new ErrorResponse(`Test case ${label}'s bound dataset no longer exists`, 400);
  }
  if (rowIndex >= dataset.rows.length) {
    throw new ErrorResponse(
      `Row index ${rowIndex} is out of range: test case ${label}'s dataset has ${dataset.rows.length} row(s)`,
      400
    );
  }
  return { columns: dataset.columns, row: dataset.rows[rowIndex] };
}

// @desc      Get all users
// @route     GET /api/v1/auth/users
// @access    Private/Admin
exports.getTestCases = asyncHandler(async (req, res, next) => {
  logger.info('getTestCases', {
    correlationId: req.correlationId,
    query: req.query
  });
  // WP-021: res.advancedResults is already tenant-scoped -- advancedResults()
  // (service-core) folds req.projectScope.projectId (set by
  // requireProjectScope(), mounted ahead of it on this route) into its
  // Mongo filter.
  //
  // WP-F06 -- opt-in only (R2). Note getTestCases is the route execution
  // enrichment calls (/api/v1/testrepo?TestCaseId=...), so expansion has to
  // work here and not only on /:id.
  //
  // WP-F07a Task 3 -- `?substitute=<rowIndex>` also needs expansion to
  // have run first (R4), so it takes this same branch even when the
  // caller didn't separately ask for `expand=steps` -- a client asking to
  // substitute wants flattened, resolved steps back, not a mix of
  // reference rows and substituted plain rows. `expand=steps` ALONE
  // (wantsSubstitute false) is the one path that must NEVER reach
  // substituteSteps() -- this is what protects execution enrichment
  // (backend/testPlanExecutionService) and the AI service
  // (backend/aiService), the only two `expand=steps`-only callers today.
  const substituteParam = req.query.substitute;
  const wantsSubstitute = substituteParam !== undefined;

  if (req.query.expand === 'steps' || wantsSubstitute) {
    const payload = { ...res.advancedResults };
    payload.data = await expandSteps(
      JSON.parse(JSON.stringify(payload.data)),
      req.projectScope.projectId
    );

    if (wantsSubstitute) {
      // The list route can return more than one test case, and each
      // one's {{placeholders}} resolve against ITS OWN bound dataset, not
      // a single shared one -- so each doc is resolved and substituted
      // independently, all against the same requested rowIndex. A doc
      // with no dataset bound (or an index its dataset doesn't have)
      // fails the whole request with 400 rather than silently omitting
      // that one item from an otherwise-200 response.
      for (const doc of payload.data) {
        // eslint-disable-next-line no-await-in-loop
        const { columns, row } = await resolveSubstitutionRow(doc, substituteParam, req.projectScope.projectId);
        substituteSteps(doc, columns, row);
      }
    }

    return res.status(200).json(payload);
  }
  res.status(200).json(res.advancedResults);
});

// @desc      Get single user
// @route     GET /api/v1/auth/users/:id
// @access    Private/Admin
//
// WP-021: findById -> findOne({_id, projectId}) so a valid, existing
// document that belongs to a DIFFERENT project than the one the caller was
// authorized for (req.projectScope, verified by requireProjectScope()) is
// indistinguishable from "doesn't exist" (404), never leaking its existence
// or content across the tenant boundary.
exports.getTestCase = asyncHandler(async (req, res, next) => {
  const folder = await TestCase.findOne({ _id: req.params.id, projectId: req.projectScope.projectId });
  if (!folder) {
    return next(new ErrorResponse(`No test case found with id ${req.params.id}`, 404));
  }

  // WP-F06 -- opt-in only (R2), same shape as getTestCases above. The
  // clone matters: `folder` is a hydrated Mongoose document, and assigning
  // a plain array with extra keys onto a strict subdocument path would
  // drop sharedStepTitle/sharedStepIndex silently.
  //
  // WP-F07a Task 3 -- same `substitute` handling as getTestCases above:
  // requesting substitution takes this branch even without a separate
  // `expand=steps`, because substitution needs the already-flattened
  // rows (R4). A read with NEITHER param (the `else` below) returns
  // `folder` completely untouched -- this is the regression guard for R3:
  // authored text, `{{placeholders}}` intact, is what a plain read must
  // always return, exactly as it did before this task existed.
  const substituteParam = req.query.substitute;
  const wantsSubstitute = substituteParam !== undefined;

  if (req.query.expand === 'steps' || wantsSubstitute) {
    const [expanded] = await expandSteps(
      [JSON.parse(JSON.stringify(folder))],
      req.projectScope.projectId
    );

    if (wantsSubstitute) {
      const { columns, row } = await resolveSubstitutionRow(folder, substituteParam, req.projectScope.projectId);
      substituteSteps(expanded, columns, row);
    }

    return res.status(200).json({
      success: true,
      data: expanded
    });
  }

  res.status(200).json({
    success: true,
    data: folder
  });
});

// @desc      Create user
// @route     POST /api/v1/auth/users
// @access    Private/Admin
//
// WP-021: projectId is stamped from the verified req.projectScope, never
// trusted from the client body -- an authenticated member of project 1
// creating a test case must not be able to write it into project 2 just by
// putting `projectId: 2` in the POST body.
exports.createTestCase = asyncHandler(async (req, res, next) => {
  const user = req.kauth.grant.access_token.content;
  const username = user;
  let reqdetails = req.body
  reqdetails['createdBy'] = username.sub
  reqdetails['updatedBy'] = username.sub
  reqdetails['projectId'] = req.projectScope.projectId

  // WP-F07a Task 2 -- reject a dataset binding that doesn't exist or
  // belongs to another project, rather than storing it and leaving every
  // later parameter check silently empty. A falsy datasetId (unset, null,
  // '') means "no binding" and is left alone.
  if (reqdetails.datasetId) {
    if (await rejectInvalidDatasetBinding(reqdetails.datasetId, req.projectScope.projectId, next)) return;
  }

  const folder = await TestCase.create(reqdetails);

  // WP-024: audit() never fails the business operation -- awaited so the
  // event is guaranteed visible to a caller that immediately reads it back
  // (e.g. GET /api/v1/audit), never because a failure here could block the
  // response.
  await audit(req, {
    entityType: 'testcase',
    entityId: folder.TestCaseId,
    action: 'create',
    after: { TestCaseId: folder.TestCaseId, TestCaseSummary: folder.TestCaseSummary }
  });

  res.status(201).json({
    success: true,
    data: folder
  });
});

// @desc      Update user
// @route     PUT /api/v1/auth/users/:id
// @access    Private/Admin
//
// WP-021: findByIdAndUpdate -> findOneAndUpdate({_id, projectId}) so a
// document belonging to a different project can't be found (404) or
// updated. `projectId` is also stripped from the incoming body so a caller
// can't reassign a document to a different project (or out of the one they
// were verified against) via the update payload itself.
// WP-051 -- fields whose edit clears the AI-generated badge (see
// models/testrepo.js's generatedBy comment for the full rule).
const AI_BADGE_CONTENT_FIELDS = ['TestCaseSummary', 'TestCaseDescription', 'TestSteps'];

exports.updateTestCase = asyncHandler(async (req, res, next) => {
  const user = req.kauth.grant.access_token.content;
  const username = user;
  let reqdetails = req.body
  reqdetails['updatedBy'] = username.sub
  delete reqdetails.projectId

  // WP-051 -- AI-generated badge rule: a human editing any CONTENT field of
  // an AI-generated test case (not metadata like assignedTo) clears the
  // badge on this same write. Only fires when the caller didn't already
  // set generatedBy explicitly (so the accept-flow's own create -- a
  // different route, POST / -- is never affected, and a caller that
  // deliberately re-marks generatedBy is respected).
  if (
    AI_BADGE_CONTENT_FIELDS.some((f) => Object.prototype.hasOwnProperty.call(reqdetails, f)) &&
    !Object.prototype.hasOwnProperty.call(reqdetails, 'generatedBy')
  ) {
    const current = await TestCase.findOne(
      { _id: req.params.id, projectId: req.projectScope.projectId },
      'generatedBy'
    );
    if (current && current.generatedBy) {
      reqdetails['generatedBy'] = null;
    }
  }

  // WP-F07a Task 2 -- same binding check as createTestCase. A truthy
  // datasetId in the update body is validated before the write; an
  // explicit `null` (clearing the binding) or an absent key (leaving it
  // untouched) both skip this check, same "falsy means no binding to
  // validate" rule as create.
  if (reqdetails.datasetId) {
    if (await rejectInvalidDatasetBinding(reqdetails.datasetId, req.projectScope.projectId, next)) return;
  }

  const folder = await TestCase.findOneAndUpdate(
    { _id: req.params.id, projectId: req.projectScope.projectId },
    reqdetails,
    {
      new: true,
      runValidators: true
    }
  );
  if (!folder) {
    return next(new ErrorResponse(`No test case found with id ${req.params.id}`, 404));
  }

  await audit(req, {
    entityType: 'testcase',
    entityId: folder.TestCaseId,
    action: 'update',
    after: reqdetails
  });

  res.status(200).json({
    success: true,
    data: folder
  });
});
exports.updateTestCaseByParam = asyncHandler(async(req,res,next)=>{
  console.log(req.query.tcid)
  console.log(req.body)
  const reqBody = { ...req.body };
  delete reqBody.projectId;

  // WP-F07a Task 2 -- same binding check as updateTestCase; this is the
  // other write path that can set datasetId.
  if (reqBody.datasetId) {
    if (await rejectInvalidDatasetBinding(reqBody.datasetId, req.projectScope.projectId, next)) return;
  }

  const folder = await TestCase.findOneAndUpdate(
    { TestCaseId: req.query.tcid, projectId: req.projectScope.projectId },
    reqBody,
    {
      new: true,
      runValidators: true
    }
  );
  if (!folder) {
    return next(new ErrorResponse(`No test case found with TestCaseId ${req.query.tcid}`, 404));
  }

  await audit(req, {
    entityType: 'testcase',
    entityId: folder.TestCaseId,
    action: 'update',
    after: reqBody
  });

  res.status(200).json({
    success: true,
    data: folder
  });
  })
// @desc      Delete user
// @route     DELETE /api/v1/auth/users/:id
// @access    Private/Admin
//
// WP-021: findByIdAndDelete -> findOneAndDelete({_id, projectId}) -- same
// scoping rationale as getTestCase/updateTestCase above.
exports.deleteTestCase = asyncHandler(async (req, res, next) => {
  const deleted = await TestCase.findOneAndDelete({ _id: req.params.id, projectId: req.projectScope.projectId });
  if (!deleted) {
    return next(new ErrorResponse(`No test case found with id ${req.params.id}`, 404));
  }

  await audit(req, {
    entityType: 'testcase',
    entityId: deleted.TestCaseId,
    action: 'delete',
    before: { TestCaseId: deleted.TestCaseId, TestCaseSummary: deleted.TestCaseSummary, status: deleted.status }
  });

  res.status(200).json({
    success: true,
    data: {}
  });
});

// WP-104 — user input is escaped before it reaches $regex and the result
// set is capped.
//
// Escaping is a correctness fix first: unescaped, a search for "TC1." also
// matched "TC11", "." matched every document and "^" anchored. The cap is
// what bounds the route -- it previously returned every match in the project,
// fully hydrated, in a single response (and accepted an empty search, which
// matched everything). A missing ?search= used to reach Mongo as
// {$regex: undefined} and surface as a 500; requireSearchTerm() makes that a
// 400, which is what bad input deserves.
exports.wildcardSearch = asyncHandler(async (req, res, next) => {
  const search = requireSearchTerm(req.query.search);

  const reqList = await TestCase.find({
    projectId: req.projectScope.projectId,
    $or: [
      { TestCaseId: { $regex: search, $options: 'i' } },
      { TestCaseSummary: { $regex: search, $options: 'i' } }
    ]
  }).limit(resolveSearchLimit());
  res.status(200).json({
    success: true,
    data: reqList
  });


})

// Sprint 2.1 (PB-04)
// @desc      Transition a test case's lifecycle status, validating the transition
// @route     PUT /api/v1/testrepo/:id/status
// @access    Private
// WP-021: both lookups scoped to req.projectScope.projectId.
exports.updateTestCaseStatus = asyncHandler(async (req, res, next) => {
  const { status: nextStatus } = req.body;

  if (!LIFECYCLE_STATUSES.includes(nextStatus)) {
    return res.status(400).json({
      success: false,
      error: `Invalid status: ${nextStatus}. Must be one of ${LIFECYCLE_STATUSES.join(', ')}`
    });
  }

  const current = await TestCase.findOne({ _id: req.params.id, projectId: req.projectScope.projectId });
  if (!current) {
    return res.status(404).json({ success: false, error: 'Test case not found' });
  }

  if (!isValidTransition(current.status, nextStatus)) {
    return res.status(400).json({
      success: false,
      error: `Cannot transition from '${current.status}' to '${nextStatus}'`
    });
  }

  const user = req.kauth.grant.access_token.content;
  const updated = await TestCase.findOneAndUpdate(
    { _id: req.params.id, projectId: req.projectScope.projectId },
    { status: nextStatus, updatedBy: user.sub },
    { new: true, runValidators: true }
  );

  logger.info('test case status transitioned', {
    correlationId: req.correlationId,
    TestCaseId: updated.TestCaseId,
    from: current.status,
    to: nextStatus
  });

  await audit(req, {
    entityType: 'testcase',
    entityId: updated.TestCaseId,
    action: 'status-change',
    before: { status: current.status },
    after: { status: nextStatus }
  });

  // WP-030: same call site as audit() above, mirroring
  // requirementService's updateRequirementStatus -- both publish onto the
  // same shared 'status-changed' stream. correlationId carried through so
  // a consumer can join an event back to this request, matching WP-024's
  // audit events.
  await publishEvent(EVENT_STREAMS.STATUS_CHANGED, {
    entityType: 'testcase',
    entityId: updated.TestCaseId,
    projectId: req.projectScope && req.projectScope.projectId,
    from: current.status,
    to: nextStatus,
    correlationId: req.correlationId
  });

  res.status(200).json({ success: true, data: updated });
});

// Sprint 2.1 (PB-04)
// @desc      Retrieve the immutable version history of a test case, newest first
// @route     GET /api/v1/testrepo/:id/versions
// @access    Private
// WP-021: the parent lookup is scoped to req.projectScope.projectId; since
// TestCaseVersion snapshots are queried only by the already-scoped parent's
// TestCaseId (never independently reachable), scope is inherited
// transitively -- there is no separate projectId on TestCaseVersion itself.
exports.getTestCaseVersions = asyncHandler(async (req, res, next) => {
  const current = await TestCase.findOne({ _id: req.params.id, projectId: req.projectScope.projectId });
  if (!current) {
    return res.status(404).json({ success: false, error: 'Test case not found' });
  }

  const versions = await TestCaseVersion.find({ TestCaseId: current.TestCaseId }).sort({ version: -1 });

  res.status(200).json({
    success: true,
    count: versions.length,
    data: versions
  });
});

// WP-F07a Task 2
// @desc      Report this case's {{placeholders}} against its bound
//            dataset's columns: which placeholders have no matching
//            column (missing -- the error case) and which columns no
//            placeholder references (unused -- a warning, not an error).
// @route     GET /api/v1/testrepo/:id/parameters
// @access    Private (read)
//
// ORDERING: shared steps are expanded BEFORE placeholders are extracted.
// A shared step's own text can contain {{placeholders}}, and those must
// resolve against the BINDING case's dataset -- so this has to see the
// expanded TestSteps, not the raw reference rows (whose testStep/Expected
// are meaningless per TestStepSchema's own contract). Extracting first
// and expanding never would silently miss every placeholder that lives
// only inside a shared step.
exports.getTestCaseParameters = asyncHandler(async (req, res, next) => {
  const { projectId } = req.projectScope;
  const testCase = await TestCase.findOne({ _id: req.params.id, projectId });
  if (!testCase) {
    return next(new ErrorResponse(`No test case found with id ${req.params.id}`, 404));
  }

  // Cloned for the same reason getTestCase's expand=steps branch clones:
  // expandSteps() mutates TestSteps in place, and doing that to a live
  // Mongoose document (rather than a plain object) risks marking paths
  // dirty with no intention of ever saving them.
  const expanded = await expandSteps(JSON.parse(JSON.stringify(testCase)), projectId);
  const placeholders = extractPlaceholders(expanded.TestSteps);

  // No dataset bound at all is not an error here -- the case may not be
  // parameterised yet, or may be mid-authoring -- but every placeholder is
  // reported `missing` since there is no column to satisfy any of them.
  let columns = [];
  if (testCase.datasetId) {
    const dataset = await Dataset.findOne({ _id: testCase.datasetId, projectId }, 'columns').lean();
    // A dangling/cross-project datasetId can't actually occur through this
    // service's own write paths (rejectInvalidDatasetBinding above checks
    // every create/update), but this still degrades to "no columns" rather
    // than throwing if it somehow did -- consistent with the unbound case.
    columns = dataset ? dataset.columns : [];
  }

  const columnSet = new Set(columns);
  const placeholderSet = new Set(placeholders);
  const missing = placeholders.filter((p) => !columnSet.has(p));
  // Fix round 1 (review, minor): built from `columnSet`, not the raw
  // `columns` array -- a Dataset's columns list has no uniqueness
  // constraint, so a duplicate column name would otherwise be reported
  // once per repetition instead of once. `[...columnSet]` also preserves
  // first-appearance order, same guarantee `placeholders` already has.
  const unused = [...columnSet].filter((c) => !placeholderSet.has(c));

  res.status(200).json({
    success: true,
    data: { placeholders, columns, missing, unused }
  });
});

// WP-043 -- Bulk operations.
//
// PARTIAL-FAILURE POLICY: ALL-OR-NOTHING, same choice and same
// justification WP-045 already made for CSV import (controllers/
// importExport.js's header comment) -- this deployment's Mongo is a
// standalone instance, not a replica set, so there is no multi-document
// transaction to fall back on for a true DB-level rollback. Every id is
// validated to exist in this project (and, for a status change, to be a
// legal transition) BEFORE any write happens; if any item fails
// validation, NOTHING is written and the response says so explicitly
// (`policy: 'all-or-nothing'`), matching what the frontend's confirmation
// dialog must promise before the user commits (Pages/testcases.tsx's bulk
// toolbar). If the DB itself fails mid-write-loop after validation passed
// (should be unreachable -- every write here is a plain field update, not
// a create with a racy id-assignment step), the loop's catch block
// compensates by reverting every already-applied item back to its
// pre-bulk value, same compensating-rollback shape as importExport.js's
// commitImport().
//
// AUDIT: WP-024's audit(req, {...}) is called ONCE PER ITEM, never as a
// single summary event -- a bulk operation on N items produces exactly N
// audit events (proven in EXECUTION_LOG.md's WP-043 report by bulk-
// assigning 10 seeded test cases and counting GET /api/v1/audit rows).
// This is a deliberate difference from WP-045's import commit (which logs
// both a batch-summary event AND N per-item events) -- the WP-043 brief
// asks specifically to "prove exactly N audit events", so no summary event
// is emitted here to keep that count unambiguous.
//
// RBAC: mounted with authorize('write') for assign/status, authorize
// ('delete') for delete (routes/testrepo.js) -- the existing shared
// authorize() middleware (WP-022) already rejects a viewer (write:false,
// delete:false in the permission matrix) with 403 before either
// controller function below ever runs. No new code needed here to enforce
// that; see EXECUTION_LOG.md's WP-043 report for the live proof.
const BULK_MAX_ITEMS = 500;

function validateBulkIds(req, next) {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    next(new ErrorResponse('ids must be a non-empty array', 400));
    return null;
  }
  if (ids.length > BULK_MAX_ITEMS) {
    next(new ErrorResponse(`Bulk operations are limited to ${BULK_MAX_ITEMS} items at a time (got ${ids.length})`, 400));
    return null;
  }
  return ids;
}

// @desc      Bulk status-change or bulk-assign, all-or-nothing.
// @route     PATCH /api/v1/testrepo/bulk
// @body      { ids: string[], action: 'assign'|'status', assignedTo?, status? }
// @access    Private (write)
exports.bulkUpdateTestCases = asyncHandler(async (req, res, next) => {
  const ids = validateBulkIds(req, next);
  if (!ids) return;

  const { action, assignedTo, status: nextStatus } = req.body;
  if (!['assign', 'status'].includes(action)) {
    return next(new ErrorResponse("action must be 'assign' or 'status'", 400));
  }
  if (action === 'assign' && !assignedTo) {
    return next(new ErrorResponse('assignedTo is required for action "assign"', 400));
  }
  if (action === 'status' && !LIFECYCLE_STATUSES.includes(nextStatus)) {
    return next(new ErrorResponse(`Invalid status: ${nextStatus}. Must be one of ${LIFECYCLE_STATUSES.join(', ')}`, 400));
  }

  const projectId = req.projectScope.projectId;
  const docs = await TestCase.find({ _id: { $in: ids }, projectId });

  if (docs.length !== ids.length) {
    const foundIds = new Set(docs.map((d) => String(d._id)));
    const missingIds = ids.filter((id) => !foundIds.has(String(id)));
    return res.status(422).json({
      success: false,
      policy: 'all-or-nothing',
      error: `${missingIds.length} of ${ids.length} item(s) were not found in this project; nothing was changed`,
      missingIds
    });
  }

  if (action === 'status') {
    const invalid = docs.filter((d) => !isValidTransition(d.status, nextStatus));
    if (invalid.length > 0) {
      return res.status(422).json({
        success: false,
        policy: 'all-or-nothing',
        error: `${invalid.length} of ${docs.length} item(s) cannot transition to '${nextStatus}'; nothing was changed`,
        invalidIds: invalid.map((d) => d.TestCaseId)
      });
    }
  }

  const user = req.kauth.grant.access_token.content;
  const update = action === 'assign' ? { assignedTo, updatedBy: user.sub } : { status: nextStatus, updatedBy: user.sub };
  const applied = [];
  let results;
  try {
    results = [];
    for (const doc of docs) {
      const before = action === 'assign' ? { assignedTo: doc.assignedTo } : { status: doc.status };
      const updated = await TestCase.findOneAndUpdate({ _id: doc._id, projectId }, update, { new: true, runValidators: true });
      applied.push({ id: doc._id, before });
      results.push(updated);
    }
  } catch (err) {
    for (const a of applied) {
      // eslint-disable-next-line no-await-in-loop
      await TestCase.findOneAndUpdate({ _id: a.id, projectId }, a.before).catch(() => {});
    }
    throw new ErrorResponse(`Bulk ${action} failed partway through (${applied.length}/${docs.length} items); all changes rolled back: ${err.message}`, 500);
  }

  for (const updated of results) {
    // eslint-disable-next-line no-await-in-loop
    await audit(req, {
      entityType: 'testcase',
      entityId: updated.TestCaseId,
      action: action === 'assign' ? 'bulk-assign' : 'bulk-status-change',
      after: action === 'assign' ? { assignedTo: updated.assignedTo } : { status: updated.status }
    });
  }

  logger.info('bulk test case update succeeded', {
    correlationId: req.correlationId,
    projectId,
    action,
    count: results.length
  });

  res.status(200).json({
    success: true,
    policy: 'all-or-nothing',
    updated: results.length,
    data: results
  });
});

// @desc      Bulk delete, all-or-nothing.
// @route     DELETE /api/v1/testrepo/bulk
// @body      { ids: string[] }
// @access    Private (delete)
exports.bulkDeleteTestCases = asyncHandler(async (req, res, next) => {
  const ids = validateBulkIds(req, next);
  if (!ids) return;

  const projectId = req.projectScope.projectId;
  const docs = await TestCase.find({ _id: { $in: ids }, projectId });

  if (docs.length !== ids.length) {
    const foundIds = new Set(docs.map((d) => String(d._id)));
    const missingIds = ids.filter((id) => !foundIds.has(String(id)));
    return res.status(422).json({
      success: false,
      policy: 'all-or-nothing',
      error: `${missingIds.length} of ${ids.length} item(s) were not found in this project; nothing was deleted`,
      missingIds
    });
  }

  const deletedIds = [];
  try {
    for (const doc of docs) {
      // eslint-disable-next-line no-await-in-loop
      await TestCase.deleteOne({ _id: doc._id, projectId });
      deletedIds.push(doc._id);
    }
  } catch (err) {
    // Compensating rollback: re-insert whatever this batch already
    // deleted, same shape as importExport.js's commitImport() rollback.
    for (const doc of docs) {
      if (deletedIds.some((id) => String(id) === String(doc._id))) {
        // eslint-disable-next-line no-await-in-loop
        await new TestCase(doc.toObject()).save().catch(() => {});
      }
    }
    throw new ErrorResponse(`Bulk delete failed partway through (${deletedIds.length}/${docs.length} items); all deletions rolled back: ${err.message}`, 500);
  }

  for (const doc of docs) {
    // eslint-disable-next-line no-await-in-loop
    await audit(req, {
      entityType: 'testcase',
      entityId: doc.TestCaseId,
      action: 'bulk-delete',
      before: { TestCaseId: doc.TestCaseId, TestCaseSummary: doc.TestCaseSummary, status: doc.status }
    });
  }

  logger.info('bulk test case delete succeeded', {
    correlationId: req.correlationId,
    projectId,
    count: docs.length
  });

  res.status(200).json({
    success: true,
    policy: 'all-or-nothing',
    deleted: docs.length
  });
});
