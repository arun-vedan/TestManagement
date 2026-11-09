const mockProvider = require('./mockProvider');
const openaiProvider = require('./openaiProvider');
const { ProviderError } = require('./errors');

// WP-050 -- THE provider adapter. This is the one seam in aiService (and in
// the whole codebase) allowed to know a vendor's request/response shape.
// Everything above this module -- controllers/ai.js, the AiInteraction
// logger, and every future WP-051..053 caller -- talks ONLY to the narrow
// interface below and never imports a provider module or a vendor SDK
// directly.
//
//   complete({system, messages, maxTokens, temperature})
//     -> Promise<{ text: string,
//                  usage: {promptTokens, completionTokens, totalTokens},
//                  model: string }>
//
//   completeStructured({system, messages, schema, maxTokens, temperature})
//     -> Promise<{ data: object,
//                  usage: {promptTokens, completionTokens, totalTokens},
//                  model: string }>
//
// Both reject with ONLY providers/errors.js's ProviderError -- never a raw
// axios/vendor error (see openaiProvider.js's normaliseAxiosError()).
//
// THE PHASE E PROVIDER DECISION (owner override, 2026-08-30, superseding
// the original Anthropic-only plan -- see EXECUTION_LOG.md's WP-050
// report for the full record): build provider-agnostic, with the seam
// PROVEN by at least two real implementations rather than assumed from a
// single one behind an interface. The two live here today:
//
//   - mock   (mockProvider.js) -- deterministic, zero network. Default in
//            this environment (AI_PROVIDER unset or 'mock') and in every
//            CI/test run -- there is no vendor account, no key, and no
//            outbound expectation in this environment.
//   - openai (openaiProvider.js) -- a real OpenAI-compatible chat/
//            completions HTTP client (axios, not the `openai` npm
//            package). Unit-tested against a stubbed local HTTP server
//            only (__tests__/openaiProvider.test.js) -- it has NEVER been
//            run against a live vendor endpoint in this session. Because
//            it speaks the OpenAI-compatible contract, pointing
//            AI_BASE_URL at Azure OpenAI's compatible endpoint or a local
//            Ollama is expected to work under AI_PROVIDER=openai with no
//            code change, but that combination is untested/unverified
//            here -- 'azure-openai' and 'ollama' are therefore NOT wired
//            in as separate provider keys below; claiming them as
//            first-class would overstate what has actually been built and
//            verified. 'anthropic' is not implemented at all (the
//            superseded plan's SDK is exactly what this WP was told not to
//            hardwire on) -- adding a real Anthropic HTTP implementation is
//            straightforward future work behind this same interface, not
//            done here because two proven implementations already satisfy
//            the "at least two" requirement without it.
const PROVIDERS = {
  mock: mockProvider,
  openai: openaiProvider
};

function resolveProviderName() {
  return (process.env.AI_PROVIDER || 'mock').trim();
}

let cached = null;
let cachedName = null;

// Cached per resolved provider name (not per-process-lifetime) so a test
// that flips AI_PROVIDER via process.env between cases (see
// __tests__/providers.test.js) always gets the implementation that name
// currently resolves to, without needing a manual cache-bust on every call
// -- _resetProviderCacheForTests() below exists for the rare case a test
// needs an even harder reset (e.g. after monkeypatching PROVIDERS itself).
function getProvider() {
  const name = resolveProviderName();
  if (cached && cachedName === name) {
    return cached;
  }
  const impl = PROVIDERS[name];
  if (!impl) {
    throw new ProviderError(
      `Unknown AI_PROVIDER '${name}'; expected one of: ${Object.keys(PROVIDERS).join(', ')}`,
      'invalid_request'
    );
  }
  cached = impl;
  cachedName = name;
  return cached;
}

function _resetProviderCacheForTests() {
  cached = null;
  cachedName = null;
}

module.exports = { getProvider, PROVIDERS, _resetProviderCacheForTests };
