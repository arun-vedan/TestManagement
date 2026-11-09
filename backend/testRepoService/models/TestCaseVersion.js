const mongoose = require("mongoose");

// Sprint 2.1 (PB-04): immutable, append-only version history for TestCaseRepo.
// Extends the versioning pattern already proven in production on
// Automation.version (backend/automationService/models/automation.js) —
// there, each version is a separate document; here, the live TestCaseRepo
// document stays a single current-state record (no API/consumer breakage),
// and every pre-update state is snapshotted here instead. No update/delete
// routes are exposed on this model — it is write-once by design.
const TestCaseVersionSchema = new mongoose.Schema(
  {
    TestCaseId: {
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

module.exports = mongoose.model("TestCaseVersion", TestCaseVersionSchema);
