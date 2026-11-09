const { PLACEHOLDER_REGEX } = require('./placeholders');

// WP-F07a Task 3 -- resolve a test case's {{placeholders}} against one row
// of its bound Dataset.
//
// Kept in its own file rather than folded into expandSteps.js: expansion
// and substitution are two independently opt-in transforms, triggered by
// two different query params (`expand=steps` vs `substitute=<rowIndex>`),
// with two very different audiences for what "never" means. `expand=steps`
// alone is read by execution enrichment and the AI service, and MUST NEVER
// carry substituted values (an execution would snapshot one row's
// concrete values as permanent history with no error; an AI exemplar
// would teach the model concrete values instead of the parameterised
// pattern). Keeping substitution in a separate module -- never imported by
// the `expand=steps`-only branch of either controller path -- makes that
// boundary something a `grep require.*substituteSteps` can confirm, not
// just a convention inside one shared function that a future edit could
// blur.
//
// Reuses Task 2's exported PLACEHOLDER_REGEX (utils/placeholders.js)
// rather than writing a second pattern -- see that file's own header
// comment for why a second, independently-written regex would itself be a
// bug the moment the two drifted.

// Resolves the placeholders in one string against `values` (a plain
// {columnName: cellValue} map for the chosen row). A placeholder with no
// matching key in `values` is left as the literal `{{name}}` it already
// was (R5) -- never blanked, since a blank is indistinguishable from
// authored-empty and would hide the very problem this is supposed to
// surface.
function resolveText(text, values) {
  if (typeof text !== 'string') return text;
  // PLACEHOLDER_REGEX is a shared module-level /g regex (placeholders.js).
  // String.prototype.replace with a /g regex scans from index 0 and does
  // not consult -- or leave dirty -- lastIndex, so no reset is strictly
  // required here the way extractPlaceholders()'s manual exec() loop
  // needs one; this codebase's replace-based usage is exactly the shape
  // that has no lastIndex statefulness problem in the first place.
  return text.replace(PLACEHOLDER_REGEX, (match, name) => (
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : match
  ));
}

// docs: already-expanded document(s) -- expandSteps() MUST have already
// run (R4: a shared step's own text can contain {{placeholders}} that
// only resolve correctly once flattened into plain testStep/Expected
// rows; substituting first would miss them, since a reference row's own
// testStep/Expected are meaningless per TestStepSchema's contract).
//
// columns/row: one Dataset's `columns` array and one selected `rows[i]`
// array -- same length per Dataset's own ragged-row guard (models/
// Dataset.js), so a positional zip is safe with no length check needed
// here.
//
// Pure string pass, not a template engine: no evaluation, no nesting, no
// escaping rules beyond "does this substring match {{name}}". Mutates and
// returns `docs` in place, the same contract expandSteps() already has --
// callers that need the pre-substitution document preserved must clone
// first, exactly as the read path already clones before calling
// expandSteps().
function substituteSteps(docs, columns, row) {
  const list = Array.isArray(docs) ? docs : [docs];
  const values = {};
  columns.forEach((name, i) => {
    values[name] = row[i];
  });

  for (const doc of list) {
    if (!doc || !Array.isArray(doc.TestSteps)) continue;
    for (const step of doc.TestSteps) {
      if (!step) continue;
      // Authored text is preserved under a separate key BEFORE it is
      // overwritten -- this is what lets a client render both forms from
      // one response (this task's interface contract) and, just as
      // importantly, is never itself written back to the stored document:
      // this function only ever runs against an already-cloned, in-memory
      // copy (see the ordering note above), never against a live Mongoose
      // document destined for .save()/.findOneAndUpdate().
      if (typeof step.testStep === 'string') {
        step.authoredTestStep = step.testStep;
        step.testStep = resolveText(step.testStep, values);
      }
      if (typeof step.Expected === 'string') {
        step.authoredExpected = step.Expected;
        step.Expected = resolveText(step.Expected, values);
      }
      step.substituted = true;
    }
  }
  return docs;
}

module.exports = { substituteSteps };
