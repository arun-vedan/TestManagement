const mockProvider = require('../providers/mockProvider');

// WP-050 -- plain Jest coverage of the mock provider's own logic (GR-6's
// "plain Jest for the library logic" half; __tests__/api.test.js is the
// black-box HTTP half). Zero network, zero container needed -- this is
// exactly the point of `mock` being first-class.
describe('mockProvider.complete()', () => {
  it('echoes the last user message deterministically', async () => {
    const result = await mockProvider.complete({
      system: 'system prompt',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' }
      ]
    });
    expect(result.text).toBe('[mock reply] second');
    expect(result.model).toBe('mock-echo-1');
  });

  it('same input -> same output (deterministic)', async () => {
    const args = { messages: [{ role: 'user', content: 'repeat me' }] };
    const first = await mockProvider.complete(args);
    const second = await mockProvider.complete(args);
    expect(first).toEqual(second);
  });

  it('reports non-zero usage that scales with input/output length', async () => {
    const short = await mockProvider.complete({ messages: [{ role: 'user', content: 'hi' }] });
    const long = await mockProvider.complete({
      messages: [{ role: 'user', content: 'a'.repeat(400) }]
    });
    expect(short.usage.totalTokens).toBeGreaterThan(0);
    expect(long.usage.totalTokens).toBeGreaterThan(short.usage.totalTokens);
  });

  it('truncates to roughly maxTokens when provided', async () => {
    const result = await mockProvider.complete({
      messages: [{ role: 'user', content: 'x'.repeat(1000) }],
      maxTokens: 5
    });
    expect(result.text.length).toBeLessThanOrEqual(5 * 4);
  });

  it('handles no messages gracefully', async () => {
    const result = await mockProvider.complete({});
    expect(result.text).toBe('[mock reply]');
  });
});

describe('mockProvider.completeStructured()', () => {
  it('fills an object schema with deterministic placeholder values', async () => {
    const schema = {
      type: 'object',
      properties: {
        title: { type: 'string' },
        priority: { type: 'number' },
        automatable: { type: 'boolean' },
        tags: { type: 'array', items: { type: 'string' } }
      }
    };
    const result = await mockProvider.completeStructured({
      messages: [{ role: 'user', content: 'draft a test case' }],
      schema
    });
    expect(result.data).toEqual({
      title: 'mock-title',
      priority: 0,
      automatable: true,
      tags: ['mock-tags']
    });
    expect(result.model).toBe('mock-echo-1');
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  });

  it('handles a missing/empty schema without throwing', async () => {
    const result = await mockProvider.completeStructured({ messages: [{ role: 'user', content: 'x' }] });
    expect(result.data).toBe('mock-value');
  });
});
