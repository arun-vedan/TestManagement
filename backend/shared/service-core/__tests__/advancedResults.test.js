const advancedResults = require('../middleware/advancedResults');

// A minimal fake of a Mongoose query chain: find().select().sort().skip().limit()
// resolves to `results` when awaited, matching how advancedResults uses it.
function makeFakeModel(results, total) {
  const query = {
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    populate: jest.fn().mockReturnThis(),
    then: (resolve) => resolve(results)
  };
  return {
    find: jest.fn().mockReturnValue(query),
    countDocuments: jest.fn().mockResolvedValue(total),
    _query: query
  };
}

describe('advancedResults', () => {
  it('returns success, count, and data for a simple query', async () => {
    const model = makeFakeModel([{ id: 1 }, { id: 2 }], 2);
    const req = { query: {} };
    const res = {};
    const next = jest.fn();

    await advancedResults(model)(req, res, next);

    expect(res.advancedResults).toEqual({
      success: true,
      count: 2,
      pagination: {},
      data: [{ id: 1 }, { id: 2 }]
    });
    expect(next).toHaveBeenCalled();
  });

  it('excludes select/sort/page/limit from the Mongo filter', async () => {
    const model = makeFakeModel([], 0);
    const req = { query: { select: 'a,b', sort: 'a', page: '2', limit: '10', status: 'open' } };

    await advancedResults(model)(req, {}, jest.fn());

    // status=open should reach find(); select/sort/page/limit should not
    expect(model.find).toHaveBeenCalledWith({ status: 'open' });
  });

  it('adds a next-page pagination entry when more results exist beyond the current page', async () => {
    const model = makeFakeModel(Array(25).fill({}), 30);
    const req = { query: {} };
    const res = {};

    await advancedResults(model)(req, res, jest.fn());

    expect(res.advancedResults.pagination.next).toEqual({ page: 2, limit: 25 });
    expect(res.advancedResults.pagination.prev).toBeUndefined();
  });

  it('adds a prev-page pagination entry when not on page 1', async () => {
    const model = makeFakeModel([], 30);
    const req = { query: { page: '2' } };
    const res = {};

    await advancedResults(model)(req, res, jest.fn());

    expect(res.advancedResults.pagination.prev).toEqual({ page: 1, limit: 25 });
  });

  // WP-021: when requireProjectScope() ran earlier in the chain, it sets
  // req.projectScope — advancedResults() must fold that verified projectId
  // into the Mongo filter so list endpoints are tenant-scoped.
  it('adds the verified projectId filter when req.projectScope is set', async () => {
    const model = makeFakeModel([], 0);
    const req = { query: { status: 'open' }, projectScope: { projectId: 1, project: {} } };

    await advancedResults(model)(req, {}, jest.fn());

    expect(model.find).toHaveBeenCalledWith({ status: 'open', projectId: 1 });
  });

  it('does not add a projectId filter when req.projectScope is absent (unmigrated services unaffected)', async () => {
    const model = makeFakeModel([], 0);
    const req = { query: { status: 'open' } };

    await advancedResults(model)(req, {}, jest.fn());

    expect(model.find).toHaveBeenCalledWith({ status: 'open' });
  });

  // WP-F06 -- 'expand' selects a response SHAPE (testRepoService's
  // getTestCases reads req.query.expand === 'steps' to decide whether to
  // expand shared-step references), never a document field. Without this
  // in removeFields, ?expand=steps would reach the Mongo filter as
  // {expand: 'steps'} and silently return zero rows on every list route
  // that supports it -- exactly the kind of silent breakage a filter-leak
  // test exists to catch.
  it('excludes expand from the Mongo filter (WP-F06)', async () => {
    const model = makeFakeModel([], 0);
    const req = { query: { expand: 'steps', status: 'open' } };

    await advancedResults(model)(req, {}, jest.fn());

    expect(model.find).toHaveBeenCalledWith({ status: 'open' });
  });

  // WP-F07a Task 3 (fix round 1, review Important) -- 'substitute' selects
  // which Dataset row testRepoService's getTestCases substitutes into the
  // response, never a document field on any model (same "no model
  // declares it" reasoning as 'expand' above). Without this in
  // removeFields, `?substitute=0` on a list route reaches the Mongo
  // filter as {substitute: '0'} and silently returns zero rows -- the
  // review reproduced this live by removing 'substitute' from
  // removeFields and confirming `?substitute=0` returned count: 0. This
  // is the dedicated regression test the sibling 'expand' case already
  // had and this one didn't: a future refactor that drops 'substitute'
  // from removeFields breaks the list route with nothing else here to
  // catch it.
  it('excludes substitute from the Mongo filter (WP-F07a)', async () => {
    const model = makeFakeModel([], 0);
    const req = { query: { substitute: '0', status: 'open' } };

    await advancedResults(model)(req, {}, jest.fn());

    expect(model.find).toHaveBeenCalledWith({ status: 'open' });
  });

  // WP-013b: a filter value that can't be cast to the field's declared
  // schema type (e.g. ?TestPlanId=PLN-3 against a Mongoose ObjectId field)
  // used to reject the awaited query with an unhandled Mongoose CastError
  // — no try/catch, no asyncHandler wrapper — which meant next() was never
  // called and the response never sent (client hangs). Live repro: GET
  // /api/v1/testexecution?TestPlanId=PLN-3 hung until client timeout, 0%
  // CPU (see EXECUTION_LOG.md's WP-013b report). This must now resolve to
  // next(err) with a 400 ErrorResponse naming the field and value, not
  // hang and not silently 500/404 it away.
  describe('CastError handling (WP-013b)', () => {
    // A fake model whose query rejects with a Mongoose-shaped CastError,
    // mirroring what `await query` actually throws for e.g.
    // TestExecution.find({ TestPlanId: 'PLN-3' }) against an ObjectId
    // field (verified against real mongoose — see WP-013b report).
    function makeCastErrorModel({ path, value, kind }) {
      const castError = Object.assign(new Error(
        `Cast to ${kind} failed for value "${value}" (type string) at path "${path}"`
      ), { name: 'CastError', path, value, kind });

      const query = {
        select: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        populate: jest.fn().mockReturnThis(),
        then: (resolve, reject) => reject(castError)
      };
      return {
        find: jest.fn().mockReturnValue(query),
        countDocuments: jest.fn().mockResolvedValue(0),
        _query: query,
        _castError: castError
      };
    }

    it('calls next() with a 400 ErrorResponse naming the field and value, instead of hanging', async () => {
      const model = makeCastErrorModel({ path: 'TestPlanId', value: 'PLN-3', kind: 'ObjectId' });
      const req = { query: { TestPlanId: 'PLN-3' } };
      const res = {};
      const next = jest.fn();

      // The pre-fix code had no catch/asyncHandler around this await, so
      // the promise this returns would never settle for this input — this
      // await is itself part of what proves the fix: it settling at all,
      // within the test's default timeout, is the fast-fail signal.
      await advancedResults(model)(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      const err = next.mock.calls[0][0];
      expect(err).toBeInstanceOf(Error);
      expect(err.statusCode).toBe(400);
      expect(err.message).toEqual(expect.stringContaining('TestPlanId'));
      expect(err.message).toEqual(expect.stringContaining('PLN-3'));
      // res.advancedResults must never be set on the error path — a
      // downstream controller reading it would send a bogus success body.
      expect(res.advancedResults).toBeUndefined();
    });

    it('does not repackage a non-CastError rejection as a 400 (server/DB errors stay server errors)', async () => {
      // Not the caller's fault (Mongo unreachable/timeout/etc.) — must not
      // be reported as a 400. advancedResults() rethrows anything that
      // isn't a CastError (see the try/catch's `throw err` branch), and
      // the outer asyncHandler wrapper (middleware/async.js) is what turns
      // that rethrow into a next(err) call in the real Express flow — so
      // next() DOES get called here, but with the original, unmodified
      // dbError, not a 400 ErrorResponse. The shared errorHandler
      // (middleware/error.js) then falls through to its default 500
      // branch for any error shape it doesn't specifically recognize.
      const dbError = new Error('connection timed out');
      dbError.name = 'MongoNetworkError';
      const model = makeFakeModel([], 0);
      model.countDocuments = jest.fn().mockRejectedValue(dbError);
      const req = { query: {} };
      const res = {};
      const next = jest.fn();

      await advancedResults(model)(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith(dbError);
      const err = next.mock.calls[0][0];
      expect(err.statusCode).toBeUndefined();
      expect(res.advancedResults).toBeUndefined();
    });
  });

  // WP-102 — the pagination total ignored every filter, including the tenant
  // filter advancedResults() itself had just added. `total` drove
  // `pagination.next`, so a caller paging a 40-document project inside a
  // 20 000-document collection was offered 800 pages, 798 of them empty --
  // and the number itself leaked the size of the whole collection across
  // every tenant. These assert the ARGUMENT countDocuments receives, not
  // just its mocked return (the pre-WP-102 suite only ever mocked the
  // return, so the bug was invisible to it).
  describe('WP-102: the total is counted against the same filter as the query', () => {
    it('passes the identical filter object to countDocuments() and find()', async () => {
      const model = makeFakeModel([], 0);
      const req = { query: { status: 'open' } };

      await advancedResults(model)(req, {}, jest.fn());

      expect(model.countDocuments).toHaveBeenCalledWith({ status: 'open' });
      expect(model.countDocuments.mock.calls[0][0]).toEqual(model.find.mock.calls[0][0]);
    });

    it('includes the verified projectId in the count, not just in the query', async () => {
      const model = makeFakeModel([], 0);
      const req = { query: { status: 'open' }, projectScope: { projectId: 7, project: {} } };

      await advancedResults(model)(req, {}, jest.fn());

      expect(model.find).toHaveBeenCalledWith({ status: 'open', projectId: 7 });
      expect(model.countDocuments).toHaveBeenCalledWith({ status: 'open', projectId: 7 });
    });

    it('counts against the tenant filter even when the caller sends no query at all', async () => {
      const model = makeFakeModel([], 0);
      const req = { query: {}, projectScope: { projectId: 7, project: {} } };

      await advancedResults(model)(req, {}, jest.fn());

      // Never a bare countDocuments() -- that is the bug.
      expect(model.countDocuments).not.toHaveBeenCalledWith();
      expect(model.countDocuments).toHaveBeenCalledWith({ projectId: 7 });
    });

    // Deliberately filter-AWARE: countDocuments resolves the collection's full
    // 20 000 when called bare (the bug) and the project's 40 when called with
    // a filter (the fix). A fake returning 40 either way would pass before and
    // after the fix and prove nothing.
    it('a 40-document project in a 20 000-document collection offers exactly two pages', async () => {
      const filterAware = (results) => {
        const query = {
          select: jest.fn().mockReturnThis(),
          sort: jest.fn().mockReturnThis(),
          skip: jest.fn().mockReturnThis(),
          limit: jest.fn().mockReturnThis(),
          populate: jest.fn().mockReturnThis(),
          then: (resolve) => resolve(results)
        };
        return {
          find: jest.fn().mockReturnValue(query),
          countDocuments: jest.fn((f) => Promise.resolve(f && Object.keys(f).length ? 40 : 20000))
        };
      };
      const scope = { projectId: 7, project: {} };

      const page1 = filterAware(Array(25).fill({}));
      const res1 = {};
      await advancedResults(page1)({ query: { page: '1' }, projectScope: scope }, res1, jest.fn());

      expect(page1.countDocuments).toHaveBeenCalledWith({ projectId: 7 });
      expect(res1.advancedResults.pagination.next).toEqual({ page: 2, limit: 25 });

      const page2 = filterAware(Array(15).fill({}));
      const res2 = {};
      await advancedResults(page2)({ query: { page: '2' }, projectScope: scope }, res2, jest.fn());

      // Page 2 is the last: endIndex 50 > total 40. Counted bare, total would
      // be 20 000 and this would offer page 3 ... page 800, 798 of them empty.
      expect(res2.advancedResults.pagination.next).toBeUndefined();
      expect(res2.advancedResults.pagination.prev).toEqual({ page: 1, limit: 25 });
    });

    it('operator syntax ($gt etc) is translated in the count filter too, not just the query', async () => {
      const model = makeFakeModel([], 0);
      const req = { query: { createdAt: { gte: '2026-01-01' } } };

      await advancedResults(model)(req, {}, jest.fn());

      expect(model.countDocuments).toHaveBeenCalledWith({ createdAt: { $gte: '2026-01-01' } });
      expect(model.countDocuments.mock.calls[0][0]).toEqual(model.find.mock.calls[0][0]);
    });
  });
});
