const fileupload = require('express-fileupload');
const mongoSanitize = require('express-mongo-sanitize');
const helmet = require('helmet');
const xss = require('xss-clean');
const rateLimit = require('express-rate-limit');
const hpp = require('hpp');
const cors = require('cors');

const PRODUCTION_DEFAULT_RATE_LIMIT_MAX = 100;

// WP-002c: resolve the effective rate-limit ceiling.
//
// Precedence (highest to lowest):
//   1. An explicit `rateLimitMax` passed by the call site (e.g.
//      linkIssueService/defectService/requirementService's 10000, or
//      userService's 1000) — this is a deliberate, per-service decision
//      baked into that service's server.js, so it always wins and is never
//      silently overridden by the environment. This is what keeps those
//      existing overrides behaving exactly as they did before this change,
//      env var set or not.
//   2. The RATE_LIMIT_MAX env var, when the call site left rateLimitMax
//      unset. This exists so the local/test environment (backend/.env +
//      docker-compose.yml pass-through, GR-9) can raise the ceiling for the
//      ~9 services that never explicitly overrode it, without touching
//      production code or config.
//   3. The hardcoded production default (100), when neither of the above is
//      set, or when RATE_LIMIT_MAX is present but not a valid positive
//      integer (e.g. empty string from an unset docker-compose
//      substitution) — never silently disable the limiter.
//
// The production default MUST stay 100: this function must keep returning
// 100 when called with no arguments and no RATE_LIMIT_MAX in the
// environment, exactly as it did before this change.
function resolveRateLimitMax(explicitRateLimitMax) {
  if (explicitRateLimitMax !== undefined) {
    return explicitRateLimitMax;
  }
  const fromEnv = process.env.RATE_LIMIT_MAX;
  if (fromEnv !== undefined && fromEnv !== '') {
    const parsed = parseInt(fromEnv, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return PRODUCTION_DEFAULT_RATE_LIMIT_MAX;
}

// The standard security-middleware stack, confirmed byte-for-byte identical
// across every service's server.js before this extraction (Sprint 1.1) — with
// one confirmed exception found in Sprint 2.1: requirementService's rate limit
// was deliberately set to 10000 instead of the otherwise-universal 100, so the
// limit is a configurable option here rather than hardcoded, to avoid quietly
// making a service more restrictive than it was when migrated onto this.
function applyStandardSecurity(app, { rateLimitMax } = {}) {
  app.use(fileupload());
  app.use(mongoSanitize());
  app.use(helmet());
  app.use(xss());
  app.use(rateLimit({ windowMs: 10 * 60 * 1000, max: resolveRateLimitMax(rateLimitMax) }));
  app.use(hpp());
  app.use(cors());
  app.options('*', cors());
}

module.exports = { applyStandardSecurity, resolveRateLimitMax };
