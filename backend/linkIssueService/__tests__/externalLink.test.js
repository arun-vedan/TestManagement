// WP-141 — the input rules for an external-issue link, as a pure unit.
// The live round trip and tenant isolation are proven in externalLink.live
// sections of api.test.js / tenantIsolation.test.js; this file pins the rules.

const {
  EXTERNAL_MODULE,
  normalizeCreate,
  normalizeUpdate
} = require('../utils/externalLink');

const base = { sourceId: 'Bug-7', srcModule: 5, linkType: 'relates-to' };

describe('external links (WP-141)', () => {
  describe('normalizeCreate', () => {
    it('derives a namespaced destinationId from provider and key, ignoring any client value', () => {
      const out = normalizeCreate({
        ...base,
        destinationModule: EXTERNAL_MODULE,
        destinationId: 'TC-1',
        external: { provider: 'jira', key: 'ACME-123' }
      });
      expect(out.destinationId).toBe('jira:ACME-123');
      expect(out.destinationModule).toBe(EXTERNAL_MODULE);
      expect(out.external).toEqual({ provider: 'jira', key: 'ACME-123' });
    });

    it('normalises key case/whitespace and provider case, and accepts a string module number', () => {
      const out = normalizeCreate({
        ...base,
        destinationModule: String(EXTERNAL_MODULE),
        external: { provider: ' JIRA ', key: '  acme-42 ' }
      });
      expect(out.destinationModule).toBe(EXTERNAL_MODULE);
      expect(out.external).toEqual({ provider: 'jira', key: 'ACME-42' });
      expect(out.destinationId).toBe('jira:ACME-42');
    });

    it('never accepts the cached status or fetch time from a client', () => {
      const out = normalizeCreate({
        ...base,
        destinationModule: EXTERNAL_MODULE,
        external: { provider: 'jira', key: 'ACME-1', status: 'Done', fetchedAt: '2026-01-01' }
      });
      expect(out.external.status).toBeUndefined();
      expect(out.external.fetchedAt).toBeUndefined();
    });

    it('keeps a trimmed summary and bounds its length', () => {
      const out = normalizeCreate({
        ...base,
        destinationModule: EXTERNAL_MODULE,
        external: { provider: 'jira', key: 'ACME-1' },
        summary: `  ${'x'.repeat(600)}  `
      });
      expect(out.summary).toHaveLength(500);
    });

    it.each([
      ['missing external block', { destinationModule: EXTERNAL_MODULE }],
      ['unknown provider', { destinationModule: EXTERNAL_MODULE, external: { provider: 'github', key: 'ACME-1' } }],
      ['missing key', { destinationModule: EXTERNAL_MODULE, external: { provider: 'jira' } }],
      ['key without a number', { destinationModule: EXTERNAL_MODULE, external: { provider: 'jira', key: 'ACME' } }],
      ['key with issue number 0', { destinationModule: EXTERNAL_MODULE, external: { provider: 'jira', key: 'ACME-0' } }],
      ['project key starting with a digit', { destinationModule: EXTERNAL_MODULE, external: { provider: 'jira', key: '1ACME-5' } }],
      ['key that is a URL', { destinationModule: EXTERNAL_MODULE, external: { provider: 'jira', key: 'https://x.atlassian.net/browse/ACME-1' } }],
      ['non-string key', { destinationModule: EXTERNAL_MODULE, external: { provider: 'jira', key: { $gt: '' } } }]
    ])('rejects %s with a 400', (_label, extra) => {
      expect(() => normalizeCreate({ ...base, ...extra })).toThrow(expect.objectContaining({ statusCode: 400 }));
    });

    it('rejects an external entity as the SOURCE of a link (links into Jira are one-way)', () => {
      expect(() =>
        normalizeCreate({ sourceId: 'jira:ACME-1', srcModule: EXTERNAL_MODULE, destinationId: 'Bug-7', destinationModule: 5 })
      ).toThrow(expect.objectContaining({ statusCode: 400 }));
    });

    it('requires an internal source id', () => {
      expect(() =>
        normalizeCreate({ srcModule: 5, destinationModule: EXTERNAL_MODULE, external: { provider: 'jira', key: 'ACME-1' } })
      ).toThrow(expect.objectContaining({ statusCode: 400 }));
    });

    it('leaves an internal link untouched apart from dropping a stray external block', () => {
      const body = { sourceId: 'Req-1', destinationId: 'TC-1', srcModule: 2, destinationModule: 1, linkType: 'tests', external: { provider: 'jira', key: 'X-1' } };
      const out = normalizeCreate(body);
      expect(out).toEqual({ sourceId: 'Req-1', destinationId: 'TC-1', srcModule: 2, destinationModule: 1, linkType: 'tests' });
    });
  });

  describe('normalizeUpdate', () => {
    it('strips every identity field so an update can only change what a link says, not what it connects', () => {
      const out = normalizeUpdate({
        linkType: 'blocks',
        projectId: 99,
        sourceId: 'X',
        destinationId: 'Y',
        srcModule: 1,
        destinationModule: 2,
        external: { provider: 'jira', key: 'ACME-9' },
        summary: 'new summary'
      });
      expect(out).toEqual({ linkType: 'blocks', summary: 'new summary' });
    });
  });
});
