const mongoose = require("mongoose");
const RequirementVersion = require("./RequirementVersion");
const { getNextSequence } = require("@srckube/service-core");

const RequirementSchema = new mongoose.Schema(
  {
    id: {
      type: Number,
      unique: true,
    },
    // WP-021: tenant-scoping field. requirementService had zero projectId
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
    reqId:{
        type:String,
        unique:true,
    },
    parentId:{
        type:Number,
        default:0
    },
    requirementSummary: {
      type: String,
      required: [true, "Please add a Field name"],
    },
    requirementDescription: {
      type: String,
      required: [true, "Please add a Display name"],
    },
    dynamicFields: {
      type: mongoose.Schema.Types.Mixed,
    },
    // Sprint 2.1 (PB-04): lifecycle + version. Corrected 2026-08-24 — see the
    // matching comment in testRepoService/models/testrepo.js for the full
    // reasoning: a schema default can't distinguish "pre-existing document"
    // from "brand-new one just created", so defaulting to 'approved' here
    // silently pre-approved every new requirement too. New requirements now
    // default to 'draft'; existing ones were explicitly backfilled to
    // 'approved' instead (scripts/backfill-approved-status.js).
    status: {
      type: String,
      enum: ['draft', 'review', 'approved', 'deprecated', 'archived'],
      default: 'draft',
    },
    version: {
      type: Number,
      default: 1,
    },
    createdBy: {
      type: String,
    },
    attachment:{
      type: [mongoose.Schema.Types.Mixed],
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
RequirementSchema.pre(['findOneAndUpdate', 'findByIdAndUpdate', 'updateOne'], function(next) {
  this.update({}, { $inc: { __v: 1 } }); // Automatically increment the __v field
  next();
});

// Sprint 2.1 (PB-04): snapshot the pre-update state before every update, and
// bump `version` (distinct from Mongoose's own internal `__v` incremented
// above — that's optimistic-concurrency bookkeeping, this is the governed
// lifecycle version). findByIdAndUpdate/findOneAndUpdate both trigger this
// same Mongoose middleware, so both existing update paths are covered.
RequirementSchema.pre("findOneAndUpdate", async function (next) {
  try {
    const docToUpdate = await this.model.findOne(this.getQuery());
    if (docToUpdate) {
      await RequirementVersion.create({
        reqId: docToUpdate.reqId,
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

RequirementSchema.pre("save", async function (next) {
  if (!this.isNew) {
    // If not a new document, move to the next middleware
    return next();
  }

  try {
    // Find the highest existing id and increment by 1
    // WP-020c: atomic counter (was a read-then-write race, see
    // backend/shared/service-core/sequence.js for why).
    const nextId = await getNextSequence(this.constructor.db, 'requirement');

    this.id = nextId;
    this.reqId="Req-"+nextId
    return next();
  } catch (error) {
    return next(error);
  }
});


module.exports = mongoose.model("Requirement", RequirementSchema);
