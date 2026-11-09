// WP-020c unit tests for getNextSequence()/seedSequenceIfAbsent().
//
// These are unit tests against a fake Connection (same style as
// audit.test.js's fake createConnection) -- they prove the call shape
// (which collection, which filter, which update operator, which options)
// and the result-shape handling (mongodb driver 3.x wraps the updated
// document in `{ value, ok, lastErrorObject }`). They deliberately do NOT
// prove atomicity under real concurrency -- that requires a real MongoDB
// server serializing the $inc, which is proven separately by WP-020c's
// live concurrent-create test against the running services (see
// EXECUTION_LOG.md's WP-020c report). What these tests catch is a wiring
// regression: wrong collection name, wrong filter, a switch back to
// read-then-write, or a driver-version result-shape mismatch.
const { getNextSequence, seedSequenceIfAbsent } = require('../sequence');

function makeFakeConnection(findOneAndUpdateImpl) {
  const findOneAndUpdate = jest.fn(findOneAndUpdateImpl);
  const collection = jest.fn(() => ({ findOneAndUpdate }));
  return { collection, _findOneAndUpdate: findOneAndUpdate };
}

describe('getNextSequence()', () => {
  it('throws without a connection', async () => {
    await expect(getNextSequence(null, 'testcase')).rejects.toThrow(/Connection is required/);
  });

  it('throws without a sequence name', async () => {
    const conn = makeFakeConnection(async () => ({ value: { _id: 'x', seq: 1 } }));
    await expect(getNextSequence(conn, '')).rejects.toThrow(/sequence name is required/);
  });

  it('reads/writes the "counters" collection with an atomic $inc, upserting', async () => {
    const conn = makeFakeConnection(async () => ({ value: { _id: 'testcase', seq: 8 } }));
    const seq = await getNextSequence(conn, 'testcase');

    expect(conn.collection).toHaveBeenCalledWith('counters');
    expect(conn._findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'testcase' },
      { $inc: { seq: 1 } },
      expect.objectContaining({ upsert: true, returnOriginal: false })
    );
    expect(seq).toBe(8);
  });

  it('never reads the current max first -- exactly one round trip to the driver', async () => {
    const conn = makeFakeConnection(async () => ({ value: { _id: 'x', seq: 1 } }));
    await getNextSequence(conn, 'x');
    expect(conn._findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it('handles a driver that returns the document unwrapped (no .value envelope)', async () => {
    const conn = makeFakeConnection(async () => ({ _id: 'x', seq: 3 }));
    const seq = await getNextSequence(conn, 'x');
    expect(seq).toBe(3);
  });

  it('throws on an unexpected result shape instead of silently returning NaN/undefined', async () => {
    const conn = makeFakeConnection(async () => ({ value: null }));
    await expect(getNextSequence(conn, 'x')).rejects.toThrow(/unexpected result shape/);
  });
});

describe('seedSequenceIfAbsent()', () => {
  it('uses $setOnInsert so an existing counter is never overwritten', async () => {
    const conn = makeFakeConnection(async () => ({ value: { _id: 'PLN', seq: 7 } }));
    const seq = await seedSequenceIfAbsent(conn, 'PLN', 7);

    expect(conn._findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'PLN' },
      { $setOnInsert: { seq: 7 } },
      expect.objectContaining({ upsert: true, returnOriginal: false })
    );
    expect(seq).toBe(7);
  });

  it('rejects a non-numeric startAt', async () => {
    const conn = makeFakeConnection(async () => ({ value: { _id: 'x', seq: 1 } }));
    await expect(seedSequenceIfAbsent(conn, 'x', 'seven')).rejects.toThrow(/startAt must be a number/);
  });
});
