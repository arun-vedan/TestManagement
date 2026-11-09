const ErrorResponse = require('../utils/errorResponse');

describe('ErrorResponse', () => {
  it('sets message and statusCode', () => {
    const err = new ErrorResponse('not found', 404);
    expect(err.message).toBe('not found');
    expect(err.statusCode).toBe(404);
    expect(err).toBeInstanceOf(Error);
  });
});
