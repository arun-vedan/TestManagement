const mongoose = require("mongoose");
const { getNextSequence, ErrorResponse } = require("@srckube/service-core");

// WP-F07b Task 2 fix round 1 (review, Important) -- `rows` had no upper
// bound at all: enrichment (backend/testPlanExecutionService) expands a
// bound case into one execution row PER dataset row, and fetches each
// row's substituted text with its own sequential HTTP round trip to this
// service (F07a's `?substitute=<i>` only ever resolves one row per call).
// An unbounded dataset therefore means an unbounded number of round trips
// and an unbounded number of subdocuments written into one execution
// document in a single request -- a real availability risk (a slow or
// struggling testRepoService instance turns one large dataset into a
// multi-second, N-round-trip request that never had a ceiling), not just
// a storage one.
//
// 100 was chosen, not derived from a hard technical limit: realistic
// parameterised test data (role/browser/locale/environment matrices) is
// a handful to a few dozen rows in practice, and 100 sequential
// same-network round trips is comfortably sub-second even with
// requestWithRetry's backoff on an occasional retry, while still being
// far below anywhere close to MongoDB's 16MB document size limit for the
// resulting execution subdocuments. Contrast with BULK_MAX_ITEMS (500,
// testrepo.js) -- that caps a list of bare ids with no per-item network
// call, a much cheaper unit of work, so a smaller cap here for a
// per-row-network-call operation is deliberate, not an inconsistency.
//
// Enforced at WRITE time only (create, and any update that touches
// `rows`), same as the ragged-row guard below -- it does not retroactively
// touch any already-stored dataset. None exists over this cap today
// (verified against live data before this change), so there is nothing
// to migrate; if one ever did, GET and enrichment would keep reading and
// expanding every one of its stored rows unaffected -- this cap only
// blocks a FUTURE write from creating or growing a dataset past it, never
// blocks reading or using rows already there.
const MAX_DATASET_ROWS = 100;

// WP-F07a -- a small table of values (columns + rows) that a test case
// binds to so its {{placeholders}} can be run once per row instead of the
// author hand-writing one near-identical case per value. Deliberately its
// own collection rather than a field on TestCaseRepo: a dataset is
// authored and reused independently of any one test case, and needs its
// own usage query the way a test case never does.
const DatasetSchema = new mongoose.Schema(
  {
    id: { type: Number, unique: true },
    DatasetId: { type: String, unique: true },
    // Same tenant-scoping contract as TestRepoSchema.projectId: stamped
    // server-side from req.projectScope, never trusted from the body.
    projectId: {
      type: Number,
      required: [true, 'projectId is required'],
      index: true,
    },
    title: {
      type: String,
      required: [true, 'Please add a title'],
      trim: true,
    },
    description: { type: String },
    columns: { type: [String], default: [] },
    // Every row must have exactly as many values as there are columns -- an
    // unchecked ragged row would shift values into the wrong placeholder on
    // substitution (Task 3) with no error, so this is caught here rather
    // than left for the substitution code to notice.
    //
    // This validator only does real work on create()/save(), where `this`
    // is the Dataset document itself, so `this.columns` is simply the
    // sibling field. Fix round 1 (review Critical): confirmed live
    // (mongoose 5.13.23, by instrumenting the model) that on
    // findOneAndUpdate with runValidators:true, mongoose calls this
    // validator with a null/undefined scope for this nested-array path,
    // which a non-strict function call substitutes with the Node global
    // object -- NOT a Dataset document, and with no sibling `columns`
    // field at all. Before this fix, that made `this.columns` silently
    // resolve to undefined -> columnCount 0 -> reject every non-empty row
    // on ANY update that touched `rows`, valid or not, while a
    // columns-only update (which never touches this `rows` path at all)
    // triggered no check here whatsoever. The `this instanceof
    // mongoose.Document` guard below routes every update-time call
    // straight to `true`, deferring entirely to
    // DatasetSchema.pre('findOneAndUpdate'), which has the actual merged
    // update payload to check.
    rows: {
      type: [[String]],
      default: [],
      validate: [
        {
          validator: function (rows) {
            if (!(this instanceof mongoose.Document)) return true;
            const columnCount = this.columns ? this.columns.length : 0;
            return rows.every((row) => row.length === columnCount);
          },
          message: 'Every row must have exactly as many values as there are columns',
        },
        {
          // Same `this instanceof mongoose.Document` update-time bypass as
          // the ragged-row validator above (and the same reason -- see its
          // comment): the merged-update case is caught in
          // DatasetSchema.pre('findOneAndUpdate') below instead, which has
          // the actual merged row count to check.
          validator: function (rows) {
            if (!(this instanceof mongoose.Document)) return true;
            return rows.length <= MAX_DATASET_ROWS;
          },
          message: `A dataset cannot have more than ${MAX_DATASET_ROWS} rows`,
        },
      ],
    },
    createdBy: { type: String },
    updatedBy: { type: String },
  },
  { timestamps: true }
);

