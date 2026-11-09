const crypto = require('crypto');

// Promoted into the shared library in Sprint 1.2 from its Sprint 1.1 pilot
// (testExecutionService + testRepoService, TB-07).

const HEADER_NAME = 'x-correlation-id';

// Reads a correlation ID from an incoming request (propagated from an upstream
// caller/gateway) or generates a new one. Attaches it to req.correlationId and
// echoes it back on the response so a client-side/gateway log can be joined to
// this service's logs for the same request.
function correlationId(req, res, next) {
  const incoming = req.headers[HEADER_NAME];
  req.correlationId = incoming || crypto.randomUUID();
  res.setHeader(HEADER_NAME, req.correlationId);
  next();
}

module.exports = { correlationId, HEADER_NAME };
