const mongoose = require('mongoose');
const { planConnection } = require('../config/db');
const { getNextSequence } = require('@srckube/service-core');

// Sprint 2.3 (TB-08): normalized from [Mixed]. Confirmed against all 7 real
// TestPlan documents first — every TestCases entry consistently has exactly
// these 4 fields, no variation — and confirmed the write path is only ever
// create()/findByIdAndUpdate() in this service's own controller (never a raw
// positional $set), so this is genuinely enforced going forward, not just
// documentation. Contrast with TestExecution.TestCases (see that model file)
// which has 3 raw $set write paths and much more heterogeneous real data —
// deliberately not normalized in this same pass.
const TestPlanTestCaseSchema = new mongoose.Schema(
  {
    id: { type: Number },
    TestCaseId: { type: String },
    TestCaseSummary: { type: String },
    TestStatus: { type: String },
  },
  { _id: false }
);

const TestPlanSchema = new mongoose.Schema(
  {
    id: {
      type: Number,
      unique: true,
    },
    // WP-021b: tenant-scoping field, closing the gap WP-021 explicitly
    // deferred ("the rest in later work" -- see controllers/testplan.js's
    // now-stale WP-024 comment). testPlanExecutionService had ZERO
    // projectId concept before this WP (verified: zero documents/fields/
    // routes referenced it on either TestPlan or TestExecution) -- this is
    // a NEW field, matching exactly how testRepoService/requirementService/
    // defectService declare theirs (see e.g. testRepoService/models/
    // testrepo.js). Existing documents (7 real plans, PLN-1..PLN-7, plus 6
    // stray same-millisecond test fixtures PLN-8..PLN-13 from a prior test
    // run that were deleted as cleanup, not backfilled) were backfilled to
    // 1 (the Default Project's legacy-compatible numeric id) by
    // scripts/backfillProjectId.js; see EXECUTION_LOG.md for the
    // before/after counts and backup path. New documents get it stamped
    // server-side by createTestPlan from req.projectScope, set by
    // requireProjectScope() -- never trusted from the client body.
    projectId: {
      type: Number,
      required: [true, 'projectId is required'],
      index: true
    },
    TestPlanId:{
        type:String,
        unique:true,
    },
    parentId:{
        type:Number,
        default:0
    },
    TestCases:{
      type: [TestPlanTestCaseSchema],
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId },

    // WP-014 (Sprint: Test Planning, strategy §16): additive TestPlan
    // enrichment fields. All optional, no defaults set beyond mongoose's
    // usual "field absent until written" behavior -- existing plans (PLN-1
    // through PLN-6 as of 2026-08-28, dump-checked, none carry any of these
    // keys or any risk-like value) are unaffected because nothing writes to
    // them until a caller explicitly sets one.
    objective: { type: String },
    scope: { type: String },
    entryCriteria: { type: String },
    exitCriteria: { type: String },
    // Enum, not free text: dump-checked all 6 existing TestPlan documents on
    // 2026-08-28 (srckube-testplan.testplans) -- none carry a `risk` field or
    // any risk-like value at all, so an enum introduces no rejection risk
    // for existing data. A closed set of 3 levels is also what the frontend
    // dropdown needs, and is easy to widen (edit the enum array) if a future
    // WP needs more granularity.
    risk: { type: String, enum: ['Low', 'Medium', 'High'] },
    // Date, not ISO string: the frontend uses plain HTML `<input type="date">`
    // controls (date-only, no time-of-day), and a date-only ISO-8601 string
    // (e.g. "2026-09-01") is parsed by both the JS Date constructor and
    // Mongoose's date cast as UTC midnight regardless of server/client
    // timezone, so round-tripping through JSON as a full ISO datetime string
    // and re-reading just the YYYY-MM-DD portion is lossless. Verified in the
    // WP-014 test suite (schedule round-trip test).
    schedule: {
      plannedStart: { type: Date },
      plannedEnd: { type: Date },
    },
    // Free-text, from WP-014. Left in place, untouched, for backward
    // compatibility (GR-7: additive migrations only) — existing plans that
    // already carry a free-text environment value keep reading it exactly
    // as before.
    environment: { type: String },
    // WP-025: the typed upgrade — a cross-service reference to
    // releaseService's Environment.id (Number, auto-incrementing; see
    // backend/releaseService/models/Environment.js), same "reference by id
    // only" convention as environmentId on TestExecution (see that model's
    // comment) and Release.linkedTestPlanIds -> TestPlan._id. Additive and
    // optional: existing TestPlan documents (7 as of 2026-08-29,
    // dump-checked) have no such field and are unaffected — verified by
    // reading them back after this change rather than trusting the schema
    // change alone (GR-1), see EXECUTION_LOG.md's WP-025 report. New/edited
    // plans should prefer this over the free-text `environment` string
    // going forward; nothing in this WP forces a migration of existing
    // values, so both fields coexist.
    environmentId: { type: Number },
    // WP-F05 -- free-form tags. Same field, setter and validator as
    // testRepoService/models/testrepo.js -- see that file's comment for the
    // full rationale (additive/defaulted, indexed for free filtering via
    // advancedResults, normalised in the setter so every write path gets
    // it, setter-before-validator ordering verified live for both create()
    // and findOneAndUpdate(..., {runValidators:true})). Fix round 1
    // (WP-F05a review) also applied identically here -- see that file's
    // comment for the scalar-normalisation and null-rejection fixes,
    // both verified live against this Mongoose version.
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
TestPlanSchema.pre("save", async function (next) {
  if (!this.isNew) {
    return next();
  }

  try {
    // WP-020c: atomic counter (was a read-then-write race, see
    // backend/shared/service-core/sequence.js for why).
    const nextId = await getNextSequence(this.constructor.db, 'testplan');

    this.id = nextId;
    this.TestPlanId="PLN-"+nextId
    return next();
  } catch (error) {
    return next(error);
  }
});
module.exports = planConnection.model("TestPlan", TestPlanSchema);
