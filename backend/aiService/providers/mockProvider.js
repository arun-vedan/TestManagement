// WP-050 -- the `mock` provider. FIRST-CLASS, not a test double bolted on:
// this is what AI_PROVIDER defaults to in this environment (no vendor
// account, no key, no outbound expectation -- see the Phase E provider
// decision recorded in EXECUTION_LOG.md's WP-050 report) and it is what
// lets WP-051/052/053 be built and tested with zero vendor account at all.
// Deterministic and network-free by construction: same input always
// produces the same shape of output, so a black-box HTTP test can assert
// on it without any stubbed server.
const MOCK_MODEL = 'mock-echo-1';
const { jaccardScore } = require('../lib/duplicateDetection');
const { analyzeForLintFindings } = require('../lib/requirementLint');
const { extractNumbers } = require('../lib/groundingCheck');
const { ProviderError } = require('./errors');

// WP-052 -- same test-only deterministic-hook convention as
// FORCE_MALFORMED_TOKEN/FORCE_MALFORMED_DUPLICATE_TOKEN/FORCE_MALFORMED_LINT_TOKEN
// below, but for the "provider throws" failure mode instead of "provider
// returns garbage": lets __tests__ prove runProviderCall's fail-closed 503
// mapping (WP-050) for check-duplicate-testcase/lint-requirement, AND
// auditDuplicates' own additional "every comparison failed -> 503, don't
// return a false all-clear" guard (controllers/ai.js#auditDuplicates) --
// without either of those, this failure mode would only ever be exercised
// generically (health/complete, from WP-050's own tests) and never for
// these specific WP-052 endpoints. Originally checked in completeStructured()
// only (every WP-052 caller uses completeStructured); WP-053's
// summarize-report uses complete() instead (free-form markdown, not
// schema-guided JSON), so complete() below checks for this token too, for
// the exact same reason -- proving runProviderCall()'s fail-closed 503
// mapping live for that route as well.
const FORCE_PROVIDER_ERROR_TOKEN = '__AI_MOCK_FORCE_ERROR__';

// WP-053 -- summarize-report's own two test-only hooks, same convention as
// every hook above:
//   - SUMMARY_DATA_TAG: not a hidden trigger, just the literal opening tag
//     controllers/ai.js#summarizeReport always wraps its grounding facts
//     in (<data trust="grounding-source">...). Used here purely to detect
//     "this is a summarize-report prompt" so complete() can hand back a
//     grounded narrative instead of the generic '[mock reply] ...' echo.
//   - FORCE_HALLUCINATION_TOKEN: forces the mock to append one sentence
//     containing a figure that provably does NOT appear anywhere in the
//     grounding data -- the deliberately-hallucinating fixture
//     __tests__/summarizeReport.test.js and __tests__/groundingCheck.test.js
//     need to prove checkGrounding() is a REAL backstop, not a check that
//     has only ever seen its own happy path.
const SUMMARY_DATA_TAG = 'trust="grounding-source"';
const FORCE_HALLUCINATION_TOKEN = '__AI_MOCK_HALLUCINATE__';

function estimateTokens(text) {
  if (!text) return 0;
  // Cheap, deterministic token estimate (chars/4) -- good enough for a
  // mock's cost/audit fields; real providers report their own exact
  // counts (see openaiProvider.js's extractUsage()).
  return Math.max(1, Math.ceil(String(text).length / 4));
}

function lastUserContent(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (arr[i] && arr[i].role === 'user') {
      return arr[i].content || '';
    }
  }
  return '';
}

// WP-053 -- extracts the <data trust="grounding-source">...</data> block
// controllers/ai.js#summarizeReport always sends -- the exact same facts
// text lib/reportAggregates.js built, unmodified, so echoing it back as
// bullets is a genuinely grounded (if simplistic) narrative: every figure
// in the output is drawn verbatim from the input.
function extractGroundingDataBlock(prompt) {
  const m = /<data trust="grounding-source">([\s\S]*?)<\/data>/.exec(String(prompt || ''));
  return m ? m[1].trim() : '';
}

