const ErrorResponse = require('./errorResponse');

// WP-104 — shared helpers for the five `wildcardsearch` routes.
//
// PROMOTED FROM A LOCAL COPY, deliberately. WP-F01 introduced this exact
// escape as a one-line local const in
// testPlanExecutionService/controllers/{testplan,testexecution}.js and
// recorded why it stayed local: "promoting it to @srckube/service-core is a
// cross-service change, which is an escalation trigger for this package."
// WP-104 *is* a cross-service change by definition (it names three separate
// services), so that constraint no longer applies and the helper belongs
// here. The two local copies in testPlanExecutionService are byte-identical
// in behaviour and are intentionally left untouched by WP-104 (not in its
// scope); de-duplicating them onto this module is recorded as a follow-up.

// The characters that give a regex meaning beyond "these literal
// characters". Escaping them is what makes a search for "." mean the
// character rather than "match every document", and what makes "TC-1."
// stop matching "TC-11".
const REGEX_METACHARACTERS = /[.*+?^${}()|[\]\\]/g;

function escapeRegex(text) {
  return String(text === undefined || text === null ? '' : text).replace(REGEX_METACHARACTERS, '\\$&');
}

// An upper bound on the search term itself. Kong already rejects a very long
// query string with 414 before it reaches any service (measured: a 10 000
// character ?search= returns 414), but that is incidental protection from the
// gateway's URI limit, not this application's own rule -- a service reached
// directly, or behind a differently-configured ingress, would have none. This
// is the app's own bound.
const SEARCH_TERM_MAX_LENGTH = 200;

// A cap on how many documents a single search may return. The three routes
// WP-104 fixes had none at all: `?search=.` (or an empty search, which these
// routes used to accept) returned every matching document in the project,
// fully hydrated, in one JSON response. At the 20 000-test-case scale this
// product targets that is the real denial-of-service surface on these routes
// -- response size and memory, not regex backtracking (see EXECUTION_LOG.md's
// WP-104 entry for the measurements that ruled backtracking out on this
// engine). Overridable for an operator who wants a different ceiling.
function resolveSearchLimit() {
  const raw = process.env.WILDCARD_SEARCH_MAX_RESULTS;
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 100;
}

// Validate + escape in one place so all three controllers stay identical.
// Throws an ErrorResponse (400) that asyncHandler forwards to the shared
// errorHandler; previously a missing ?search= produced a Mongo error
// ("$regex has to be a string") surfaced as a 500, which is a server-fault
// status for what is purely bad input.
function requireSearchTerm(raw) {
  if (raw === undefined || raw === null) {
    throw new ErrorResponse('A search term is required: pass ?search=<text>', 400);
  }
  if (typeof raw !== 'string') {
    // e.g. ?search=a&search=b, which Express parses into an array.
    throw new ErrorResponse('The search term must be a single text value', 400);
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    // Previously this returned the entire project's documents, unbounded.
    throw new ErrorResponse('A search term is required: pass ?search=<text>', 400);
  }
  if (trimmed.length > SEARCH_TERM_MAX_LENGTH) {
    throw new ErrorResponse(
      `The search term must be ${SEARCH_TERM_MAX_LENGTH} characters or fewer (received ${trimmed.length})`,
      400
    );
  }
  return escapeRegex(trimmed);
}

module.exports = {
  escapeRegex,
  requireSearchTerm,
  resolveSearchLimit,
  SEARCH_TERM_MAX_LENGTH,
  REGEX_METACHARACTERS
};
