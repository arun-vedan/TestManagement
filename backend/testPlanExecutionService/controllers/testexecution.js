const {
  ErrorResponse,
  asyncHandler,
  requestWithRetry,
  CORRELATION_HEADER,
  PROJECT_ID_HEADER,
  createLogger,
  audit,
  publishEvent,
  EVENT_STREAMS
} = require('@srckube/service-core');

// WP-021b: testPlanExecutionService is now on requireProjectScope()
// (routes/testexecution.js), closing the gap WP-021 explicitly deferred
// ("the rest in later work" — see the now-stale comment this replaces).
// Every lookup below is scoped to req.projectScope.projectId, same
// convention as testRepoService's controllers/testrepo.js. The one
// cross-service call below (fetching a test case's details from
// testRepoService to enrich an execution record) now forwards the
// caller's REAL, verified project scope instead of a hardcoded
// DEFAULT_PROJECT_ID='1' — testRepoService has been tenant-scoped since
// WP-021, so a hardcoded '1' would silently 403 (or worse, silently fetch
// the wrong project's test case) for any project other than the Default
// one now that real multi-project data exists here too.
const TestExecution = require('../models/TestExecution');

const logger = createLogger('testPlanExecutionService');

// WP-F07b Task 1 -- a case within a run is now addressed by TestCaseId
// PLUS iterationIndex (R1: absent means 0), not TestCaseId alone. Before
// this, N iterations of one parameterised case would all share a
// TestCaseId and every one of the six sites below would silently resolve
// to whichever row happened to match first (see models/TestExecution.js's
// iterationIndex comment for the full rationale). These three helpers are
// the SINGLE source of truth for "does this row match the requested
// iteration" -- so the six call sites (three Mongo queries, three
// in-memory .find() calls) share one definition of a match instead of
// three query filters and three predicates that could drift apart one at
// a time.
//
// iterationIndex 0 is the ordinary case (every pre-existing row, and
// every unparameterised case going forward) -- never read with `||` or
// any other truthiness check anywhere below, only `??` / `!== undefined`,
// or it would be silently swallowed exactly like an absent value.
const CANONICAL_ITERATION_INDEX = /^(0|[1-9][0-9]*)$/;

// Resolves a request's `iterationIndex` query param to a real number,
// same "canonical non-negative integer only" contract as testRepoService's
// resolveSubstitutionRow (../../testRepoService/controllers/testrepo.js)
// -- no sign, no leading zeros, no hex, no decimal point, no whitespace --
// so a malformed value fails loudly (400) instead of silently resolving to
// iteration 0 and landing a write on the wrong row. Absence (undefined,
// per R1) is the one case that legitimately means 0, not an error.
function resolveIterationIndex(raw) {
  if (raw === undefined) return 0;
  if (typeof raw !== 'string' || !CANONICAL_ITERATION_INDEX.test(raw)) {
    throw new ErrorResponse(
      `Invalid iterationIndex '${raw}': must be a canonical non-negative integer (e.g. '0', '1', '2') -- no sign, no leading zeros, no hex, no decimal point`,
      400
    );
  }
  return Number(raw);
}

// In-memory predicate for the three `execution.TestCases.find(...)` sites.
// `tc.iterationIndex ?? 0` (never `||`) so a genuinely-stored 0 -- the
// normal case -- is never mistaken for "not set".
function matchesCaseIteration(tc, tcid, iterationIndex) {
  return tc.TestCaseId === tcid && (tc.iterationIndex ?? 0) === iterationIndex;
}

function findCaseIteration(execution, tcid, iterationIndex) {
  return execution.TestCases.find((tc) => matchesCaseIteration(tc, tcid, iterationIndex));
}

