const advancedResults = (model, populate) => async (req, res, next) => {
  let query;
  req.query['status'] = 1;
  // Copy req.query
  const reqQuery = { ...req.query };

  // Fields to exclude
  const removeFields = ['select', 'sort', 'page', 'limit'];

  // Loop over removeFields and delete them from reqQuery
  removeFields.forEach(param => delete reqQuery[param]);

  // WP-115 — fold the verified tenant into the filter.
  //
  // THIS COPY HAD DIVERGED AND MISSED IT. service-core's advancedResults
  // gained this block in WP-021; this local copy never did. So mounting
  // requireProjectScope() on the list route would have authorized the caller
  // and then returned EVERY TENANT'S comments — scoped-looking and silently
  // leaking, which is the worst of the three states.
  //
  // The file stays separate on purpose: line 3's `req.query['status'] = 1`
  // soft-delete filter is a documented deliberate deviation
  // (LAUNCH_PLAN.md operational warnings) and must not be consolidated away.
  // Keeping the deviation does NOT mean keeping the drift — the tenant filter
  // is ported in, the status filter stays local.
  if (req.projectScope) {
    reqQuery.projectId = req.projectScope.projectId;
  }

  // Create query string
  let queryStr = JSON.stringify(reqQuery);

  // Create operators ($gt, $gte, etc)
  queryStr = queryStr.replace(/\b(gt|gte|lt|lte|in)\b/g, match => `$${match}`);

  // WP-102: parsed once and reused, because the pagination total below must be
  // counted against this exact filter. It previously called a bare
  // countDocuments(), which ignored every filter here -- including this
  // service's own status:1 soft-delete filter set at the top of this function.
  // So `total` counted soft-deleted comments that the returned rows correctly
  // excluded, and `pagination.next` offered pages the query would never fill.
  //
  // Fixed separately from @srckube/service-core's copy on purpose: these two
  // files must NOT be consolidated (the status:1 line is a documented
  // deliberate deviation, not drift). See __tests__/advancedResults.test.js.
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
  const total = await model.countDocuments(filter);

  query = query.skip(startIndex).limit(limit);

  if (populate) {
    query = query.populate(populate);
  }


  // Executing query
  const results = await query;

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
};

module.exports = advancedResults;
