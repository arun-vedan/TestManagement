// WP-053 -- THE grounding post-check. Per the WP brief and the owner's
// framing: this module, not the prompt or the endpoint plumbing around it,
// is the actual deliverable. Everything else in this feature exists to
// hand this module two strings (the reporting-service facts the model was
// given, and the markdown narrative it produced) and to act correctly on
// what it reports back.
//
// THE THREE DESIGN QUESTIONS, ANSWERED AND JUSTIFIED:
//
// 1. WHAT COUNTS AS A "NUMBER"?
//    Five shapes, in this priority order (a combined regex tries each
//    alternative left-to-right at every position, so more specific shapes
//    win over the generic bare-number fallback):
//      - ISO date/datetime      2026-08-28 or 2026-08-28T10:00:00.000Z
//      - currency                $1,234.56
//      - percentage               49.7% (comma-grouped allowed)
//      - duration                 250ms, 30s, 5min, 2hrs, 7days/7d
//      - plain number              1,234.56 or 1234 or 49.7
//    NOT caught, deliberately: spelled-out numbers ("three defects"),
//    fractions ("half of"), and human-formatted dates ("August 28, 2026")
//    -- catching those needs NLP-grade parsing this module doesn't attempt.
//    This is a stated gap, not a silent one: a model could in principle
//    launder a hallucinated figure through prose that avoids digits
//    entirely. The system prompt (controllers/ai.js) explicitly forbids
//    that, but the regex-based backstop here cannot enforce it. What the
//    regex reliably catches is the failure mode the WP names outright --
//    a hallucinated DIGIT figure ("63 open defects" for input "3").
//
//    IDENTIFIERS ARE NOT FIGURES: a digit sequence immediately preceded by
//    a letter or a hyphen (REL-1, TC-5, PLN-5, Req-3, v2) is excluded from
//    extraction entirely -- it names an entity, it doesn't claim a
//    quantity. Without this guard, every mention of a release/plan/test
//    case id would be flagged as an "ungrounded number" (its digits won't
//    coincidentally appear as a bare figure in the input facts), which
//    would make the post-check cry wolf on completely benign text and
//    erode the one signal that matters. The same guard also means a
//    hyphenated range's second half ("8-30 days" -> "30" not extracted) is
//    skipped -- an accepted, narrower miss, not a safety hole: it shrinks
//    what gets CHECKED, it never causes a real hallucination to be
//    reported as grounded.
//
// 2. WHAT IS AN ACCEPTABLE MATCH?
//    - Dates: exact string match on the YYYY-MM-DD prefix only. No
//      rounding concept applies to a date.
//    - Currency/percentage/plain numbers ("quantity"-like figures):
//      numeric equality after stripping formatting ($, %, thousands
//      commas, trailing .0) -- so 50, 50.0 and "50%" (once %-stripped) are
//      the same figure -- PLUS a rounding tolerance of
//      max(0.5, 1% of the grounded value). That tolerance exists
//      specifically to let "coverage is about 50%" stand when the real
//      figure is 49.7 -- legitimate narrative rounding -- while still
//      rejecting "63 open defects" against a real value of 3
//      (|63-3|=60, tolerance is max(0.5, 0.03)=0.5 -- nowhere close).
//      The line is deliberately drawn tight (0.5, not e.g. 5 or 10%):
//      a wide tolerance would let a model quietly inflate small counts
//      ("3 defects" -> "4 defects" would slip through at a laxer band) --
//      the whole point is catching invention, not accommodating it.
//    - Currency and duration figures are compared ONLY against other
//      currency/duration figures respectively (duration converted to a
//      common unit, seconds, before comparing) -- a dollar amount must
//      never "match" an unrelated count just because the digits agree.
//      Percentages and plain numbers ARE cross-compatible with each other
//      (grouped as "quantity"): the same underlying value legitimately
//      appears as a bare number in one report's JSON (`value: 0`) and
//      might be narrated with a "%" sign, or vice versa.
//
// 3. WHAT HAPPENS ON A VIOLATION?
//    FLAG, NEVER SILENTLY DISCARD THE WHOLE SUMMARY. Two reasons: (a) one
//    invented figure in an otherwise-grounded five-paragraph narrative is
//    a much smaller failure than throwing the entire summary away and
//    giving the reader nothing (a summary that's 95% real and clearly
//    marks the 5% that isn't is strictly more useful than a 503); and
//    (b) rejecting outright hides the fact that a violation occurred at
//    all if the caller silently retries -- flagging makes the failure
//    VISIBLE, which is what actually matters here (same reasoning as
//    WP-052's failedComparisonCount and WP-040's stale: surface it, don't
//    just log it). Concretely: flagUngroundedNumbers() surgically wraps
//    every ungrounded figure in the returned markdown with an
//    unmissable "**[UNVERIFIED FIGURE: <raw>]**" marker, AND the API
//    response's top-level `grounding.grounded`/`ungroundedFigures` fields
//    (controllers/ai.js) carry the same information structurally, so the
//    UI has no path that can drop the signal even if it ignores the
//    markdown text itself.
'use strict';

const DATE_TOKEN = '\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z?)?';
const CURRENCY_TOKEN = '\\$\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?';
const PERCENT_TOKEN = '\\d{1,3}(?:,\\d{3})*(?:\\.\\d+)?%';
const DURATION_UNIT = '(?:ms|milliseconds|millisecond|seconds|second|secs|sec|s|minutes|minute|mins|min|hours|hour|hrs|hr|days|day|d)\\b';
const DURATION_TOKEN = `\\d+(?:\\.\\d+)?\\s?${DURATION_UNIT}`;
const THOUSANDS_TOKEN = '\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?';
const PLAIN_TOKEN = '\\d+(?:\\.\\d+)?';