// Mongo query fragment for the three findOne() sites, matching the SAME
// definition of "this row" as matchesCaseIteration above. $elemMatch (not
// two separate dotted-path conditions) is required so both clauses are
// checked against the SAME array element -- 'TestCases.TestCaseId': tcid
// and 'TestCases.iterationIndex': i as two top-level conditions would each
// match independently against ANY element, so a doc with TC-9 iteration 0
// and TC-9 iteration 1 would match a query for {TC-9, iteration 5} as long
// as *some* element had TestCaseId TC-9 and *some* element (any element)
// had iterationIndex 0 -- silently wrong.
//
// The iterationIndex clause accepts an explicit null in addition to 0:
// this runs as a real MongoDB query against the STORED document, which
// never sees Mongoose's `default: 0` (that only applies when Mongoose
// hydrates a document in memory, not to the server-side query planner) --
// so a document that predates the backfill (scripts/backfill-iteration-index.js)
// has iterationIndex genuinely absent, and MongoDB's own null-matches-
// missing-or-null semantics is what makes iteration 0 still find it.
// Verified live (see task report) against a scratch collection with rows
// missing the field, holding 0, and holding an explicit null -- all three
// matched an `iterationIndex: {$in:[0, null]}` query; a row holding 1 did
// not. This is what keeps R1 ("absent means 0") true for reads even
// against a partially-migrated database, not just after the backfill runs.
function caseIterationQuery(tcid, iterationIndex) {
  const iterationMatch = iterationIndex === 0 ? { $in: [0, null] } : iterationIndex;
  return { TestCases: { $elemMatch: { TestCaseId: tcid, iterationIndex: iterationMatch } } };
}

exports.getTestExecutions = asyncHandler(async (req, res, next) => {
  // res.advancedResults is already tenant-scoped -- advancedResults()
  // (service-core) folds req.projectScope.projectId into its Mongo filter.
  res.status(200).json(res.advancedResults);
});

exports.getTestExecution = asyncHandler(async (req, res, next) => {
  const execution = await TestExecution.findOne({ _id: req.params.id, projectId: req.projectScope.projectId });
  if (!execution) {
    // WP-021b: the original controller (pre-scoping) returned 200 with
    // data: null for a not-found id, matching neither testRepoService's
    // convention nor this WP's own isolation guarantee cleanly (a foreign
    // project's document and a nonexistent one should both read as "not
    // found", not as "found, here's null"). Upgraded to the established
    // 404 convention (testRepoService's getTestCase, this file's own
    // getTestPlan) -- a document belonging to a different project is
    // indistinguishable from "doesn't exist".
    return next(new ErrorResponse(`No test execution found with id ${req.params.id}`, 404));
  }

  res.status(200).json({
    success: true,
    data: execution,
  });
});

exports.createTestExecution = asyncHandler(async (req, res, next) => {
  const user = req.kauth.grant.access_token.content;
  const username = user;
  let reqdetails = req.body
  // The plan's "Create Execution" dialog can assign the run to someone
  // else; with no assignee given, the creator is assigned (the only
  // behaviour before, when any body value was silently overwritten).
  if (typeof reqdetails.assignedTo !== 'string' || !reqdetails.assignedTo.trim()) {
    reqdetails['assignedTo'] = username.sub
  }
  // projectId is stamped from the verified req.projectScope, never trusted
  // from the client body -- same rule as testRepoService's createTestCase.
  reqdetails['projectId'] = req.projectScope.projectId
  const execution = await TestExecution.create(reqdetails);

  await audit(req, {
    entityType: 'testexecution',
    entityId: execution.TestExecutionId,
    action: 'create',
    after: { TestExecutionId: execution.TestExecutionId }
  });

  res.status(201).json({
    success: true,
    data: execution,
  });
});

exports.updateTestExecution = asyncHandler(async (req, res, next) => {
  // projectId is stripped from the incoming body so a caller can't
  // reassign an execution to a different project via the update payload
  // itself -- same rule as testRepoService's updateTestCase.
  const reqBody = { ...req.body };
  delete reqBody.projectId;

  const execution = await TestExecution.findOneAndUpdate(
    { _id: req.params.id, projectId: req.projectScope.projectId },
    reqBody,
    {
      new: true,
      runValidators: true,
    }
  );

  if (execution) {
    // WP-024: covers both a plain field update and a status-change --
    // TestExecution has no dedicated status-transition endpoint (unlike
    // testcase/requirement/defect), status is just another field on this
    // same PUT, so 'update' is the correct action here rather than a
    // separate 'status-change' call site.
    await audit(req, {
      entityType: 'testexecution',
      entityId: execution.TestExecutionId,
      action: 'update',
      after: reqBody
    });

    // WP-030: same call site as the audit() call directly above and the
    // same reasoning for why it belongs here rather than a dedicated
    // status-transition endpoint -- TestExecution has no separate one
    // (unlike testcase/requirement), status is just another field on this
    // same PUT. correlationId carried through so a consumer's log line can
    // be joined back to this request, matching WP-024's audit events.
    // projectId (WP-021b) carried through too, same as testRepoService's
    // STATUS_CHANGED publish -- notificationService's consumer already
    // reads payload.projectId (and tolerates it being absent), so this is
    // a pure correctness improvement, not a new required field on that
    // side.
    await publishEvent(EVENT_STREAMS.EXECUTION_COMPLETED, {
      entityType: 'testexecution',
      entityId: execution.TestExecutionId,
      TestExecutionId: execution.TestExecutionId,
      TestPlanId: execution.TestPlanId,
      assignedTo: execution.assignedTo,
      projectId: execution.projectId,
      correlationId: req.correlationId
    });
  } else {
    // WP-021b: same 404 upgrade as getTestExecution above -- a
    // scope-mismatched or nonexistent id is now reported explicitly
    // rather than a 200 with data: null.
    return next(new ErrorResponse(`No test execution found with id ${req.params.id}`, 404));
  }

  res.status(200).json({
    success: true,
    data: execution,
  });
});

