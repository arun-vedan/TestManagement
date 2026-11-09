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
  pingMongoConnection,
  createMetricsMiddleware
} = require('@srckube/service-core');
const session = require('express-session');
const connectDB = require('./config/db');
const keycloak = initKeycloak()
// Load env vars
dotenv.config({ path: './config/config.env' });
const memoryStore = new session.MemoryStore();
// Connect to database
connectDB();

// Route files


const fields = require('./routes/field')
// WP-043 -- SavedView CRUD, homed here (see models/savedView.js's header
// comment for the full home decision). A second router mounted alongside
// the existing `fields` one, on its own Kong route (srckube-kong/kong.yml's
// `savedviewroute`) pointed at this same fieldsservice upstream.
const savedviews = require('./routes/savedView')

const app = express();

// WP-061 -- shared Prometheus instrumentation (mounted below, before routers).
const metrics = createMetricsMiddleware('fieldsService');

// Body parser
app.use(express.json());

// Cookie parser
app.use(cookieParser());

// Correlation ID -- must run before routes so every handler/log line for
// this request can include it (Sprint 1.1 pattern, WP-061 verification pass).
app.use(correlationId);

// WP-061 -- request metrics for every route (mounted before routers so it
// observes every request, matched or not).
app.use(metrics.requestMetricsMiddleware);

// WP-061 -- /healthz (unauthenticated, genuinely pings Mongo -- see
// service-core/health.js) and /metrics (prom-client, NOT routed through
// Kong -- see EXECUTION_LOG.md's WP-061 entry). Mounted here, before
// session/keycloak/applyStandardSecurity, so neither depends on auth
// machinery, rate limiting, or CORS.
app.get('/healthz', createHealthzHandler('fieldsService', {
  required: { mongo: () => pingMongoConnection(mongoose.connection) }
}));
app.get('/metrics', metrics.metricsHandler);

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
applyStandardSecurity(app);

// Set static folder
app.use(express.static(path.join(__dirname, 'public')));

// Mount routers
app.use('/api/v1/fields',fields)
app.use('/api/v1/savedviews',savedviews)



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