// "Not part of an identifier" guards -- see header comment. Applied only to
// the duration/plain/thousands alternatives: dates, currency and
// percentages are already self-delimited by their own punctuation ($, %,
// the date's own fixed digit-hyphen-digit shape) and are vanishingly
// unlikely to appear as a suffix of a letter-led identifier token.
const NOT_AFTER_IDENTIFIER_CHAR = '(?<![A-Za-z0-9])(?<!-)';
const NOT_BEFORE_LETTER = '(?![A-Za-z])';

const TOKEN_RE = new RegExp(
  [
    DATE_TOKEN,
    CURRENCY_TOKEN,
    PERCENT_TOKEN,
    NOT_AFTER_IDENTIFIER_CHAR + DURATION_TOKEN,
    NOT_AFTER_IDENTIFIER_CHAR + THOUSANDS_TOKEN + NOT_BEFORE_LETTER,
    NOT_AFTER_IDENTIFIER_CHAR + PLAIN_TOKEN + NOT_BEFORE_LETTER
  ].join('|'),
  'g'
);

const DURATION_TO_SECONDS = {
  ms: 0.001,
  milliseconds: 0.001,
  millisecond: 0.001,
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  d: 86400,
  day: 86400,
  days: 86400
};

function classify(raw) {
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return 'date';
  if (raw.startsWith('$')) return 'currency';
  if (raw.endsWith('%')) return 'percent';
  if (/[A-Za-z]/.test(raw)) return 'duration';
  return 'number';
}

function normalize(raw, kind) {
  switch (kind) {
    case 'date':
      return null; // compared by string prefix, not numeric value
    case 'currency':
      return parseFloat(raw.replace(/[$,]/g, ''));
    case 'percent':
      return parseFloat(raw.replace(/[,%]/g, ''));
    case 'duration': {
      const m = /^(\d+(?:\.\d+)?)\s?([A-Za-z]+)$/.exec(raw.trim());
      if (!m) return null;
      const factor = DURATION_TO_SECONDS[m[2].toLowerCase()];
      return factor ? parseFloat(m[1]) * factor : null;
    }
    default:
      return parseFloat(raw.replace(/,/g, ''));
  }
}

// Comparison group -- see design question 2 above. Currency and duration
// are their own islands; percent/number are cross-compatible ("quantity").
const GROUP_OF = { date: 'date', currency: 'money', duration: 'time', percent: 'quantity', number: 'quantity' };

// Extracts every number-shaped token from `text` as
// { raw, kind, value, index }. `value` is null for dates (compared by
// string prefix instead) and for a duration whose unit wasn't recognised.
function extractNumbers(text) {
  const str = String(text || '');
  const out = [];
  let m;
  TOKEN_RE.lastIndex = 0;
  // eslint-disable-next-line no-cond-assign
  while ((m = TOKEN_RE.exec(str)) !== null) {
    const raw = m[0];
    const kind = classify(raw);
    out.push({ raw, kind, value: normalize(raw, kind), index: m.index });
  }
  return out;
}

function datesMatch(a, b) {
  return a.raw.slice(0, 10) === b.raw.slice(0, 10);
}

function quantitiesMatch(a, b) {
  if (a.value === null || b.value === null || Number.isNaN(a.value) || Number.isNaN(b.value)) {
    return false;
  }
  const tolerance = Math.max(0.5, Math.abs(b.value) * 0.01);
  return Math.abs(a.value - b.value) <= tolerance;
}

function numberIsGrounded(candidate, inputPool) {
  const group = GROUP_OF[candidate.kind];
  return inputPool.some((input) => {
    if (GROUP_OF[input.kind] !== group) return false;
    return group === 'date' ? datesMatch(candidate, input) : quantitiesMatch(candidate, input);
  });
}

// The post-check itself: every number-shaped token in `outputText` must be
// traceable to a number-shaped token in `inputText` under the match rule
// above. Returns which output figures are grounded/ungrounded -- it never
// mutates either string (see flagUngroundedNumbers for that).
function checkGrounding(inputText, outputText) {
  const inputNumbers = extractNumbers(inputText);
  const outputNumbers = extractNumbers(outputText);

  const grounded = [];
  const ungrounded = [];
  outputNumbers.forEach((n) => {
    (numberIsGrounded(n, inputNumbers) ? grounded : ungrounded).push(n);
  });

  return {
    grounded: ungrounded.length === 0,
    citedCount: outputNumbers.length,
    groundedCount: grounded.length,
    ungroundedFigures: ungrounded
  };
}

// Surgically wraps every ungrounded figure's exact character span in
// `markdown` with an unmissable marker -- splicing by recorded
// index/raw.length (processed highest-index-first so earlier splices never
// invalidate later ones), never a blind global string replace (which could
// mangle an unrelated occurrence of the same digits, e.g. inside a
// timestamp).
function flagUngroundedNumbers(markdown, ungroundedFigures) {
  if (!ungroundedFigures || ungroundedFigures.length === 0) {
    return markdown;
  }
  const bySpan = [...ungroundedFigures].sort((a, b) => b.index - a.index);
  let result = String(markdown || '');
  bySpan.forEach((figure) => {
    const before = result.slice(0, figure.index);
    const raw = result.slice(figure.index, figure.index + figure.raw.length);
    const after = result.slice(figure.index + figure.raw.length);
    result = `${before}**[UNVERIFIED FIGURE: ${raw}]**${after}`;
  });
  return result;
}

module.exports = {
  extractNumbers,
  checkGrounding,
  flagUngroundedNumbers
};
