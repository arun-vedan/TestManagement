const mongoose = require("mongoose");
const { getNextSequence } = require("@srckube/service-core");

const automationSchema = new mongoose.Schema(
  {
    id: {
      type: Number,
    },
    // WP-117 — tenant scope. Additive (GR-7). No backfill was needed: this
    // collection was EMPTY when WP-117 ran (verified, not assumed), so there were
    // no documents to attribute to a project.
    projectId: {
      type: Number,
      required: [true, 'Project Id is mandatory'],
      index: true
          
    },
    TestCaseId: {
      type: String,
    },
    automationScript: {
      type: String,
    },
    version: {
      type: Number,
      default: 1, // Default to 1 for new records
    },
    createdBy: {
      type: String,
    },
    updatedBy: { type: String },
  },
  {
    timestamps: true,
  }
);

automationSchema.pre("save", async function (next) {
  try {
    // If it's a new document, handle id and TestCaseId assignment
    if (this.isNew) {
      // WP-020c: atomic counter (was a read-then-write race, see
      // backend/shared/service-core/sequence.js for why). Note: the
      // `version` lookup just below this is a SEPARATE, still-racy
      // read-then-write on a field with no unique index -- out of scope
      // for WP-020c (which targets generated *ids*), flagged here for a
      // future pass; see the WP-020c report in EXECUTION_LOG.md.
      const nextId = await getNextSequence(this.constructor.db, 'automation');

      this.id = nextId;

      // Check if TestCaseId already exists
      const existingRecord = await this.constructor.findOne({
        TestCaseId: this.TestCaseId,
      }).sort({version : -1 }).limit(1);

      if (existingRecord) {
        // If TestCaseId exists, increment version for the new document
        this.version = existingRecord.version + 1;
      } 
      else{
        this.version = 1
      }
    }

    next();
  } catch (error) {
    next(error);
  }
});

module.exports = mongoose.model("Automation", automationSchema);
