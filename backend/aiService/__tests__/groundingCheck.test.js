const { extractNumbers, checkGrounding, flagUngroundedNumbers } = require('../lib/groundingCheck');

// WP-053 -- unit tests for the grounding post-check. This module IS the
// deliverable (see lib/groundingCheck.js's header comment for the full
// design reasoning) so it gets the deepest coverage of anything in this
// WP: what counts as a number, what counts as an acceptable match, and
// proof -- via a deliberately-hallucinating fixture -- that a violation is
// actually caught, not just theoretically catchable.

describe('groundingCheck.extractNumbers -- what counts as a "number"', () => {
  it('extracts bare integers and decimals', () => {
    const nums = extractNumbers('There are 3 defects and the completion figure reads 12.5 currently');
    expect(nums.map((n) => n.raw)).toEqual(expect.arrayContaining(['3', '12.5']));
  });

  it('a decimal immediately followed by a recognised unit word is extracted as ONE duration token, not a bare number plus a stray unit', () => {
    const nums = extractNumbers('the average age is 12.5 days old');
    expect(nums).toHaveLength(1);
    expect(nums[0]).toMatchObject({ raw: '12.5 days', kind: 'duration' });
  });

  it('extracts percentages, distinct from bare numbers', () => {
    const nums = extractNumbers('Coverage is 49.7% today, up from 12%');
    const kinds = nums.map((n) => ({ raw: n.raw, kind: n.kind }));
    expect(kinds).toEqual(
      expect.arrayContaining([
        { raw: '49.7%', kind: 'percent' },
        { raw: '12%', kind: 'percent' }
      ])
    );
  });

  it('extracts currency', () => {
    const nums = extractNumbers('The estimated cost is $1,234.56 this month');
    expect(nums.find((n) => n.kind === 'currency').raw).toBe('$1,234.56');
  });

  it('extracts durations with recognised units', () => {
    const nums = extractNumbers('The call took 250ms, and the job ran for 2 hours');
    const kinds = nums.filter((n) => n.kind === 'duration').map((n) => n.raw);
    expect(kinds).toEqual(expect.arrayContaining(['250ms', '2 hours']));
  });

  it('extracts ISO dates as a single token, not as three separate numbers', () => {
    const nums = extractNumbers('computed at 2026-08-28T10:00:00.000Z sharp');
    expect(nums).toHaveLength(1);
    expect(nums[0].kind).toBe('date');
    expect(nums[0].raw).toBe('2026-08-28T10:00:00.000Z');
  });

  it('does NOT extract digits embedded in an identifier (REL-1, TC-5, PLN-42, Req-3)', () => {
    const nums = extractNumbers('See REL-1, TC-5, PLN-42 and Req-3 for details.');
    expect(nums).toHaveLength(0);
  });

  it('does NOT extract an ordinal-like trailing-letter number (e.g. "3rd")', () => {
    const nums = extractNumbers('This is the 3rd occurrence.');
    expect(nums).toHaveLength(0);
  });

  it('handles thousands-separated plain numbers', () => {
    const nums = extractNumbers('Total requests: 12,345 today');
    expect(nums.find((n) => n.raw === '12,345').value).toBe(12345);
  });
});

describe('groundingCheck.checkGrounding -- what counts as an acceptable match', () => {
  const facts = [
    'COVERAGE (fresh as of 2026-08-28T10:00:00.000Z): 49.7% requirement coverage (5 of 10 requirements tested, 5 untested).',
    'DEFECTS (fresh as of 2026-08-28T10:00:00.000Z): 3 total defects. By severity -- Major: 2, Minor: 1.',
    'RELEASE READINESS: 1 release(s) tracked, 0 green, 1 red.'
  ].join('\n');

  it('grounds every real, exactly-cited figure', () => {
    const output = 'Coverage is 49.7% (5 of 10 tested). There are 3 open defects (2 Major, 1 Minor). 1 release is tracked, 0 green, 1 red.';
    const result = checkGrounding(facts, output);
    expect(result.grounded).toBe(true);
    expect(result.ungroundedFigures).toEqual([]);
    expect(result.citedCount).toBeGreaterThan(0);
  });

  it('accepts legitimate rounding of a real decimal (49.7 -> "about 50")', () => {
    const output = 'Coverage is about 50% currently.';
    const result = checkGrounding(facts, output);
    expect(result.grounded).toBe(true);
  });

  it('accepts a percent figure cited as a bare number, and vice versa (quantity group is cross-compatible)', () => {
    const result = checkGrounding('value: 49.7', 'coverage is roughly 50%');
    expect(result.grounded).toBe(true);
  });

  it('REJECTS a materially different invented figure (63 open defects when the real figure is 3)', () => {
    const output = 'There are 63 open defects, which is very concerning.';
    const result = checkGrounding(facts, output);
    expect(result.grounded).toBe(false);
    expect(result.ungroundedFigures).toHaveLength(1);
    expect(result.ungroundedFigures[0].raw).toBe('63');
  });

  it('draws the line: a small but real inflation (3 -> 4 defects) is still flagged, not waved through by a loose tolerance', () => {
    const output = 'There are 4 open defects today.';
    const result = checkGrounding(facts, output);
    expect(result.grounded).toBe(false);
    expect(result.ungroundedFigures.map((f) => f.raw)).toContain('4');
  });

  it('dates require an exact match -- a wrong date is flagged even though "close" in calendar terms', () => {
    const result = checkGrounding('computed 2026-08-28T10:00:00.000Z', 'as of 2026-08-29 this is current');
    expect(result.grounded).toBe(false);
    expect(result.ungroundedFigures[0].kind).toBe('date');
  });

  it('a correct date (same day, different precision) is grounded', () => {
    const result = checkGrounding('computed 2026-08-28T10:00:00.000Z', 'as of 2026-08-28 this is current');
    expect(result.grounded).toBe(true);
  });

  it('currency never matches a same-valued plain number (different groups, no cross-compatibility)', () => {
    const result = checkGrounding('total defects: 50', 'the release costs $50');
    expect(result.grounded).toBe(false);
    expect(result.ungroundedFigures[0].kind).toBe('currency');
  });

  it('duration never matches a same-valued plain number', () => {
    const result = checkGrounding('total defects: 30', 'the job took 30 minutes');
    expect(result.grounded).toBe(false);
    expect(result.ungroundedFigures[0].kind).toBe('duration');
  });

  it('duration matches across units via seconds conversion (60s grounds "1 minute")', () => {
    const result = checkGrounding('latency: 60s', 'it took about 1 minute');
    expect(result.grounded).toBe(true);
  });

  it('a release/test-case id mentioned in the narrative is never flagged as an ungrounded number', () => {
    const output = 'Release REL-1 is red; see TC-5 for the failing case.';
    const result = checkGrounding(facts, output);
    expect(result.grounded).toBe(true);
    expect(result.citedCount).toBe(0);
  });
});

