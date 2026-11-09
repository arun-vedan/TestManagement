export const tokens = {
  // vedan brand. Deep Forest is the anchor and the only brand colour that
  // carries text (10.05:1 on white). Adventure orange (2.72:1) and Golden
  // Ember (2.19:1) fail WCAG AA as text on white, so they are accents only:
  // fills, highlights, illustration -- never a label or a link.
  brand: '#084C32',
  brandDeep: '#05331F',
  brandTint: '#D6E8DE',
  accent: { adventure: '#FF7235', ember: '#F39C12' },
  neutral: [
    '#ffffff', '#f7f8f9', '#eceef0', '#dfe2e6', '#c3c8ce',
    '#9aa3ac', '#6b757f', '#454d55', '#1c2126',
  ],
  // Contrast-checked against white (the workbench surface). Values are
  // intended as fills/dots beside a neutral label, never as the label
  // colour itself -- spec §6 reserves colour for signalling, not text.
  // Ratios on white: pass 5.13, fail 5.62, blocked 4.54, skipped 4.69,
  // notRun 5.45, inProgress 4.87 -- all clear WCAG AA.
  // blocked/notRun/inProgress were darkened from #ed6c02 (3.11),
  // #9aa3ac (2.56 -- an outright failure) and #0288d1 (3.86). notRun is
  // deliberately darker than skipped so the two greys stay tellable apart.
  status: {
    pass:       '#2e7d32',
    fail:       '#c62828',
    blocked:    '#c25600',
    skipped:    '#6b757f',
    notRun:     '#5f6b76',
    inProgress: '#0277b5',
  },
  density: { rowHeight: 32, spacing: 4, fontSize: 13 },
} as const;

export type StatusToken = keyof typeof tokens.status;
