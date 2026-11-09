const { createMetricsMiddleware } = require('../metrics');

// WP-061 -- plain Jest coverage of the shared Prometheus instrumentation.
// Exercises the middleware against hand-built req/res fakes (no real
// Express server needed) so this stays a fast unit suite; the actual
// per-service wiring (mounted early, real routes) is proven live in each
// service's black-box suite / the manual sweep recorded in
// EXECUTION_LOG.md's WP-061 entry.

function fakeReqRes({ method = 'GET', baseUrl, routePath, statusCode = 200 } = {}) {
  const finishListeners = [];
  const req = {
    method,
    baseUrl,
    route: routePath !== undefined ? { path: routePath } : undefined
  };
  const res = {
    statusCode,
    on(event, cb) {
      if (event === 'finish') {
        finishListeners.push(cb);
      }
    },
    finish() {
      finishListeners.forEach((cb) => cb());
    }
  };
  return { req, res };
}

describe('createMetricsMiddleware()', () => {
  test('records a matched route using the PATTERN, not any concrete id', async () => {
    const metrics = createMetricsMiddleware('testsvc-a');
    const { req, res } = fakeReqRes({ method: 'GET', baseUrl: '/api/v1/testrepo', routePath: '/:id', statusCode: 200 });

    let nextCalled = false;
    metrics.requestMetricsMiddleware(req, res, () => { nextCalled = true; });
    expect(nextCalled).toBe(true);

    res.finish();

    const body = await metrics.register.metrics();
    expect(body).toContain('route="/api/v1/testrepo/:id"');
    // The whole point of the cardinality rule: no raw id anywhere in the output.
    expect(body).not.toMatch(/testrepo\/[a-f0-9]{24}/);
    expect(body).toContain('http_requests_total');
    expect(body).toContain('http_request_duration_seconds');
  });

  test('unmatched route (404/typo/probe) is labeled "unmatched", never the raw path', async () => {
    const metrics = createMetricsMiddleware('testsvc-b');
    const { req, res } = fakeReqRes({ method: 'GET', baseUrl: undefined, routePath: undefined, statusCode: 404 });
    // Simulate Express: baseUrl/route are only populated on a MATCH.
    req.baseUrl = undefined;
    req.route = undefined;
    req.originalUrl = '/api/v1/totally-made-up-path-12345';

    metrics.requestMetricsMiddleware(req, res, () => {});
    res.finish();

    const body = await metrics.register.metrics();
    expect(body).toContain('route="unmatched"');
    expect(body).not.toContain('totally-made-up-path-12345');
  });

  test('4xx/5xx responses increment the errors counter; 2xx does not', async () => {
    const metrics = createMetricsMiddleware('testsvc-c');

    const ok = fakeReqRes({ baseUrl: '/api/v1/x', routePath: '/', statusCode: 200 });
    metrics.requestMetricsMiddleware(ok.req, ok.res, () => {});
    ok.res.finish();

    const bad = fakeReqRes({ baseUrl: '/api/v1/x', routePath: '/', statusCode: 500 });
    metrics.requestMetricsMiddleware(bad.req, bad.res, () => {});
    bad.res.finish();

    const body = await metrics.register.metrics();
    const errorLine = body.split('\n').find((l) => l.startsWith('http_request_errors_total{') && l.includes('status_code="500"'));
    expect(errorLine).toBeDefined();
    expect(body).not.toMatch(/http_request_errors_total\{[^}]*status_code="200"/);
  });

  test('two independent middlewares (two services) do not share/collide on metric state', async () => {
    const a = createMetricsMiddleware('svc-iso-a');
    const b = createMetricsMiddleware('svc-iso-b');

    const reqA = fakeReqRes({ baseUrl: '/api/v1/a', routePath: '/', statusCode: 200 });
    a.requestMetricsMiddleware(reqA.req, reqA.res, () => {});
    reqA.res.finish();

    const bodyB = await b.register.metrics();
    // b's registry must not have recorded a's request.
    expect(bodyB).not.toMatch(/http_requests_total\{[^}]*route="\/api\/v1\/a\/"/);
  });

  test('metricsHandler sets Prometheus content type and returns the registry body', async () => {
    const metrics = createMetricsMiddleware('testsvc-d');
    let sentType;
    let ended = '';
    const res = {
      set(key, value) { sentType = value; },
      end(body) { ended = body; }
    };
    await metrics.metricsHandler({}, res);
    expect(sentType).toMatch(/text\/plain/);
    expect(ended).toContain('# HELP');
  });
});
