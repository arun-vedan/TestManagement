const mongoose = require('mongoose');

// WP-052 -- persisted "not a duplicate" dismissals.
//
// HOME DECISION: aiService's own tiny collection, same reasoning as
// AiProjectSettings.js (WP-050) -- this is bookkeeping about aiService's own
// advisory feature, not a domain entity, so it stays entirely inside
// aiService rather than growing testRepoService's schema. Dismissing a
// suggested duplicate pair never writes to testRepoService/linkIssueService
// at all (GR-8: no write to a domain entity without the user's OWN explicit
// action on THAT entity, e.g. linking).
//
// PERSISTENCE DECISION (WP-052 brief: "decide whether a dismissal persists
// or is transient -- and say which"): PERSISTS, scoped per-project and per
// pair, until the pair is explicitly un-dismissed via
// controllers/ai.js#undismissDuplicate (DELETE /api/v1/ai/dismiss-duplicate)
// -- added specifically so a mistaken dismissal (or a test fixture's own
// dismissal -- see __tests__/aiDuplicates.test.js's afterAll) is reversible,
// rather than permanent forever. Rationale for persisting by default: a human reviewer already
// spent attention concluding "these two are not duplicates" -- re-showing
// the identical advisory chip every single time they reopen the same test
// case (or re-run a bulk audit) would train users to ignore the whole
// feature, which is worse than a dismissal that's slightly too sticky. Once
// EITHER test case's summary/description is edited, checkDuplicateTestCase
// naturally re-evaluates from scratch next time it's called -- but the OLD
// dismissal record for the old pairKey is deliberately not auto-cleared
// (the pairKey is by TestCaseId, not by content hash), so a genuinely
// significant rewrite of one side won't automatically un-suppress the pair.
// Acceptable for v1 given tiny collection sizes and the ability to widen
// this later without a schema change.
//
// KNOWN CAVEAT (found while testing this WP -- see EXECUTION_LOG.md's
// WP-052 report): pairKey is keyed on TestCaseId (the business key, e.g.
// "TC-5"), and testRepoService's id assignment
// (models/testrepo.js#TestRepoSchema's pre('save') hook -- pre-existing,
// not introduced here) reuses a numeric id the moment the highest-id
// document is deleted, since it always computes `max(existing id) + 1`. If
// TC-5 is deleted and a LATER, semantically unrelated test case happens to
// be assigned the same TestCaseId "TC-5", any old dismissal recorded
// against the original TC-5 would incorrectly suppress a warning for the
// new one. Deleting the highest-id test case is rare in normal use (most
// deletions are not of the single most-recently-created row project-wide),
// so this is accepted as a pre-existing, low-probability edge case rather
// than fixed here -- fixing it properly would mean keying on Mongo _id
// instead, which the WP-020c-flagged id scheme was never designed around
// project-wide. Reproduced locally during this WP's own manual testing
// (repeated create/delete of throwaway fixtures with the same
// TestCaseId), which is what surfaced this note.
const DismissedDuplicateSchema = new mongoose.Schema(
  {
    projectId: { type: Number, required: true, index: true },
    entityType: { type: String, enum: ['testcase'], default: 'testcase' },
    // Sorted [aId, bId] joined with '|' -- order-independent so dismissing
    // from either test case's side suppresses the pair from both.
    pairKey: { type: String, required: true },
    aId: { type: String, required: true },
    bId: { type: String, required: true },
    dismissedBy: { type: String }
  },
  { timestamps: true }
);

DismissedDuplicateSchema.index({ projectId: 1, entityType: 1, pairKey: 1 }, { unique: true });

DismissedDuplicateSchema.statics.makePairKey = function makePairKey(aId, bId) {
  return [String(aId), String(bId)].sort().join('|');
};

module.exports = mongoose.model('DismissedDuplicate', DismissedDuplicateSchema);
