const asyncHandler = require('./async');
const ErrorResponse = require('../utils/errorResponse');

// WP-013b: `TestExecution.TestPlanId` (and other ObjectId-typed fields
// across the other 14 services) reject a non-castable filter value (e.g.
// ?TestPlanId=PLN-3, a human-readable id, not a Mongo ObjectId) with a
// Mongoose CastError thrown asynchronously out of `await query` below.
// Before this fix, neither this middleware nor its route mounting (e.g.
// `.get(keycloak.protect(), advancedResults(TestExecution), ...)` in
// testPlanExecutionService/routes/testexecution.js — routes are out of
// this WP's scope, so the fix lives entirely here) wrapped that rejection
// in a catch/asyncHandler, so it became an unhandled promise rejection:
// Express never got a call to next(err), so the response was never sent
// and the client hung until its own timeout. Reproduced live (0% CPU,
// >30s no response) before this change; see EXECUTION_LOG.md for the
// WP-013b report.
//
// Fix: wrap the whole middleware in asyncHandler (belt-and-suspenders —
// covers any synchronous throw too, e.g. a malformed JSON.parse below,
// not just the two awaits) AND explicitly classify CastError as a client
// error inside a try/catch around the DB calls, because asyncHandler alone
// would forward a CastError to the shared errorHandler (middleware/error.js),
// which maps `err.name === 'CastError'` to a generic 404 "Resource not
// found" — the right call for a bad :id path param, but wrong here: the
// caller supplied a bad *filter value* on a list endpoint, not a bad
// resource identifier, so 400 naming the field/value is more useful and
// more correct (the resource collection was found; the query was invalid).
// Constructing our own ErrorResponse(..., 400) and calling next() with it
// directly bypasses errorHandler's CastError->404 branch (that branch only
// triggers on err.name === 'CastError'; ErrorResponse's err.name is
// 'Error').
//
// Client vs. server error: only a genuine CastError (the driver validated
// our own query object against the schema, synchronously-in-effect, with
// no DB round trip) is classified as the caller's mistake -> 400. Verified
// this really is DB-independent: running `M.find({TestPlanId:'PLN-3'})`
// against a model with no live Mongo connection at all still throws
// CastError on await (see WP-013b report for the reproduction). Any other
// rejection (Mongo unreachable, connection timeout, server error, etc.) is
// NOT a CastError and is deliberately left to propagate to asyncHandler ->
// errorHandler's default branch (500), matching the fail-closed,
// don't-mask-outages posture requireProjectScope() already uses for a
// dependency outage (see middleware/projectScope.js's identity-service
// unavailable -> 503 comment) — a database problem is not the caller's
// fault and must not be reported as 400.
const advancedResults = (model, populate) => asyncHandler(async (req, res, next) => {
  let query;

  // Copy req.query
  const reqQuery = { ...req.query };

  // Fields to exclude. WP-F06 adds 'expand': it selects a response SHAPE
  // (see testRepoService's getTestCases) and is never a document field --
  // no model in any service declares one, verified by grep across
  // backend/*/models/ -- so leaving it in reqQuery would filter every list
  // route down to zero rows the moment a caller asks to expand.
  //
  // WP-F07a Task 3 adds 'substitute' for the identical reason: it selects
  // which Dataset row testRepoService's getTestCases substitutes into the
  // response, never a document field on any model (same grep, same
  // result), so left in reqQuery it would filter the list route to zero
  // rows for a request like `?substitute=0` the same way an unstripped
  // `expand` did before WP-F06 fixed it here.
  const removeFields = ['select', 'sort', 'page', 'limit', 'expand', 'substitute'];

  // Loop over removeFields and delete them from reqQuery
  removeFields.forEach(param => delete reqQuery[param]);

  // WP-021: when requireProjectScope() ran earlier in this route's chain
  // (mounted before advancedResults(), see e.g.
  // testRepoService/routes/testrepo.js), it verified the caller's project
  // membership and set req.projectScope. Every migrated service's list
  // endpoint must be tenant-scoped, so fold that verified projectId into
  // the Mongo filter here rather than trusting a client-supplied
  // ?projectId= query value (which req.query already excludes from nothing
  // — this line always wins over/adds to it). Services that never call
  // requireProjectScope() (the 11 not in this WP's rollout) never set
  // req.projectScope, so this is a no-op for them — advancedResults()
  // behaves exactly as before.
  if (req.projectScope) {
    reqQuery.projectId = req.projectScope.projectId;
  }

  // Create query string
  let queryStr = JSON.stringify(reqQuery);

  // Create operators ($gt, $gte, etc)
  queryStr = queryStr.replace(/\b(gt|gte|lt|lte|in)\b/g, match => `$${match}`);

  // WP-102: parsed once and reused, because the pagination total below must
  // be counted against this exact filter. It previously called a bare
  // countDocuments(), which ignored every filter here -- the caller's own
  // query params AND the verified tenant projectId folded in just above. The
  // total drives `pagination.next`, so a 40-document project inside a
  // 20 000-document collection was offered 800 pages (798 empty), and the
  // number itself disclosed the whole collection's size to every tenant.
  const filter = JSON.parse(queryStr);

  // Finding resource
  query = model.find(filter);

  // Select Fields
  if (req.query.select) {
    const fields = req.query.select.split(',').join(' ');
    query = query.select(fields);
  }

  // Sort
  if (req.query.sort) {
    const sortBy = req.query.sort.split(',').join(' ');
    query = query.sort(sortBy);
  } else {
    query = query.sort('-createdAt');
  }

  // Pagination
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 25;
  const startIndex = (page - 1) * limit;
  const endIndex = page * limit;

  query = query.skip(startIndex).limit(limit);

  if (populate) {
    query = query.populate(populate);
  }

  // Both of these can reject with a Mongoose CastError when a caller
  // supplies a filter value that can't be cast to the field's declared
  // schema type (e.g. ?TestPlanId=PLN-3 against an ObjectId field) — see
  // the WP-013b comment above the outer function for the full story.
  let total;
  let results;
  try {
    total = await model.countDocuments(filter);
    results = await query;
  } catch (err) {
    if (err.name === 'CastError') {
      return next(
        new ErrorResponse(
          `Invalid value '${err.value}' for query field '${err.path}': cannot be cast to ${err.kind}`,
          400
        )
      );
    }
    // Not a cast problem with the caller's input (e.g. Mongo unreachable,
    // connection timeout, other server-side failure) — not the caller's
    // fault, so don't report 400. Rethrow and let asyncHandler forward it
    // to the shared errorHandler, which defaults to 500 for an
    // unrecognized error shape.
    throw err;
  }

  // Pagination result
  const pagination = {};

  if (endIndex < total) {
    pagination.next = {
      page: page + 1,
      limit
    };
  }

  if (startIndex > 0) {
    pagination.prev = {
      page: page - 1,
      limit
    };
  }

  res.advancedResults = {
    success: true,
    count: results.length,
    pagination,
    data: results
  };

  next();
});

module.exports = advancedResults;
