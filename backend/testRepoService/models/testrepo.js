const mongoose = require("mongoose");
const TestCaseVersion = require("./TestCaseVersion");
const { getNextSequence } = require("@srckube/service-core");

// Sprint 2.3 (TB-08): fixed the `typeof: String` typo (Phase 1 §8 finding) —
// Mongoose silently ignored that key entirely, so these fields had zero
// schema enforcement despite looking typed. Verified against the real data
// (TC-1/2/3) before this change: every existing TestSteps entry already
// matches exactly this shape (testStep, Expected strings, no extra keys), so
// this is a type-safety fix with no reshaping needed.
const TestStepSchema = new mongoose.Schema(
  {
    testStep:{
      type: String
    },
    Expected:{
      type: String
    },

    // WP-F06 -- when set, this row is a REFERENCE to a SharedStep, not a
    // step in its own right, and testStep/Expected are ignored. Added in
    // Task 1 rather than Task 2 because Task 1's usage query and delete
    // guard both read this path, and a strict schema would silently strip
    // it from their fixtures.
    sharedStepId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SharedStep',
    },

    // WP-F06 Task 6 -- found by the end-to-end journey, not by any of
    // Tasks 1-5's own tests: this schema is strict (Mongoose's default),
    // and this field was missing, so `sharedStepTitle` -- the label
    // TableRows.tsx's `row.sharedStepId` branch renders next to the
    // "Shared" chip (that file's own header comment says a reference row
    // "carries only these two fields meaningfully", i.e. this one and
    // sharedStepId) -- was silently stripped on every save. The picker's
    // freshly-inserted row showed the title fine (it was still only in
    // React state); the FIRST save-and-reload wiped it, leaving a Shared
    // chip with no title. jsdom coverage never caught this because it
    // mocks the API and never sends a row through this real schema.
    sharedStepTitle: {
      type: String,
    },
  }
)

