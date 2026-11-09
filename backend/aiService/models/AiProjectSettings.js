const mongoose = require('mongoose');

// WP-050 -- per-project AI enable/disable flag.
//
// HOME DECISION: its own tiny collection inside aiService's own database,
// NOT a field bolted onto userService's Project document -- same reasoning
// WP-043's SavedView used for its own home decision (see that model's
// header comment). This is aiService's own configuration about aiService's
// own feature; keeping it here means zero cross-service write coupling
// (userService never needs to know aiService exists, and a future removal
// of aiService touches nothing outside this one collection).
//
// DEFAULT: a project with NO document here is treated as ENABLED (opt-out,
// not opt-in) -- see middleware/checkProjectEnabled.js, which is the only
// code that reads this collection on the request path. This keeps every
// WP-156 INVERTED THIS. It used to be opt-OUT: no document meant AI was ON,
// so every project worked the moment the service went live and an admin only
// created a document to turn it OFF. For a self-serve product that means every
// new tenant starts spending against the AI provider without anyone choosing
// to, so the model is now opt-IN -- no document means OFF, and an
// admin/manager turns it on, optionally for a bounded window
// (PUT /api/v1/ai/settings with enabled:true and enabledUntil).
const AiProjectSettingsSchema = new mongoose.Schema(
  {
    // WP-020c convention: no numeric read-then-write id -- projectId
    // itself (unique-indexed) is this document's natural key, and
    // findOneAndUpdate({projectId}, ..., {upsert:true}) is an atomic Mongo
    // upsert on that unique index, not the racy "read max, +1, write"
    // pattern that model class is warning about.
    projectId: { type: Number, required: true, unique: true, index: true },
    // WP-156 — AI is OFF by default. This was `default: true` (opt-OUT): any
    // project with no settings document had AI enabled, which for a
    // self-serve product means every new tenant starts spending against the
    // provider without anyone choosing to. Opt-in is the correct default for
    // a metered feature.
    enabled: { type: Boolean, default: false },

    // WP-156 — the time box. When set, `enabled: true` only holds until this
    // instant; after it the middleware treats the project as disabled without
    // anything having to run. That matters: a cron that flips flags back off
    // can fail silently and leave the feature on, whereas an expiry that is
    // evaluated on every request cannot. Null/absent means "on until someone
    // turns it off", which stays available deliberately -- an operator who
    // wants AI on indefinitely should be able to say so explicitly rather
    // than work around the mechanism.
    enabledUntil: { type: Date, default: null },
    updatedBy: { type: String }
  },
  { timestamps: true }
);

module.exports = mongoose.model('AiProjectSettings', AiProjectSettingsSchema);
