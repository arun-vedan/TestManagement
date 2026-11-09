const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const morgan = require('morgan');
const colors = require('colors');
const cookieParser = require('cookie-parser');
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
const session = require('express-session');

// Load env vars before anything that reads them (models/db connections included)
dotenv.config({ path: './config/config.env' });

const keycloak = initKeycloak()
const memoryStore = new session.MemoryStore();

// Establishes both DB connections (config/db.js) — required here, before the
// route files, so both are connecting as early as possible at boot.
// WP-061: kept as separate named connections (not the default global
// mongoose.connection) -- healthz below pings BOTH explicitly, since this
// service's config/db.js's whole design is that neither database is
// optional.
const { planConnection, executionConnection } = require('./config/db');

// Route files
const testplan = require('./routes/testplan')
const testexecution = require('./routes/testexecution')

const app = express();

// WP-061 -- shared Prometheus instrumentation (mounted below, before routers).
const metrics = createMetricsMiddleware('testPlanExecutionService');

// Body parser
app.use(express.json());

// Cookie parser
app.use(cookieParser());

// Correlation ID — must run before routes so every handler/log line for this
// request can include it (Sprint 1.1 pilot, promoted to shared lib Sprint 1.2).
app.use(correlationId);

// WP-061 -- request metrics for every route (mounted before routers so it
// observes every request, matched or not).
app.use(metrics.requestMetricsMiddleware);

// WP-061 -- /healthz (unauthenticated). BOTH database connections are
// required -- this service's own config/db.js already documents that
// neither srckube-testplan nor srckube-testexecution is optional, so a
// failure on either one flips this to 503/"down", not just a partial
// "degraded". Redis is optional (event-bus producer only, fail-open by
// ADR-004 design -- see service-core/events.js).
app.get('/healthz', createHealthzHandler('testPlanExecutionService', {
  required: {
    mongoTestPlan: () => pingMongoConnection(planConnection),
    mongoTestExecution: () => pingMongoConnection(executionConnection)
  },
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
app.get('/docs', createDocsViewerHandler('testPlanExecutionService', path.join(__dirname, 'openapi.yaml'), {
  otherServices: ['testreposervice', 'requirementservice', 'defectservice', 'reportingservice', 'releaseservice', 'aiservice', 'userservice']
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
    store: memoryStore,
  })
);

app.use(keycloak.middleware());

// Standard security middleware stack (fileupload, mongoSanitize, helmet, xss,
// rate limiting, hpp, cors).
applyStandardSecurity(app);

// Set static folder
app.use(express.static(path.join(__dirname, 'public')));

// Mount routers — both preserve their original external paths, so Kong's
// routing (and the frontend's api calls) need no changes.
app.use('/api/v1/testplan', testplan)
app.use('/api/v1/testexecution', testexecution)

app.use(errorHandler);

const PORT = process.env.PORT || 3000;

const server = app.listen(
  PORT,
  console.log(
    `Server running in ${process.env.NODE_ENV} mode on port ${PORT}`.yellow.bold
  )
);

// Handle unhandled promise rejections
process.on('unhandledRejection', (err, promise) => {
  console.log(`Error: ${err.message}`.red);
});