const TestRepoSchema = new mongoose.Schema(
  {
    id: {
      type: Number,
      unique: true,
    },
    // WP-021: tenant-scoping field. testRepoService had zero projectId
    // concept before this WP (verified: zero documents/fields/routes
    // referenced it) -- this is a NEW field, not preservation of an
    // existing one. Existing documents were backfilled to 1 (the Default
    // Project's legacy-compatible numeric id, same value every real
    // projectId-bearing document elsewhere in this deployment already
    // holds) by scripts/backfillProjectId.js; see EXECUTION_LOG.md for the
    // before/after counts and backup path. New documents get it stamped
    // server-side by createTestCase from req.projectScope, set by
    // requireProjectScope() -- never trusted from the client body.
    projectId: {
      type: Number,
      required: [true, 'projectId is required'],
      index: true
    },
    TestCaseId:{
        type:String,
        unique:true,
    },
    parentId:{
        type:Number,
        default:0
    },
    TestCaseSummary: {
      type: String,
      required: [true, "Please add a Field name"],
    },
    TestCaseDescription: {
      type: String,
      required: [true, "Please add a Display name"],
    },
    // Sprint 2.3 (TB-08): normalized from [Mixed] to a typed sub-document
    // array. Confirmed against real data first: TestSteps is written only
    // through normal create()/findByIdAndUpdate() in this service's own
    // controller (not a raw positional $set), so this is actually enforced,
    // not just documentation.
    TestSteps:{
      type: [TestStepSchema],
    },
    dynamicFields: {
      type: mongoose.Schema.Types.Mixed,
    },
    // Sprint 2.1 (PB-04): lifecycle + version. Corrected 2026-08-24: the
    // default was originally 'approved', on the reasoning that pre-existing
    // test cases should read back as already-approved rather than reverting
    // to draft — true, but a schema default can't distinguish "old document
    // missing this field" from "brand-new test case just created", so it
    // also silently pre-approved every NEW test case, which is wrong (new
    // work should start as draft). Fixed by defaulting new documents to
    // 'draft' and explicitly backfilling pre-existing ones to 'approved'
    // instead (see scripts/backfill-approved-status.js) — the backfill
    // writes the value, so it no longer depends on which state this default
    // is in.
    status: {
      type: String,
      enum: ['draft', 'review', 'approved', 'deprecated', 'archived'],
      default: 'draft',
    },
    version: {
      type: Number,
      default: 1,
    },
    // WP-043 -- new, additive field (GR-7). Keycloak `sub` of the test
    // case's assignee. No default: existing test cases (and any created
    // through the plain POST/PUT routes without this field) simply have it
    // unset, which is exactly what the "Unassigned" saved-view concept
    // means for this entity. Set via the plain PUT /:id route (generic
    // field, same as any other) or in bulk via PATCH /api/v1/testrepo/bulk
    // (controllers/testrepo.js#bulkUpdateTestCases).
    assignedTo: {
      type: String,
    },
    createdBy: {
      type: String,
    },
    updatedBy: { type: String },
    // WP-051 -- AI-generated marker. Additive, GR-7-style field (same shape
    // as WP-043's assignedTo): existing test cases simply have it unset.
    // Set ONLY by the accept-flow create call (POST /api/v1/testrepo with
    // generatedBy:'ai' in the body) -- this schema field is what lets that
    // marker actually persist; without declaring it here Mongoose's default
    // strict mode would silently drop it. Not an enum -- 'ai' is the only
    // value written today, but a free string leaves room for a future
    // generator label (e.g. a specific model/version) without a schema
    // change.
    //
    // BADGE RULE (see controllers/testrepo.js#updateTestCase): the
    // AI-generated badge is shown in the UI while this field is truthy, and
    // is cleared the first time a human PUT-updates any CONTENT field
    // (TestCaseSummary, TestCaseDescription, TestSteps) via the normal
    // update endpoint -- metadata-only edits (assignedTo, status via the
    // separate /status route, updatedBy) leave it untouched.
    generatedBy: { type: String },
    // WP-F05 -- free-form tags. Additive and defaulted, so every existing
    // document reads back unchanged with an empty array; no migration was
    // needed or written.
    //
    // Indexed because the whole point is filtering: advancedResults copies
    // ?tags=<value> straight into the Mongo filter, and a scalar matches
    // any element of an array natively, so the query path needed no code
    // at all -- only this field and this index.
    //
    // Normalised in a setter rather than in each controller so EVERY write
    // path gets it: create, update, bulk, CSV import and anything added
    // later. Lowercased and trimmed so 'Regression', 'regression' and
    // ' regression ' are one tag; de-duplicated; a tag containing
    // whitespace is rejected by the validator below rather than silently
    // rewritten, so the rule is learnable. Verified live (Mongoose
    // 5.13.23) that the setter runs before the validator on BOTH create()
    // and findOneAndUpdate(..., {runValidators:true}) -- every write path
    // in this codebase uses one of those two, never a raw positional
    // update -- so 'not one token' is normalised to itself (already clean
    // tokens, still whitespace) and then correctly fails validation.
    //
    // Fix round 1 (WP-F05a review) -- two bugs the initial setter shipped
    // with, both verified live before fixing rather than assumed:
    //
    // 1) A bare scalar (e.g. tags: "REGRESSION", a JSON string rather than
    //    an array) used to hit `if (!Array.isArray(values)) return values;`
    //    and skip cleaning entirely. Mongoose's SchemaArray then auto-wraps
    //    the RAW value into ["REGRESSION"] after this setter runs
    //    (castNonArrays: true), which passed the whitespace validator and
    //    stored uppercase -- silently breaking the lowercased/trimmed
    //    guarantee. Fixed by wrapping any non-null, non-array value into a
    //    one-element array before cleaning, so a lone scalar is normalised
    //    exactly as if it had arrived as a one-element array.
    //
    // 2) tags: null used to reach the validator unchanged (Array.isArray
    //    (null) is false, same as a malformed array) and fail with "A tag
    //    cannot contain whitespace" -- accurate for a bad array, nonsense
    //    for a client trying to clear tags. Verified live which of the two
    //    fixable outcomes (store [] cleanly, or an accurate 400) Mongoose's
    //    actual behaviour supports: on create()/save(), this setter DOES
    //    run for a null value, so null could be mapped to [] there -- but
    //    on findOneAndUpdate(..., {runValidators:true}), the ONLY update
    //    path used anywhere in this codebase, Mongoose never invokes this
    //    setter for a null value at all (confirmed by instrumenting the
    //    setter and observing zero calls); the raw null reaches the
    //    validator regardless of what the setter does. Silently turning
    //    null into [] on create but 400ing on update would be an
    //    inconsistent, surprising split for what is nominally the same
    //    "clear the tags" input, so both paths now reject null identically
    //    with a distinct, accurate message telling the caller to send []
    //    instead -- the "accurate 400" outcome, not a contortion to make
    //    null store as [] on only one of the two paths.
    // WP-F07a -- the dataset whose rows supply values for this case's
    // {{placeholders}}. Added in Task 1 rather than Task 2 because Task 1's
    // usage query and delete guard both read this path, and a strict schema
    // would silently strip it from their fixtures.
    datasetId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Dataset',
    },
    tags: {
      type: [String],
      default: [],
      index: true,
      set: (values) => {
        // Fix 2: null/undefined pass through unchanged rather than being
        // coerced here -- see the comment above for why (the setter isn't
        // even invoked for null on the findOneAndUpdate path, so handling
        // it here would only ever fire on create(), producing an
        // inconsistent result across write paths). The validator below
        // gives it an accurate, dedicated message instead.
        if (values === null || values === undefined) return values;
        // Fix 1: a bare scalar is normalised as if it were a one-element
        // array, instead of bypassing cleaning and later being silently
        // auto-wrapped uppercase/untrimmed by Mongoose's own array cast.
        const arr = Array.isArray(values) ? values : [values];
        const cleaned = arr
          .filter((v) => typeof v === 'string')
          .map((v) => v.trim().toLowerCase())
          .filter((v) => v.length > 0);
        return [...new Set(cleaned)];
      },
      validate: {
        validator: (values) => Array.isArray(values) && values.every((v) => !/\s/.test(v)),
        message: (props) => (props.value === null
          ? 'tags cannot be set to null -- send an empty array to clear tags, or omit the field to leave them unchanged'
          : 'A tag cannot contain whitespace -- use one token per tag (e.g. "smoke-test", not "smoke test")')
      }
    },
  },
  {
    timestamps: true,
  }
);
TestRepoSchema.pre("save", async function (next) {
  if (!this.isNew) {
    // If not a new document, move to the next middleware
    return next();
  }

  try {
    // WP-020c: atomic counter (was a read-then-write race, see
    // backend/shared/service-core/sequence.js for why).
    const nextId = await getNextSequence(this.constructor.db, 'testcase');

    this.id = nextId;
    this.TestCaseId="TC-"+nextId
    return next();
  } catch (error) {
    return next(error);
  }
});

// Sprint 2.1 (PB-04): snapshot the pre-update state before every update, and
// bump `version`. findByIdAndUpdate/findOneAndUpdate both trigger this same
// Mongoose middleware, so both existing update paths (updateTestCase,
// updateTestCaseByParam) are covered by this one hook.
TestRepoSchema.pre("findOneAndUpdate", async function (next) {
  try {
    const docToUpdate = await this.model.findOne(this.getQuery());
    if (docToUpdate) {
      await TestCaseVersion.create({
        TestCaseId: docToUpdate.TestCaseId,
        version: docToUpdate.version || 1,
        snapshot: docToUpdate.toObject(),
      });
      this.set({ version: (docToUpdate.version || 1) + 1 });
    }
    return next();
  } catch (error) {
    return next(error);
  }
});

mongoose.model("TestStep", TestStepSchema);
module.exports = mongoose.model("TestCaseRepo", TestRepoSchema);