describe('groundingCheck.flagUngroundedNumbers -- violations are marked, never silently dropped', () => {
  it('wraps exactly the ungrounded span, leaving the rest of the text untouched', () => {
    const output = 'Coverage is 0%. There are 63 open defects this period.';
    const result = checkGrounding('coverage: 0%, defects: 3', output);
    const flagged = flagUngroundedNumbers(output, result.ungroundedFigures);
    expect(flagged).toBe('Coverage is 0%. There are **[UNVERIFIED FIGURE: 63]** open defects this period.');
  });

  it('a fully-grounded narrative is returned unmodified', () => {
    const output = 'Coverage is 0%, and there are 3 defects.';
    const result = checkGrounding('coverage: 0%, defects: 3', output);
    expect(flagUngroundedNumbers(output, result.ungroundedFigures)).toBe(output);
  });

  it('flags multiple violations correctly without corrupting indices (processed highest-index-first)', () => {
    const output = 'Figures: 63 defects and $999 spent.';
    const result = checkGrounding('defects: 3', output);
    const flagged = flagUngroundedNumbers(output, result.ungroundedFigures);
    expect(flagged).toBe('Figures: **[UNVERIFIED FIGURE: 63]** defects and **[UNVERIFIED FIGURE: $999]** spent.');
  });
});

describe('THE deliberately-hallucinating fixture (mock provider + post-check, end to end)', () => {
  // WP-053 acceptance: "Extend the mock provider to emit a narrative
  // containing a figure absent from the input, and assert the post-check
  // catches it. A post-check that has never caught anything is untested."
  //
  // This is the live proof, exercising the REAL mock provider
  // (providers/mockProvider.js) together with the REAL post-check
  // (this module) -- not a hand-built string, the actual code path
  // controllers/ai.js#summarizeReport runs.
  const mockProvider = require('../providers/mockProvider');

  it('the mock provider, when forced, fabricates a figure absent from the grounding data -- and checkGrounding catches it', async () => {
    const facts = [
      'COVERAGE (fresh as of 2026-08-28T10:00:00.000Z): 0% requirement coverage (0 of 5 requirements tested, 5 untested).',
      'DEFECTS (fresh as of 2026-08-28T10:00:00.000Z): 3 total defects. By severity -- Major: 2, Minor: 1.'
    ].join('\n');
    const userContent = `<data trust="grounding-source">\n${facts}\n</data>\n${mockProvider.FORCE_HALLUCINATION_TOKEN}`;

    const raw = await mockProvider.complete({ system: 'sys', messages: [{ role: 'user', content: userContent }] });

    // Sanity: the mock really did fabricate something, not just echo facts.
    expect(raw.text).toMatch(/open defects were also observed/);

    const result = checkGrounding(facts, raw.text);
    expect(result.grounded).toBe(false);
    expect(result.ungroundedFigures.length).toBeGreaterThan(0);
    // The fabricated figure must not coincidentally equal a real one.
    const realNumbers = extractNumbers(facts).map((n) => n.value);
    result.ungroundedFigures.forEach((f) => {
      if (typeof f.value === 'number') {
        expect(realNumbers).not.toContain(f.value);
      }
    });

    const flagged = flagUngroundedNumbers(raw.text, result.ungroundedFigures);
    expect(flagged).toMatch(/\*\*\[UNVERIFIED FIGURE: \d+\]\*\*/);
    // Every ungrounded figure's raw text must actually appear wrapped.
    result.ungroundedFigures.forEach((f) => {
      expect(flagged).toContain(`**[UNVERIFIED FIGURE: ${f.raw}]**`);
    });
  });

  it('without the hallucination hook, the same mock provider produces a fully-grounded narrative (the golden path is exercised too, not just the failure)', async () => {
    const facts = 'COVERAGE: 0% (0 of 5 tested). DEFECTS: 3 total.';
    const userContent = `<data trust="grounding-source">\n${facts}\n</data>`;
    const raw = await mockProvider.complete({ system: 'sys', messages: [{ role: 'user', content: userContent }] });
    const result = checkGrounding(facts, raw.text);
    expect(result.grounded).toBe(true);
    expect(result.ungroundedFigures).toEqual([]);
  });
});
