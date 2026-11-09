const { analyzeForLintFindings, validateAndRepairFindings } = require('../lib/requirementLint');

// WP-052 -- plain Jest coverage of lib/requirementLint.js's pure logic
// (GR-6's "plain Jest for the library logic" half; __tests__/aiLint.test.js
// is the black-box HTTP half). Zero network, zero container needed.
//
// THE POINT: prove the deterministic analyzer finds real issues in vague
// text and finds nothing in clean text (both directions, mirroring the
// duplicate-detection proof), and prove validateAndRepairFindings() never
// trusts the model's output shape -- especially that a HALLUCINATED excerpt
// (one that doesn't actually appear in the source text) is dropped, since
// the apply flow can only ever work against a real, literal substring.
describe('lib/requirementLint', () => {
  describe('analyzeForLintFindings() -- both directions', () => {
    it('finds vague-quantifier, untestable-phrasing, and missing-acceptance-criteria issues in an ambiguous requirement', () => {
      const text = 'The system should respond quickly to some user requests. Response time must be appropriate for most use cases.';
      const findings = analyzeForLintFindings(text);
      const types = findings.map((f) => f.type);
      expect(types).toContain('vague-quantifier');
      expect(types).toContain('untestable-phrasing');
      expect(types).toContain('missing-acceptance-criteria');
      expect(findings.length).toBeGreaterThan(0);
    });

    it('finds nothing in a precise, criteria-bearing requirement', () => {
      const text =
        'Given a user on the login page, when they submit a valid username and password, ' +
        'then the system must authenticate them within 2 seconds and redirect to the dashboard.\n\n' +
        'Acceptance Criteria:\n- [ ] Valid credentials log the user in\n- [ ] Invalid credentials show an error';
      expect(analyzeForLintFindings(text)).toEqual([]);
    });

    it('every finding\'s excerpt is a literal, verbatim substring of the source text', () => {
      const text = 'The system should respond quickly to some user requests, and so on, in an appropriate manner.';
      const findings = analyzeForLintFindings(text);
      expect(findings.length).toBeGreaterThan(0);
      findings.forEach((f) => {
        expect(text.includes(f.excerpt)).toBe(true);
      });
    });

    it('is deterministic (same input -> same output)', () => {
      const text = 'The system should respond quickly to some user requests.';
      expect(analyzeForLintFindings(text)).toEqual(analyzeForLintFindings(text));
    });
  });

  describe('validateAndRepairFindings() -- never trusts model output shape', () => {
    const text = 'The system should respond quickly to some user requests.';

    it('keeps a well-formed finding whose excerpt is a real substring', () => {
      const out = validateAndRepairFindings(
        { findings: [{ type: 'vague-quantifier', description: 'd', excerpt: 'quickly', suggestedRewrite: 'within 2 seconds' }] },
        text
      );
      expect(out).toEqual([{ type: 'vague-quantifier', description: 'd', excerpt: 'quickly', suggestedRewrite: 'within 2 seconds' }]);
    });

    it('drops a finding whose excerpt does not appear anywhere in the source text (hallucinated)', () => {
      const out = validateAndRepairFindings(
        { findings: [{ type: 'vague-quantifier', description: 'd', excerpt: 'this phrase is not in the text', suggestedRewrite: 'x' }] },
        text
      );
      expect(out).toEqual([]);
    });

    it('corrects a case-mismatched excerpt to the real, exact-case substring rather than dropping it', () => {
      const out = validateAndRepairFindings(
        { findings: [{ type: 'vague-quantifier', description: 'd', excerpt: 'QUICKLY', suggestedRewrite: 'within 2 seconds' }] },
        text
      );
      expect(out).toEqual([{ type: 'vague-quantifier', description: 'd', excerpt: 'quickly', suggestedRewrite: 'within 2 seconds' }]);
    });

    it('coerces an unrecognized/malformed type to "other" rather than dropping an otherwise-valid finding', () => {
      const out = validateAndRepairFindings(
        { findings: [{ type: 12345, description: 'd', excerpt: 'quickly', suggestedRewrite: 'within 2 seconds' }] },
        text
      );
      expect(out).toEqual([{ type: 'other', description: 'd', excerpt: 'quickly', suggestedRewrite: 'within 2 seconds' }]);
    });

    it('drops a non-object entry', () => {
      expect(validateAndRepairFindings({ findings: ['not-an-object'] }, text)).toEqual([]);
    });

    it('drops a finding with empty required fields', () => {
      const out = validateAndRepairFindings(
        { findings: [{ type: 'vague-quantifier', description: '', excerpt: '', suggestedRewrite: '' }] },
        text
      );
      expect(out).toEqual([]);
    });

    it('drops a no-op rewrite (excerpt === suggestedRewrite)', () => {
      const out = validateAndRepairFindings(
        { findings: [{ type: 'vague-quantifier', description: 'd', excerpt: 'quickly', suggestedRewrite: 'quickly' }] },
        text
      );
      expect(out).toEqual([]);
    });

    it('caps the number of findings at MAX_FINDINGS', () => {
      const many = Array.from({ length: 20 }, () => ({
        type: 'vague-quantifier',
        description: 'd',
        excerpt: 'quickly',
        suggestedRewrite: 'within 2 seconds'
      }));
      const out = validateAndRepairFindings({ findings: many }, text);
      expect(out.length).toBeLessThanOrEqual(8);
    });

    it('handles a completely garbage raw payload without throwing', () => {
      expect(validateAndRepairFindings(null, text)).toEqual([]);
      expect(validateAndRepairFindings({}, text)).toEqual([]);
      expect(validateAndRepairFindings({ findings: 'not-an-array' }, text)).toEqual([]);
    });
  });
});
