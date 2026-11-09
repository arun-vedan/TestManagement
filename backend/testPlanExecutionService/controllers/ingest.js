// WP-033 -- CI result ingestion (closes BG-09/PB-07, the product's
// differentiator loop per strategy doc §52.23).
//
// POST /api/v1/testexecution/ingest -- authenticated by API key
// (requireAuth('results:write'), see routes/testexecution.js), accepts a
// Cucumber JSON report, a JUnit XML report, or an already-normalized JSON
// payload, and creates exactly ONE new TestExecution document per call,
// flagged source: 'ci', with one TestCases[] entry per test result found.
//
// MAPPING DECISION (GR-1 -- read before writing, see EXECUTION_LOG.md's
// WP-033 entry for the full report):
//   - TestExecution is this codebase's existing "one run" concept
//     (TestExecutionId = "Run-N", see ../models/TestExecution.js's pre-save
//     hook) with a TestCases[] array of per-test-case results nested inside
//     it -- the exact same shape a human-driven run already uses (see
//     createTestExecution/updateTestStep in ./testexecution.js). A CI
//     report (one Cucumber JSON file or one JUnit XML file) is naturally
//     "one run producing N test-case results", so it maps 1:1 onto one NEW
//     TestExecution document -- never appended onto a pre-existing
//     human-created run (there is no reliable way to know which existing
//     run a CI report corresponds to, and conflating the two would make a
//     human's in-progress run silently mutate under them).
//   - `source: 'ci'` lives on the TestExecution document (whole-run
//     metadata), `ciEnvironment`/`durationMs`/`startedAt`/`errorMessage`
//     live per-TestCases[]-entry (the WP's normalized payload allows these
//     to vary per individual result) -- see the field comments in
//     ../models/TestExecution.js for the additive schema fields this WP
//     introduces.
//   - Every field on ExecutionTestCaseSchema is DECLARED (strict schema,
//     TD-23/WP-013 removed strict:false) -- an ingest payload with typos or
//     extra fields is silently dropped, not rejected, by Mongoose itself,
//     which is why this controller validates the incoming shape itself
//     BEFORE calling TestExecution.create() (see adapters/normalize.js's
//     validateResult) and returns 400 with field-level errors rather than
//     relying on schema validation errors, which would be generic/silent
//     for unknown fields and reference internal field names, not the
//     caller's payload shape.
const {
  asyncHandler,
  publishEvent,
  createLogger
} = require('@srckube/service-core');
const TestExecution = require('../models/TestExecution');
const { validateResult, toTestCaseSubdoc } = require('../adapters/normalize');
const { parseCucumberJson } = require('../adapters/cucumberAdapter');
const { parseJunitXml } = require('../adapters/junitAdapter');

const logger = createLogger('testPlanExecutionService:ingest');

// WP-030 established EVENT_STREAMS as the canonical place stream names are
// spelled once and shared -- but that file lives in
// backend/shared/service-core/ (eventStreams.js), out of this WP's scope
// (concurrent agents may be touching service-core; this WP was explicitly
// told not to). publishEvent() itself only ever requires a plain string, so
// this literal is behaviorally identical to an EVENT_STREAMS.* constant; any
// future consumer (e.g. reportingService, WP-040) subscribes to this exact
// same string. Flagged here and in EXECUTION_LOG.md as a follow-up: promote
// this to EVENT_STREAMS.CI_RESULT_RECEIVED once service-core is free to
// touch again.
const CI_RESULT_RECEIVED_STREAM = 'ci-result-received';

function detectFormat(req) {
  const explicit = (req.query.format || '').toLowerCase();
  if (explicit === 'cucumber' || explicit === 'junit' || explicit === 'normalized') {
    return explicit;
  }
  if (req.is('application/xml') || req.is('text/xml')) {
    return 'junit';
  }
  if (Array.isArray(req.body)) {
    return 'cucumber';
  }
  return 'normalized';
}