exports.deleteTestExecution = asyncHandler(async (req, res, next) => {
  const deleted = await TestExecution.findOneAndDelete({ _id: req.params.id, projectId: req.projectScope.projectId });

  if (!deleted) {
    // WP-021b: same 404 upgrade as getTestExecution above.
    return next(new ErrorResponse(`No test execution found with id ${req.params.id}`, 404));
  }

  await audit(req, {
    entityType: 'testexecution',
    entityId: deleted.TestExecutionId,
    action: 'delete',
    before: { TestExecutionId: deleted.TestExecutionId }
  });

  res.status(200).json({
    success: true,
    data: {},
  });
});

// TD-23: previously a raw positional `$set` via TestExecution.updateOne(),
// which bypasses Mongoose schema casting/validation entirely for nested
// array elements (see the comment on ExecutionTestCaseSchema in
// ../models/TestExecution.js). Refactored to fetch-modify-save so every
// write to TestCases[] goes through the schema: casting of TestSteps'
// sub-schema, and validation of TestStatus/'Executed By' as declared types.
//
// Concurrency note: this trades the old approach's single atomic
// updateOne() for a read-then-write. That is a real, deliberate trade-off,
// not an oversight:
//   - Only the paths this handler actually touches (TestSteps, TestStatus,
//     'Executed By' on the ONE matched TestCases subdocument) are marked
//     modified and sent back to Mongo as a targeted $set — save() does not
//     serialize the whole document, so a concurrent write to a *different*
//     field (e.g. a concurrent updateAttachment call for the same test
//     case, or any update to a different test case in the same execution)
//     is not clobbered.
//   - Replacing the TestSteps array wholesale *is* tracked by Mongoose's
//     default versioning (the schema's implicit __v), so save() now
//     includes an __v check and throws a VersionError instead of silently
//     overwriting if the document changed between the read and the write.
//     The old raw $set had no such protection (silent last-write-wins).
//     This is a strictly safer behavior change for the same-document,
//     concurrent-array-write case, called out per GR-3 rather than left
//     implicit.
//   - validateModifiedOnly limits validation to the paths actually
//     touched, so a pre-existing, differently-shaped sibling TestCases
//     entry elsewhere in the same array can't block this save.
//
// WP-021b: the lookup by TestExecutionId (a business string id, not the
// Mongo _id) is scoped to req.projectScope.projectId too -- same rule as
// every other lookup in this file, so a caller scoped to project A can't
// touch project B's execution just because it guessed/enumerated a
// TestExecutionId string.
exports.updateTestStep = asyncHandler(async(req,res,next) => {
  let tcid = req.query.tcid
  let exeid = req.query.exeid
  // WP-F07b Task 1 -- see the helpers above. Absent (no caller has been
  // updated to send it yet -- Task 4 is the frontend) resolves to 0, which
  // is every pre-existing row's iteration, so this is unchanged behaviour
  // for every caller that doesn't know about iterations yet.
  const iterationIndex = resolveIterationIndex(req.query.iterationIndex);
  const user = req.kauth.grant.access_token.content;
  const username = user;

  const execution = await TestExecution.findOne({
    TestExecutionId: exeid,
    projectId: req.projectScope.projectId,
    ...caseIterationQuery(tcid, iterationIndex)
  });
  let result = { acknowledged: true, matchedCount: 0, modifiedCount: 0 };

  if (execution) {
    const testCase = findCaseIteration(execution, tcid, iterationIndex);
    if (testCase) {
      result.matchedCount = 1;
      testCase.set({
        TestSteps: req.body['TestSteps'],
        TestStatus: req.body['TestStatus'],
        'Executed By': username.sub,
      });
      // Fix round 1 (review, minor) -- a genuine concurrent-write conflict
      // (the __v optimistic-lock check baked into save()'s delta, see the
      // header comment above) used to surface as an UNCAUGHT 500: a real,
      // actionable "someone else changed this at the same time" condition
      // indistinguishable from a server bug. 409 + a retry message is the
      // honest answer, matching the delete-guard 409 precedent elsewhere
      // in this codebase (e.g. testRepoService's deleteDataset).
      try {
        await execution.save({ validateModifiedOnly: true });
      } catch (err) {
        if (err.name === 'VersionError') {
          return next(new ErrorResponse(
            'This test case was updated by someone else at the same time -- reload and retry',
            409
          ));
        }
        throw err;
      }
      result.modifiedCount = 1;
    }
  }

  res.status(200).json({
    success: true,
    data: result,
  });
})

