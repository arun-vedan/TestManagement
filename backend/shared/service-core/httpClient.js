const axios = require('axios');

// Promoted into the shared library in Sprint 1.2 from its Sprint 1.1 pilot
// (testExecutionService/utils/httpClient.js, TD-16). Timeout + bounded
// exponential-backoff retry on network/5xx errors.
//
// WP-105 — 4xx fails fast, with one OPT-IN exception: 429 via
// `retryOn429: true`. 400/401/403/404 all mean "your request is wrong", and
// replaying it cannot change that. 429 means something categorically
// different -- "your request is fine, you are just early" -- and it is the one
// 4xx a retry can actually resolve.
//
// WHY OPT-IN RATHER THAN THE DEFAULT. This WP's brief put it exactly right:
// failing fast on 429 is "correct for internal service-to-service calls,
// backwards for a third-party API". Every one of this client's ~16 current
// call sites is internal, where a 429 comes from the caller's own sibling
// service's limiter; retrying there just spends the same exhausted budget
// again. Defaulting to on would also collide with
// aiService/providers/openaiProvider.js, the one genuine third-party caller,
// which already implements this (bounded, jittered, Retry-After-aware) in its
// own adapter and documents the deliberate choice to keep it there. With 429
// retried underneath it too, each of its attempts would cost two vendor calls
// instead of one -- doubling traffic against a quota that is, by definition,
// already exhausted.
//
// So the default preserves today's behaviour exactly, and a caller that talks
// to a metered third party asks for it explicitly. That is what makes this a
// Phase 3 prerequisite: the capability is ready for the outbound integrations
// (Jira/Slack/CI/webhooks) that will need it, without changing any existing
// internal call.

// How long a Retry-After we are willing to honour. Beyond this we do not
// retry at all.
//
// This bound exists because of a concrete case in this repo, not as a
// precaution. Its own internal limiter (express-rate-limit v5, wired up in
// security.js with windowMs = 10 minutes) responds to a throttled request
// with `Retry-After: Math.ceil(windowMs / 1000)` -- literally `600`. A
// service-to-service call that trips it is therefore told to come back in ten
// minutes. Sleeping on that would hold an inbound HTTP request open for ten
// minutes per retry, which is far worse than the fail-fast behaviour this WP
// replaced: it converts a fast, legible 429 into a hung request and, with
// retries, a queue of them.
//
// So the rule is: honour a Retry-After the caller can plausibly wait out, and
// treat anything longer as "not worth retrying" -- which reproduces exactly
// the pre-WP-105 behaviour for that case, while still gaining the retry for
// the short, actionable delays a third-party API actually sends.
const DEFAULT_MAX_RETRY_AFTER_MS = 10000;

// RFC 9110 §10.2.3 allows two forms: delay-seconds ("120") or an HTTP-date
// ("Wed, 21 Oct 2026 07:28:00 GMT"). Returns milliseconds to wait, or null
// when the header is absent or unparseable -- null means "no instruction from
// the server", and the caller falls back to ordinary exponential backoff
// rather than guessing.
function parseRetryAfter(headerValue, now = Date.now()) {
  if (headerValue === undefined || headerValue === null) {
    return null;
  }
  const raw = String(headerValue).trim();
  if (raw === '') {
    return null;
  }

  // delay-seconds: digits only. Anything else (a negative, a decimal, a word)
  // is not this form and must not be coerced -- Number('-5') would otherwise
  // sail through as a negative delay.
  if (/^\d+$/.test(raw)) {
    return parseInt(raw, 10) * 1000;
  }

  // HTTP-date, but only if it actually looks like one. Date.parse() is far
  // more permissive than RFC 9110 and will happily read junk as a date:
  // Date.parse('-5') is 2001-05-01 and Date.parse('1.5') is 2001-01-05, both
  // in the past, which would otherwise come back as "retry immediately" -- so
  // a malformed header would make us hammer a server that just asked us to
  // slow down. All three legal formats (IMF-fixdate, RFC 850, asctime) begin
  // with a day name, so require that before trusting Date.parse at all.
  if (/^[A-Za-z]{3}/.test(raw)) {
    const when = Date.parse(raw);
    if (!Number.isNaN(when)) {
      // A date already in the past means "you may retry now", not a negative
      // sleep.
      return Math.max(0, when - now);
    }
  }

  return null;
}

function isRetryable(error, { retryOn429 = false } = {}) {
  if (!error.response) {
    // network error, timeout, connection refused, etc.
    return true;
  }
  if (error.response.status === 429) {
    return retryOn429;
  }
  return error.response.status >= 500;
}

async function requestWithRetry(
  config,
  {
    retries = 2,
    timeout = 5000,
    retryOn429 = false,
    maxRetryAfterMs = DEFAULT_MAX_RETRY_AFTER_MS
  } = {}
) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await axios({ timeout, ...config });
    } catch (error) {
      attempt += 1;
      if (attempt > retries || !isRetryable(error, { retryOn429 })) {
        throw error;
      }

      let backoffMs = 100 * 2 ** (attempt - 1);

      if (error.response && error.response.status === 429) {
        const headers = error.response.headers || {};
        // axios lower-cases response header names.
        const retryAfterMs = parseRetryAfter(headers['retry-after']);
        if (retryAfterMs !== null) {
          if (retryAfterMs > maxRetryAfterMs) {
            // The server has told us it will not be ready for longer than we
            // are prepared to wait. Retrying sooner would just be ignoring it.
            throw error;
          }
          backoffMs = retryAfterMs;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }
}

module.exports = { requestWithRetry, parseRetryAfter, isRetryable };
