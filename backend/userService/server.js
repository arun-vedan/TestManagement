const path = require('path');
const express = require('express');
const dotenv = require('dotenv');
const morgan = require('morgan');
const colors = require('colors');
const cookieParser = require('cookie-parser');
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
const session = require('express-session');
const keycloak = initKeycloak()
const memoryStore = new session.MemoryStore();
// Load env vars
dotenv.config({ path: './config/config.env' });

// Connect to database
connectDB();

// Route files


const users = require('./routes/users');
const organizations = require('./routes/organizations');
const projects = require('./routes/projects');
const apikeys = require('./routes/apikeys');
const invites = require('./routes/invites');




const app = express();

// WP-061 -- shared Prometheus instrumentation (mounted below, before routers).
const metrics = createMetricsMiddleware('userService');

// Body parser
app.use(express.json());

// Cookie parser
app.use(cookieParser());

// Correlation ID -- must run before routes so every handler/log line for
// this request can include it (Sprint 1.1 pattern; userService was the one
// service that never picked this up -- closed here, WP-061 verification pass).
app.use(correlationId);

// WP-061 -- request metrics for every route (mounted before routers so it
// observes every request, matched or not).
app.use(metrics.requestMetricsMiddleware);

// WP-061 -- /healthz (unauthenticated, genuinely pings Mongo -- see
// service-core/health.js) and /metrics (prom-client, NOT routed through
// Kong -- see EXECUTION_LOG.md's WP-061 entry). Mounted here, before
// session/keycloak/applyStandardSecurity, so neither depends on auth
// machinery, rate limiting, or CORS. Redis is optional -- this service's
// existing existence-cache (controllers/users.js's `redis.get`/`redis.set`
// calls) was never audited for fail-open behavior the way events.js/
// aiService's rate limiter explicitly were, so treating a Redis outage as
// "degraded" rather than "down" here is a conscious, stated choice (not a
// verified fail-open contract like the others), made because userService's
// core identity/auth path does not depend on that cache to function.
app.get('/healthz', createHealthzHandler('userService', {
  required: { mongo: () => pingMongoConnection(mongoose.connection) },
  optional: { redis: () => pingRedisUri(process.env.Redis_URI ? `redis://${process.env.Redis_URI}:6379` : null) }
}));
app.get('/metrics', metrics.metricsHandler);

// WP-062 (ADR-007) -- OpenAPI docs route. Same unauthenticated
// treatment as /healthz above (WP-061): mounted here, before
// session/keycloak/applyStandardSecurity, and reachable through Kong
// only via the separate <name>Docs/<name>OpenApi route objects in
// srckube-kong/kong.yml (no jwt plugin) -- every /api/v1/... route on
// this service is unchanged.
app.get('/openapi.yaml', createOpenApiHandler(path.join(__dirname, 'openapi.yaml')));
app.get('/docs', createDocsViewerHandler('userService', path.join(__dirname, 'openapi.yaml'), {
  otherServices: ['testreposervice', 'requirementservice', 'defectservice', 'testplanexecutionservice', 'reportingservice', 'releaseservice', 'aiservice']
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
// rate limiting, hpp, cors) — extracted to shared/service-core in Sprint 1.1.
// rateLimitMax matches this service's original, deliberately higher limit
// (1000 vs. the shared default of 100).
applyStandardSecurity(app, { rateLimitMax: 1000 });

// Set static folder
app.use(express.static(path.join(__dirname, 'public')));

// Mount routers


// WP-022 (TD-03): the legacy JWT auth system (register/login/logout/getMe/
// forgotpassword/resetpassword/updatedetails/updatepassword) previously
// mounted here at /api/v1/auth is retired. Consumer audit (frontend/,
// srckube-kong/kong.yml, every other backend service) found no live
// consumer -- see EXECUTION_LOG.md's WP-022 entry for the full evidence.
// Identity in this stack is Keycloak-only from here on; `middleware/
// auth.js`, `controllers/auth.js`, `routes/auth.js`, and `utils/
// sendEmail.js` are removed, not just unmounted.
app.use('/api/v1/users', users);
// WP-020: Organization & Project entities, homed here per the ADR note in
// EXECUTION_LOG.md (evolving userService toward "Identity & Access").
app.use('/api/v1/organizations', organizations);
app.use('/api/v1/projects', projects);
// WP-032: per-project API keys (machine-to-machine auth). See
// routes/apikeys.js and EXECUTION_LOG.md's WP-032 entry.
app.use('/api/v1/apikeys', apikeys);
// WP-132 — invitation acceptance. Not under /projects because the caller is
// not yet a member of any project (see routes/invites.js).
app.use('/api/v1/invites', invites);




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
  // Close server & exit process
  // server.close(() => process.exit(1));
});
