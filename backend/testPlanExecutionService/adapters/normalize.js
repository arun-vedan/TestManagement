// WP-033 -- CI result ingestion: the one shared status vocabulary + field
// validator every adapter (cucumberAdapter.js, junitAdapter.js) and the
// directly-posted "normalized" JSON shape all funnel through, so there is
// exactly one place that decides what counts as Pass/Fail/No Run and what
// counts as a malformed payload.
//
// MAPPING DECISION (recorded here + EXECUTION_LOG.md's WP-033 entry):
//   - Internal vocabulary (matches the values already live in real
//     TestExecution.TestCases[].TestStatus data, e.g. Run-7 -- see GR-1's
//     dump-check note in ../models/TestExecution.js): 'Pass' | 'Fail' |
//     'No Run'.
//   - CI-facing vocabulary accepted on input, case-insensitively: passed/
//     pass -> Pass; failed/fail/error/ambiguous -> Fail; skipped/skip/
//     pending/undefined -> No Run. 'ambiguous' (Cucumber's status for a step
//     matching more than one step definition) is treated as a failure, not
//     a skip -- it means the run itself is broken, not merely not-yet-run.
//   - The mapper is also fed values already in the internal vocabulary
//     ('Pass'/'Fail'/'No Run') by lower-casing before lookup, so a caller
//     posting the normalized JSON shape directly with our own vocabulary
//     round-trips unchanged through the same one function.
const STATUS_MAP = {
  passed: 'Pass',
  pass: 'Pass',
  failed: 'Fail',
  fail: 'Fail',
  error: 'Fail',
  ambiguous: 'Fail',
  skipped: 'No Run',
  skip: 'No Run',
  pending: 'No Run',
  undefined: 'No Run',
  'no run': 'No Run'
};

const ALLOWED_STATUS_INPUTS = Object.keys(STATUS_MAP);

function normalizeStatus(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  return STATUS_MAP[raw.trim().toLowerCase()] || null;
}

// Builds the TestCases[] TestCaseId this result will be stored under.
// Prefers an explicit testCaseId (assumed to reference a real
// testRepoService TestCaseId) verbatim. Falls back to a `TAG:`-namespaced
// form of `tag` (a free-text CI tag/scenario-name/testcase-name with no
// guarantee of matching a real TestCaseId) so the two are never
// indistinguishable downstream -- a reader can tell "this maps to a known
// test case" from "this is merely what the CI tool called it" at a glance.
function buildTestCaseId({ testCaseId, tag }) {
  if (typeof testCaseId === 'string' && testCaseId.trim()) {
    return testCaseId.trim();
  }
  if (typeof tag === 'string' && tag.trim()) {
    return `TAG:${tag.trim()}`;
  }
  return null;
}

// Validates one normalized result object (the shape adapters produce, and
// the shape a direct "normalized" caller posts). Returns an array of
// { field, message } -- empty array means valid. Never throws.
function validateResult(result, index) {
  const errors = [];
  const prefix = (field) => (typeof index === 'number' ? `results[${index}].${field}` : field);

  if (!result || typeof result !== 'object') {
    return [{ field: prefix('_'), message: 'result must be an object' }];
  }

  const testCaseId = buildTestCaseId(result);
  if (!testCaseId) {
    errors.push({
      field: prefix('testCaseId'),
      message: 'either testCaseId or tag is required'
    });
  }

  if (result.status === undefined || result.status === null) {
    errors.push({ field: prefix('status'), message: 'status is required' });
  } else if (!normalizeStatus(result.status)) {
    errors.push({
      field: prefix('status'),
      message: `status must be one of: ${ALLOWED_STATUS_INPUTS.join(', ')} (case-insensitive), got '${result.status}'`
    });
  }

  if (result.durationMs !== undefined && result.durationMs !== null) {
    const n = Number(result.durationMs);
    if (!Number.isFinite(n) || n < 0) {
      errors.push({ field: prefix('durationMs'), message: 'durationMs must be a non-negative number' });
    }
  }

  if (result.startedAt !== undefined && result.startedAt !== null) {
    const d = new Date(result.startedAt);
    if (Number.isNaN(d.getTime())) {
      errors.push({ field: prefix('startedAt'), message: 'startedAt must be a valid date/time' });
    }
  }

  if (result.steps !== undefined && result.steps !== null && !Array.isArray(result.steps)) {
    errors.push({ field: prefix('steps'), message: 'steps must be an array when present' });
  }

  if (result.errorMessage !== undefined && result.errorMessage !== null && typeof result.errorMessage !== 'string') {
    errors.push({ field: prefix('errorMessage'), message: 'errorMessage must be a string when present' });
  }

  if (result.ciRunUrl !== undefined && result.ciRunUrl !== null && typeof result.ciRunUrl !== 'string') {
    errors.push({ field: prefix('ciRunUrl'), message: 'ciRunUrl must be a string when present' });
  }

  if (result.environment !== undefined && result.environment !== null && typeof result.environment !== 'string') {
    errors.push({ field: prefix('environment'), message: 'environment must be a string when present' });
  }

  return errors;
}

// Converts one already-validated normalized result into the
// ExecutionTestCaseSchema shape (see ../models/TestExecution.js).
function toTestCaseSubdoc(result, index) {
  const steps = Array.isArray(result.steps)
    ? result.steps.map((step) => ({
        testStep: step.testStep || step.name || step.keyword || '',
        Expected: step.Expected || '',
        status: normalizeStatus(step.status) || 'No Run'
      }))
    : [];

  return {
    id: index,
    TestCaseId: buildTestCaseId(result),
    TestCaseSummary: result.testCaseSummary || result.tag || result.testCaseId || '',
    TestStatus: normalizeStatus(result.status),
    TestSteps: steps,
    attachment: [],
    durationMs: result.durationMs !== undefined && result.durationMs !== null ? Number(result.durationMs) : undefined,
    startedAt: result.startedAt ? new Date(result.startedAt) : undefined,
    errorMessage: result.errorMessage || undefined,
    ciEnvironment: result.environment || undefined
  };
}

module.exports = {
  STATUS_MAP,
  ALLOWED_STATUS_INPUTS,
  normalizeStatus,
  buildTestCaseId,
  validateResult,
  toTestCaseSubdoc
};
