// WP-052 -- requirement ambiguity linting library.
//
// Same split as lib/testCaseCandidates.js (WP-051) and
// lib/duplicateDetection.js (this WP): a schema hint for
// providers/index.js's completeStructured(), plus provider-agnostic
// server-side validate/repair of whatever comes back. THE MODEL'S OUTPUT
// SHAPE IS NEVER TRUSTED -- and for lint findings specifically, a finding
// is USELESS to the apply flow unless its `excerpt` is an actual, literal
// substring of the requirement's real (plain-text-extracted) description:
// controllers/ai.js#applyLintFinding works by finding `excerpt` in the
// CURRENT live description text and replacing it with `suggestedRewrite`,
// so a hallucinated excerpt that doesn't appear in the real text must never
// reach the caller as if it were actionable. validateAndRepairFindings()
// below is the backstop for that, independent of whatever generated the
// finding (a real vendor, or the mock's deterministic analyzer, or the
// FORCE_MALFORMED_LINT_TOKEN adversarial hook in mockProvider.js).
//
// analyzeForLintFindings() is the deterministic, zero-network analyzer
// mockProvider.js's completeStructured() calls to fill lint findings from
// real requirement text (not a placeholder) -- pattern-based (vague
// quantifiers, untestable modal verbs, missing acceptance criteria), not
// real semantic understanding, which is an accepted, documented cost of a
// zero-network mock provider (see providers/index.js's Phase E decision
// comment) -- appropriate for proving the wiring, apply flow, and
// lifecycle gate end-to-end without a vendor account, not a claim of real
// NLP quality. A real vendor provider is expected to reason about meaning
// instead, but is validated through this exact same
// validateAndRepairFindings() so the server-side contract is identical
// regardless of provider.

const MAX_FINDINGS = 8;

function buildLintSchema() {
  return {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            description: { type: 'string' },
            excerpt: { type: 'string' },
            suggestedRewrite: { type: 'string' }
          }
        }
      }
    }
  };
}

const KNOWN_TYPES = new Set(['vague-quantifier', 'untestable-phrasing', 'missing-acceptance-criteria']);

// raw: whatever providers/index.js's completeStructured() returned as
// `.data`. plainText: the CURRENT plain-text requirement description
// (lib/richText.js#extractPlainText), used to verify -- and, if the model
// returned an excerpt that matches only case-insensitively, to CORRECT --
// every excerpt so the apply flow's later exact-substring replace is
// guaranteed to find it. Never throws; a garbage `raw` (or one with no
// findings that actually appear in the text) just yields an empty findings
// list, not an error.
function validateAndRepairFindings(raw, plainText) {
  const rawFindings = raw && Array.isArray(raw.findings) ? raw.findings : [];
  const text = String(plainText || '');
  const out = [];

  for (const f of rawFindings) {
    if (out.length >= MAX_FINDINGS) break;
    if (!f || typeof f !== 'object' || Array.isArray(f)) continue;

    const type = typeof f.type === 'string' && KNOWN_TYPES.has(f.type.trim()) ? f.type.trim() : 'other';
    const description = typeof f.description === 'string' ? f.description.trim().slice(0, 500) : '';
    const rawExcerpt = typeof f.excerpt === 'string' ? f.excerpt : '';
    const suggestedRewrite = typeof f.suggestedRewrite === 'string' ? f.suggestedRewrite.trim().slice(0, 4000) : '';

    if (!description || !rawExcerpt || !suggestedRewrite) continue; // incomplete -- not actionable, drop

    // Exact match first; fall back to a case-insensitive search and
    // CORRECT the excerpt to the real, exact-case substring found in the
    // text, so applyLintFinding's later exact `text.includes(excerpt)`
    // check is guaranteed to pass for anything that survives this
    // function. If neither matches, the excerpt doesn't exist in the real
    // text at all (hallucinated) -- drop the finding entirely rather than
    // hand back something the apply flow could never actually apply.
    let excerpt = rawExcerpt.trim();
    if (!excerpt) continue;
    if (!text.includes(excerpt)) {
      const idx = text.toLowerCase().indexOf(excerpt.toLowerCase());
      if (idx === -1) continue;
      excerpt = text.slice(idx, idx + excerpt.length);
    }
    if (excerpt === suggestedRewrite) continue; // no-op rewrite, nothing to apply

    out.push({ type, description, excerpt, suggestedRewrite });
  }

  return out;
}

// ---------------------------------------------------------------------
// Deterministic mock analyzer (used only by mockProvider.js -- see that
// file's completeStructured()). Pattern-based, zero network.
// ---------------------------------------------------------------------

