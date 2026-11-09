const SharedStep = require('../models/SharedStep');

// WP-F06 -- expand reference rows into flat steps for consumers that need
// a plain sequence (execution enrichment, AI, CSV export). One query for
// the whole page of documents, not one per case: enrichment can pass a
// list of cases and this must not become N+1.
//
// projectId is required and applied to the lookup, so a reference that
// somehow points at another project's shared step resolves to nothing and
// is dropped rather than leaking that project's text.
async function expandSteps(docs, projectId) {
  const list = Array.isArray(docs) ? docs : [docs];

  const ids = new Set();
  for (const doc of list) {
    for (const step of doc?.TestSteps || []) {
      if (step && step.sharedStepId) ids.add(String(step.sharedStepId));
    }
  }
  if (ids.size === 0) return docs;

  const shared = await SharedStep.find(
    { _id: { $in: [...ids] }, projectId },
    'title steps'
  ).lean();
  const byId = new Map(shared.map((s) => [String(s._id), s]));

  for (const doc of list) {
    if (!doc || !Array.isArray(doc.TestSteps)) continue;
    const expanded = [];
    for (const step of doc.TestSteps) {
      if (!step || !step.sharedStepId) {
        expanded.push(step);
        continue;
      }
      const source = byId.get(String(step.sharedStepId));
      // A dangling or cross-project reference is DROPPED, not emitted as a
      // blank row. ExecutionTestStepSchema is strict (testStep/Expected/
      // status), so a blank row would be snapshotted into a run as an
      // empty step with no clue where it came from.
      if (!source) continue;
      source.steps.forEach((s, i) => {
        expanded.push({
          testStep: s.testStep,
          Expected: s.Expected,
          sharedStepId: String(step.sharedStepId),
          sharedStepTitle: source.title,
          sharedStepIndex: i,
        });
      });
    }
    doc.TestSteps = expanded;
  }
  return docs;
}

module.exports = { expandSteps };
