const http = require('http');

// WP-050 -- unit coverage for the `openai` provider implementation, against
// a STUBBED local HTTP server -- never a live vendor endpoint (per the
// ground rules: "if you add a real-provider implementation, it must be
// exercised by unit tests against a stubbed HTTP layer, and you must say
// plainly that it has never been run against the live vendor" -- it has
// not, in this session; there is no key/account in this environment).
// Same `withServer` pattern service-core's own httpClient.test.js already
// uses for exactly this reason (real HTTP behavior against a real local
// socket, not a mocked axios that could quietly diverge from reality).
function withServer(handler, testFn) {
  return () =>
    new Promise((resolve, reject) => {
      const server = http.createServer(handler);
      server.listen(0, async () => {
        const port = server.address().port;
        try {
          await testFn(port);
          resolve();
        } catch (err) {
          reject(err);
        } finally {
          server.close();
        }
      });
    });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data ? JSON.parse(data) : {}));
  });
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  jest.resetModules();
  process.env.AI_API_KEY = 'test-key';
  process.env.AI_MODEL = 'test-model';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('openaiProvider.complete()', () => {
  it(
    'normalises a successful chat/completions response',
    withServer(
      async (req, res) => {
        expect(req.method).toBe('POST');
        expect(req.url).toBe('/chat/completions');
        expect(req.headers.authorization).toBe('Bearer test-key');
        const body = await readBody(req);
        expect(body.model).toBe('test-model');
        expect(body.messages).toEqual([
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hello' }
        ]);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            model: 'test-model',
            choices: [{ message: { role: 'assistant', content: 'hi there' } }],
            usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
          })
        );
      },
      async (port) => {
        process.env.AI_BASE_URL = `http://127.0.0.1:${port}`;
        // eslint-disable-next-line global-require
        const provider = require('../providers/openaiProvider');
        const result = await provider.complete({ system: 'sys', messages: [{ role: 'user', content: 'hello' }] });
        expect(result.text).toBe('hi there');
        expect(result.model).toBe('test-model');
        expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 3, totalTokens: 13 });
      }
    )
  );

  it(
    'normalises a 401 to a ProviderError with code "auth"',
    withServer(
      (req, res) => {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
      },
      async (port) => {
        process.env.AI_BASE_URL = `http://127.0.0.1:${port}`;
        // eslint-disable-next-line global-require
        const provider = require('../providers/openaiProvider');
        // eslint-disable-next-line global-require
        const { ProviderError } = require('../providers/errors');
        await expect(provider.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({
          code: 'auth'
        });
        try {
          await provider.complete({ messages: [{ role: 'user', content: 'x' }] });
        } catch (err) {
          expect(err).toBeInstanceOf(ProviderError);
        }
      }
    )
  );

  it(
    'normalises a 429 to a ProviderError with code "rate_limited"',
    withServer(
      (req, res) => {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'slow down' } }));
      },
      async (port) => {
        process.env.AI_BASE_URL = `http://127.0.0.1:${port}`;
        // eslint-disable-next-line global-require
        const provider = require('../providers/openaiProvider');
        await expect(provider.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({
          code: 'rate_limited'
        });
      }
    )
  );

  it(
    'normalises a 500 to a ProviderError with code "unavailable"',
    withServer(
      (req, res) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'boom' } }));
      },
      async (port) => {
        process.env.AI_BASE_URL = `http://127.0.0.1:${port}`;
        // eslint-disable-next-line global-require
        const provider = require('../providers/openaiProvider');
        await expect(provider.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({
          code: 'unavailable'
        });
      }
    )
  );

  it('normalises a connection-refused (unreachable server) to code "unavailable"', async () => {
    process.env.AI_BASE_URL = 'http://127.0.0.1:1'; // nothing listens on port 1
    // eslint-disable-next-line global-require
    const provider = require('../providers/openaiProvider');
    await expect(provider.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({
      code: 'unavailable'
    });
  });

  it('refuses to call out with no AI_API_KEY configured (code "auth")', async () => {
    delete process.env.AI_API_KEY;
    process.env.AI_BASE_URL = 'http://127.0.0.1:1';
    // eslint-disable-next-line global-require
    const provider = require('../providers/openaiProvider');
    await expect(provider.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({
      code: 'auth'
    });
  });

  it(
    'normalises a malformed (missing choices) response to code "invalid_response"',
    withServer(
      (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ model: 'test-model' }));
      },
      async (port) => {
        process.env.AI_BASE_URL = `http://127.0.0.1:${port}`;
        // eslint-disable-next-line global-require
        const provider = require('../providers/openaiProvider');
        await expect(provider.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({
          code: 'invalid_response'
        });
      }
    )
  );
});

