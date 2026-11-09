const mongoose = require("mongoose");
const { getNextSequence } = require("@srckube/service-core");

// WP-F06 -- a step sequence authored once and referenced from many test
// cases. Deliberately NOT a TestCaseRepo with a flag: a shared step has no
// lifecycle status, no version history, no assignee, and is never executed
// or linked to a defect, but it does need a usage query that a test case
// never needs. Sharing the collection would mean every existing test case
// read has to learn to exclude these.
const SharedStepEntrySchema = new mongoose.Schema(
  {
    testStep: { type: String },
    Expected: { type: String },
  },
  { _id: false }
);

const SharedStepSchema = new mongoose.Schema(
  {
    id: { type: Number, unique: true },
    SharedStepId: { type: String, unique: true },
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
    steps: { type: [SharedStepEntrySchema], default: [] },
    createdBy: { type: String },
    updatedBy: { type: String },
  },
  { timestamps: true }
);

// Mirrors TestRepoSchema.pre("save") in models/testrepo.js: atomic counter,
// guarded on isNew so an update never re-stamps the id.
SharedStepSchema.pre("save", async function (next) {
  if (!this.isNew) return next();
  try {
    const nextId = await getNextSequence(this.constructor.db, 'sharedstep');
    this.id = nextId;
    this.SharedStepId = "SS-" + nextId;
    return next();
  } catch (error) {
    return next(error);
  }
});

module.exports = mongoose.model("SharedStep", SharedStepSchema);
