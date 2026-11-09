const mongoose = require('mongoose');

// WP-040 — the ONLY collection this service ever writes to (its own
// database, srckube-reporting — see docker-compose.yml's reportingservice
// block and config/db.js's header comment). One document per
// (projectId, reportType): the materialized, chart-ready payload a GET
// /api/v1/reports/<type> request serves, refreshed either by the node-cron
// sweep (lib/cronJob.js, Default Project only — see that file's header
// comment for why) or lazily/on-demand by a GET whose cached entry is
// older than REPORT_STALE_MS, or by POST /api/v1/reports/refresh (the
// caller's own project, synchronously, all six reports at once).
//
// `data` is intentionally Mixed: each reportType has its own fixed shape
// (see services/*.js, each shaped to match a specific frontend/src/
// Components/charts/*.tsx prop contract) but those shapes differ from each
// other (TrendChart's {xLabels,series} vs DonutChart's {data:[...]} vs
// StatTile's {value,label}), so there is no single schema that usefully
// constrains all six without just re-declaring Mixed at one more level of
// indirection. The controllers own each shape's contract, not this model.
const ReportCacheSchema = new mongoose.Schema(
  {
    projectId: {
      type: Number,
      required: [true, 'projectId is required'],
      index: true
    },
    reportType: {
      type: String,
      required: [true, 'reportType is required'],
      enum: [
        'coverage',
        'pass-rate-trend',
        'defect-summary',
        'plan-progress',
        'release-readiness',
        'workload',
        // WP-F13 Task 2 -- the traceability matrix. Adding a type HERE
        // alone compiles and serves, but never refreshes: postRefresh's
        // own `reportTypes` list (controllers/reports.js) AND lib/
        // cronJob.js's own `REPORT_TYPES` list are each a SEPARATE array
        // this enum has no power over, and forgetting to add a new type to
        // either is a silent staleness bug (premise 7 -- caught for real
        // the second time around when cronJob.js's own list was found to
        // have been missed in WP-F13's final fix round; see
        // __tests__/reportTypeRegistries.test.js, which derives its
        // expected set from THIS enum so it fails if any one of the three
        // lists ever falls out of sync again) -- all three are updated
        // together.
        'traceability'
      ]
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      required: true
    },
    // When this materialized value was last SUCCESSFULLY computed. Distinct
    // from Mongoose's own updatedAt (timestamps:true below) -- a failed
    // refresh attempt never updates this document at all (see
    // controllers/reports.js's getOrCompute: no cache write on a failed
    // compute), so computedAt is always "the last time this was actually
    // correct", not "the last time this document was touched".
    computedAt: {
      type: Date,
      required: true
    },
    computeDurationMs: {
      type: Number
    }
  },
  {
    timestamps: true
  }
);

// One materialized row per project+report -- refresh always upserts this
// exact key, never appends a history of past computations (this is a
// read-model cache, not an audit log; WP-024's dedicated audit store is
// the place for history if a future WP wants it).
ReportCacheSchema.index({ projectId: 1, reportType: 1 }, { unique: true });

module.exports = mongoose.model('ReportCache', ReportCacheSchema);
