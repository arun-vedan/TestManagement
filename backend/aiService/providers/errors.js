// WP-050 -- normalised provider error. Every provider implementation MUST
// throw only this class (never let a vendor-specific error/exception shape
// escape the provider module) so nothing above the adapter boundary --
// controllers, the AiInteraction logger, any future WP-051..053 code --
// ever needs to know whether the underlying failure was an OpenAI 429, a
// connection refused talking to a self-hosted Ollama, or a malformed JSON
// body from azure-openai. See providers/index.js's header comment for the
// full "why an adapter" reasoning.
const CODES = ['unavailable', 'auth', 'rate_limited', 'invalid_request', 'invalid_response'];

class ProviderError extends Error {
  constructor(message, code = 'unavailable', cause) {
    super(message);
    this.name = 'ProviderError';
    this.code = CODES.includes(code) ? code : 'unavailable';
    if (cause) {
      this.cause = cause;
    }
  }
}

module.exports = { ProviderError, PROVIDER_ERROR_CODES: CODES };
