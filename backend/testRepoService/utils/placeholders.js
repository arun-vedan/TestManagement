// WP-F07a Task 2 -- find the {{placeholder}} names a test case's steps
// reference, so a bound Dataset's columns can be checked against them
// (this task's /:id/parameters route) and, later, substituted (Task 3).
//
// Exported alongside extractPlaceholders() rather than kept private: Task 3
// needs the exact same matching rule to substitute values back into these
// same strings, and a second, independently-written regex would be a real
// bug the moment the two ever drifted (e.g. one allowing a hyphen the other
// doesn't). One regex, two consumers.
const PLACEHOLDER_REGEX = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

// Scans both testStep and Expected on every row (a plain step's own text,
// or -- after the caller has run expandSteps() -- an expanded shared
// step's text). Returns unique names in first-appearance order: a Set for
// membership plus a parallel array preserves insertion order without
// relying on Set iteration order semantics the reader would have to look up.
function extractPlaceholders(steps) {
  const seen = new Set();
  const names = [];

  for (const step of steps || []) {
    if (!step) continue;
    for (const text of [step.testStep, step.Expected]) {
      if (typeof text !== 'string') continue;
      // PLACEHOLDER_REGEX is a shared module-level /g regex, so its
      // lastIndex persists across calls -- reset before every fresh scan
      // rather than relying on the previous scan having run its while loop
      // to natural exhaustion (which itself resets lastIndex to 0, but a
      // reset up front makes that assumption explicit rather than implicit).
      PLACEHOLDER_REGEX.lastIndex = 0;
      let match = PLACEHOLDER_REGEX.exec(text);
      while (match !== null) {
        const name = match[1];
        if (!seen.has(name)) {
          seen.add(name);
          names.push(name);
        }
        match = PLACEHOLDER_REGEX.exec(text);
      }
    }
  }

  return names;
}

module.exports = { extractPlaceholders, PLACEHOLDER_REGEX };
