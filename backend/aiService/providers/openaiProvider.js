// WP-050 -- the `openai` provider. Proves the adapter seam is real: a
// second, independent implementation of the same complete()/
// completeStructured() contract as mockProvider.js, talking to an
// OpenAI-compatible chat/completions HTTP API.
//
// Deliberately built on axios (via service-core's requestWithRetry, the
// same wrapper every other cross-service HTTP call in this codebase uses)
// rather than the `openai` npm package -- per the WP-050 ground rules,
// nothing above the adapter boundary may import a vendor SDK, and this file
// IS the adapter boundary: it is the only place in the codebase that knows
// OpenAI's chat/completions request/response JSON shape at all.
//
// AI_BASE_URL defaults to OpenAI's own endpoint, but because this speaks
// the OpenAI-compatible chat/completions contract, pointing AI_BASE_URL at
// an Azure OpenAI deployment's compatible endpoint or a local Ollama
// (`ollama serve` exposes an OpenAI-compatible `/v1/chat/completions`) is
// expected to work with AI_PROVIDER=openai and no code change -- but that
// has NOT been exercised against any live vendor in this session (no key,
// no outbound expectation, per the Phase E decision). Only unit-tested here
// against a stubbed local HTTP server (see __tests__/openaiProvider.test.js).
const crypto = require('crypto');
const { requestWithRetry } = require('@srckube/service-core');
const { ProviderError } = require('./errors');

function resolveBaseUrl() {
  return (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
}

function resolveApiKey() {
  // Generic AI_API_KEY, never a vendor-named variable (WP-050 ground rule
  // #3) -- this same env var is read the same way regardless of which
  // OpenAI-compatible backend AI_BASE_URL points at.
  return process.env.AI_API_KEY || '';
}

function resolveModel() {
  return process.env.AI_MODEL || 'gpt-4o-mini';
}

// Some OpenAI-compatible gateways meter by client identity. OpenCode Go,
// for one, requires its own (non-SDK) User-Agent and a stable session id in
// a named header. Both are generic knobs here, not vendor branches: the
// User-Agent is always sent (harmless anywhere), the session header only
// when AI_SESSION_HEADER names one.
function resolveUserAgent() {
  return process.env.AI_USER_AGENT || 'srckube-aiService/1.0';
}

function resolveSessionHeader() {
  return (process.env.AI_SESSION_HEADER || '').trim();
}

// Default 15s suits a fast chat model; a reasoning model can legitimately
// think for longer than that on a structured-generation prompt.
const TIMEOUT_MS_DEFAULT = 15000;

function resolveTimeoutMs() {
  const raw = Number(process.env.AI_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : TIMEOUT_MS_DEFAULT;
}

// Rate-limit (429) retry knobs. Deliberately adapter-local rather than a
// change to service-core's requestWithRetry: that shared client backs every
// cross-service call in this codebase, where a 429 comes from a service's
// OWN rate limiter and should keep failing fast. Here, a 429 comes from a
// metered vendor quota -- see the retry loop in callChatCompletions().
const RATE_LIMIT_RETRIES_DEFAULT = 2;
const RATE_LIMIT_BACKOFF_MS_DEFAULT = 500;
// Ceiling on any single wait, including one the vendor asks for. A
// Retry-After of "86400" must not turn one user's click into a day-long
// hang -- we give up and surface rate_limited instead.
const RETRY_AFTER_MAX_MS = 30000;

function resolveRateLimitRetries() {
  const raw = Number(process.env.AI_RATE_LIMIT_RETRIES);
  return Number.isFinite(raw) && raw >= 0 ? raw : RATE_LIMIT_RETRIES_DEFAULT;
}

function resolveRateLimitBackoffMs() {
  const raw = Number(process.env.AI_RATE_LIMIT_BACKOFF_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : RATE_LIMIT_BACKOFF_MS_DEFAULT;
}

// RFC 9110 Retry-After: either delta-seconds or an HTTP-date. Returns null
// for anything we cannot trust (absent, junk, or already in the past), so
// the caller falls back to its own backoff rather than treating a bad
// header as "retry immediately".
function parseRetryAfterMs(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const raw = String(value).trim();
  let ms = null;
  if (/^-?\d+$/.test(raw)) {
    ms = Number(raw) * 1000;
  } else {
    const when = Date.parse(raw);
    if (!Number.isNaN(when)) {
      ms = when - Date.now();
    }
  }
  if (ms === null || !Number.isFinite(ms) || ms <= 0) {
    return null;
  }
  return Math.min(ms, RETRY_AFTER_MAX_MS);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toChatMessages(system, messages) {
  const out = [];
  if (system) {
    out.push({ role: 'system', content: system });
  }
  (messages || []).forEach((m) => out.push({ role: m.role, content: m.content }));
  return out;
}

// Vendor error shapes normalised to ProviderError HERE, at the adapter
// boundary (WP-050 ground rule #4) -- nothing above this file ever sees an
// axios error or an OpenAI-shaped `{error: {message, type, code}}` body.
function normaliseAxiosError(err) {
  if (!err.response) {
    return new ProviderError(`AI provider unreachable: ${err.message}`, 'unavailable', err);
  }
  const status = err.response.status;
  const body = err.response.data;
  const vendorMessage = (body && body.error && body.error.message) || err.message;
  if (status === 401 || status === 403) {
    return new ProviderError(`AI provider rejected credentials: ${vendorMessage}`, 'auth', err);
  }
  if (status === 429) {
    return new ProviderError(`AI provider rate limit hit: ${vendorMessage}`, 'rate_limited', err);
  }
  if (status >= 500) {
    return new ProviderError(`AI provider error: ${vendorMessage}`, 'unavailable', err);
  }
  return new ProviderError(`AI provider rejected request: ${vendorMessage}`, 'invalid_request', err);
}

// requestWithRetry already covers network errors and 5xx. It deliberately
// does NOT retry 4xx ("retrying can't fix a client error" -- see
// service-core/httpClient.js), which is right for 400/401/404 and wrong for
// exactly one status: 429 is time-based, not request-based, so the identical
// request succeeds once the vendor's window rolls over. auditDuplicates
// (controllers/ai.js) fires one call per test case in a tight loop and will
// burst past a metered per-minute quota on any real vendor, so that retry
// lives here, bounded, and prefers the vendor's own Retry-After over our
// guess.
async function callChatCompletions(body) {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw new ProviderError('AI_API_KEY is not configured for the openai provider', 'auth');
  }
  const maxRetries = resolveRateLimitRetries();
  const baseBackoffMs = resolveRateLimitBackoffMs();
  const timeout = resolveTimeoutMs();
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    'User-Agent': resolveUserAgent()
  };
  const sessionHeader = resolveSessionHeader();
  if (sessionHeader) {
    // One id per logical call, reused across its 429 retries -- every
    // aiService call is a single-shot conversation.
    headers[sessionHeader] = crypto.randomUUID();
  }
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const resp = await requestWithRetry(
        {
          method: 'post',
          url: `${resolveBaseUrl()}/chat/completions`,
          headers,
          data: body
        },
        { retries: 1, timeout }
      );
      return resp.data;
    } catch (err) {
      if (err instanceof ProviderError) {
        throw err;
      }
      const status = err.response && err.response.status;
      if (status !== 429 || attempt >= maxRetries) {
        throw normaliseAxiosError(err);
      }
      const respHeaders = (err.response && err.response.headers) || {};
      const askedForMs = parseRetryAfterMs(respHeaders['retry-after']);
      // Jittered exponential backoff when the vendor does not say -- without
      // jitter, several comparisons rate-limited in the same instant would
      // all wake and retry in the same instant too.
      const waitMs =
        askedForMs === null
          ? Math.round(baseBackoffMs * 2 ** attempt * (1 + Math.random() * 0.25))
          : askedForMs;
      attempt += 1;
      // eslint-disable-next-line no-await-in-loop
      await sleep(waitMs);
    }
  }
}

