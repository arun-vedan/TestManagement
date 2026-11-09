import { parseEditorValue } from '../FieldGrid';

// WP-074c regression guard. Both of these were found only by rendering the
// workbench in a real browser against real seeded data -- the jest suite was
// fully green while TC-695 crashed the detail region on sight.
describe('parseEditorValue', () => {
  it('parses a JSON-serialised Quill delta', () => {
    const delta = { ops: [{ insert: 'hello\n' }] };
    expect(parseEditorValue(JSON.stringify(delta))).toEqual(delta);
  });

  // The bug: TC-695's stored value is the plain string "seeded for ...".
  // An unguarded JSON.parse threw and took the whole detail region down
  // into RegionErrorBoundary. TabContent.tsx:760 still has this bug.
  it('returns a non-JSON plain string unchanged instead of throwing', () => {
    expect(() => parseEditorValue('seeded for regression')).not.toThrow();
    expect(parseEditorValue('seeded for regression')).toBe('seeded for regression');
  });

  it('treats empty and non-string values as empty', () => {
    expect(parseEditorValue('')).toBe('');
    expect(parseEditorValue(undefined)).toBe('');
    expect(parseEditorValue(null)).toBe('');
  });
});
