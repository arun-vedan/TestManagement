const mongoose = require('mongoose');
const { executionConnection } = require('../config/db');
const { getNextSequence } = require('@srckube/service-core');

// Sprint 2.3 (TB-08): TestCases normalized from [Mixed] — but unlike
// TestRepoService.TestSteps and TestPlan.TestCases (also done this sprint),
// the real data here is genuinely heterogeneous: entries range from the
// minimal shape (TestCaseId/TestCaseSummary/TestStatus/id, before a test
// case's details are fetched from testRepoService) to a fully "enriched"
// shape with 15+ fields once getExecutionTestCaseDetails has run.
//
// TD-23 (this change): `updateTestStep`, `updateAttachment`, and
// getExecutionTestCaseDetails's enrichment (all in
// controllers/testexecution.js) used to write into this array via raw
// MongoDB positional $set updates, which bypassed Mongoose's schema casting
// for nested array elements at this Mongoose version. All 3 are now
// refactored to fetch-modify-save, so every write to TestCases[] goes
// through this schema. `strict: false` was removed (dump-and-diff against
// the live srckube-testexecution.testexecutions collection — 14 documents,
// every TestCases/TestSteps subdocument — on 2026-08-28 found every
// observed key/type already declared below; a mongodump backup was taken
// first, see EXECUTION_LOG.md for the WP-013 report and rollback note).
//
// 'Test Status' (with a space) is a confirmed-dead field — grepped
// repo-wide (including frontend/), never read anywhere. No longer written
// (dropped from the enrichment write in testexecution.js); kept declared
// here, and left untouched on already-enriched documents, purely so old
// stored values keep round-tripping on read instead of being silently
// stripped now that strict:false is gone.
const ExecutionTestStepSchema = new mongoose.Schema(
  {
    testStep: { type: String },
    Expected: { type: String },
    status: { type: String },
  }
);

const ExecutionTestCaseSchema = new mongoose.Schema(
  {
    id: { type: Number },
    TestCaseId: { type: String },
    TestCaseSummary: { type: String },
    TestStatus: { type: String },
    'Test Status': { type: String }, // dead field — see comment above
    TestCaseDescription: { type: String },
    // Reachability fix (final review of WP-F07b, 2026-09-14/15): Mongoose
    // materialises an undeclared-default array path to `[]` on every
    // document it creates, sent or not -- so `createTestExecution`'s stub
    // (which never sends `TestSteps`) always persisted a real, truthy `[]`,
    // and `getExecutionTestCaseDetails`'s enrichment guard
    // (`if (!TestCases[0].TestSteps)`, controllers/testexecution.js) can
    // never fire against `![]` (`false`). Every API-created execution was
    // therefore permanently stuck un-enriched -- verified live, no
    // exceptions. `default: undefined` restores the pre-TB-08 semantics the
    // guard was actually written against (`TestCases` was `[Mixed]` then, so
    // a stub with no `TestSteps` key stored it genuinely absent): a new
    // document with no `TestSteps` in its input now reads back with the key
    // itself absent, not `[]`, so `!TestSteps` is `true` and enrichment
    // fires on first open, exactly once, as designed.
    //
    // This is additive/default-only -- it changes what a NEW document gets
    // when the field is omitted, not how an EXISTING stored value (`[]`,
    // absent, or a populated array) reads back; verified live against all
    // 14 pre-existing documents in srckube-testexecution before and after
    // (see the reachability-fix-report.md this comment's WP references).
    // CI ingest is unaffected: adapters/normalize.js sets `TestSteps`
    // explicitly on every row it builds, so a CI result still keeps its own
    // `[]` (or populated array) and is never re-enriched.
    //
    // Deliberately NOT the alternative, controller-side fix (loosening the
    // guard to `|| TestSteps.length === 0`): the expansion path's
    // `execution.TestCases.push(...rowsToAppend)` has no check for
    // iteration rows that already exist, so a case whose real test case
    // genuinely has zero steps would re-enrich -- and re-push duplicate
    // iteration rows -- on every single open. The model-side default keeps
    // "populated `[]`" and "genuinely absent" distinguishable, which is the
    // only way the once-only guard stays correct.
    TestSteps: { type: [ExecutionTestStepSchema], default: undefined },
    attachment: { type: [mongoose.Schema.Types.Mixed] },
    dynamicFields: { type: mongoose.Schema.Types.Mixed }, // intentionally Mixed: genuinely open-ended custom fields
    parentId: { type: Number },
    createdBy: { type: String },
    updatedBy: { type: String },
    'Executed By': { type: String },
    createdAt: { type: Date },
    updatedAt: { type: Date },
    __v: { type: Number },
    // WP-033 (CI result ingestion): additive, per-test-case fields carried
    // by the normalized ingest payload (durationMs/startedAt/errorMessage/
    // environment) that have no existing home on this subdocument. Declared
    // here (not stuffed into `dynamicFields`) because they have a fixed,
    // known shape/type across every CI adapter (Cucumber, JUnit, and later
    // Playwright) rather than being genuinely open-ended per-vendor data —
    // see controllers/ingest.js's header comment for the full mapping
    // decision, recorded also in EXECUTION_LOG.md's WP-033 entry. Optional
    // and unset on every pre-existing document (same "declared-but-absent
    // reads back as absent" reasoning WP-025 already verified for
    // environmentId).
    durationMs: { type: Number },
    startedAt: { type: Date },
    errorMessage: { type: String },
    // Raw CI environment label (e.g. "staging", "ci-pr-1234") as reported by
    // the CI payload -- deliberately a separate String field from
    // TestExecutionSchema.environmentId (WP-025's Number FK into
    // releaseService's Environment collection): the ingest payload's
    // `environment` is CI-supplied free text with no guarantee it matches a
    // real releaseService Environment.id, so conflating the two would risk
    // either silently miscasting a non-numeric string into environmentId
    // (Mongoose would just fail that cast) or losing the CI-reported label
    // entirely. Named distinctly so both can coexist if a future WP wants to
    // resolve CI environment strings to a real environmentId.
    ciEnvironment: { type: String },
    // WP-F07b Task 1 -- a case within a run is addressed by TestCaseId
    // PLUS iterationIndex now, not TestCaseId alone (see
    // controllers/testexecution.js's matching helpers). Additive and
    // defaulted to 0 (R1: "absent means 0") so every pre-existing
    // single-row document -- which is every document today, live data
    // confirmed zero runs with two rows sharing a TestCaseId -- keeps
    // meaning exactly what it always meant: the one and only row for that
    // case. Never read with `||` or a truthiness check anywhere this repo
    // touches it: iterationIndex 0 is the ordinary, common case, not an
    // absent one, and a falsy check would silently misroute every update
    // for it to nothing.
    iterationIndex: { type: Number, default: 0 },
    // The dataset row (WP-F07a's Dataset.columns/rows) that produced this
    // iteration, kept for display and defect context (R5) -- a Map of
    // column name to that row's string value, mirroring Dataset's own
    // `columns: [String]` / `rows: [[String]]` shape rather than a
    // positional array, so a value survives independent of column order
    // and reads self-descriptively on an execution record long after the
    // originating Dataset may have changed. Left unset for iteration 0 of
    // an unparameterised case (nothing to snapshot); populating it for a
    // parameterised case's rows is Task 2 (enrichment), not this task.
    iterationValues: { type: Map, of: String },
  }
);

