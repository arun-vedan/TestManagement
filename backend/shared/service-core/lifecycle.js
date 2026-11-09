// Sprint 2.1 (PB-04): shared lifecycle-status vocabulary and transition rules
// for governed entities (TestCaseRepo, Requirement so far). Built directly in
// the shared library rather than locally-then-promoted, since both consumers
// need identical rules from day one — unlike Sprint 1.1's httpClient/logger,
// which started on one service before a second needed the same thing.

const LIFECYCLE_STATUSES = ['draft', 'review', 'approved', 'deprecated', 'archived'];

const VALID_TRANSITIONS = {
  draft: ['review'],
  review: ['draft', 'approved'],
  approved: ['deprecated'],
  deprecated: ['approved', 'archived'],
  archived: [] // terminal — no transitions out
};

function isValidTransition(currentStatus, nextStatus) {
  return (VALID_TRANSITIONS[currentStatus] || []).includes(nextStatus);
}

module.exports = { LIFECYCLE_STATUSES, VALID_TRANSITIONS, isValidTransition };
