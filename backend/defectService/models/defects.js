const mongoose = require("mongoose");
const { getNextSequence } = require("@srckube/service-core");

const defectsSchema = new mongoose.Schema(
  {
    id: {
      type: Number,
      unique: true,
    },
    // WP-021: tenant-scoping field. defectService had zero projectId
    // concept before this WP (verified: zero documents/fields/routes
    // referenced it) -- see backend/testRepoService/models/testrepo.js for
    // the full rationale, identical here. Existing documents backfilled to
    // 1 by scripts/backfillProjectId.js (before/after counts + backup path
    // in EXECUTION_LOG.md).
    projectId: {
      type: Number,
      required: [true, 'projectId is required'],
      index: true
    },
    defectId:{
        type:String,
        unique:true,
    },
    summary:{
      type:String
    },
    Priority:{
      type: String
    },
    Severity:{
      type:String
    },
    description:{
      type:String
    },
    Status:{
      type:String
    },
    assignedTo:{
      type: String
    },
    attachment:{
      type: [mongoose.Schema.Types.Mixed],
    },
    // WP-010 (2.4.3): lightweight, append-only transition log — NOT a full
    // document-snapshot version history like TestCaseVersion/
    // RequirementVersion (Sprint 2.1). Those exist as separate collections
    // because they snapshot an entire content document on every edit, for
    // entities where reverting/comparing full content matters. A defect
    // status change only ever moves one field through a small, well-defined
    // graph (istatusservice's parentId graph, 8 states) — the useful
    // history is "who moved it from A to B and when", which fits as a
    // small embedded array on the defect itself, no new collection or
    // routes needed. Populated only by PUT /api/v1/defects/:id/status
    // (backend/defectService/controllers/defects.js), never by the
    // generic PUT /:id, so free-text edits to Status via the old route
    // don't pollute it.
    statusHistory: {
      type: [
        {
          from: { type: String },
          to: { type: String, required: true },
          changedBy: { type: String },
          changedAt: { type: Date, default: Date.now },
          correlationId: { type: String }
        }
      ],
      default: []
    },
    createdBy: {
      type: String,
    },
    dynamicFields: {
      type: mongoose.Schema.Types.Mixed,
    },
    updatedBy: { type: String },
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
defectsSchema.pre(['findOneAndUpdate', 'findByIdAndUpdate', 'updateOne'], function(next) {
  this.update({}, { $inc: { __v: 1 } }); // Automatically increment the __v field
  next();
});
defectsSchema.pre("save", async function (next) {
  if (!this.isNew) {
    // If not a new document, move to the next middleware
    return next();
  }

  try {
    // Find the highest existing id and increment by 1
    // WP-020c: atomic counter (was a read-then-write race, see
    // backend/shared/service-core/sequence.js for why).
    const nextId = await getNextSequence(this.constructor.db, 'defect');

    this.id = nextId;
    this.defectId="Bug-"+nextId
    return next();
  } catch (error) {
    return next(error);
  }
});


module.exports = mongoose.model("defects", defectsSchema);