// TD-23: same fetch-modify-save refactor and concurrency reasoning as
// updateTestStep above — only the 'attachment' path on the matched
// TestCases subdocument is touched/validated. WP-021b: same
// projectId-scoped lookup as updateTestStep above.
exports.updateAttachment = asyncHandler(async(req,res,next) => {
  let tcid = req.query.tcid
  let exeid = req.query.exeid
  // WP-F07b Task 1 -- same iteration resolution as updateTestStep above.
  const iterationIndex = resolveIterationIndex(req.query.iterationIndex);

  const execution = await TestExecution.findOne({
    TestExecutionId: exeid,
    projectId: req.projectScope.projectId,
    ...caseIterationQuery(tcid, iterationIndex)
  });
  let result = { acknowledged: true, matchedCount: 0, modifiedCount: 0 };

  if (execution) {
    const testCase = findCaseIteration(execution, tcid, iterationIndex);
    if (testCase) {
      result.matchedCount = 1;
      testCase.set({ attachment: req.body['attachment'] });
      // Fix round 1 (review, minor) -- same VersionError -> 409 handling
      // as updateTestStep above, and the same reasoning.
      try {
        await execution.save({ validateModifiedOnly: true });
      } catch (err) {
        if (err.name === 'VersionError') {
          return next(new ErrorResponse(
            'This test case was updated by someone else at the same time -- reload and retry',
            409
          ));
        }
        throw err;
      }
      result.modifiedCount = 1;
    }
  }

  res.status(200).json({
    success: true,
    data: result,
  });
})


// WP-F07b Task 1 -- aggregation-expression equivalent of matchesCaseIteration
// above, for the two $filter stages in getExecutionTestCaseDetails below.
// Not one of the six audited addressing sites (those are the findOne/.find()
// pair using caseIterationQuery/findCaseIteration further down this same
// function) -- added alongside them anyway so this function's third read
// mechanism doesn't drift from the other two now that TestCases rows carry
// iterationIndex at all. $ifNull mirrors `?? 0`: a stored null or a
// genuinely-absent field (a pre-backfill document; aggregation expressions,
// like the raw query in caseIterationQuery, never see Mongoose's own
// `default: 0`) both resolve to 0 before the comparison.
function caseIterationFilterCond(tcid, iterationIndex) {
  return {
    $and: [
      { $eq: ['$$testCase.TestCaseId', tcid] },
      { $eq: [{ $ifNull: ['$$testCase.iterationIndex', 0] }, iterationIndex] }
    ]
  };
}

// WP-F07b Task 2 -- marks every step 'No Run', same convention the
// enrichment write has always used for a freshly-fetched case (mutates in
// place; the caller passes an array it owns, never a live Mongoose doc).
function markStepsNoRun(steps) {
  for (const step of steps || []) {
    step.status = 'No Run';
  }
  return steps;
}

