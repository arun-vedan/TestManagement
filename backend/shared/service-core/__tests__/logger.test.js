const { createLogger } = require('../logger');

describe('createLogger', () => {
  let consoleSpy;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('emits a single-line JSON entry with service name, level, and message', () => {
    const logger = createLogger('testService');
    logger.info('hello', { correlationId: 'abc-123' });

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(consoleSpy.mock.calls[0][0]);

    expect(entry).toMatchObject({
      level: 'info',
      service: 'testService',
      message: 'hello',
      correlationId: 'abc-123'
    });
    expect(entry.timestamp).toEqual(expect.any(String));
  });

  it('supports warn and error levels', () => {
    const logger = createLogger('testService');
    logger.warn('careful');
    logger.error('broken');

    const warnEntry = JSON.parse(consoleSpy.mock.calls[0][0]);
    const errorEntry = JSON.parse(consoleSpy.mock.calls[1][0]);

    expect(warnEntry.level).toBe('warn');
    expect(errorEntry.level).toBe('error');
  });
});
