// WP-033 -- Cucumber JSON adapter.
//
// Input: the standard Cucumber JSON report shape produced by
// @cucumber/cucumber's built-in `json` formatter (also what WebdriverIO's
// @wdio/cucumber-framework produces -- see the vendored
// backend/automationService/automationFramework, this repo's real
// cucumber-boilerplate dependency, which pulls in exactly that formatter
// via @wdio/cucumber-framework -- no sample .json report is checked into
// that boilerplate, but its src/features/api.feature is the real feature
// this adapter's own fixture/tests are modeled on, per the WP's
// instruction to use its real shape rather than inventing one): a top-level
// ARRAY of "feature" objects, each with an `elements` array of scenarios,
// each with a `steps` array. See
// https://github.com/cucumber/cucumber-json-schema for the full schema;
// only the fields this adapter actually reads are documented below.
//
// One scenario -> one normalized result (see ./normalize.js). Mapping
// decisions:
//   - testCaseId: the scenario's first tag (`@TC-101` -> `TC-101`, leading
//     `@` stripped) if any tag is present. No tag -> fall back to `tag:
//     <scenario name>` (normalize.js's buildTestCaseId adds the `TAG:`
//     namespace prefix), since a Cucumber scenario always has a name even
//     when un-tagged.
//   - status: 'failed' if ANY step failed/errored/was ambiguous; else
//     'pending'/'undefined'/'skipped' if any step is not yet implemented or
//     was skipped (mirrors Cucumber's own scenario-status rollup: the
//     worst step status wins); else 'passed'.
//   - durationMs: sum of every step's `result.duration` (Cucumber JSON
//     reports this in NANOSECONDS), converted to milliseconds.
//   - errorMessage: the first failing step's `result.error_message`, if any.
//   - steps: each step's `keyword`+`name` -> testStep; `result.status` ->
//     status. Cucumber has no separate "expected" text per step (unlike
//     this schema's TestSteps.Expected, populated from testRepoService
//     elsewhere), so Expected is left blank for CI-originated steps.
const { normalizeStatus } = require('./normalize');

const STATUS_PRIORITY = ['failed', 'ambiguous', 'error', 'undefined', 'pending', 'skipped', 'passed'];

function worstStatus(statuses) {
  for (const candidate of STATUS_PRIORITY) {
    if (statuses.includes(candidate)) {
      return candidate;
    }
  }
  return 'passed';
}

function parseCucumberJson(reportBody, envelope = {}) {
  let features;
  if (typeof reportBody === 'string') {
    features = JSON.parse(reportBody);
  } else {
    features = reportBody;
  }

  if (!Array.isArray(features)) {
    throw new Error('Cucumber JSON report must be a top-level array of features');
  }

  const results = [];
  for (const feature of features) {
    const elements = Array.isArray(feature.elements) ? feature.elements : [];
    for (const scenario of elements) {
      // 'background' elements are setup blocks, not real test results.
      if (scenario.type === 'background') {
        continue;
      }
      const steps = Array.isArray(scenario.steps) ? scenario.steps : [];
      const stepStatuses = steps.map((s) => (s.result && s.result.status) || 'undefined');
      const rawStatus = worstStatus(stepStatuses);

      const firstTag = Array.isArray(scenario.tags) && scenario.tags.length > 0 ? scenario.tags[0].name : null;
      const testCaseId = firstTag ? firstTag.replace(/^@/, '') : null;

      const durationNs = steps.reduce((sum, s) => sum + ((s.result && s.result.duration) || 0), 0);

      const failingStep = steps.find((s) => s.result && s.result.error_message);
      const errorMessage = failingStep ? failingStep.result.error_message : undefined;

      results.push({
        testCaseId: testCaseId || undefined,
        tag: testCaseId ? undefined : (scenario.name || feature.name || 'unnamed-scenario'),
        testCaseSummary: scenario.name || feature.name,
        status: rawStatus,
        durationMs: durationNs / 1e6,
        errorMessage,
        steps: steps.map((s) => ({
          testStep: `${(s.keyword || '').trim()} ${s.name || ''}`.trim(),
          Expected: '',
          status: normalizeStatus((s.result && s.result.status) || 'undefined') || 'No Run'
        })),
        ciRunUrl: envelope.ciRunUrl,
        environment: envelope.environment
      });
    }
  }
  return results;
}

module.exports = { parseCucumberJson };