// WP-F07b Task 2 -- resolves a bound case's dataset via testRepoService's
// OWN, already-existing F07a read endpoint (GET /api/v1/dataset/:id) --
// not a new parameter bolted onto the testrepo route. The testrepo route's
// surface (`?expand=steps&substitute=<i>`) stays exactly F07a's: it can
// hand back one row's SUBSTITUTED steps, but never the raw {columns, rows}
// a snapshot needs for `iterationValues` (R5's per-row data-values
// context), so that part has to come from the dataset itself.
//
// A missing/dangling binding (deleted dataset, cross-project reference
// that somehow got stored) degrades to `{rows: [], columns: []}` -- the
// same shape a genuinely empty dataset produces -- so the caller has one
// fallback path for both, never a 500. Any OTHER failure (network, 5xx)
// is rethrown: that is a real error, not a caller mistake to paper over.
async function fetchDatasetForCase(datasetId, headers) {
  if (!datasetId) {
    return { rows: [], columns: [] };
  }
  try {
    const datasetResp = await requestWithRetry({
      method: 'get',
      url: `http://${process.env.testRepoService}/api/v1/dataset/${datasetId}`,
      headers
    });
    return {
      rows: datasetResp.data.data.rows || [],
      columns: datasetResp.data.data.columns || []
    };
  } catch (err) {
    if (err.response && err.response.status === 404) {
      return { rows: [], columns: [] };
    }
    throw err;
  }
}

