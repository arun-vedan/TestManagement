const { ErrorResponse, asyncHandler } = require('@srckube/service-core');
const SavedView = require('../models/savedView');

// WP-043 -- SavedView CRUD. See models/savedView.js's header comment for
// the home decision and id-strategy reasoning.
//
// SEEDING (no read-then-write race): the four named default views from the
// WP brief ("My failed tests", "Unassigned", "Untested requirements",
// "Critical defects") are ensured to exist via a per-entityType
// findOneAndUpdate({...key}, {$setOnInsert:{...}}, {upsert:true}) -- one
// atomic upsert per default, keyed on the exact (projectId, entityType,
// ownerId:null, name) tuple the schema's unique index enforces. Two
// concurrent requests racing to seed the same project both attempt the
// same upsert; Mongo resolves the race atomically at the index (the loser
// gets a harmless duplicate-key-turned-no-op via upsert semantics, not a
// 400 surfaced to either caller) -- this is the deliberate opposite of the
// WP-020c `findOne().sort().limit()` then `+1` race this WP was told not
// to repeat.
//
// REAL-DATA NOTES on what each default's filter actually matches today
// (verified against project 1 directly, see EXECUTION_LOG.md's WP-043
// report):
//   - "Critical defects" (entityType 'defect'): defectService's `Severity`
//     field has no enforced enum (models/defects.js: `Severity: {type:
//     String}`, free text) and no document anywhere in this deployment
//     currently holds the literal value "Critical" -- the real values seen
//     are "High"/"Minor". Defined as Severity=High: it is the highest
//     real severity value in use, and matches project 1's 3 real defects
//     (Bug-1/2/3), which is what "critical" means operationally here.
//   - "Unassigned" (entityType 'defect'): defined as assignedTo="" (exact
//     empty-string equality). advancedResults() (service-core) only
//     converts the literal words gt/gte/lt/lte/in into Mongo operators on
//     a flat query-string param -- it cannot express "field is null or
//     missing" ($exists/$eq:null) through a query string without a
//     broader change to that shared middleware, which 16 other services
//     also depend on and which this WP judged too risky to touch for one
//     default view. This is a real, stated limitation: today, every
//     project-1 defect has assignedTo set, so this view correctly (and
//     honestly) returns zero rows rather than silently matching the wrong
//     thing.
//   - "My failed tests" (entityType 'testexecution') and "Untested
//     requirements" (entityType 'requirement', intended to use WP-011's
//     coverage computation) are seeded here (proving the CRUD/seed
//     contract this WP's acceptance criteria require), but neither
//     testExecution.tsx nor requirements.tsx were migrated to a
//     DataGrid+view-switcher in this WP -- see EXECUTION_LOG.md's WP-043
//     report for the explicit scope decision (test cases and defects only,
//     the two entities the acceptance criteria name). Their queryParams
//     are recorded for a future WP to wire up, not silently guessed at.
const SELF_TOKEN = '$self';

const DEFAULT_VIEWS = [
  {
    entityType: 'testexecution',
    name: 'My failed tests',
    filterModel: { items: [{ field: 'assignedTo', operator: 'equals', value: SELF_TOKEN }, { field: 'TestCases.TestStatus', operator: 'equals', value: 'Fail' }] },
    sortModel: [],
    columnVisibilityModel: {},
    queryParams: { assignedTo: SELF_TOKEN, 'TestCases.TestStatus': 'Fail' }
  },
  {
    entityType: 'defect',
    name: 'Unassigned',
    filterModel: { items: [{ field: 'assignedTo', operator: 'equals', value: '' }] },
    sortModel: [],
    columnVisibilityModel: {},
    queryParams: { assignedTo: '' }
  },
  {
    entityType: 'requirement',
    name: 'Untested requirements',
    filterModel: { special: 'untested-requirements' },
    sortModel: [],
    columnVisibilityModel: {},
    // No flat advancedResults query param can express this -- "untested"
    // is a cross-service join (requirementService x linkIssueService, the
    // same computation WP-011/WP-040's `coverage` report already performs
    // server-side). Left empty deliberately rather than guessed at; see
    // header comment above.
    queryParams: {}
  },
  {
    entityType: 'defect',
    name: 'Critical defects',
    filterModel: { items: [{ field: 'Severity', operator: 'equals', value: 'High' }] },
    sortModel: [{ field: 'createdAt', sort: 'desc' }],
    columnVisibilityModel: {},
    queryParams: { Severity: 'High' }
  }
];

async function ensureDefaultViews(projectId, entityType) {
  const relevant = DEFAULT_VIEWS.filter((v) => v.entityType === entityType);
  await Promise.all(
    relevant.map((def) =>
      SavedView.findOneAndUpdate(
        { projectId, entityType, ownerId: null, name: def.name },
        {
          $setOnInsert: {
            projectId,
            entityType,
            ownerId: null,
            isSystem: true,
            name: def.name,
            filterModel: def.filterModel,
            sortModel: def.sortModel,
            columnVisibilityModel: def.columnVisibilityModel,
            queryParams: def.queryParams
          }
        },
        { upsert: true, setDefaultsOnInsert: true }
      )
    )
  );
}

