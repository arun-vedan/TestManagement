// WP-033 -- JUnit XML adapter.
//
// Input: the de-facto-standard JUnit XML report shape produced by
// virtually every test runner's JUnit reporter (Jest's jest-junit, Maven
// Surefire, pytest, etc.) -- a <testsuites> root (or a single top-level
// <testsuite>, both accepted) containing one or more <testsuite> elements,
// each containing <testcase> elements, each optionally containing a
// <failure>, <error>, or <skipped> child.
//
// One <testcase> -> one normalized result (see ./normalize.js). Mapping
// decisions:
//   - testCaseId: JUnit testcase names are free text (e.g. "should return
//     200 for a valid request"), not testRepoService TestCaseIds, so this
//     adapter always sets `tag` (never `testCaseId`) -- normalize.js's
//     buildTestCaseId then namespaces it `TAG:<classname>.<name>` (or just
//     `TAG:<name>` when no classname attribute is present), consistent with
//     how cucumberAdapter.js falls back to an un-tagged scenario's name.
//   - status: a <failure> or <error> child -> 'failed'; a <skipped> child
//     (with no failure/error) -> 'skipped'; neither -> 'passed'. JUnit has
//     no notion of Cucumber's 'pending'/'undefined'/'ambiguous'.
//   - durationMs: the testcase's `time` attribute (JUnit reports this in
//     SECONDS, as a decimal), converted to milliseconds.
//   - errorMessage: the failure/error element's `message` attribute, or its
//     text content if `message` is absent.
//   - steps: JUnit has no per-step granularity (unlike Cucumber) -- omitted
//     entirely, matching this schema's TestSteps being genuinely absent on
//     pre-enrichment TestExecution records elsewhere in this codebase
//     rather than forcing an empty-but-present array with invented meaning.
const { XMLParser } = require('fast-xml-parser');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text'
});

function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function extractMessage(node) {
  if (!node) return undefined;
  const one = Array.isArray(node) ? node[0] : node;
  if (typeof one === 'string') return one;
  if (one && typeof one === 'object') {
    return one['@_message'] || one['#text'] || undefined;
  }
  return undefined;
}

function parseJunitXml(xmlBody, envelope = {}) {
  let parsed;
  try {
    parsed = parser.parse(xmlBody);
  } catch (err) {
    throw new Error(`Malformed JUnit XML: ${err.message}`);
  }

  const root = parsed.testsuites || parsed;
  const suites = toArray(root.testsuite);
  if (suites.length === 0) {
    throw new Error('No <testsuite> elements found in JUnit XML report');
  }

  const results = [];
  for (const suite of suites) {
    const testcases = toArray(suite.testcase);
    for (const tc of testcases) {
      const name = tc['@_name'] || 'unnamed-testcase';
      const classname = tc['@_classname'];
      const label = classname ? `${classname}.${name}` : name;

      const timeSeconds = tc['@_time'] !== undefined ? Number(tc['@_time']) : undefined;

      let status = 'passed';
      let errorMessage;
      if (tc.failure !== undefined) {
        status = 'failed';
        errorMessage = extractMessage(tc.failure);
      } else if (tc.error !== undefined) {
        status = 'failed';
        errorMessage = extractMessage(tc.error);
      } else if (tc.skipped !== undefined) {
        status = 'skipped';
        errorMessage = extractMessage(tc.skipped);
      }

      results.push({
        tag: label,
        testCaseSummary: label,
        status,
        durationMs: Number.isFinite(timeSeconds) ? timeSeconds * 1000 : undefined,
        errorMessage,
        ciRunUrl: envelope.ciRunUrl,
        environment: envelope.environment
      });
    }
  }
  return results;
}

module.exports = { parseJunitXml };
