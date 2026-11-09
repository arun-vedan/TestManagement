import { tokens } from '../tokens';
import theme from '../theme';

// Colour contrast is invisible to this repo's axe suites: jsdom does not
// compute rendered colour, so every a11y test can pass while a control sits
// at 1.70:1. These assertions are the only automated guard we have.
// Accepts both #rgb and #rrggbb -- the theme mixes the two ('#fff' vs
// '#244855'), and treating shorthand as 6-digit silently yields nonsense.
const expand = (hex: string): string =>
  hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;

const luminance = (raw: string): number => {
  const hex = expand(raw);
  const channels = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
};

export const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const WHITE = '#ffffff';

describe('colour contrast', () => {
  it('secondary text on secondary background clears WCAG AA', () => {
    // Was contrastText '#fff' on '#B4CAD6' = 1.70:1, which made contained
    // secondary buttons look disabled while being fully functional.
    const ratio = contrast(theme.palette.secondary.main, theme.palette.secondary.contrastText);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('brand primary carries white text at AA', () => {
    expect(contrast(theme.palette.primary.main, theme.palette.primary.contrastText)).toBeGreaterThanOrEqual(4.5);
  });

  it('every status token is legible on the workbench surface', () => {
    // Intended as fills/dots beside a neutral label, but held to the text
    // threshold so none is adopted as a label colour by accident.
    const failing = Object.entries(tokens.status)
      .map(([name, hex]) => ({ name, hex, ratio: Number(contrast(WHITE, hex).toFixed(2)) }))
      .filter((t) => t.ratio < 4.5);
    expect(failing).toEqual([]);
  });

  it('brand accents are never AA-legible as text on white, so stay fills only', () => {
    // Guards the reason they are accents: if a future palette tweak made one
    // pass, this fails and someone re-decides deliberately.
    Object.values(tokens.accent).forEach((hex) => expect(contrast(WHITE, hex)).toBeLessThan(4.5));
  });

  it('table header ink on the brand tint clears WCAG AA', () => {
    expect(contrast(tokens.brandTint, tokens.brand)).toBeGreaterThanOrEqual(4.5);
  });

  it('the neutral ramp offers an AA body-text step', () => {
    expect(contrast(WHITE, tokens.neutral[7])).toBeGreaterThanOrEqual(4.5);
  });
});
