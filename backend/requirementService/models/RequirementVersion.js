const mongoose = require("mongoose");

// Sprint 2.1 (PB-04): immutable, append-only version history for Requirement.
// Same pattern as testRepoService/models/TestCaseVersion.js — see that file's
// comment for the full rationale. No update/delete routes exposed here.
const RequirementVersionSchema = new mongoose.Schema(
  {
    reqId: {
      type: String,
      required: true,
      index: true,
    },
    version: {
      type: Number,
      required: true,
    },
    snapshot: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("RequirementVersion", RequirementVersionSchema);
