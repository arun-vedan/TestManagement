const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const morgan = require('morgan');
const colors = require('colors');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const mongoose = require('mongoose');
const {
  errorHandler,
  initKeycloak,
  resolveSessionSecret,
  applyStandardSecurity,
  correlationId,
  createHealthzHandler,
  createOpenApiHandler,
  createDocsViewerHandler,
  pingMongoConnection,
  pingRedisUri,
  createMetricsMiddleware
} = require('@srckube/service-core');
const connectDB = require('./config/db');

// Load env vars
dotenv.config({ path: './config/config.env' });

const keycloak = initKeycloak();
const memoryStore = new session.MemoryStore();
// Connect to database (this service's OWN database only -- see config/db.js)
connectDB();

// Route files
const ai = require('./routes/ai');

const app = express();

// WP-061 -- shared Prometheus instrumentation (mounted below, before routers).
const metrics = createMetricsMiddleware('aiService');

// Body parser
app.use(express.json());

// Cookie parser
app.use(cookieParser());

// Correlation ID — must run before routes so every handler/log line for this
// request can include it (Sprint 1.1 pattern).
app.use(correlationId);

// WP-061 -- request metrics for every route (mounted before routers so it
// observes every request, matched or not).
app.use(metrics.requestMetricsMiddleware);

// WP-061 -- /healthz (unauthenticated, genuinely pings Mongo -- see
// service-core/health.js) and /metrics (prom-client, NOT routed through
// Kong -- see EXECUTION_LOG.md's WP-061 entry). Mounted here, before
// session/keycloak/applyStandardSecurity, so neither depends on auth
// machinery, rate limiting, or CORS. Redis is optional here too --
// aiService's own rate limiter (lib/rateLimiter.js) is explicitly
// fail-open on Redis, same reasoning as service-core/health.js's header
// comment.
app.get('/healthz', createHealthzHandler('aiService', {
  required: { mongo: () => pingMongoConnection(mongoose.connection) },
  optional: { redis: () => pingRedisUri(process.env.REDIS_URI) }
}));
app.get('/metrics', metrics.metricsHandler);

// WP-062 (ADR-007) -- OpenAPI docs route. Same unauthenticated
// treatment as /healthz above (WP-061): mounted here, before
// session/keycloak/applyStandardSecurity, and reachable through Kong
// only via the separate <name>Docs/<name>OpenApi route objects in
// srckube-kong/kong.yml (no jwt plugin) -- every /api/v1/... route on
// this service is unchanged.
app.get('/openapi.yaml', createOpenApiHandler(path.join(__dirname, 'openapi.yaml')));
app.get('/docs', createDocsViewerHandler('aiService', path.join(__dirname, 'openapi.yaml'), {
  otherServices: ['testreposervice', 'requirementservice', 'defectservice', 'testplanexecutionservice', 'reportingservice', 'releaseservice', 'userservice']
}));

// Dev logging middleware
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev'));
}

app.use(
  session({
    secret: resolveSessionSecret(),
    resave: false,
    saveUninitialized: true,
    store: memoryStore
  })
);

app.use(keycloak.middleware());

// Standard security middleware stack (default rate limit, RATE_LIMIT_MAX
// env passthrough — see docker-compose.yml's aiservice block). This is the
// per-SERVICE HTTP rate limiter -- distinct from lib/rateLimiter.js's
// per-USER-per-day AI usage limiter, which is a separate cost-control
// concern (see that file's header comment).
applyStandardSecurity(app);

// Set static folder
app.use(express.static(path.join(__dirname, 'public')));

// Mount routers
app.use('/api/v1/ai', ai);

app.use(errorHandler);

const PORT = process.env.PORT || 3000;

app.listen(
  PORT,
  console.log(`Server running in ${process.env.NODE_ENV} mode on port ${PORT}`.yellow.bold)
);

// Handle unhandled promise rejections
process.on('unhandledRejection', (err, promise) => {
  console.log(`Error: ${err.message}`.red);
  // Close server & exit process
  // server.close(() => process.exit(1));
});
