// Promoted into the shared library in Sprint 1.2 from its Sprint 1.1 pilot
// (testExecutionService + testRepoService, TB-07). Minimal by design: plain
// single-line JSON to stdout, no new dependency, consistent with every other
// service's current console-based logging so this can be picked up by any
// future log-shipping setup without a rewrite.

function createLogger(serviceName) {
  function log(level, message, meta = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      service: serviceName,
      message,
      ...meta
    };
    console.log(JSON.stringify(entry));
  }

  return {
    info: (message, meta) => log('info', message, meta),
    warn: (message, meta) => log('warn', message, meta),
    error: (message, meta) => log('error', message, meta)
  };
}

module.exports = { createLogger };
