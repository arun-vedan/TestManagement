// WP-061 (ADR-006) -- shared Prometheus instrumentation (prom-client,
// exact-pinned in package.json per this repo's WP-016 convention).
//
// CARDINALITY -- the load-bearing design constraint. A label built from
// the raw request URL (e.g. "/api/v1/testrepo/670e88648adda70a0aaa804b")
// would mint one new time series PER DISTINCT ID EVER REQUESTED, and never
// stops growing -- exactly the unbounded-cardinality failure this module
// must not have. The `route` label below is always the Express ROUTE
// PATTERN as registered on the router (e.g. "/api/v1/testrepo/:id"), read
// from `req.baseUrl` + `req.route.path` AFTER Express has finished
// dispatching (in the response 'finish' handler, so `req.route` is
// already populated by then) -- never the concrete path. A request that
// never matched any route (404, typo, probe) is labeled "unmatched" as a
// single bounded bucket, not with the raw path that caused the miss.
// `method` and `status_code` are both drawn from small fixed enumerations.
// `service` is a single constant per process. None of these can grow
// without bound.
//
// USAGE (per service, in server.js):
//   const { createMetricsMiddleware } = require('@srckube/service-core');
//   const metrics = createMetricsMiddleware('aiService');
//   app.use(metrics.requestMetricsMiddleware);   // mount EARLY, before routers
//   ...
//   app.get('/metrics', metrics.metricsHandler); // deliberately NOT routed
//                                                 // through Kong -- see
//                                                 // EXECUTION_LOG.md's
//                                                 // WP-061 entry for why.

const client = require('prom-client');

function routeLabel(req) {
  if (req.route && typeof req.baseUrl === 'string') {
    const full = `${req.baseUrl}${req.route.path}`;
    return full.length > 1 ? full.replace(/\/$/, '') : full;
  }
  return 'unmatched';
}

function createMetricsMiddleware(serviceName) {
  // A dedicated Registry per service process (not the global default
  // registry) so requiring this module twice in tests, or from two
  // different services' code loaded in the same process, never collides
  // on metric names.
  const register = new client.Registry();
  register.setDefaultLabels({ service: serviceName });
  client.collectDefaultMetrics({ register });

  const httpRequestDuration = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds, labeled by route PATTERN (not raw path)',
    labelNames: ['method', 'route', 'status_code'],
    buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5, 10],
    registers: [register]
  });

  const httpRequestsTotal = new client.Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests, labeled by route PATTERN (not raw path)',
    labelNames: ['method', 'route', 'status_code'],
    registers: [register]
  });

  const httpRequestErrorsTotal = new client.Counter({
    name: 'http_request_errors_total',
    help: 'Total HTTP requests that resulted in a 4xx or 5xx response',
    labelNames: ['method', 'route', 'status_code'],
    registers: [register]
  });

  function requestMetricsMiddleware(req, res, next) {
    const startNs = process.hrtime.bigint();
    res.on('finish', () => {
      const durationSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
      const route = routeLabel(req);
      const labels = { method: req.method, route, status_code: String(res.statusCode) };
      httpRequestDuration.observe(labels, durationSeconds);
      httpRequestsTotal.inc(labels);
      if (res.statusCode >= 400) {
        httpRequestErrorsTotal.inc(labels);
      }
    });
    next();
  }

  async function metricsHandler(req, res) {
    try {
      res.set('Content-Type', register.contentType);
      res.end(await register.metrics());
    } catch (err) {
      res.status(500).end(err.message);
    }
  }

  return { requestMetricsMiddleware, metricsHandler, register };
}

module.exports = { createMetricsMiddleware };