exports.getExecutionTestCaseDetails = asyncHandler(async (req, res, next) => {
  let tcid = req.query.tcid
  let exeid = req.query.exeid
  // WP-F07b Task 1 -- same iteration resolution as updateTestStep/
  // updateAttachment above.
  const iterationIndex = resolveIterationIndex(req.query.iterationIndex);
  let resp = await TestExecution.aggregate([
    { $match: { TestExecutionId:  exeid, projectId: req.projectScope.projectId } },
    {
      $project: {
        TestCases: {
          $filter: {
            input: "$TestCases",
            as: "testCase",
            cond: caseIterationFilterCond(tcid, iterationIndex),
          },
        },
        "TestExecutionId": 1,
      },
    },
  ]);
  if(!resp[0] || !resp[0]['TestCases'][0])
  {
    return res.status(404).json({
      success: false,
      error: `No test execution found with TestExecutionId ${exeid} in this project`
    });
  }
  if(!resp[0]['TestCases'][0]['TestSteps'])
  {
    let headers = {
      'Authorization': `${req.headers.authorization}`,
      [CORRELATION_HEADER]: req.correlationId,
      [PROJECT_ID_HEADER]: String(req.projectScope.projectId),
    }
    logger.info('fetching test case details from testRepoService', {
      correlationId: req.correlationId,
      tcid,
      exeid
    })
    // WP-F06 -- expand=steps because ExecutionTestStepSchema is strict
    // (testStep/Expected/status): an unexpanded reference row would have
    // sharedStepId stripped on save and be snapshotted into the run as a
    // blank step. An execution is a point-in-time snapshot by design
    // (this is what keeps a finished run honest when the shared step is
    // later edited), so it must snapshot the resolved text.
    //
    // WP-F07b Task 2 -- fetched WITHOUT `substitute` on purpose: this read
    // both detects a bound dataset (`datasetId` survives an unsubstituted
    // expand=steps fetch untouched) and doubles as the exact content for
    // the "behave like unbound" fallback below (no dataset bound, or one
    // with zero rows) -- one fetch serves both jobs, no second call.
    let tcDetails = await requestWithRetry({
      method: 'get',
      url: `http://${process.env.testRepoService}/api/v1/testrepo?TestCaseId=${tcid}&expand=steps`,
      headers
    })
    logger.info('received test case details from testRepoService', {
      correlationId: req.correlationId,
      tcid,
      status: tcDetails.status
    })

    const baseCase = tcDetails.data.data[0];
    const dataset = await fetchDatasetForCase(baseCase.datasetId, headers);

    const execution = await TestExecution.findOne({
      TestExecutionId: exeid,
      projectId: req.projectScope.projectId,
      ...caseIterationQuery(tcid, iterationIndex)
    });

    if (execution) {
      const testCase = findCaseIteration(execution, tcid, iterationIndex);
      if (testCase && dataset.rows.length === 0) {
        // Unbound case, OR a bound dataset with zero rows -- exactly ONE
        // row, iterationIndex unchanged (still whatever the stub already
        // had, i.e. 0 -- R1), `iterationValues` left unset. This is the
        // regression guard for every pre-WP-F07b run: identical write to
        // the one this handler has always made.
        //
        // TD-23: 'Test Status' (with a space) is a confirmed-dead field —
        // never read anywhere in the repo (grepped, including frontend/)
        // — so it's dropped here rather than written. Stored data on
        // already-enriched documents is left untouched; only this write
        // site changes.
        baseCase['attachment'] = [];
        markStepsNoRun(baseCase['TestSteps']);
        testCase.set(baseCase);
        await execution.save({ validateModifiedOnly: true });
      } else if (testCase) {
        // WP-F07b Task 2 -- bound dataset with N>=1 rows: turn the single
        // stub row into N case rows, one per data row. Each row fetches
        // its OWN substituted text via F07a's existing `?substitute=<i>`
        // (never invented here), which is also why this is N sequential
        // round trips rather than one -- the endpoint's contract only
        // ever resolves one row at a time.
        //
        // R2: each row snapshots its resolved text and its own
        // `iterationValues` at THIS moment -- editing the dataset
        // afterwards never rewrites a stored row, exactly like every
        // other execution snapshot in this file.
        //
        // Fix round 1 (review, Important): this used to remove the stub
        // and `splice()` in N replacements. Mongoose's DocumentArray#splice
        // marks the WHOLE `TestCases` array modified, so save() sent the
        // entire array back as one `$set` -- and that is a genuine, PROVEN
        // silent-data-loss hazard, not just a theoretical one: a
        // concurrent PLAIN update to a DIFFERENT case in the same
        // execution (e.g. a tester marking case B failed via
        // updateTestStep), landing between this handler's own read of
        // `execution` and this save, is wiped back to its pre-update value
        // with NO error -- a plain field write never bumps `__v`, so
        // save()'s own optimistic-lock check (the VersionError path fixed
        // above) never fires to catch it either.
        //
        // Fixed by never replacing the stub: it STAYS in place and becomes
        // iteration 0 via the same targeted `testCase.set()` the
        // single-row branch above already uses (a real MongoDB $set on
        // just `TestCases.<its index>.<field>`, proven live via
        // mongoose.set('debug', ...) to never touch any other array
        // element). Iterations 1..N-1 are appended with
        // DocumentArray#push, which Mongoose registers as a genuine $push
        // atomic (mongoose/lib/types/core_array.js, confirmed by reading
        // the source: push() calls `_registerAtomic('$push', ...)`, a
        // different code path from splice()'s `_registerAtomic('$set',
        // this)`) -- an atomic append that reads and rewrites nothing
        // about any OTHER element, concurrent or not.
        //
        // Two separate save() calls, deliberately, not one: MongoDB
        // itself rejects a single update document that both $set's a
        // nested path (TestCases.<i>.field, from the .set() below) and
        // $push'es the SAME top-level array path in the same command
        // ("conflict at TestCases"), so the in-place update has to be its
        // own save() before the append's $push is added in a second one.
        //
        // Appending (instead of preserving each row's "natural" position)
        // is safe: every `TestCases[]` consumer was grepped for this fix
        // (reportingService's planProgress/passRateTrend/workload,
        // ingestion's adapters/normalize.js, frontend's TestRunDetail.tsx)
        // and none depends on array order -- only on TestCaseId (+
        // iterationIndex, Task 1), which already carries the ordering
        // meaning.
        const stubFields = testCase.toObject();
        delete stubFields._id;

        const rowsToAppend = [];
        for (let i = 0; i < dataset.rows.length; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          const substitutedResp = await requestWithRetry({
            method: 'get',
            url: `http://${process.env.testRepoService}/api/v1/testrepo?TestCaseId=${tcid}&expand=steps&substitute=${i}`,
            headers
          });
          const rowCase = substitutedResp.data.data[0];
          delete rowCase._id;
          markStepsNoRun(rowCase['TestSteps']);

          const iterationValues = {};
          dataset.columns.forEach((name, colIdx) => {
            iterationValues[name] = dataset.rows[i][colIdx];
          });

          if (i === 0) {
            rowCase.attachment = [];
            testCase.set({ ...rowCase, iterationIndex: 0, iterationValues });
          } else {
            rowsToAppend.push({
              ...stubFields,
              ...rowCase,
              attachment: [],
              iterationIndex: i,
              iterationValues
            });
          }
        }
        await execution.save({ validateModifiedOnly: true });
        if (rowsToAppend.length) {
          execution.TestCases.push(...rowsToAppend);
          await execution.save({ validateModifiedOnly: true });
        }
      }
    }

    resp = await TestExecution.aggregate([
      { $match: { TestExecutionId:  exeid, projectId: req.projectScope.projectId } },
      {
        $project: {
          TestCases: {
            $filter: {
              input: "$TestCases",
              as: "testCase",
              cond: caseIterationFilterCond(tcid, iterationIndex),
            },
          },
          "TestExecutionId": 1,
        },
      },
    ]);
  }
  res.status(200).json({
    success: true,
    data: resp,
  });
});

