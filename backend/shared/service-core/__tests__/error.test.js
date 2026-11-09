const errorHandler = require('../middleware/error');

function mockRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('errorHandler', () => {
  let consoleSpy;

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('maps a Mongoose CastError to a 404', () => {
    const res = mockRes();
    const err = { name: 'CastError', message: 'bad id' };

    errorHandler(err, {}, res, () => {});

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Resource not found'
    });
  });

  it('maps a Mongo duplicate-key error (code 11000) to a 400', () => {
    const res = mockRes();
    const err = { code: 11000, message: 'duplicate' };

    errorHandler(err, {}, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Duplicate field value entered'
    });
  });

  it('maps a Mongoose ValidationError to a 400 with field messages', () => {
    const res = mockRes();
    const err = {
      name: 'ValidationError',
      message: 'validation failed',
      errors: {
        name: { message: 'Name is required' }
      }
    };

    errorHandler(err, {}, res, () => {});

    expect(res.status).toHaveBeenCalledWith(400);
    // ErrorResponse's message is set via `super(message)` with an array —
    // Error coerces a single-element array message to its bare string form.
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Name is required'
    });
  });

  it('defaults to a 500 for an unrecognized error', () => {
    const res = mockRes();
    const err = { message: 'something broke' };

    errorHandler(err, {}, res, () => {});

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'something broke'
    });
  });
});
