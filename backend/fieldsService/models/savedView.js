const mongoose = require('mongoose');

// WP-043 -- SavedView entity.
//
// HOME DECISION (recorded here, see also EXECUTION_LOG.md's WP-043 report):
// SavedView lives in fieldsService, not a new microservice and not
// "the Catalog group" as its own thing. Reasoning:
//   1. The WP brief itself offers exactly two options: "fieldsService or
//      the Catalog group". ENTERPRISE_TRANSFORMATION_STRATEGY.md (line
//      ~829) and AGENT_EXECUTION_PLAN.md (line ~776) both define "Catalog"
//      as a FUTURE strangler-fig consolidation target (moduleService +
//      folderService + fieldsService merged into one service) that has not
//      happened yet -- there is no live "Catalog" service to home anything
//      in today. Grepping the whole repo for "Catalog" turns up only that
//      still-pending plan, never a running service.
//   2. fieldsService already exists, is already one of the three services
//      the future Catalog group would merge, and its existing job --
//      per-project, per-entity-type CONFIGURATION metadata (custom field
//      definitions) -- is conceptually the same shape of data as a saved
//      view (per-project, per-entity-type, user-authored configuration
//      that shapes how an entity's list is displayed/filtered). Homing
//      SavedView here avoids standing up an 18th service, Dockerfile, Kong
//      service entry, and compose block for what is, functionally, one more
//      config collection next to `fields`.
//   3. This mirrors WP-024's own audit-log home decision (reuse an
//      existing, conceptually-adjacent service instead of adding a new
//      one for a small, cross-cutting collection) -- see audit.js's header
//      comment for the precedent this follows.
//
// ID STRATEGY (WP-043 ground-rule, explicit): plain Mongo `_id`
// (ObjectId), NOT a numeric field assigned by read-then-write. Both
// fieldsService's own existing Field model (models/field.js) and several
// other legacy models in this repo (TestRepo, defects) use exactly the
// `findOne({}, {id:1}).sort({id:-1})` then `+1` pattern that WP-020c
// diagnosed as a real concurrency race (two concurrent creates read the
// same max, the second dies on a duplicate-key 400 against a `unique`
// index -- see EXECUTION_LOG.md's WP-020c report). SavedView deliberately
// does NOT copy that pattern: it has no numeric `id` field at all. Every
// reference to a saved view (read/update/delete/URL) uses its Mongo
// `_id`, which Mongo itself generates atomically with no read-before-write
// step and no duplicate-key race under concurrent creates.
const SavedViewSchema = new mongoose.Schema(
  {
    projectId: {
      type: Number,
      required: [true, 'projectId is required'],
      index: true
    },
    // Which entity's list this view applies to. Kept to the four the
    // WP-043 brief's seeded defaults actually name -- not an open string,
    // so a typo in a future caller can't silently create an unreachable
    // view.
    entityType: {
      type: String,
      enum: ['testcase', 'defect', 'requirement', 'testexecution'],
      required: [true, 'entityType is required']
    },
    // Keycloak `sub` of the owning user. null/undefined for a system
    // (seeded default) view -- shared read-only across every member of the
    // project, never owned by one person. Regular views are always
    // strictly personal: "per user, per project, per entity type" per the
    // WP brief, verbatim -- there is no "team view" concept here beyond
    // the four seeded system defaults.
    ownerId: {
      type: String,
      default: null
    },
    isSystem: {
      type: Boolean,
      default: false
    },
    name: {
      type: String,
      required: [true, 'name is required'],
      trim: true
    },
    // MUI X DataGrid's own filter-model shape ({items:[{field,operator,
    // value}], quickFilterValues}), stored verbatim so the view switcher
    // can rehydrate the grid's UI state exactly as the user left it.
    // Deliberately Mixed/untyped -- this schema does not need to
    // understand DataGrid's internal shape, only round-trip it.
    filterModel: { type: mongoose.Schema.Types.Mixed, default: {} },
    // MUI X DataGrid's GridSortModel ([{field, sort}]), same
    // round-trip-only treatment as filterModel.
    sortModel: { type: mongoose.Schema.Types.Mixed, default: [] },
    columnVisibilityModel: { type: mongoose.Schema.Types.Mixed, default: {} },
    // The FLAT query-string params actually sent to the entity's own
    // advancedResults()-backed list endpoint to reproduce this view's
    // result set server-side (server-side pagination/sort/filter, per the
    // WP brief). Kept separate from filterModel/sortModel above because
    // DataGrid's own filter-model shape does not map 1:1 onto
    // advancedResults' flat query-param + operator-keyword contract
    // (backend/shared/service-core/middleware/advancedResults.js) --
    // storing the already-resolved query params here means the frontend
    // never has to re-derive that mapping at read time, and a saved view
    // can never drift from what it actually filtered on when it was saved.
    queryParams: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdBy: { type: String },
    updatedBy: { type: String }
  },
  { timestamps: true }
);

// One name per (project, entityType, owner) -- prevents a user from
// silently creating two views called "My review queue" for the same list,
// and (since ownerId is null for system views) prevents seeding the same
// named default twice for one project+entityType. Mongo's unique index
// treats every `ownerId: null` document as sharing the same index key
// (unlike a sparse/partial index), which is exactly the behavior wanted
// here: system views ARE meant to collide on (projectId, entityType, null,
// name) so the upsert-based seeding in controllers/savedView.js can use
// this same key to seed exactly once, idempotently, with no read-then-
// write race (see that file's ensureDefaultViews()).
SavedViewSchema.index({ projectId: 1, entityType: 1, ownerId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('SavedView', SavedViewSchema);