// WP-F01 -- see controllers/testplan.js for why this is local rather than
// promoted into @srckube/service-core.
const escapeRegex = (text) => String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// WP-F01
// @desc      Search test runs by business id
// @route     GET /api/v1/testexecution/wildcardsearch?search=<text>
// @access    Private (read)
//
// FINDING, recorded rather than worked around: TestExecution has NO
// human-readable text field at all -- verified by enumerating the schema's
// top-level keys in models/TestExecution.js, where the only strings are
// TestExecutionId, assignedTo, source and ciRunUrl. assignedTo is a
// Keycloak subject UUID, not a name (confirmed against live data), so it
// is not searchable text either: nobody types a UUID. That leaves the
// business id as the only thing a run can be found by.
//
// This route therefore deliberately searches ONE field, unlike its
// testplan.js counterpart. It also does NOT join to the parent plan to
// borrow that plan's objective: that would turn one search into N+1
// queries. Giving a run a name of its own is WP-F09, and this narrowness
// is part of that package's justification.
exports.wildcardSearch = asyncHandler(async (req, res, next) => {
  const search = escapeRegex(req.query.search);

  // Final-review fix: only TestExecutionId is ever read by the one
  // consumer (frontend/src/workbench/search/entitySearchConfigs.ts's
  // testRunSearchConfig) -- projectId is kept too because api.test.js's
  // "scopes every result to the caller's project" assertion reads it.
  // Without this .select(), every match returned its full embedded
  // TestCases[] tree (TestSteps[], TestCaseDescription, dynamicFields,
  // attachment: [Mixed]) for a route that renders nothing but a list of
  // ids, and unlike the / list route (advancedResults) this route is not
  // paginated either.
  const runList = await TestExecution.find({
    projectId: req.projectScope.projectId,
    TestExecutionId: { $regex: search, $options: 'i' }
  }).select('TestExecutionId projectId');

  res.status(200).json({
    success: true,
    data: runList
  });
});

// WP-F03 -- bulk assign and delete for test runs. See
// controllers/testplan.js's bulk header and
// testRepoService/controllers/testrepo.js:309-520 for the inherited
// all-or-nothing and per-item-audit rules.
//
// ASSIGN ONLY on the PATCH side, deliberately: TestExecution has
// `assignedTo` but no lifecycle `status` field (verified against
// models/TestExecution.js), so 'status' is rejected rather than silently
// accepted.
const BULK_MAX_ITEMS_EXEC = 500;

function validateBulkExecIds(req, next) {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    next(new ErrorResponse('ids must be a non-empty array', 400));
    return null;
  }
  if (ids.length > BULK_MAX_ITEMS_EXEC) {
    next(new ErrorResponse(`Bulk operations are limited to ${BULK_MAX_ITEMS_EXEC} items at a time (got ${ids.length})`, 400));
    return null;
  }
  return ids;
}

