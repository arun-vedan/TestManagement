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
  createMetricsMiddleware
} = require('@srckube/service-core');
const connectDB = require('./config/db');
const { startReportRefreshCron } = require('./lib/cronJob');

// Load env vars
dotenv.config({ path: './config/config.env' });

const keycloak = initKeycloak();
const memoryStore = new session.MemoryStore();
// Connect to database (this service's OWN database only -- see config/db.js)
connectDB();

// Route files
const reports = require('./routes/reports');

const app = express();

// WP-061 -- shared Prometheus instrumentation (mounted below, before routers).
const metrics = createMetricsMiddleware('reportingService');

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
// machinery, rate limiting, or CORS.
app.get('/healthz', createHealthzHandler('reportingService', {
  required: { mongo: () => pingMongoConnection(mongoose.connection) }
}));
app.get('/metrics', metrics.metricsHandler);

// WP-062 (ADR-007) -- OpenAPI docs route. Same unauthenticated
// treatment as /healthz above (WP-061): mounted here, before
// session/keycloak/applyStandardSecurity, and reachable through Kong
// only via the separate <name>Docs/<name>OpenApi route objects in
// srckube-kong/kong.yml (no jwt plugin) -- every /api/v1/... route on
// this service is unchanged.
app.get('/openapi.yaml', createOpenApiHandler(path.join(__dirname, 'openapi.yaml')));
app.get('/docs', createDocsViewerHandler('reportingService', path.join(__dirname, 'openapi.yaml'), {
  otherServices: ['testreposervice', 'requirementservice', 'defectservice', 'testplanexecutionservice', 'releaseservice', 'aiservice', 'userservice']
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
// env passthrough — see docker-compose.yml's reportingservice block).
applyStandardSecurity(app);

// Set static folder
app.use(express.static(path.join(__dirname, 'public')));

// Mount routers
app.use('/api/v1/reports', reports);

app.use(errorHandler);

const PORT = process.env.PORT || 3000;

const server = app.listen(
  PORT,
  console.log(`Server running in ${process.env.NODE_ENV} mode on port ${PORT}`.yellow.bold)
);

// WP-040 — node-cron background refresh sweep (Default Project only; see
// lib/cronJob.js's header comment for the full scope reasoning). Started
// after the HTTP server is listening, same ordering every other
// server.js-with-a-background-job in this codebase uses. Skipped entirely
// under NODE_ENV=test so the Jest suite (which boots this file per-worker,
// see package.json's "test": "jest --runInBand") never races a live sweep
// against its own fixtures/assertions or leaves a dangling interval after
// the test process exits.
if (process.env.NODE_ENV !== 'test') {
  startReportRefreshCron();
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (err, promise) => {
  console.log(`Error: ${err.message}`.red);
  // Close server & exit process
  // server.close(() => process.exit(1));
});