describe('openaiProvider client identification (gateway headers)', () => {
  function okResponse(res) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: 'test-model', choices: [{ message: { content: 'ok' } }] }));
  }

  it(
    'sends its own User-Agent, never the HTTP library default',
    withServer(
      (req, res) => {
        withServer.seen = req.headers;
        okResponse(res);
      },
      async (port) => {
        process.env.AI_BASE_URL = `http://127.0.0.1:${port}`;
        delete process.env.AI_USER_AGENT;
        delete process.env.AI_SESSION_HEADER;
        // eslint-disable-next-line global-require
        const provider = require('../providers/openaiProvider');
        await provider.complete({ messages: [{ role: 'user', content: 'x' }] });
        expect(withServer.seen['user-agent']).toBe('srckube-aiService/1.0');
        expect(withServer.seen['x-opencode-session']).toBeUndefined();
      }
    )
  );

  it(
    'honours AI_USER_AGENT and sends a fresh session id under AI_SESSION_HEADER per call',
    withServer(
      (req, res) => {
        withServer.sessions = withServer.sessions || [];
        withServer.sessions.push(req.headers['x-opencode-session']);
        withServer.ua = req.headers['user-agent'];
        okResponse(res);
      },
      async (port) => {
        withServer.sessions = [];
        process.env.AI_BASE_URL = `http://127.0.0.1:${port}`;
        process.env.AI_USER_AGENT = 'srckube-test/9.9';
        process.env.AI_SESSION_HEADER = 'x-opencode-session';
        // eslint-disable-next-line global-require
        const provider = require('../providers/openaiProvider');
        await provider.complete({ messages: [{ role: 'user', content: 'a' }] });
        await provider.complete({ messages: [{ role: 'user', content: 'b' }] });
        expect(withServer.ua).toBe('srckube-test/9.9');
        expect(withServer.sessions).toHaveLength(2);
        withServer.sessions.forEach((id) => expect(id).toMatch(/^[0-9a-f-]{36}$/));
        expect(withServer.sessions[0]).not.toBe(withServer.sessions[1]);
      }
    )
  );

  it(
    'honours AI_TIMEOUT_MS -- a slower-than-configured vendor surfaces as "unavailable"',
    withServer(
      (req, res) => {
        setTimeout(() => okResponse(res), 300);
      },
      async (port) => {
        process.env.AI_BASE_URL = `http://127.0.0.1:${port}`;
        process.env.AI_TIMEOUT_MS = '50';
        // eslint-disable-next-line global-require
        const provider = require('../providers/openaiProvider');
        await expect(provider.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({
          code: 'unavailable'
        });
      }
    )
  );
});

describe('openaiProvider token-limit exhaustion', () => {
  it(
    'reports finish_reason "length" with no content as a token-limit problem, not a bad shape',
    withServer(
      (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            model: 'test-model',
            choices: [{ finish_reason: 'length', message: { role: 'assistant', content: null } }],
            usage: { prompt_tokens: 23, completion_tokens: 32, total_tokens: 55 }
          })
        );
      },
      async (port) => {
        process.env.AI_BASE_URL = `http://127.0.0.1:${port}`;
        // eslint-disable-next-line global-require
        const provider = require('../providers/openaiProvider');
        await expect(provider.complete({ messages: [{ role: 'user', content: 'x' }], maxTokens: 32 })).rejects.toMatchObject({
          code: 'invalid_response',
          message: expect.stringContaining('token limit')
        });
      }
    )
  );
});

describe('openaiProvider.completeStructured()', () => {
  it(
    'parses a JSON-object response into `data`',
    withServer(
      async (req, res) => {
        const body = await readBody(req);
        expect(body.response_format).toEqual({ type: 'json_object' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            model: 'test-model',
            choices: [{ message: { content: '{"title":"Login works","priority":1}' } }],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }
          })
        );
      },
      async (port) => {
        process.env.AI_BASE_URL = `http://127.0.0.1:${port}`;
        // eslint-disable-next-line global-require
        const provider = require('../providers/openaiProvider');
        const result = await provider.completeStructured({
          messages: [{ role: 'user', content: 'draft' }],
          schema: { type: 'object', properties: { title: { type: 'string' }, priority: { type: 'number' } } }
        });
        expect(result.data).toEqual({ title: 'Login works', priority: 1 });
      }
    )
  );

  it(
    'non-JSON content -> ProviderError code "invalid_response"',
    withServer(
      (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            model: 'test-model',
            choices: [{ message: { content: 'not json' } }]
          })
        );
      },
      async (port) => {
        process.env.AI_BASE_URL = `http://127.0.0.1:${port}`;
        // eslint-disable-next-line global-require
        const provider = require('../providers/openaiProvider');
        await expect(
          provider.completeStructured({
            messages: [{ role: 'user', content: 'x' }],
            schema: { type: 'object', properties: {} }
          })
        ).rejects.toMatchObject({ code: 'invalid_response' });
      }
    )
  );
});