// @desc      Bulk assign test runs, all-or-nothing.
// @route     PATCH /api/v1/testexecution/bulk
// @body      { ids: string[], action: 'assign', assignedTo: string }
// @access    Private (write)
exports.bulkUpdateTestExecutions = asyncHandler(async (req, res, next) => {
  const ids = validateBulkExecIds(req, next);
  if (!ids) return;

  const { action, assignedTo } = req.body;
  if (action !== 'assign') {
    return next(new ErrorResponse("action must be 'assign' (test runs have no lifecycle status field)", 400));
  }
  if (!assignedTo) {
    return next(new ErrorResponse('assignedTo is required for action "assign"', 400));
  }

  const found = await TestExecution.find({ _id: { $in: ids }, projectId: req.projectScope.projectId });
  const foundIds = found.map((d) => String(d._id));
  const missingIds = ids.filter((id) => !foundIds.includes(String(id)));
  if (missingIds.length > 0) {
    return res.status(422).json({
      success: false,
      policy: 'all-or-nothing',
      error: 'No test run was changed: some ids were not found in this project',
      missingIds
    });
  }

  const previous = new Map(found.map((d) => [String(d._id), d.assignedTo]));
  const applied = [];
  try {
    for (const doc of found) {
      await TestExecution.findOneAndUpdate(
        { _id: doc._id, projectId: req.projectScope.projectId },
        { assignedTo }
      );
      applied.push(String(doc._id));
      await audit(req, {
        entityType: 'testexecution',
        entityId: doc.TestExecutionId,
        action: 'bulk-assign',
        after: { assignedTo }
      });
    }
  } catch (err) {
    for (const id of applied) {
      await TestExecution.findOneAndUpdate(
        { _id: id, projectId: req.projectScope.projectId },
        { assignedTo: previous.get(id) }
      );
    }
    return next(err);
  }

  res.status(200).json({ success: true, policy: 'all-or-nothing', updated: applied.length });
});

// @desc      Bulk delete test runs, all-or-nothing.
// @route     DELETE /api/v1/testexecution/bulk
// @access    Private (delete)
exports.bulkDeleteTestExecutions = asyncHandler(async (req, res, next) => {
  const ids = validateBulkExecIds(req, next);
  if (!ids) return;

  const found = await TestExecution.find({ _id: { $in: ids }, projectId: req.projectScope.projectId });
  const foundIds = found.map((d) => String(d._id));
  const missingIds = ids.filter((id) => !foundIds.includes(String(id)));
  if (missingIds.length > 0) {
    return res.status(422).json({
      success: false,
      policy: 'all-or-nothing',
      error: 'Nothing was deleted: some ids were not found in this project',
      missingIds
    });
  }

  // Compensating rollback, following testRepoService/controllers/
  // testrepo.js:470-487 in shape: validation already passed, so a failure
  // here is a DB fault, not bad input -- restore whatever this batch
  // already removed rather than leaving a half-deleted set behind. The
  // all-or-nothing promise BulkActionBar shows the user has to hold on the
  // delete path too, not just the update path.
  //
  // ONE DELIBERATE DIVERGENCE from the canonical: it restores with
  // `new Model(doc.toObject()).save()`, which re-runs the model's
  // pre('save') hook. That hook guards on `this.isNew` -- true for a
  // reconstructed document even with _id set -- so it calls
  // getNextSequence() and OVERWRITES the business id. The canonical would
  // therefore restore each document under a NEW id, orphaning every
  // linkIssue and audit row pointing at the old one. Restoring through the
  // driver bypasses model middleware, which is correct here: this is
  // reinstating an exact prior state, not creating a document. The same
  // defect exists in the canonical and is tracked separately -- do not
  // "fix" this back to match it.
  const deletedIds = [];
  try {
    for (const doc of found) {
      // eslint-disable-next-line no-await-in-loop
      await TestExecution.findOneAndDelete({ _id: doc._id, projectId: req.projectScope.projectId });
      deletedIds.push(doc._id);
    }
  } catch (err) {
    for (const doc of found) {
      if (deletedIds.some((id) => String(id) === String(doc._id))) {
        // eslint-disable-next-line no-await-in-loop
        await TestExecution.collection.insertOne(doc.toObject()).catch(() => {});
      }
    }
    throw new ErrorResponse(`Bulk delete failed partway through (${deletedIds.length}/${found.length} items); all deletions rolled back: ${err.message}`, 500);
  }

  // Audited after the write loop, once per item, with a `before` snapshot:
  // on a delete the document is gone, so this row is the only surviving
  // record of what it contained.
  for (const doc of found) {
    // eslint-disable-next-line no-await-in-loop
    await audit(req, {
      entityType: 'testexecution',
      entityId: doc.TestExecutionId,
      action: 'bulk-delete',
      before: { TestExecutionId: doc.TestExecutionId, TestPlanId: doc.TestPlanId, assignedTo: doc.assignedTo }
    });
  }

  res.status(200).json({ success: true, policy: 'all-or-nothing', deleted: found.length });
});