// Mirrors TestRepoSchema.pre("save") in models/testrepo.js: atomic counter,
// guarded on isNew so an update never re-stamps the id.
DatasetSchema.pre("save", async function (next) {
  if (!this.isNew) return next();
  try {
    const nextId = await getNextSequence(this.constructor.db, 'dataset');
    this.id = nextId;
    this.DatasetId = "DS-" + nextId;
    return next();
  } catch (error) {
    return next(error);
  }
});

// The `rows` validator above only does real work on create/save (see its
// comment for why it can't on update). So a PUT can produce a ragged
// dataset three ways -- rows-only (new rows disagree with the STORED
// columns), columns-only (shrinking or growing columns leaves the STORED
// rows mismatched), or both (disagree with each other) -- and this hook
// is the single place that actually catches all three on the write path:
// it loads whatever is currently stored, overlays whatever the update
// itself supplies, and rejects if that MERGED result would be ragged.
// Mirrors the shape of TestRepoSchema.pre("findOneAndUpdate") in
// models/testrepo.js (also loads the pre-update document via
// this.model.findOne(this.getQuery())), but rejects instead of snapshotting.
//
// Field lookup note (fix round 1, found by instrumenting a live run): at
// the point THIS hook runs, this.getUpdate() still has the caller's own
// fields at the TOP LEVEL, not inside `$set` -- mongoose's `timestamps:
// true` plugin registers its own earlier findOneAndUpdate hook that adds
// a `$set` wrapper containing only `updatedAt` (and `$setOnInsert` for
// `createdAt`), but the caller's plain-object fields (this codebase's
// only update style: findOneAndUpdate(filter, reqdetails, opts), never a
// raw $set) are not folded into `$set` until the query's own cast step,
// which runs AFTER every pre hook including this one. So `columns`/`rows`
// must be looked up at the top level of the update AND inside `$set`
// (the latter kept only in case a future caller passes one explicitly);
// checking only one of the two silently missed the caller's real values.
DatasetSchema.pre('findOneAndUpdate', async function (next) {
  try {
    const update = this.getUpdate() || {};
    const setOps = update.$set || {};
    const hasField = (obj, name) => Object.prototype.hasOwnProperty.call(obj, name);
    const readField = (name) => (hasField(update, name) ? update[name] : setOps[name]);
    const touchesColumns = hasField(update, 'columns') || hasField(setOps, 'columns');
    const touchesRows = hasField(update, 'rows') || hasField(setOps, 'rows');
    if (!touchesColumns && !touchesRows) return next();

    const existing = await this.model.findOne(this.getQuery(), 'columns rows').lean();
    // No document matches this update's filter -- findOneAndUpdate will
    // simply resolve to null and the controller reports its own 404;
    // nothing to validate here.
    if (!existing) return next();

    const columns = touchesColumns ? readField('columns') : existing.columns;
    const rows = touchesRows ? readField('rows') : existing.rows;
    // Deliberate: an empty columns list ([] or unset) means every row
    // must also be empty ([]) -- there is no "columns don't matter yet"
    // state once rows exist, so this falls out of the same length check
    // rather than needing a special case.
    const columnCount = columns ? columns.length : 0;
    const ragged = (rows || []).some((row) => row.length !== columnCount);
    if (ragged) {
      return next(new ErrorResponse('Every row must have exactly as many values as there are columns', 400));
    }
    // WP-F07b Task 2 fix round 1 -- same MAX_DATASET_ROWS cap as the
    // create/save validator above, checked here too since (per this
    // hook's own header comment) the create-time validator's `this
    // instanceof mongoose.Document` guard skips every update-time call.
    if ((rows || []).length > MAX_DATASET_ROWS) {
      return next(new ErrorResponse(`A dataset cannot have more than ${MAX_DATASET_ROWS} rows`, 400));
    }
    return next();
  } catch (error) {
    return next(error);
  }
});

module.exports = mongoose.model("Dataset", DatasetSchema);
