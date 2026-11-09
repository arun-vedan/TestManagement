const mongoose = require("mongoose");
const { getNextSequence } = require("@srckube/service-core");

// WP-F08 Task 1 -- a named, stored draft prefill. R1: a template holds the
// same flattened shape the frontend's useCloneEntity builds from a live
// record; creating from a template replays that exact draft-open path with
// a stored prefill instead of a live one. It is NOT a new entity type and
// it is NOT the project-scaffold "Template" in
// frontend/src/model/TemplateModel.tsx (git-URL project scaffolds, used by
// the create-project wizard) -- that is a separate, unrelated concept that
// happens to share an English word. This collection is always CaseTemplate.
//
// R4: capturing a template never updates it -- it is a snapshot taken once
// at save time, not a live reference back to the record it came from (that
// is what WP-F06's SharedStep already is, for the one field -- steps --
// that actually wants live propagation). So unlike SharedStep/Dataset in
// this same service, CaseTemplate deliberately has NO usage query and NO
// delete guard (R5): nothing ever references a template after it is
// created, because creating FROM a template copies its prefill once and
// then that new record is independent. There is nothing a delete could
// leave dangling. Do not add a usage/delete-guard pair here to "match" the
// sibling collections -- that would be solving a problem this collection
// does not have.
const CaseTemplateSchema = new mongoose.Schema(
  {
    id: { type: Number, unique: true },
    CaseTemplateId: { type: String, unique: true },
    // Same tenant-scoping contract as TestRepoSchema.projectId /
    // SharedStepSchema.projectId: stamped server-side from
    // req.projectScope, never trusted from the body.
    projectId: {
      type: Number,
      required: [true, 'projectId is required'],
      index: true,
    },
    // Which module's draft flow this template prefills. Restricted to the
    // draft-capable modules (frontend/src/workbench/modules.ts,
    // DRAFT_CAPABLE_MODULES): 1 test cases, 2 requirements, 3 test plans,
    // 5 defects. Module 4 (runs) has no draft/create flow to start one
    // from, and module 6 (releases) is created from its own page, not the
    // workbench draft flow this feature reuses.
    // Number's enum validator, unlike String's, does NOT support the
    // { values, message } object form -- SchemaNumber.prototype.enum only
    // special-cases a plain array or bare varargs (mongoose 5.13.23,
    // lib/schema/number.js); passed an object it does
    // utils.object.vals(values), which here would silently become
    // [[1,2,3,5], 'the message string'] as the actual allowed set. Found
    // by a real validation-error round trip against this exact container,
    // not by reading the docs example. Plain array only; default message
    // ("`N` is not a valid enum value for path `moduleId`") is acceptable.
    moduleId: {
      type: Number,
      required: [true, 'moduleId is required'],
      enum: [1, 2, 3, 5],
    },
    name: {
      type: String,
      required: [true, 'Please add a name'],
      trim: true,
    },
    description: { type: String },
    // Deliberately Mixed, not a fixed sub-schema: this holds whatever
    // shape the frontend's clone-flatten produces for the given module,
    // and that shape differs across the five detail components it can be
    // opened from. Constraining it to a strict schema would couple this
    // one collection to all of their field lists, and -- per WP-F06's
    // sharedStepTitle loss through five reviewed tasks -- a strict schema
    // that's even slightly out of sync with the frontend silently drops
    // whatever field it wasn't told about. Mongoose passes Mixed through
    // verbatim on both create and update; that round trip is asserted in
    // __tests__/caseTemplate.test.js rather than assumed.
    prefill: { type: mongoose.Schema.Types.Mixed },
    createdBy: { type: String },
    updatedBy: { type: String },
  },
  { timestamps: true }
);

// Mirrors TestRepoSchema.pre("save") in models/testrepo.js and
// SharedStepSchema.pre("save"): atomic counter, guarded on isNew so an
// update never re-stamps the id.
CaseTemplateSchema.pre("save", async function (next) {
  if (!this.isNew) return next();
  try {
    const nextId = await getNextSequence(this.constructor.db, 'casetemplate');
    this.id = nextId;
    this.CaseTemplateId = "CT-" + nextId;
    return next();
  } catch (error) {
    return next(error);
  }
});

module.exports = mongoose.model("CaseTemplate", CaseTemplateSchema);