function currentUserSub(req) {
  const grant = req.kauth && req.kauth.grant && req.kauth.grant.access_token && req.kauth.grant.access_token.content;
  return grant && grant.sub;
}

// @desc   List saved views for one entityType in the caller's project: the
//         caller's own personal views + every system (seeded default) view.
//         Never another user's personal views (WP-043 brief: "per user").
// @route  GET /api/v1/savedviews?entityType=testcase
// @access Private (read)
exports.getSavedViews = asyncHandler(async (req, res, next) => {
  const { entityType } = req.query;
  if (!entityType) {
    return next(new ErrorResponse('entityType query param is required', 400));
  }
  const projectId = req.projectScope.projectId;
  const sub = currentUserSub(req);

  await ensureDefaultViews(projectId, entityType);

  const views = await SavedView.find({
    projectId,
    entityType,
    $or: [{ ownerId: sub }, { isSystem: true }]
  }).sort({ isSystem: -1, name: 1 });

  res.status(200).json({ success: true, count: views.length, data: views });
});

// @desc   Create a personal saved view. Always owned by the caller;
//         isSystem is never settable via this route (system views only
//         ever come from ensureDefaultViews' seeding).
// @route  POST /api/v1/savedviews
// @access Private (write)
exports.createSavedView = asyncHandler(async (req, res, next) => {
  const { entityType, name, filterModel, sortModel, columnVisibilityModel, queryParams } = req.body;
  if (!entityType || !name) {
    return next(new ErrorResponse('entityType and name are required', 400));
  }
  const sub = currentUserSub(req);
  const projectId = req.projectScope.projectId;

  let view;
  try {
    view = await SavedView.create({
      projectId,
      entityType,
      ownerId: sub,
      isSystem: false,
      name,
      filterModel: filterModel || {},
      sortModel: sortModel || [],
      columnVisibilityModel: columnVisibilityModel || {},
      queryParams: queryParams || {},
      createdBy: sub,
      updatedBy: sub
    });
  } catch (err) {
    if (err.code === 11000) {
      return next(new ErrorResponse(`A saved view named "${name}" already exists for this list`, 409));
    }
    throw err;
  }

  res.status(201).json({ success: true, data: view });
});

// @desc   Update a personal saved view. Only its own owner may update it;
//         system (seeded default) views are read-only through this API --
//         there is no PUT path that can set isSystem or take ownership of
//         one, so the four seeded defaults can never drift per-user.
// @route  PUT /api/v1/savedviews/:id
// @access Private (write)
exports.updateSavedView = asyncHandler(async (req, res, next) => {
  const sub = currentUserSub(req);
  const projectId = req.projectScope.projectId;
  const existing = await SavedView.findOne({ _id: req.params.id, projectId });
  if (!existing) {
    return next(new ErrorResponse(`No saved view found with id ${req.params.id}`, 404));
  }
  if (existing.isSystem || existing.ownerId !== sub) {
    return next(new ErrorResponse('You can only edit your own saved views', 403));
  }

  const { name, filterModel, sortModel, columnVisibilityModel, queryParams } = req.body;
  if (name !== undefined) existing.name = name;
  if (filterModel !== undefined) existing.filterModel = filterModel;
  if (sortModel !== undefined) existing.sortModel = sortModel;
  if (columnVisibilityModel !== undefined) existing.columnVisibilityModel = columnVisibilityModel;
  if (queryParams !== undefined) existing.queryParams = queryParams;
  existing.updatedBy = sub;

  try {
    await existing.save();
  } catch (err) {
    if (err.code === 11000) {
      return next(new ErrorResponse(`A saved view named "${existing.name}" already exists for this list`, 409));
    }
    throw err;
  }

  res.status(200).json({ success: true, data: existing });
});

// @desc   Delete a personal saved view. Only its own owner may delete it;
//         system views cannot be deleted through this API.
// @route  DELETE /api/v1/savedviews/:id
// @access Private (delete)
exports.deleteSavedView = asyncHandler(async (req, res, next) => {
  const sub = currentUserSub(req);
  const projectId = req.projectScope.projectId;
  const existing = await SavedView.findOne({ _id: req.params.id, projectId });
  if (!existing) {
    return next(new ErrorResponse(`No saved view found with id ${req.params.id}`, 404));
  }
  if (existing.isSystem || existing.ownerId !== sub) {
    return next(new ErrorResponse('You can only delete your own saved views', 403));
  }

  await SavedView.deleteOne({ _id: existing._id });
  res.status(200).json({ success: true, data: {} });
});

module.exports.DEFAULT_VIEWS = DEFAULT_VIEWS;
module.exports.SELF_TOKEN = SELF_TOKEN;
