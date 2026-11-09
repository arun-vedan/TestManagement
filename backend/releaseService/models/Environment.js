const mongoose = require('mongoose');
const { getNextSequence } = require('@srckube/service-core');

// WP-025 — Environment. Deliberately small (strategy §33): a project-scoped
// place to name where things run (e.g. "Staging", "UAT", "Prod"), referenced
// by id from TestPlan/TestExecution (see backend/testPlanExecutionService's
// models — the `environmentId` field added there) and from Release (a
// release can optionally target one). No lifecycle, no health-check
// integration, no auto-discovery — just a named, described, optionally
// linked-URL record. Same auto-increment `id` + `timestamps` pattern as
// every other entity in this codebase (defects.js, TestPlan.js, ...).
const EnvironmentSchema = new mongoose.Schema(
  {
    id: {
      type: Number,
      unique: true
    },
    name: {
      type: String,
      required: [true, 'name is required']
    },
    // WP-021-style tenant scoping, built in from birth per the WP-025
    // dispatch brief (not retrofitted) — every route in this service mounts
    // requireProjectScope() and stamps this server-side from req.projectScope.
    projectId: {
      type: Number,
      required: [true, 'projectId is required'],
      index: true
    },
    description: {
      type: String
    },
    url: {
      type: String
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

EnvironmentSchema.pre('save', async function (next) {
  if (!this.isNew) {
    return next();
  }
  try {
    // WP-020c: atomic counter (was a read-then-write race, see
    // backend/shared/service-core/sequence.js for why).
    this.id = await getNextSequence(this.constructor.db, 'environment');
    return next();
  } catch (error) {
    return next(error);
  }
});

module.exports = mongoose.model('Environment', EnvironmentSchema);