// Deterministic, zero-network "executive summary": restates every fact
// line as a bullet (so every number in the output is provably grounded by
// construction) under the four sections the real system prompt asks for.
// When FORCE_HALLUCINATION_TOKEN is present, appends one sentence with a
// figure chosen to be numerically far outside anything in the real facts
// (max grounded value + 999) -- deliberately fabricated, deliberately
// impossible to mistake for legitimate rounding of a real figure.
function mockSummaryNarrative(prompt) {
  const dataBlock = extractGroundingDataBlock(prompt);
  const factLines = dataBlock
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const bulleted = factLines.length ? factLines.map((l) => `- ${l}`).join('\n') : '- No data available.';

  let md = [
    '## What changed',
    bulleted,
    '',
    '## Risks',
    'Review any figures above marked STALE or red/failing before treating this as a live picture.',
    '',
    '## Notable failures',
    'See the defect and release-readiness figures above for counts and status.',
    '',
    '## Recommendation',
    'Base any release/go decision on the figures above; none of them have been altered by this summary.'
  ].join('\n');

  if (String(prompt).includes(FORCE_HALLUCINATION_TOKEN)) {
    const groundedValues = extractNumbers(dataBlock)
      .map((n) => n.value)
      .filter((v) => typeof v === 'number' && !Number.isNaN(v));
    const fabricated = Math.round(Math.max(0, ...groundedValues)) + 999;
    md += `\n\n## Notable failures\nAdditionally, ${fabricated} open defects were also observed this period -- not reflected in the figures above.`;
  }

  return md;
}

async function complete({ system, messages, maxTokens } = {}) {
  const prompt = lastUserContent(messages);

  if (String(prompt).includes(FORCE_PROVIDER_ERROR_TOKEN)) {
    throw new ProviderError('simulated provider unavailable (test-only hook)', 'unavailable');
  }

  const promptTokens = estimateTokens(system) + estimateTokens(prompt);

  if (String(prompt).includes(SUMMARY_DATA_TAG)) {
    const text = mockSummaryNarrative(prompt);
    const completionTokens = estimateTokens(text);
    return {
      text,
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      model: MOCK_MODEL
    };
  }

  let text = `[mock reply] ${prompt}`.trim();
  if (typeof maxTokens === 'number' && maxTokens > 0) {
    text = text.slice(0, maxTokens * 4);
  }
  const completionTokens = estimateTokens(text);
  return {
    text,
    usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    model: MOCK_MODEL
  };
}

// Deterministically fills a small JSON-Schema-like shape ({type, properties,
// items} -- not a full JSON Schema implementation, just the subset the
// structured-output variant needs) with placeholder values, so callers can
// develop/test against realistic structured output with zero network
// access. WP-051's brief calls this out explicitly ("mock... capable of
// returning structured output").
function fillSchema(schema, keyHint = 'value') {
  if (!schema || typeof schema !== 'object') {
    return `mock-${keyHint}`;
  }
  switch (schema.type) {
    case 'object': {
      const out = {};
      const props = schema.properties || {};
      Object.keys(props).forEach((key) => {
        out[key] = fillSchema(props[key], key);
      });
      return out;
    }
    case 'array':
      return [fillSchema(schema.items, keyHint)];
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return true;
    case 'string':
    default:
      return `mock-${keyHint}`;
  }
}

// WP-051 -- test-only deterministic hook: if the prompt contains this exact
// literal, completeStructured() returns a fixed, deliberately malformed
// payload instead of filling the schema normally. Exists ONLY here (never
// in openaiProvider.js, never reachable from a real vendor) so
// aiService/__tests__ can exercise its server-side validation/repair path
// (lib/testCaseCandidates.js) end-to-end through the live mock -- see that
// test file for the fixture. A requirement whose text happened to contain
// this exact 26-character token in production would trigger it too, but
// that's an accepted, documented cost of a zero-network test hook: the
// token is chosen to be vanishingly unlikely in real text, and it is
// completely inert once AI_PROVIDER=openai (that provider ignores prompt
// content entirely -- it only ever asks the real vendor).
const FORCE_MALFORMED_TOKEN = '__AI_MOCK_MALFORMED__';

function malformedStructuredPayload() {
  return {
    candidates: [
      // Wrong types throughout -- summary isn't a string, steps isn't an
      // array. Fully unsalvageable: must be dropped entirely.
      { TestCaseSummary: 12345, TestSteps: 'not-an-array' },
      // A plain string where an object was expected -- must be dropped.
      'not-even-an-object',
      // Realistic partial failure: one good step, one step missing
      // `Expected`, one step that's `null`. The candidate itself has a
      // valid title, so it must be REPAIRED (bad steps dropped) rather than
      // dropped outright.
      {
        TestCaseSummary: 'Login with valid credentials',
        description: 'Verify a user can log in with a correct username/password.',
        TestSteps: [
          { testStep: 'Enter valid username and password', Expected: 'Fields accept the input' },
          { testStep: 'Click "Log in"' }, // missing Expected -- drop just this step
          null // not even an object -- drop
        ]
      }
    ]
  };
}