const TestExecutionSchema = new mongoose.Schema(
  {
    id: {
      type: Number,
      unique: true,
    },
    // WP-021b: tenant-scoping field -- same rationale/decision as
    // TestPlan.projectId (see ../models/TestPlan.js's comment). Existing
    // documents (14 real executions, Run-1..Run-14) were backfilled to 1
    // (the Default Project) by scripts/backfillProjectId.js; new documents
    // get it stamped server-side from req.projectScope, set by
    // requireProjectScope() -- never trusted from the client body. For a
    // CI-ingested execution (WP-033, POST /ingest, API-key auth), the
    // stamped value is the API key's own bound projectId (req.projectScope
    // is pre-set by requireAuth() in that case -- see controllers/
    // ingest.js), never a client-supplied value in the payload.
    projectId: {
      type: Number,
      required: [true, 'projectId is required'],
      index: true
    },
    TestExecutionId:{
        type:String,
        unique:true,
    },
    TestPlanId:{
      type: mongoose.Schema.Types.ObjectId
    },
    // WP-025: additive. Cross-service reference to releaseService's
    // Environment.id (Number, auto-incrementing — see
    // backend/releaseService/models/Environment.js), same "reference by id
    // only, no FK/populate" convention as Release.linkedTestPlanIds ->
    // TestPlan._id. Optional and unset by default: existing TestExecution
    // documents (14 as of 2026-08-29, dump-checked) have no such field, and
    // Mongoose leaves a declared-but-absent field simply absent on read —
    // verified by reading them back after this change (see
    // EXECUTION_LOG.md's WP-025 report) rather than trusting the schema
    // change alone (GR-1).
    environmentId: {
      type: Number
    },
    assignedTo:{
      type: String
    },
    TestCases:{
      type: [ExecutionTestCaseSchema],
    },
    // Confirmed dead — never read or written anywhere in the codebase (only
    // ever declared here). Left as Mixed deliberately: there's no real data
    // shape to normalize since nothing populates it. Candidate for outright
    // removal in a future cleanup pass, not done here since that's a
    // different kind of change than "add types."
    TestDetails:{
      type: [mongoose.Schema.Types.Mixed],
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId },
    // WP-033 -- CI result ingestion (BG-09/PB-07). Additive, defaulted so
    // every pre-existing document (created via the human-driven
    // createTestExecution path) reads back as 'ui' rather than undefined --
    // deliberately a real default value here (unlike environmentId/
    // durationMs etc above, which are left genuinely optional/unset) because
    // "where did this run come from" is a property every TestExecution
    // document always has an honest answer to, not something that's only
    // sometimes known. See controllers/ingest.js's header comment for the
    // full mapping decision: one ingest call (one Cucumber JSON report or
    // JUnit XML file) creates exactly ONE new TestExecution document with
    // source:'ci' and one TestCases[] entry per scenario/testcase found in
    // that report -- never appended onto a pre-existing human-created run.
    source: { type: String, enum: ['ui', 'ci'], default: 'ui' },
    // The CI build/pipeline URL this run's results came from (e.g. a GitHub Actions
    // job URL). Whole-run metadata, so it lives here rather than repeated on
    // every TestCases[] entry -- contrast with ciEnvironment above, which
    // the WP's normalized payload shape allows to vary per individual
    // result and so is stored per-test-case instead.
    ciRunUrl: { type: String },
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
TestExecutionSchema.pre("save", async function (next) {
  if (!this.isNew) {
    return next();
  }

  try {
    // WP-020c: atomic counter (was a read-then-write race, see
    // backend/shared/service-core/sequence.js for why).
    const nextId = await getNextSequence(this.constructor.db, 'testexecution');

    this.id = nextId;
    this.TestExecutionId="Run-"+nextId
    return next();
  } catch (error) {
    return next(error);
  }
});
module.exports = executionConnection.model("TestExecution", TestExecutionSchema);
