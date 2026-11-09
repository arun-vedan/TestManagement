const { subscribe } = require('../events');
const { createLogger } = require('../logger');

const logger = createLogger('service-core:events:log-only-consumer');

// WP-030 -- "First consumer: a log-only consumer proving delivery."
//
// The simplest possible subscribe() caller: it does nothing but log every
// event it receives (structured JSON, via the shared logger, same as every
// other log line in this repo) and ack it. Exists to prove the publisher ->
// broker -> consumer path actually delivers real events end-to-end before
// anything (WP-031's notification service) is built on top of it -- and
// doubles as the smallest possible reference implementation for a future
// subscribe() caller to copy.
//
// `onEvent`, if passed, is called with the same (payload, meta) subscribe()
// hands the handler -- purely a test hook so a suite can assert on what was
// received without scraping stdout; production callers should not need it.
function startLogOnlyConsumer(stream, group, options = {}) {
  const { onEvent, ...subscribeOptions } = options;

  return subscribe(
    stream,
    group,
    async (payload, meta) => {
      logger.info('event received', {
        stream: meta.stream,
        group: meta.group,
        consumerName: meta.consumerName,
        id: meta.id,
        correlationId: payload && payload.correlationId,
        payload
      });
      if (onEvent) {
        await onEvent(payload, meta);
      }
    },
    subscribeOptions
  );
}

module.exports = { startLogOnlyConsumer };
