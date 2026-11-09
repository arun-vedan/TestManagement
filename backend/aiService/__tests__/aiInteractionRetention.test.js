// WP-050 -- plain Jest coverage of the retention/privacy decision in
// models/AiInteraction.js: shapeText() is the ONE place that decides how
// much of a prompt/response gets persisted, so its default behavior (no
// full text, a short preview + hash) is worth proving directly, independent
// of any live database.
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('AiInteraction.shapeText()', () => {
  it('DEFAULT: does not include full text, only a preview + hash', () => {
    delete process.env.AI_STORE_FULL_TEXT;
    // eslint-disable-next-line global-require
    const { shapeText } = require('../models/AiInteraction');
    const shaped = shapeText('some customer-authored requirement text');
    expect(shaped.full).toBeUndefined();
    expect(shaped.preview).toBe('some customer-authored requirement text');
    expect(shaped.hash).toEqual(expect.any(String));
    expect(shaped.hash).toHaveLength(64); // sha256 hex
  });

  it('AI_STORE_FULL_TEXT=true opts in to storing the full text', () => {
    process.env.AI_STORE_FULL_TEXT = 'true';
    // eslint-disable-next-line global-require
    const { shapeText } = require('../models/AiInteraction');
    const shaped = shapeText('full text please');
    expect(shaped.full).toBe('full text please');
  });

  it('truncates the preview to AI_LOG_PREVIEW_CHARS', () => {
    process.env.AI_LOG_PREVIEW_CHARS = '10';
    // eslint-disable-next-line global-require
    const { shapeText } = require('../models/AiInteraction');
    const shaped = shapeText('this text is much longer than ten characters');
    expect(shaped.preview).toBe('this text ');
    expect(shaped.preview).toHaveLength(10);
  });

  it('same text -> same hash (lets two interactions be correlated without storing raw text)', () => {
    // eslint-disable-next-line global-require
    const { shapeText } = require('../models/AiInteraction');
    const a = shapeText('identical prompt');
    const b = shapeText('identical prompt');
    expect(a.hash).toBe(b.hash);
  });

  it('empty/falsy text is handled without throwing', () => {
    // eslint-disable-next-line global-require
    const { shapeText } = require('../models/AiInteraction');
    expect(shapeText('')).toEqual({ preview: '', hash: null, full: undefined });
    expect(shapeText(undefined)).toEqual({ preview: '', hash: null, full: undefined });
  });
});

describe('resolveRetentionDays() / resolveStoreFullText() / resolvePreviewChars()', () => {
  it('default retention is 30 days', () => {
    delete process.env.AI_LOG_RETENTION_DAYS;
    // eslint-disable-next-line global-require
    const { resolveRetentionDays } = require('../models/AiInteraction');
    expect(resolveRetentionDays()).toBe(30);
  });

  it('default store-full-text is false', () => {
    delete process.env.AI_STORE_FULL_TEXT;
    // eslint-disable-next-line global-require
    const { resolveStoreFullText } = require('../models/AiInteraction');
    expect(resolveStoreFullText()).toBe(false);
  });

  it('an invalid AI_LOG_RETENTION_DAYS falls back to the 30-day default, never disables the TTL', () => {
    process.env.AI_LOG_RETENTION_DAYS = 'not-a-number';
    // eslint-disable-next-line global-require
    const { resolveRetentionDays } = require('../models/AiInteraction');
    expect(resolveRetentionDays()).toBe(30);
  });
});
