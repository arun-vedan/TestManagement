const { correlationId, HEADER_NAME } = require('../correlationId');

describe('correlationId middleware', () => {
  it('generates a new ID when none is present on the incoming request', () => {
    const req = { headers: {} };
    const res = { setHeader: jest.fn() };
    const next = jest.fn();

    correlationId(req, res, next);

    expect(req.correlationId).toEqual(expect.any(String));
    expect(req.correlationId.length).toBeGreaterThan(0);
    expect(res.setHeader).toHaveBeenCalledWith(HEADER_NAME, req.correlationId);
    expect(next).toHaveBeenCalled();
  });

  it('propagates an incoming correlation ID instead of generating a new one', () => {
    const req = { headers: { [HEADER_NAME]: 'existing-id-123' } };
    const res = { setHeader: jest.fn() };
    const next = jest.fn();

    correlationId(req, res, next);

    expect(req.correlationId).toBe('existing-id-123');
    expect(res.setHeader).toHaveBeenCalledWith(HEADER_NAME, 'existing-id-123');
  });
});