// Token accounting normalised HERE too (WP-050 ground rule #4) -- OpenAI's
// snake_case usage object becomes the same {promptTokens, completionTokens,
// totalTokens} shape mockProvider.js already returns.
function extractUsage(payload) {
  const usage = payload && payload.usage;
  return {
    promptTokens: (usage && usage.prompt_tokens) || 0,
    completionTokens: (usage && usage.completion_tokens) || 0,
    totalTokens: (usage && usage.total_tokens) || 0
  };
}

// A reasoning model that exhausts max_tokens while still thinking returns
// finish_reason 'length' with content null. Say so, rather than calling it
// a malformed response -- the fix is a larger maxTokens, not a new vendor.
function contentMissingError(choice) {
  if (choice && choice.finish_reason === 'length') {
    return new ProviderError(
      'AI provider hit the token limit before producing an answer (a reasoning model may need a larger maxTokens)',
      'invalid_response'
    );
  }
  return new ProviderError('AI provider returned an unexpected response shape', 'invalid_response');
}

async function complete({ system, messages, maxTokens, temperature } = {}) {
  const model = resolveModel();
  const payload = await callChatCompletions({
    model,
    messages: toChatMessages(system, messages),
    max_tokens: maxTokens,
    temperature
  });
  const choice = payload.choices && payload.choices[0];
  const text = choice && choice.message && choice.message.content;
  if (typeof text !== 'string') {
    throw contentMissingError(choice);
  }
  return { text, usage: extractUsage(payload), model: payload.model || model };
}

async function completeStructured({ system, messages, schema, maxTokens, temperature } = {}) {
  const model = resolveModel();
  const schemaInstruction =
    `Respond with ONLY a single JSON object matching this JSON Schema, no prose, no markdown fences:\n` +
    `${JSON.stringify(schema)}`;
  const combinedSystem = system ? `${system}\n\n${schemaInstruction}` : schemaInstruction;
  const payload = await callChatCompletions({
    model,
    messages: toChatMessages(combinedSystem, messages),
    max_tokens: maxTokens,
    temperature,
    response_format: { type: 'json_object' }
  });
  const choice = payload.choices && payload.choices[0];
  const raw = choice && choice.message && choice.message.content;
  if (typeof raw !== 'string') {
    throw contentMissingError(choice);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new ProviderError('AI provider returned non-JSON structured output', 'invalid_response', err);
  }
  return { data, usage: extractUsage(payload), model: payload.model || model };
}

module.exports = { complete, completeStructured, resolveBaseUrl, resolveModel, parseRetryAfterMs };
