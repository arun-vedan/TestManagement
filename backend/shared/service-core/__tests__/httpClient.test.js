const http = require('http');
const { requestWithRetry } = require('../httpClient');

// These spin up a real local HTTP server rather than mocking axios — this is
// the exact failure mode the wrapper exists for (TD-16: testExecutionService
// had no timeout/retry calling testRepoService), so it's tested against real
// network behavior, not a mock that could quietly diverge from reality.

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

describe('requestWithRetry', () => {
  it(
    'recovers after transient 500s and eventually succeeds',
    withServer(
      (() => {
        let attempts = 0;
        return (req, res) => {
          attempts += 1;
          if (attempts < 3) {
            res.writeHead(500);
            res.end('fail');
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, attempts }));
          }
        };
      })(),
      async (port) => {
        const resp = await requestWithRetry(
          { method: 'get', url: `http://127.0.0.1:${port}/` },
          { retries: 3 }
        );
        expect(resp.data.ok).toBe(true);
        expect(resp.data.attempts).toBe(3);
      }
    )
  );

  it(
    'gives up after exhausting retries against a persistently failing server',
    withServer(
      (req, res) => {
        res.writeHead(500);
        res.end('always fails');
      },
      async (port) => {
        await expect(
          requestWithRetry({ method: 'get', url: `http://127.0.0.1:${port}/` }, { retries: 2 })
        ).rejects.toThrow();
      }
    )
  );

  it(
    'fails fast on a non-retryable 4xx without retrying',
    withServer(
      (() => {
        let attempts = 0;
        return (req, res) => {
          attempts += 1;
          res.writeHead(400);
          res.end(JSON.stringify({ attempts }));
        };
      })(),
      async (port) => {
        try {
          await requestWithRetry({ method: 'get', url: `http://127.0.0.1:${port}/` }, { retries: 2 });
          throw new Error('expected requestWithRetry to reject');
        } catch (err) {
          expect(err.response.status).toBe(400);
          // axios auto-parses a JSON-looking body, so this is already an object.
          expect(err.response.data.attempts).toBe(1);
        }
      }
    )
  );
});

// WP-105 — 429 is the one 4xx worth retrying: unlike 400/401/403/404 it does
// not mean "your request is wrong", it means "you are early". The server often
// says exactly how early via Retry-After (RFC 9110 §10.2.3), in either
// delay-seconds or HTTP-date form.
//
// THE CAP IS NOT OPTIONAL, and the reason is in this repo. Its own internal
// limiter (express-rate-limit v5, configured in shared/service-core/
// security.js with windowMs = 10 minutes) sets
// `Retry-After: Math.ceil(windowMs / 1000)` = **600**. So a service-to-service
// call that trips the internal limiter is told to wait ten minutes. Honouring
// that literally would hang the caller's request for ten minutes per retry --
// dramatically worse than the fail-fast behaviour it replaced. So a
// Retry-After beyond maxRetryAfterMs means "do not retry at all", which
// preserves today's behaviour exactly for that case while still honouring the
// short, actionable delays a third-party API sends.

const { parseRetryAfter, isRetryable } = require('../httpClient');

describe('parseRetryAfter (unit)', () => {
  it('parses the delay-seconds form into milliseconds', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter('0')).toBe(0);
    expect(parseRetryAfter('600')).toBe(600000); // what this repo's own limiter sends
  });

  it('parses the HTTP-date form as a delay from now', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:05 GMT', now)).toBe(5000);
  });

  it('treats an HTTP-date already in the past as no delay, never negative', () => {
    const now = Date.parse('2026-01-01T00:00:10Z');
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:00 GMT', now)).toBe(0);
  });

  it('returns null for absent or unparseable values, so the caller falls back to backoff', () => {
    [undefined, null, '', '   ', 'soon', 'NaN'].forEach((bad) => {
      expect(parseRetryAfter(bad)).toBeNull();
    });
  });

  // Regression guard for a defect this suite caught in WP-105's own first
  // implementation. Date.parse() is far looser than RFC 9110:
  // Date.parse('-5') is 2001-05-01 and Date.parse('1.5') is 2001-01-05 --
  // both valid, both in the past. Without a format guard those came back as 0
  // ("retry immediately"), so a server sending a malformed Retry-After would
  // be hammered by the very client it had just asked to slow down. They must
  // be null (fall back to exponential backoff), not 0.
  it('does not let Date.parse coerce malformed values into "retry immediately"', () => {
    ['-5', '1.5'].forEach((v) => expect(parseRetryAfter(v)).not.toBe(0));
    expect(parseRetryAfter('-5')).toBeNull();
    expect(parseRetryAfter('1.5')).toBeNull();
    // ...while the legitimate forms still work.
    expect(parseRetryAfter('0')).toBe(0);
    expect(parseRetryAfter('7')).toBe(7000);
  });
});

