const express = require("express");
const bodyParser = require("body-parser");
const logger = require("morgan");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const connectDB = require("./database/config");
const cookieParser = require('cookie-parser');
const cors = require('cors');

const attachments = require('./routes/attachment')
const helmet = require('helmet');
const hpp = require('hpp');
const xss = require('xss-clean');
const session = require('express-session');
const {
  initKeycloak,
  resolveSessionSecret,
  correlationId,
  createHealthzHandler,
  pingMongoConnection,
  createMetricsMiddleware
} = require('@srckube/service-core');
const keycloak = initKeycloak()
const memoryStore = new session.MemoryStore();
dotenv.config({ path: './config/config.env' });

const app = express();

// Connect to database
connectDB();

// NOT using @srckube/service-core's applyStandardSecurity() here (WP-012):
// it bundles express-fileupload(), which is a full multipart-body-parsing
// middleware. This service parses multipart uploads itself via multer +
// multer-gridfs-storage (see utils/upload.js) on the specific upload routes.
// Mounting express-fileupload globally would consume the multipart request
// stream ahead of multer, breaking every /upload/* route. The hpp/cors/xss/
// helmet stack below is kept exactly as it was pre-migration, including
// this service's newer helmet/hpp majors (package.json), which are
// independent of service-core's pinned (older) versions since service-core
// resolves its own dependencies from its own node_modules.
// Connect to MongoDB GridFS bucket using mongoose
app.use(hpp());
app.use(cors());
app.use(xss());
app.use(cookieParser());
app.options('*', cors());
app.use(helmet());

// WP-061 -- correlation ID, request metrics, and /healthz + /metrics. This
// service never picked up correlationId (no server.js template to inherit
// it from -- see EXECUTION_LOG.md's WP-061 audit), closed here. Mounted
// before bodyParser/routes so healthz/metrics never depend on request-body
// parsing, and before session/keycloak so they stay unauthenticated.
const metrics = createMetricsMiddleware('uploadService');
app.use(correlationId);
app.use(metrics.requestMetricsMiddleware);
app.get('/healthz', createHealthzHandler('uploadService', {
  required: { mongo: () => pingMongoConnection(mongoose.connection) }
}));
app.get('/metrics', metrics.metricsHandler);

// Middleware for parsing request body and logging requests
app.use(bodyParser.json());
app.use(logger("dev"));
app.use(
  session({
    secret: resolveSessionSecret(),
    resave: false,
    saveUninitialized: true,
    store: memoryStore,
  })
);

app.use(keycloak.middleware());

// Routes for API endpoints

// Upload a single file
app.use('/api/v1/attachment',attachments)

// Server listening on port 3000 for incoming requests
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
