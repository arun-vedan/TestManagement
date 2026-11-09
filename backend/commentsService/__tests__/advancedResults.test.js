// WP-102 — unit test for commentsService's OWN copy of advancedResults.
//
// This service deliberately does not use @srckube/service-core's shared
// advancedResults: line 3 of middleware/advancedResults.js sets
// req.query['status'] = 1 to enforce soft-delete filtering, a documented
// deliberate deviation (LAUNCH_PLAN.md "Operational warnings"). The two files
// must NOT be consolidated, so the same WP-102 bug had to be fixed twice and
// is asserted twice -- here, against the local copy.
//
// The bug: `const total = await model.countDocuments()` ignored every filter,
// including this service's own status:1 soft-delete filter. So the pagination
// total counted soft-deleted comments that the returned rows correctly
// excluded -- `pagination.next` offered pages of documents the query would
// never return.

const advancedResults = require('../middleware/advancedResults');

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

describe("commentsService advancedResults (local copy, status:1 deviation preserved)", () => {
  it('still forces the soft-delete filter status:1 into the query (the deliberate deviation)', async () => {
    const model = makeFakeModel([], 0);
    const req = { query: {} };

    await advancedResults(model)(req, {}, jest.fn());

    expect(model.find).toHaveBeenCalledWith({ status: 1 });
  });

  it('WP-102: counts against the same filter as the query, soft-delete filter included', async () => {
    const model = makeFakeModel([], 0);
    const req = { query: {} };

    await advancedResults(model)(req, {}, jest.fn());

    // Never a bare countDocuments() -- that is the bug: it counted
    // soft-deleted comments the query itself excluded.
    expect(model.countDocuments).not.toHaveBeenCalledWith();
    expect(model.countDocuments).toHaveBeenCalledWith({ status: 1 });
    expect(model.countDocuments.mock.calls[0][0]).toEqual(model.find.mock.calls[0][0]);
  });

  it('WP-102: a caller filter is counted too, and select/sort/page/limit are not', async () => {
    const model = makeFakeModel([], 0);
    const req = { query: { RequirementId: 'Req-1', select: 'a', sort: 'b', page: '2', limit: '10' } };

    await advancedResults(model)(req, {}, jest.fn());

    expect(model.countDocuments).toHaveBeenCalledWith({ status: 1, RequirementId: 'Req-1' });
    expect(model.countDocuments.mock.calls[0][0]).toEqual(model.find.mock.calls[0][0]);
  });

  // Deliberately filter-AWARE: countDocuments resolves the collection's full
  // 20 000 when called bare (the bug) and the thread's 40 when called with a
  // filter (the fix). A fake that returns 40 either way would pass before and
  // after and prove nothing.
  it('WP-102: 40 live comments among 20 000 rows offers exactly two pages, not 800', async () => {
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

    const page1 = filterAware(Array(25).fill({}));
    const res1 = {};
    await advancedResults(page1)({ query: { page: '1' } }, res1, jest.fn());
    expect(res1.advancedResults.pagination.next).toEqual({ page: 2, limit: 25 });

    const page2 = filterAware(Array(15).fill({}));
    const res2 = {};
    await advancedResults(page2)({ query: { page: '2' } }, res2, jest.fn());

    // Page 2 is the last. Counted bare, total would be 20 000 and this would
    // offer page 3 ... page 800, 798 of them empty.
    expect(res2.advancedResults.pagination.next).toBeUndefined();
    expect(res2.advancedResults.pagination.prev).toEqual({ page: 1, limit: 25 });
  });

  it('operator syntax is translated in the count filter as well', async () => {
    const model = makeFakeModel([], 0);
    const req = { query: { createdAt: { gte: '2026-01-01' } } };

    await advancedResults(model)(req, {}, jest.fn());

    expect(model.countDocuments).toHaveBeenCalledWith({ status: 1, createdAt: { $gte: '2026-01-01' } });
  });
});