// phrase -> replacement text. Deliberately concrete/testable in spirit
// ("within 2 seconds" rather than "fast") -- exactly the kind of rewrite a
// reviewer applying the suggestion should end up editing further with a
// real number for their own system, but the shape (a specific, checkable
// claim instead of a vague one) is the point being demonstrated.
const VAGUE_REPLACEMENTS = new Map([
  ['some', 'a specific number of'],
  ['many', 'a specific number of'],
  ['few', 'a specific small number of'],
  ['several', 'a specific number of'],
  ['various', 'a specifically enumerated set of'],
  ['numerous', 'a specific number of'],
  ['appropriate', 'a precisely defined'],
  ['reasonable', 'a precisely defined'],
  ['sufficient', 'a precisely defined minimum'],
  ['adequate', 'a precisely defined minimum'],
  ['fast', 'within 2 seconds'],
  ['quickly', 'within 2 seconds'],
  ['slow', 'slower than 2 seconds'],
  ['efficient', 'measurably within a defined performance budget'],
  ['user-friendly', 'usable without training, verified by a usability test'],
  ['easy to use', 'usable without training, verified by a usability test'],
  ['intuitive', 'usable without training, verified by a usability test'],
  ['etc', '(fully enumerated -- no items omitted)'],
  ['and so on', '(fully enumerated -- no items omitted)']
]);

const UNTESTABLE_REPLACEMENTS = new Map([
  ['should', 'must'],
  ['may need to', 'must'],
  ['might', 'must (confirm whether this is actually optional)']
]);

function findFirstWordMatch(text, phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![a-zA-Z0-9])${escaped}(?![a-zA-Z0-9])`, 'i');
  const match = re.exec(text);
  if (!match) return null;
  return { excerpt: text.slice(match.index, match.index + match[0].length), index: match.index };
}

function analyzeForLintFindings(text) {
  const plain = String(text || '');
  const findings = [];

  // 1. Vague quantifiers / subjective adjectives -- first occurrence of
  // each distinct phrase found, so a description repeating "fast" three
  // times produces one finding, not three.
  for (const [phrase, replacement] of VAGUE_REPLACEMENTS) {
    if (findings.length >= MAX_FINDINGS) break;
    const found = findFirstWordMatch(plain, phrase);
    if (!found) continue;
    findings.push({
      type: 'vague-quantifier',
      description: `"${found.excerpt}" is a vague/subjective term that can't be verified by a test -- specify a precise, measurable value instead.`,
      excerpt: found.excerpt,
      suggestedRewrite: replacement
    });
  }

  // 2. Untestable modal phrasing -- "should" (optional-reading) instead of
  // "must"/"shall" (a real acceptance test needs an unambiguous pass/fail
  // obligation).
  for (const [phrase, replacement] of UNTESTABLE_REPLACEMENTS) {
    if (findings.length >= MAX_FINDINGS) break;
    const found = findFirstWordMatch(plain, phrase);
    if (!found) continue;
    findings.push({
      type: 'untestable-phrasing',
      description: `"${found.excerpt}" reads as optional/non-binding -- a testable requirement needs an unambiguous obligation ("must"/"shall").`,
      excerpt: found.excerpt,
      suggestedRewrite: replacement
    });
  }

  // 3. Missing acceptance criteria -- no explicit criteria markers
  // anywhere in the text at all. Excerpt is the whole text (a trivial
  // literal substring of itself) so applying this finding appends a
  // criteria block to the end of the description.
  const hasCriteriaMarkers = /(acceptance criteria|given\s.+\swhen\s.+\sthen\s|^\s*[-*]\s+)/im.test(plain);
  if (!hasCriteriaMarkers && plain.trim().length > 0 && findings.length < MAX_FINDINGS) {
    const trimmed = plain.replace(/\s+$/, '');
    findings.push({
      type: 'missing-acceptance-criteria',
      description:
        'No acceptance criteria found (no "Acceptance Criteria" section, Given/When/Then, or bullet list) -- add explicit, checkable criteria so this requirement can be verified.',
      excerpt: trimmed,
      suggestedRewrite: `${trimmed}\n\nAcceptance Criteria:\n- [ ] <add a specific, checkable condition>\n- [ ] <add another specific, checkable condition>`
    });
  }

  return findings;
}

module.exports = {
  MAX_FINDINGS,
  buildLintSchema,
  validateAndRepairFindings,
  analyzeForLintFindings
};
