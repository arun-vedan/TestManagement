const mongoose = require('mongoose');
const { getNextSequence } = require('@srckube/service-core');

// WP-025 — QualityGate. A rule evaluated on demand against LIVE data from
// other services (testPlanExecutionService for TestExecution pass/fail,
// defectService + istatusservice for open-defect counts) via
// GET /api/v1/releases/:id/gate-status — see controllers/releases.js
// (evaluateGateStatus). Deliberately embedded as a subdocument array on
// Release rather than its own top-level collection/service: there is no
// independent lifecycle for a gate rule outside the release it belongs to
// (it's created/edited/deleted only as part of editing the release), no
// cross-release querying need, and exactly two rule types exist today
// (strategy §33 — "keep it deliberately small"). If a future WP needs gates
// with their own identity/history (e.g. per-rule audit trail), promoting
// this to a real collection is a small, additive change since the shape
// here already carries everything a standalone document would need except
// its own _id/timestamps.
const QualityGateSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      required: [true, 'quality gate type is required'],
      enum: ['minPassRate', 'maxOpenDefects']
    },
    // minPassRate: threshold is a percentage (0-100) of executed test cases
    //   (across every TestExecution linked to this release's TestPlans)
    //   that must be 'Pass'.
    // maxOpenDefects: threshold is the maximum number of open defects
    //   (optionally filtered by `severity`) allowed.
    threshold: {
      type: Number,
      required: [true, 'quality gate threshold is required']
    },
    // maxOpenDefects only. Absent/empty = count open defects of every
    // severity. Matches defectService's free-text Severity field (e.g.
    // 'High', 'Minor') — not an enum here since defectService itself
    // doesn't enforce one (verified: live data has 'High' and 'Minor').
    severity: {
      type: String
    }
  },
  { _id: false }
);

// WP-025 — Release. Deliberately small (strategy §33): the fields the spec
// names and nothing speculative. `linkedTestPlanIds` stores
// testPlanExecutionService TestPlan Mongo `_id` strings (matching the type
// TestExecution.TestPlanId already uses in that service — see
// backend/testPlanExecutionService/models/TestExecution.js), which is what
// lets gate evaluation query
// `GET /api/v1/testexecution?TestPlanId=<id>` directly with no extra
// lookup. It is a cross-service reference by id only, same convention as
// the new `environmentId` fields on TestPlan/TestExecution — no FK
// enforcement, no populate, this service doesn't own that data.
const ReleaseSchema = new mongoose.Schema(
  {
    id: {
      type: Number,
      unique: true
    },
    releaseId: {
      type: String,
      unique: true
    },
    name: {
      type: String,
      required: [true, 'name is required']
    },
    projectId: {
      type: Number,
      required: [true, 'projectId is required'],
      index: true
    },
    targetDate: {
      type: Date
    },
    status: {
      type: String,
      enum: ['planned', 'in-progress', 'frozen', 'released', 'cancelled'],
      default: 'planned'
    },
    linkedTestPlanIds: {
      type: [String],
      default: []
    },
    notes: {
      type: String
    },
    qualityGates: {
      type: [QualityGateSchema],
      default: []
    },
    // WP-F24 Task 1 (fix round 1) -- configured per-project fields
    // (fieldsService's moduleId 6 documents), same shape/name as the three
    // sibling models that already support this (requirementService/models/
    // requirement.js, defectService/models/defects.js, testRepoService/
    // models/testrepo.js all declare `dynamicFields: { type:
    // mongoose.Schema.Types.Mixed }` -- verified by reading all three
    // before adding this). Without this path, a strict Mongoose schema
    // (this one has no `strict: false`, same as those three) silently
    // drops any key in an update payload that isn't a declared schema
    // path -- a configured field's value would round-trip through the
    // frontend and the controller (which already forwards the whole
    // request body unfiltered, see controllers/releases.js's
    // createRelease/updateRelease) and vanish only here, at the very last
    // step. `Mixed`, not a typed sub-schema: field *definitions* (their
    // types/labels) live in fieldsService, keyed generically by moduleId --
    // this collection has no idea what shape a given project's module-6
    // fields take, exactly like the three sibling models it copies this
    // from.
    dynamicFields: {
      type: mongoose.Schema.Types.Mixed
    },
    createdBy: {
      type: String
    },
    updatedBy: {
      type: String
    }
  },
  {
    timestamps: true
  }
);

ReleaseSchema.pre('save', async function (next) {
  if (!this.isNew) {
    return next();
  }
  try {
    // WP-020c: atomic counter (was a read-then-write race, see
    // backend/shared/service-core/sequence.js for why).
    const nextId = await getNextSequence(this.constructor.db, 'release');
    this.id = nextId;
    this.releaseId = 'REL-' + nextId;
    return next();
  } catch (error) {
    return next(error);
  }
});

module.exports = mongoose.model('Release', ReleaseSchema);
