// WP-051 -- shape + server-side validation for AI-generated test-case
// candidates.
//
// THE MODEL'S OUTPUT SHAPE IS NEVER TRUSTED. providers/index.js's
// completeStructured() is schema-GUIDED, not schema-ENFORCED -- a real
// vendor can still return malformed/incomplete JSON (wrong types, missing
// keys, extra commentary coerced into a field), and openaiProvider.js
// parses whatever the vendor sends without validating it against the
// schema it was given. This module is the backstop: every candidate is
// re-validated here, in this service, before it is ever returned to a
// caller -- matching GR-8's "server-side validation of model output"
// requirement and the general rule that a schema passed to a provider is a
// *hint* to the model, not a guarantee about what comes back.
//
// Deliberately REPAIRS where the intent is unambiguous (trims whitespace,
// drops an individual malformed TestStep while keeping the rest of an
// otherwise-good candidate) and DROPS where it isn't (a candidate with no
// usable title, or with zero usable steps, is not a test case -- keeping a
// half-formed placeholder would be worse than omitting it, since a
// reviewer might accept it as-is).

const MAX_CANDIDATES = 5;
const DEFAULT_CANDIDATES = 3;

// The JSON-Schema-shaped hint sent to providers/index.js's
// completeStructured(). Matches testRepoService's real TestStepSchema
// ({testStep, Expected}) plus the create-payload fields the accept flow
// needs (TestCaseSummary, description -> TestCaseDescription,
// preconditions -- see backend/testRepoService/models/testrepo.js).
function buildCandidateSchema() {
  return {
    type: 'object',
    properties: {
      candidates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            TestCaseSummary: { type: 'string' },
            description: { type: 'string' },
            preconditions: { type: 'string' },
            TestSteps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  testStep: { type: 'string' },
                  Expected: { type: 'string' }
                }
              }
            }
          }
        }
      }
    }
  };
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Validates + repairs ONE raw candidate. Returns null if it can't be
// salvaged into something a reviewer could plausibly accept.
function repairCandidate(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const TestCaseSummary = cleanString(raw.TestCaseSummary);
  if (!TestCaseSummary) {
    // No title -- nothing for a reviewer to look at, not repairable.
    return null;
  }

  const description = cleanString(raw.description);
  const preconditions = cleanString(raw.preconditions);

  const rawSteps = Array.isArray(raw.TestSteps) ? raw.TestSteps : [];
  const TestSteps = [];
  rawSteps.forEach((step) => {
    if (!step || typeof step !== 'object') {
      return;
    }
    const testStep = cleanString(step.testStep);
    const Expected = cleanString(step.Expected);
    // A step missing either half isn't executable -- drop just that step,
    // keep the rest of the candidate.
    if (testStep && Expected) {
      TestSteps.push({ testStep, Expected });
    }
  });

  if (TestSteps.length === 0) {
    // A "test case" with zero usable steps isn't one -- drop the whole
    // candidate rather than return something a reviewer could mistake for
    // complete.
    return null;
  }

  const candidate = { TestCaseSummary, description, TestSteps };
  if (preconditions) {
    candidate.preconditions = preconditions;
  }
  return candidate;
}

// raw: whatever providers/index.js's completeStructured() returned as
// `.data` -- untyped, unvalidated. Returns
// { candidates, droppedCandidates, receivedCount }, never throws (a
// completely non-object/garbage `raw` just yields zero candidates, not an
// error -- the caller (controllers/ai.js) still returns 200 with an empty
// list plus the drop count, so the failure is visible rather than
// swallowed into a 500).
function validateAndRepairCandidates(raw, { count } = {}) {
  const rawCandidates = raw && Array.isArray(raw.candidates) ? raw.candidates : [];
  const repaired = [];
  let droppedCandidates = 0;

  rawCandidates.forEach((rc) => {
    const ok = repairCandidate(rc);
    if (ok) {
      repaired.push(ok);
    } else {
      droppedCandidates += 1;
    }
  });

  const limit = typeof count === 'number' && count > 0 ? count : MAX_CANDIDATES;
  const candidates = repaired.slice(0, limit);
  // Distinct from droppedCandidates (malformed, unsalvageable) -- these were
  // VALID but exceeded the requested count, so truncating them is not a
  // validation failure worth conflating with one.
  const truncatedCount = Math.max(0, repaired.length - candidates.length);

  return {
    candidates,
    droppedCandidates,
    truncatedCount,
    receivedCount: rawCandidates.length
  };
}

module.exports = {
  buildCandidateSchema,
  validateAndRepairCandidates,
  repairCandidate,
  MAX_CANDIDATES,
  DEFAULT_CANDIDATES
};