// WP-051 -- honours a `COUNT:<n>` hint the caller embeds in the prompt
// (see aiService/controllers/ai.js#generateTestCases) so the mock can
// simulate a real provider generating a variable number of candidates,
// deterministically and with zero network. Every other completeStructured()
// caller (WP-050's plain /structured route, WP-052/053's future ones) never
// sends this hint, so this is purely additive to the schema-filling
// behaviour above.
function countHint(prompt) {
  const match = /COUNT:(\d+)/.exec(prompt || '');
  if (!match) return null;
  return Math.max(1, Math.min(5, parseInt(match[1], 10)));
}

function isCandidateArraySchema(schema) {
  return !!(
    schema &&
    schema.type === 'object' &&
    schema.properties &&
    schema.properties.candidates &&
    schema.properties.candidates.type === 'array'
  );
}

function mockTestCaseCandidate(index) {
  return {
    TestCaseSummary: `mock-generated candidate ${index + 1}`,
    description: `Deterministic mock-generated draft test case #${index + 1}.`,
    preconditions: 'mock-preconditions',
    TestSteps: [
      { testStep: `Step 1 for candidate ${index + 1}`, Expected: `Expected result 1 for candidate ${index + 1}` },
      { testStep: `Step 2 for candidate ${index + 1}`, Expected: `Expected result 2 for candidate ${index + 1}` }
    ]
  };
}

// WP-052 -- duplicate-scan schema detection. Distinguished from
// isCandidateArraySchema() by its `results` array (lib/duplicateDetection.js
// #buildDuplicateSchema()) rather than `candidates`.
function isDuplicateScanSchema(schema) {
  return !!(
    schema &&
    schema.type === 'object' &&
    schema.properties &&
    schema.properties.results &&
    schema.properties.results.type === 'array'
  );
}

// WP-052 -- lint-findings schema detection (lib/requirementLint.js
// #buildLintSchema()).
function isLintSchema(schema) {
  return !!(
    schema &&
    schema.type === 'object' &&
    schema.properties &&
    schema.properties.findings &&
    schema.properties.findings.type === 'array'
  );
}

// WP-052 -- same test-only deterministic-hook convention as
// FORCE_MALFORMED_TOKEN above (WP-051): a literal, vanishingly-unlikely
// token that forces a fixed, deliberately malformed duplicate-scan payload
// so __tests__ can prove lib/duplicateDetection.js#validateAndRepairDuplicateResults
// is a real backstop -- wrong types, an unknown/hallucinated candidateId
// (a real LLM failure mode this schema is specifically exposed to, since
// the model echoes ids back rather than the server assigning them), and an
// out-of-range score all in one fixed response.
const FORCE_MALFORMED_DUPLICATE_TOKEN = '__AI_MOCK_MALFORMED_DUPLICATE__';
// WP-052 -- same idea for lint findings: forces a fixed, deliberately
// malformed findings payload so __tests__ can prove
// lib/requirementLint.js#validateAndRepairFindings is a real backstop --
// wrong types, empty required fields, and a HALLUCINATED excerpt (text that
// does not appear anywhere in the real requirement description, so the
// apply flow could never actually locate/replace it) all in one response.
const FORCE_MALFORMED_LINT_TOKEN = '__AI_MOCK_MALFORMED_LINT__';

// <target trust="...">...</target> / <candidate id="...">...</candidate>
// block parsing -- must match exactly what controllers/ai.js#checkDuplicateTestCase
// and #auditDuplicates build the prompt with (see that file's header
// comment on the tag shape).
function parseDuplicateScanPrompt(prompt) {
  const text = String(prompt || '');
  const targetMatch = /<target[^>]*>([\s\S]*?)<\/target>/.exec(text);
  const targetText = targetMatch ? targetMatch[1] : '';
  const candidates = [];
  const candidateRe = /<candidate id="([^"]*)">([\s\S]*?)<\/candidate>/g;
  let m;
  // eslint-disable-next-line no-cond-assign
  while ((m = candidateRe.exec(text)) !== null) {
    candidates.push({ id: m[1], text: m[2] });
  }
  return { targetText, candidates };
}

function malformedDuplicatePayload(candidates) {
  const realId = candidates.length > 0 ? candidates[0].id : 'TC-0';
  return {
    results: [
      // Wrong type for candidateId (number, not string) -- must be dropped.
      { candidateId: 12345, score: 50, reason: 'wrong type' },
      // Not even an object -- must be dropped.
      'not-even-an-object',
      // A real-shaped entry, but candidateId was never sent in this
      // request (hallucinated) -- must be dropped, never surfaced as if it
      // were one of the actual candidates compared.
      { candidateId: 'UNKNOWN-ID-NOT-IN-REQUEST', score: 80, reason: 'hallucinated id' },
      // Valid, real id but an out-of-range score -- REPAIRED (clamped to
      // 100), not dropped, since the id/shape are otherwise legitimate.
      { candidateId: realId, score: 999, reason: 'out-of-range score, should be clamped' }
    ]
  };
}