// ---------------------------------------------------------------------------
// Rate-limit (429) retry. Added after a live Gemini run: auditDuplicates
// fires one provider call per test case in a tight loop
// (controllers/ai.js), which burst past the vendor's per-minute quota and
// came back 429. service-core's requestWithRetry deliberately fails 4xx
// fast -- correct for 400/401/404, but 429 is the ONE 4xx a retry CAN fix,
// because it is time-based rather than request-based. So the adapter, not
// the shared client, owns backing off on it: the shared client also backs
// every cross-service call in this codebase, where a 429 from a service's
// own rate limiter should still fail fast.
describe('openaiProvider 429 handling', () => {
  beforeEach(() => {
    // Keep the suite fast -- the production default is AI_RATE_LIMIT_BACKOFF_MS's
    // 500ms base, which would make these cases sleep for real.
    process.env.AI_RATE_LIMIT_BACKOFF_MS = '1';
  });

  it(
    'retries a 429 and succeeds when the next attempt is allowed through',
    withServer(
      (req, res) => {
        withServer.calls = (withServer.calls || 0) + 1;
        if (withServer.calls === 1) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'quota exceeded' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            model: 'test-model',
            choices: [{ message: { content: 'recovered' } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          })
        );
      },
      async (port) => {
        withServer.calls = 0;
        process.env.AI_BASE_URL = `http://127.0.0.1:${port}`;
        // eslint-disable-next-line global-require
        const provider = require('../providers/openaiProvider');
        const out = await provider.complete({ messages: [{ role: 'user', content: 'x' }] });
        expect(out.text).toBe('recovered');
        expect(withServer.calls).toBe(2);
      }
    )
  );

  it(
    'gives up after the bounded retry budget and still reports rate_limited',
    withServer(
      (req, res) => {
        withServer.calls = (withServer.calls || 0) + 1;
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'quota exceeded' } }));
      },
      async (port) => {
        withServer.calls = 0;
        process.env.AI_BASE_URL = `http://127.0.0.1:${port}`;
        process.env.AI_RATE_LIMIT_RETRIES = '2';
        // eslint-disable-next-line global-require
        const provider = require('../providers/openaiProvider');
        await expect(provider.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({
          code: 'rate_limited'
        });
        // Bounded: the initial attempt plus exactly AI_RATE_LIMIT_RETRIES more,
        // never an unbounded hammer on a vendor that is already refusing us.
        expect(withServer.calls).toBe(3);
      }
    )
  );

  it(
    'does NOT retry a 400 -- the fail-fast stance still holds for real client errors',
    withServer(
      (req, res) => {
        withServer.calls = (withServer.calls || 0) + 1;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad request' } }));
      },
      async (port) => {
        withServer.calls = 0;
        process.env.AI_BASE_URL = `http://127.0.0.1:${port}`;
        // eslint-disable-next-line global-require
        const provider = require('../providers/openaiProvider');
        await expect(provider.complete({ messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({
          code: 'invalid_request'
        });
        expect(withServer.calls).toBe(1);
      }
    )
  );
});

describe('openaiProvider.parseRetryAfterMs()', () => {
  // Pure function, unit-tested directly rather than through a timing
  // assertion -- asserting "it actually slept ~N seconds" is exactly the
  // kind of wall-clock test that goes flaky on a loaded CI box.
  // eslint-disable-next-line global-require
  const { parseRetryAfterMs } = require('../providers/openaiProvider');

  it('reads delta-seconds', () => {
    expect(parseRetryAfterMs('2')).toBe(2000);
  });

  it('reads an HTTP-date', () => {
    const twoSecondsOut = new Date(Date.now() + 2000).toUTCString();
    const ms = parseRetryAfterMs(twoSecondsOut);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(2000);
  });

  it('ignores junk, a missing header, and negative values', () => {
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs('soon')).toBeNull();
    expect(parseRetryAfterMs('-5')).toBeNull();
  });

  it('clamps an absurd Retry-After so one hostile header cannot hang a request', () => {
    expect(parseRetryAfterMs('86400')).toBe(30000);
  });
});
