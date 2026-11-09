// WP-052 -- duplicate-detection library.
//
// Two responsibilities, mirroring lib/testCaseCandidates.js's split
// (WP-051): (1) the JSON-Schema-shaped hint passed to
// providers/index.js's completeStructured(), and (2) provider-agnostic
// server-side validate/repair of whatever comes back -- THE MODEL'S OUTPUT
// SHAPE IS NEVER TRUSTED, same contract as every other structured-output
// caller in this service. A candidateId that doesn't match one of the ids
// this request actually sent, a non-numeric score, or a malformed entry is
// dropped here regardless of why it happened (real vendor quirk, or the
// mock's FORCE_MALFORMED_DUPLICATE_TOKEN hook -- see mockProvider.js).
//
// tokenize()/jaccardScore() are ALSO used directly by mockProvider.js's
// completeStructured() to compute real, deterministic similarity scores
// from the actual (plain-text-extracted) target/candidate text embedded in
// the prompt -- not a placeholder. That is what lets a zero-network test
// prove duplicate detection works in BOTH directions with actual numbers
// (see __tests__/duplicateDetection.test.js and
// __tests__/aiDuplicates.test.js): a seeded near-duplicate pair scores far
// above THRESHOLD, an unrelated pair scores far below it, through the exact
// same code path production traffic uses when AI_PROVIDER=mock.
//
// THRESHOLD -- chosen empirically (recorded in EXECUTION_LOG.md's WP-052
// report), not guessed: a same-topic near-duplicate pair (paraphrased login
// requirement) scores ~63-67 with this tokenizer/Jaccard combination, an
// unrelated pair (login vs CSV export) scores ~4. 55 sits with a wide
// margin below the near-duplicate case and a wide margin above the
// unrelated case, so small wording variation on either side of the fixture
// doesn't flip the result. This is a coarse lexical-overlap signal (word
// Jaccard, not semantic embedding) -- appropriate for a zero-network mock
// provider proving the wiring end-to-end, not a claim of real semantic
// duplicate detection; a real vendor provider is expected to reason about
// meaning, not just word overlap, but is scored/thresholded through this
// exact same THRESHOLD so the server-side contract (only surface a
// candidate at or above THRESHOLD) is identical regardless of provider.
const THRESHOLD = 55;

// Collection sizes here are tiny (per the WP brief) -- these caps exist to
// bound prompt size and LLM call cost, not because larger numbers would be
// unsafe.
const MAX_CANDIDATES_PER_CHECK = 20; // candidates compared against one target
const MAX_RESULTS = 5; // top-N returned to the caller, after threshold filtering

// Deliberately small and generic (not tuned to any one fixture's wording) --
// removes function words that would otherwise inflate overlap between any
// two unrelated test-case/requirement descriptions just by both containing
// "the", "a", "with", etc. "summary"/"description" are stripped too since
// mockProvider.js's prompt blocks below always carry those labels
// literally, and they'd otherwise contribute a constant, contentless
// overlap between every single pair regardless of real similarity.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'and', 'or', 'is', 'are', 'in', 'on', 'with',
  'for', 'that', 'this', 'be', 'been', 'being', 'it', 'as', 'at', 'by',
  'from', 'summary', 'description'
]);

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

// Jaccard similarity over token sets, as a 0-100 integer percentage.
function jaccardScore(textA, textB) {
  const a = new Set(tokenize(textA));
  const b = new Set(tokenize(textB));
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  a.forEach((w) => {
    if (b.has(w)) intersection += 1;
  });
  const union = new Set([...a, ...b]).size;
  if (union === 0) return 0;
  return Math.round((intersection / union) * 100);
}

function buildDuplicateSchema() {
  return {
    type: 'object',
    properties: {
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            candidateId: { type: 'string' },
            score: { type: 'number' },
            reason: { type: 'string' }
          }
        }
      }
    }
  };
}

// raw: whatever providers/index.js's completeStructured() returned as
// `.data`. allowedIds: the exact set of candidate ids THIS request sent, so
// a hallucinated/unknown id (a real risk with any LLM, and exactly what
// FORCE_MALFORMED_DUPLICATE_TOKEN below exercises deliberately) can never
// be returned to the caller. Never throws; a garbage `raw` just yields zero
// results.
function validateAndRepairDuplicateResults(raw, allowedIds) {
  const rawResults = raw && Array.isArray(raw.results) ? raw.results : [];
  const allowed = new Set(allowedIds);
  const byId = new Map();

  rawResults.forEach((r) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return;
    const candidateId = typeof r.candidateId === 'string' ? r.candidateId.trim() : '';
    if (!candidateId || !allowed.has(candidateId)) return; // unknown/hallucinated id -- drop
    const numericScore = typeof r.score === 'number' ? r.score : Number(r.score);
    if (!Number.isFinite(numericScore)) return; // wrong type -- drop
    const score = Math.max(0, Math.min(100, Math.round(numericScore)));
    const reason = typeof r.reason === 'string' ? r.reason.trim().slice(0, 300) : '';
    const existing = byId.get(candidateId);
    // A provider could (in principle) return the same candidateId twice --
    // keep the higher score rather than the last-seen one.
    if (!existing || score > existing.score) {
      byId.set(candidateId, { candidateId, score, reason });
    }
  });

  return Array.from(byId.values());
}

module.exports = {
  THRESHOLD,
  MAX_CANDIDATES_PER_CHECK,
  MAX_RESULTS,
  STOPWORDS,
  tokenize,
  jaccardScore,
  buildDuplicateSchema,
  validateAndRepairDuplicateResults
};