// Builds the raw (pre-validation) normalized results array for every
// supported input format. Throws a plain Error on a structurally-broken
// report (malformed XML/JSON, no results found at all) -- the caller (the
// exported handler below) turns that into a 400 with a single field error,
// distinct from the per-result field errors validateResult() produces for a
// structurally-valid-but-semantically-wrong payload.
function buildRawResults(req, format) {
  const envelope = {
    ciRunUrl: req.query.ciRunUrl,
    environment: req.query.environment
  };

  if (format === 'cucumber') {
    return parseCucumberJson(req.body, envelope);
  }

  if (format === 'junit') {
    if (typeof req.body !== 'string' || !req.body.trim()) {
      throw new Error('Expected a non-empty JUnit XML body (Content-Type: application/xml or text/xml)');
    }
    return parseJunitXml(req.body, envelope);
  }

  // 'normalized'
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    throw new Error('Expected a JSON object body for the normalized format (either a single result, or {results: [...]})');
  }
  if (Array.isArray(req.body.results)) {
    return req.body.results.map((r) => ({
      ...r,
      ciRunUrl: r.ciRunUrl !== undefined ? r.ciRunUrl : req.body.ciRunUrl,
      environment: r.environment !== undefined ? r.environment : req.body.environment
    }));
  }
  // Single-result normalized payload -- the shape the WP's own text
  // describes: {projectId, testCaseId or tag, status, durationMs,
  // startedAt, steps?, errorMessage?, ciRunUrl?, environment?}.
  return [req.body];
}

exports.ingestResults = asyncHandler(async (req, res, next) => {
  const format = detectFormat(req);

  let rawResults;
  try {
    rawResults = buildRawResults(req, format);
  } catch (err) {
    return res.status(400).json({
      success: false,
      errors: [{ field: 'body', message: err.message }]
    });
  }

  if (!Array.isArray(rawResults) || rawResults.length === 0) {
    return res.status(400).json({
      success: false,
      errors: [{ field: 'body', message: `No test results were found in the ${format} report` }]
    });
  }

  // The caller's project is already verified by requireAuth() (the API
  // key's bound projectId, matched exactly against X-Project-Id -- see
  // @srckube/service-core's middleware/apiKeyAuth.js). A `projectId` on the
  // payload itself (present per the WP's normalized-payload description) is
  // therefore informational, not authoritative -- but if the caller
  // supplies one that DISAGREES with the verified project, that is exactly
  // the kind of malformed/inconsistent payload GR-1 says to reject with a
  // field error rather than silently trusting the header over the body (or
  // vice versa) without telling the caller.
  const verifiedProjectId = req.projectScope && req.projectScope.projectId;
  const fieldErrors = [];
  rawResults.forEach((result, index) => {
    const errs = validateResult(result, rawResults.length > 1 ? index : undefined);
    fieldErrors.push(...errs);
    if (
      result &&
      result.projectId !== undefined &&
      result.projectId !== null &&
      Number(result.projectId) !== verifiedProjectId
    ) {
      fieldErrors.push({
        field: rawResults.length > 1 ? `results[${index}].projectId` : 'projectId',
        message: `projectId '${result.projectId}' does not match the authenticated project (${verifiedProjectId})`
      });
    }
  });

  if (fieldErrors.length > 0) {
    return res.status(400).json({ success: false, errors: fieldErrors });
  }

  const ciRunUrl = rawResults.find((r) => r.ciRunUrl)?.ciRunUrl;

  // WP-021b: TestExecution.projectId is now a required schema field (see
  // ../models/TestExecution.js). Stamped from verifiedProjectId -- the
  // SAME value req.projectScope.projectId already resolved to above (the
  // API key's own bound projectId, or a human caller's verified
  // membership) -- never re-derived here, so a CI-ingested execution lands
  // in exactly the key's/caller's bound project, matching every other
  // create path in this service (createTestPlan/createTestExecution).
  const execution = await TestExecution.create({
    source: 'ci',
    ciRunUrl,
    projectId: verifiedProjectId,
    TestCases: rawResults.map((r, i) => toTestCaseSubdoc(r, i + 1))
  });

  logger.info('CI results ingested', {
    correlationId: req.correlationId,
    format,
    TestExecutionId: execution.TestExecutionId,
    resultCount: rawResults.length,
    projectId: verifiedProjectId
  });

  // WP-030 contract: publishEvent() never throws/rejects and must not be
  // able to fail this request (fail-OPEN, unlike requireAuth/
  // requireProjectScope above it, which are correctness boundaries -- see
  // service-core/events.js's header comment). correlationId propagated per
  // GR-3/WP-024 convention.
  await publishEvent(CI_RESULT_RECEIVED_STREAM, {
    entityType: 'testexecution',
    entityId: execution.TestExecutionId,
    TestExecutionId: execution.TestExecutionId,
    projectId: verifiedProjectId,
    source: 'ci',
    format,
    resultCount: rawResults.length,
    ciRunUrl,
    correlationId: req.correlationId
  });

  res.status(201).json({
    success: true,
    data: execution
  });
});