function malformedLintPayload(text) {
  // A real, literal substring of `text` (first word-ish token found) so the
  // "wrong type for `type`" entry below is otherwise fully valid/actionable
  // -- proving specifically that a malformed `type` value gets repaired
  // (coerced to 'other'), not that the whole finding gets dropped for an
  // unrelated reason (a missing/hallucinated excerpt).
  const wordMatch = /\w+/.exec(text);
  const realExcerpt = wordMatch ? wordMatch[0] : text;
  return {
    findings: [
      // Wrong type for `type` (number, not string) -- repaired to type
      // 'other' by validateAndRepairFindings, not dropped, since
      // description/excerpt/suggestedRewrite are otherwise valid -- proves
      // an unrecognized/malformed `type` value doesn't sink an otherwise
      // actionable finding.
      { type: 12345, description: 'Vague term found', excerpt: realExcerpt, suggestedRewrite: 'a precisely defined value' },
      // Not even an object -- must be dropped.
      'not-even-an-object',
      // Empty required fields -- must be dropped.
      { type: 'vague-quantifier', description: '', excerpt: '', suggestedRewrite: '' },
      // Real shape, but a HALLUCINATED excerpt that does not appear
      // anywhere in the actual requirement text -- must be dropped, since
      // the apply flow could never locate it to replace.
      {
        type: 'vague-quantifier',
        description: 'Hallucinated excerpt not present in the source text',
        excerpt: 'THIS EXACT PHRASE DOES NOT APPEAR ANYWHERE IN THE REQUIREMENT __AI_MOCK_MALFORMED_LINT__',
        suggestedRewrite: 'irrelevant'
      }
    ]
  };
}

async function completeStructured({ system, messages, schema } = {}) {
  const prompt = lastUserContent(messages);

  if (String(prompt).includes(FORCE_PROVIDER_ERROR_TOKEN)) {
    throw new ProviderError('simulated provider unavailable (test-only hook)', 'unavailable');
  }

  const promptTokens = estimateTokens(system) + estimateTokens(prompt);

  let data;
  if (isCandidateArraySchema(schema) && String(prompt).includes(FORCE_MALFORMED_TOKEN)) {
    data = malformedStructuredPayload();
  } else if (isCandidateArraySchema(schema)) {
    const n = countHint(prompt) || 1;
    data = { candidates: Array.from({ length: n }, (_, i) => mockTestCaseCandidate(i)) };
  } else if (isDuplicateScanSchema(schema)) {
    // WP-052 -- deterministic duplicate scoring: real word-overlap (Jaccard)
    // similarity computed from the ACTUAL target/candidate text embedded in
    // the prompt (lib/duplicateDetection.js#jaccardScore), not a
    // placeholder -- this is what lets a zero-network test prove both a
    // near-duplicate pair scores high and an unrelated pair scores low
    // through this exact code path.
    const { targetText, candidates } = parseDuplicateScanPrompt(prompt);
    if (String(prompt).includes(FORCE_MALFORMED_DUPLICATE_TOKEN)) {
      data = malformedDuplicatePayload(candidates);
    } else {
      data = {
        results: candidates.map((c) => ({
          candidateId: c.id,
          score: jaccardScore(targetText, c.text),
          reason: 'mock deterministic word-overlap (Jaccard) similarity'
        }))
      };
    }
  } else if (isLintSchema(schema)) {
    // WP-052 -- deterministic ambiguity analysis of the ACTUAL requirement
    // text embedded in the prompt (lib/requirementLint.js#analyzeForLintFindings),
    // not a placeholder -- pattern-based (vague quantifiers, untestable
    // modal verbs, missing acceptance criteria), each finding's `excerpt`
    // guaranteed to be a real substring of the source text.
    const requirementMatch = /<requirement[^>]*>([\s\S]*?)<\/requirement>/.exec(String(prompt));
    const requirementText = requirementMatch ? requirementMatch[1] : '';
    data = String(prompt).includes(FORCE_MALFORMED_LINT_TOKEN)
      ? malformedLintPayload(requirementText)
      : { findings: analyzeForLintFindings(requirementText) };
  } else {
    data = fillSchema(schema);
  }

  const completionTokens = estimateTokens(JSON.stringify(data));
  return {
    data,
    usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    model: MOCK_MODEL
  };
}

module.exports = {
  complete,
  completeStructured,
  MOCK_MODEL,
  fillSchema,
  FORCE_MALFORMED_TOKEN,
  FORCE_MALFORMED_DUPLICATE_TOKEN,
  FORCE_MALFORMED_LINT_TOKEN,
  FORCE_PROVIDER_ERROR_TOKEN,
  FORCE_HALLUCINATION_TOKEN
};