describe('requestWithRetry — 429 handling (WP-105)', () => {
  it(
    'retries a 429 and honours Retry-After: 2 (~2s), then succeeds',
    withServer(
      (() => {
        let attempts = 0;
        return (req, res) => {
          attempts += 1;
          if (attempts === 1) {
            res.writeHead(429, { 'Retry-After': '2' });
            res.end('slow down');
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, attempts }));
          }
        };
      })(),
      async (port) => {
        const started = Date.now();
        const resp = await requestWithRetry(
          { method: 'get', url: `http://127.0.0.1:${port}/` },
          { retries: 2, retryOn429: true }
        );
        const elapsed = Date.now() - started;

        expect(resp.data.ok).toBe(true);
        expect(resp.data.attempts).toBe(2);
        // Honoured the server's 2s, not the 100ms exponential backoff.
        expect(elapsed).toBeGreaterThanOrEqual(1900);
        expect(elapsed).toBeLessThan(4000);
      }
    ),
    15000
  );

  it(
    'retries a 429 with no Retry-After using ordinary exponential backoff',
    withServer(
      (() => {
        let attempts = 0;
        return (req, res) => {
          attempts += 1;
          if (attempts < 3) {
            res.writeHead(429);
            res.end('slow down');
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, attempts }));
          }
        };
      })(),
      async (port) => {
        const started = Date.now();
        const resp = await requestWithRetry(
          { method: 'get', url: `http://127.0.0.1:${port}/` },
          { retries: 3, retryOn429: true }
        );
        expect(resp.data.attempts).toBe(3);
        // 100ms + 200ms of backoff, nowhere near a Retry-After style wait.
        expect(Date.now() - started).toBeLessThan(2000);
      }
    ),
    15000
  );

  it(
    'does NOT wait on a Retry-After beyond the cap — it fails fast, as it did before WP-105',
    withServer(
      (() => {
        let attempts = 0;
        return (req, res) => {
          attempts += 1;
          // Exactly what this repo's own express-rate-limit sends.
          res.writeHead(429, { 'Retry-After': '600', 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ attempts }));
        };
      })(),
      async (port) => {
        const started = Date.now();
        await expect(
          requestWithRetry(
            { method: 'get', url: `http://127.0.0.1:${port}/` },
            { retries: 2, retryOn429: true }
          )
        ).rejects.toMatchObject({ response: { status: 429 } });
        // Returned immediately rather than sleeping for ten minutes.
        expect(Date.now() - started).toBeLessThan(1000);
      }
    ),
    15000
  );

  it(
    'honours a caller-supplied maxRetryAfterMs',
    withServer(
      (req, res) => {
        res.writeHead(429, { 'Retry-After': '5' });
        res.end('slow down');
      },
      async (port) => {
        const started = Date.now();
        await expect(
          requestWithRetry(
            { method: 'get', url: `http://127.0.0.1:${port}/` },
            { retries: 2, retryOn429: true, maxRetryAfterMs: 1000 }
          )
        ).rejects.toMatchObject({ response: { status: 429 } });
        // 5s exceeds the 1s cap, so no wait at all.
        expect(Date.now() - started).toBeLessThan(1000);
      }
    ),
    15000
  );

  it(
    'gives up after exhausting retries against a server that always 429s',
    withServer(
      (req, res) => {
        res.writeHead(429, { 'Retry-After': '0' });
        res.end('always limited');
      },
      async (port) => {
        await expect(
          requestWithRetry(
            { method: 'get', url: `http://127.0.0.1:${port}/` },
            { retries: 2, retryOn429: true }
          )
        ).rejects.toMatchObject({ response: { status: 429 } });
      }
    ),
    15000
  );

  // The default is what every existing internal call site gets, so it is
  // asserted explicitly rather than left implied.
  it(
    'does NOT retry a 429 by default — internal callers keep today\'s fail-fast behaviour',
    withServer(
      (() => {
        let attempts = 0;
        return (req, res) => {
          attempts += 1;
          res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
          res.end(JSON.stringify({ attempts }));
        };
      })(),
      async (port) => {
        const started = Date.now();
        try {
          // No retryOn429 — exactly how all ~16 current call sites invoke it.
          await requestWithRetry({ method: 'get', url: `http://127.0.0.1:${port}/` }, { retries: 2 });
          throw new Error('expected requestWithRetry to reject');
        } catch (err) {
          expect(err.response.status).toBe(429);
          // One attempt only: no retry, and no wait on the Retry-After.
          expect(err.response.data.attempts).toBe(1);
          expect(Date.now() - started).toBeLessThan(1000);
        }
      }
    ),
    15000
  );

  it('isRetryable treats 429 as retryable only when opted in', () => {
    const e429 = { response: { status: 429 } };
    expect(isRetryable(e429)).toBe(false);
    expect(isRetryable(e429, { retryOn429: false })).toBe(false);
    expect(isRetryable(e429, { retryOn429: true })).toBe(true);

    // The opt-in must not widen anything else.
    [400, 401, 403, 404, 409, 422].forEach((status) => {
      expect(isRetryable({ response: { status } }, { retryOn429: true })).toBe(false);
    });
    // ...and must not narrow 5xx or network errors.
    [500, 502, 503].forEach((status) => {
      expect(isRetryable({ response: { status } })).toBe(true);
      expect(isRetryable({ response: { status } }, { retryOn429: true })).toBe(true);
    });
    expect(isRetryable({})).toBe(true);
  });

  it.each([[400], [401], [403], [404], [409], [422]])(
    'still fails fast on %i without retrying',
    async (status) => {
      await withServer(
        (() => {
          let attempts = 0;
          return (req, res) => {
            attempts += 1;
            // A Retry-After on a non-429 must be ignored entirely.
            res.writeHead(status, { 'Content-Type': 'application/json', 'Retry-After': '1' });
            res.end(JSON.stringify({ attempts }));
          };
        })(),
        async (port) => {
          const started = Date.now();
          try {
            await requestWithRetry({ method: 'get', url: `http://127.0.0.1:${port}/` }, { retries: 2 });
            throw new Error('expected requestWithRetry to reject');
          } catch (err) {
            expect(err.response.status).toBe(status);
            expect(err.response.data.attempts).toBe(1);
            expect(Date.now() - started).toBeLessThan(1000);
          }
        }
      )();
    },
    15000
  );
});
