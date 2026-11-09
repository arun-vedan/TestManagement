// WP-104 — unit tests for the shared wildcardsearch helpers.
//
// Context for the assertions below: this WP's brief described the three
// unescaped `$regex` routes as "a denial of service any registered stranger
// can trigger" via catastrophic backtracking. That was measured against this
// deployment (MongoDB 6.0.28) and NOT reproduced -- classic exponential
// patterns ((a+)+$, (a*)*b, six-deep nested quantifiers) against subjects up
// to 50 000 characters all completed in <= 5 ms. See EXECUTION_LOG.md's
// WP-104 entry for the full measurements.
//
// What escaping does fix here is therefore correctness first and defence in
// depth second: without it a search for "TC-1." matches "TC-11", a search for
// "." matches every document, and "^" anchors. The result cap is what closes
// the real resource-exhaustion path on these routes.

const {
  escapeRegex,
  requireSearchTerm,
  resolveSearchLimit,
  SEARCH_TERM_MAX_LENGTH
} = require('../utils/searchQuery');

describe('escapeRegex', () => {
  it('escapes every regex metacharacter so the term matches literally', () => {
    expect(escapeRegex('.')).toBe('\\.');
    expect(escapeRegex('.*')).toBe('\\.\\*');
    expect(escapeRegex('^')).toBe('\\^');
    expect(escapeRegex('(a+)+$')).toBe('\\(a\\+\\)\\+\\$');
    expect(escapeRegex('a|b')).toBe('a\\|b');
    expect(escapeRegex('x[y]z')).toBe('x\\[y\\]z');
    expect(escapeRegex('back\\slash')).toBe('back\\\\slash');
    expect(escapeRegex('{2,3}')).toBe('\\{2,3\\}');
  });

  it('leaves ordinary search text untouched', () => {
    expect(escapeRegex('TC-104')).toBe('TC-104');
    expect(escapeRegex('login flow')).toBe('login flow');
  });

  it('is byte-identical in behaviour to the WP-F01 local copies it replaces', () => {
    // The exact one-liner still present in
    // testPlanExecutionService/controllers/{testplan,testexecution}.js.
    const wpF01 = (text) => String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    ['.', '.*', '^', '$', '(a+)+$', 'TC-104', 'a|b', '[x]', 'a\\b', '', 'plain text']
      .forEach((input) => expect(escapeRegex(input)).toBe(wpF01(input)));
  });

  it('the escaped output is a literal match, proven by running it as a real regex', () => {
    // The concrete correctness bug: unescaped "TC-1." matches "TC-11".
    expect(new RegExp('TC-1.', 'i').test('TC-11')).toBe(true);
    expect(new RegExp(escapeRegex('TC-1.'), 'i').test('TC-11')).toBe(false);
    expect(new RegExp(escapeRegex('TC-1.'), 'i').test('TC-1.')).toBe(true);

    // And "." must stop meaning "any character".
    expect(new RegExp('.', 'i').test('anything')).toBe(true);
    expect(new RegExp(escapeRegex('.'), 'i').test('anything')).toBe(false);
    expect(new RegExp(escapeRegex('.'), 'i').test('v1.2')).toBe(true);
  });

  it('handles null/undefined without throwing', () => {
    expect(escapeRegex(undefined)).toBe('');
    expect(escapeRegex(null)).toBe('');
  });
});

describe('requireSearchTerm', () => {
  it('returns the escaped term for valid input', () => {
    expect(requireSearchTerm('TC-104')).toBe('TC-104');
    expect(requireSearchTerm('TC-1.')).toBe('TC-1\\.');
  });

  it('trims surrounding whitespace before escaping', () => {
    expect(requireSearchTerm('  login  ')).toBe('login');
  });

  it('rejects a missing term with 400, not the 500 Mongo used to produce', () => {
    // Before WP-104 a missing ?search= reached Mongo as {$regex: undefined}
    // and surfaced as HTTP 500 "$regex has to be a string" -- a server-fault
    // status for purely bad input.
    expect.assertions(2);
    try { requireSearchTerm(undefined); } catch (e) {
      expect(e.statusCode).toBe(400);
      expect(e.message).toMatch(/search term is required/i);
    }
  });

  it('rejects an empty or whitespace-only term with 400', () => {
    // Before WP-104 an empty search returned every document in the project.
    ['', '   ', '\t'].forEach((bad) => {
      expect(() => requireSearchTerm(bad)).toThrow(/search term is required/i);
      try { requireSearchTerm(bad); } catch (e) { expect(e.statusCode).toBe(400); }
    });
  });

  it('rejects a repeated ?search= (Express parses it as an array) with 400', () => {
    expect.assertions(2);
    try { requireSearchTerm(['a', 'b']); } catch (e) {
      expect(e.statusCode).toBe(400);
      expect(e.message).toMatch(/single text value/i);
    }
  });

  it(`rejects a term longer than ${SEARCH_TERM_MAX_LENGTH} characters with 400, naming the length`, () => {
    const tooLong = 'a'.repeat(SEARCH_TERM_MAX_LENGTH + 1);
    expect.assertions(2);
    try { requireSearchTerm(tooLong); } catch (e) {
      expect(e.statusCode).toBe(400);
      expect(e.message).toMatch(new RegExp(`${SEARCH_TERM_MAX_LENGTH + 1}`));
    }
  });

  it(`accepts a term of exactly ${SEARCH_TERM_MAX_LENGTH} characters (boundary)`, () => {
    const exact = 'a'.repeat(SEARCH_TERM_MAX_LENGTH);
    expect(requireSearchTerm(exact)).toBe(exact);
  });
});

describe('resolveSearchLimit', () => {
  const original = process.env.WILDCARD_SEARCH_MAX_RESULTS;
  afterEach(() => {
    if (original === undefined) delete process.env.WILDCARD_SEARCH_MAX_RESULTS;
    else process.env.WILDCARD_SEARCH_MAX_RESULTS = original;
  });

  it('defaults to 100', () => {
    delete process.env.WILDCARD_SEARCH_MAX_RESULTS;
    expect(resolveSearchLimit()).toBe(100);
  });

  it('honours a valid override', () => {
    process.env.WILDCARD_SEARCH_MAX_RESULTS = '25';
    expect(resolveSearchLimit()).toBe(25);
  });

  it('falls back to the default for junk, zero or negative values (never unbounded)', () => {
    ['nonsense', '0', '-5', ''].forEach((bad) => {
      process.env.WILDCARD_SEARCH_MAX_RESULTS = bad;
      expect(resolveSearchLimit()).toBe(100);
    });
  });
});
