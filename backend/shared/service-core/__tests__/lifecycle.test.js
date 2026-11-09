const { LIFECYCLE_STATUSES, isValidTransition } = require('../lifecycle');

describe('lifecycle', () => {
  it('exposes the 5 governed statuses', () => {
    expect(LIFECYCLE_STATUSES).toEqual(['draft', 'review', 'approved', 'deprecated', 'archived']);
  });

  it.each([
    ['draft', 'review', true],
    ['draft', 'approved', false],
    ['review', 'draft', true],
    ['review', 'approved', true],
    ['approved', 'deprecated', true],
    ['approved', 'draft', false],
    ['deprecated', 'approved', true],
    ['deprecated', 'archived', true],
    ['archived', 'draft', false],
    ['archived', 'approved', false]
  ])('isValidTransition(%s -> %s) === %s', (from, to, expected) => {
    expect(isValidTransition(from, to)).toBe(expected);
  });

  it('archived is a terminal state with no valid outgoing transitions', () => {
    LIFECYCLE_STATUSES.forEach((status) => {
      expect(isValidTransition('archived', status)).toBe(false);
    });
  });
});
