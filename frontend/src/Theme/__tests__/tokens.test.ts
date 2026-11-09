import { tokens } from '../tokens';
import theme from '../theme';

describe('design tokens', () => {
  it('exposes all six execution status colours', () => {
    expect(Object.keys(tokens.status).sort()).toEqual(
      ['blocked', 'fail', 'inProgress', 'notRun', 'pass', 'skipped'],
    );
  });

  it('exposes a 9-step neutral ramp', () => {
    expect(tokens.neutral).toHaveLength(9);
    tokens.neutral.forEach((c) => expect(c).toMatch(/^#[0-9a-f]{6}$/i));
  });

  it('uses vedan Deep Forest #084C32 as the brand anchor', () => {
    expect(theme.palette.primary.main.toLowerCase()).toBe('#084c32');
  });

  it('sets the dense base font size', () => {
    expect(theme.typography.fontSize).toBe(13);
  });
});
