const {
  THRESHOLD,
  tokenize,
  jaccardScore,
  validateAndRepairDuplicateResults
} = require('../lib/duplicateDetection');

// WP-052 -- plain Jest coverage of lib/duplicateDetection.js's pure logic
// (GR-6's "plain Jest for the library logic" half; __tests__/aiDuplicates.test.js
// is the black-box HTTP half). Zero network, zero container needed.
//
// THE POINT: prove jaccardScore() genuinely separates a near-duplicate pair
// from an unrelated pair with real numbers on both sides of THRESHOLD (not
// just "it returns *a* number"), and prove
// validateAndRepairDuplicateResults() never trusts the model's output shape
// -- wrong types, a hallucinated/unknown candidateId, and an out-of-range
// score are each handled the way GR-8 requires (dropped, or repaired,
// never passed through as-is).
describe('lib/duplicateDetection', () => {
  describe('jaccardScore() -- both directions, actual scores', () => {
    const nearA =
      'SUMMARY: User can log in to the application using a valid username and password\n' +
      'DESCRIPTION: Verify that a registered user is able to log in successfully by entering a correct username and password on the login page.';
    const nearB =
      'SUMMARY: User is able to login to the app with valid username and password\n' +
      'DESCRIPTION: Verify that a registered user can successfully log in by entering a valid username and password on the login screen.';
    const unrelated =
      'SUMMARY: Export report as CSV\n' +
      'DESCRIPTION: Verify that clicking the export button downloads a CSV file containing every visible column of the current report.';

    it('scores a seeded near-duplicate pair well above THRESHOLD', () => {
      const score = jaccardScore(nearA, nearB);
      expect(score).toBeGreaterThanOrEqual(THRESHOLD + 10);
    });

    it('scores an unrelated pair well below THRESHOLD', () => {
      const score = jaccardScore(nearA, unrelated);
      expect(score).toBeLessThan(THRESHOLD - 30);
    });

    it('is symmetric', () => {
      expect(jaccardScore(nearA, nearB)).toBe(jaccardScore(nearB, nearA));
    });

    it('is deterministic (same input -> same output)', () => {
      expect(jaccardScore(nearA, nearB)).toBe(jaccardScore(nearA, nearB));
    });

    it('scores identical text 100', () => {
      expect(jaccardScore(nearA, nearA)).toBe(100);
    });

    it('handles empty text without throwing', () => {
      expect(jaccardScore('', '')).toBe(0);
      expect(jaccardScore('', nearA)).toBe(0);
    });
  });

  describe('tokenize()', () => {
    it('lowercases, strips punctuation, drops stopwords and single-char tokens', () => {
      expect(tokenize('The Login Page: a user, and a password!')).toEqual(['login', 'page', 'user', 'password']);
    });
  });

  describe('validateAndRepairDuplicateResults() -- never trusts model output shape', () => {
    const allowedIds = ['TC-1', 'TC-2'];

    it('drops a result whose candidateId is the wrong type', () => {
      const out = validateAndRepairDuplicateResults({ results: [{ candidateId: 12345, score: 80, reason: 'x' }] }, allowedIds);
      expect(out).toEqual([]);
    });

    it('drops a non-object entry', () => {
      const out = validateAndRepairDuplicateResults({ results: ['not-an-object'] }, allowedIds);
      expect(out).toEqual([]);
    });

    it('drops a hallucinated/unknown candidateId not in allowedIds', () => {
      const out = validateAndRepairDuplicateResults({ results: [{ candidateId: 'TC-999', score: 90, reason: 'x' }] }, allowedIds);
      expect(out).toEqual([]);
    });

    it('clamps an out-of-range score to [0, 100] rather than dropping an otherwise-valid entry', () => {
      const out = validateAndRepairDuplicateResults({ results: [{ candidateId: 'TC-1', score: 999, reason: 'x' }] }, allowedIds);
      expect(out).toEqual([{ candidateId: 'TC-1', score: 100, reason: 'x' }]);
    });

    it('clamps a negative score to 0', () => {
      const out = validateAndRepairDuplicateResults({ results: [{ candidateId: 'TC-1', score: -50, reason: 'x' }] }, allowedIds);
      expect(out[0].score).toBe(0);
    });

    it('keeps the higher score if the same candidateId appears twice', () => {
      const out = validateAndRepairDuplicateResults(
        { results: [{ candidateId: 'TC-1', score: 20, reason: 'a' }, { candidateId: 'TC-1', score: 80, reason: 'b' }] },
        allowedIds
      );
      expect(out).toEqual([{ candidateId: 'TC-1', score: 80, reason: 'b' }]);
    });

    it('handles a completely garbage raw payload without throwing', () => {
      expect(validateAndRepairDuplicateResults(null, allowedIds)).toEqual([]);
      expect(validateAndRepairDuplicateResults({}, allowedIds)).toEqual([]);
      expect(validateAndRepairDuplicateResults({ results: 'not-an-array' }, allowedIds)).toEqual([]);
    });
  });
});
