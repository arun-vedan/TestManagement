const express = require('express');
const { initKeycloak, requireProjectScope, authorize } = require('@srckube/service-core');
const { checkProjectEnabled } = require('../middleware/checkProjectEnabled');
const {
  health,
  complete,
  completeStructured,
  generateTestCases,
  checkDuplicateTestCase,
  auditDuplicates,
  dismissDuplicate,
  undismissDuplicate,
  lintRequirement,
  applyLintFinding,
  summarizeReport,
  listInteractions,
  getSettings,
  updateSettings,
  availability
} = require('../controllers/ai');

const keycloak = initKeycloak();
const router = express.Router();

// WP-050 — project-scoped from birth, same middleware order as every
// current-generation service (WP-021 requireProjectScope() -> WP-022
// authorize()): keycloak.protect() -> requireProjectScope() -> authorize().
// checkProjectEnabled() is this service's own addition, mounted AFTER
// authorize() (it needs req.projectScope, and RBAC should be decided before
// the feature-flag check so an unauthorised caller sees a 403 for that
// reason, not a feature-disabled one — a caller with no access to a project
// should not learn anything about that project's AI settings either way,
// but authorize() already reaches its own 403 first so this ordering costs
// nothing and keeps failure semantics tidy).
//
// 'read' is the RBAC action for every AI-usage route (health/complete/
// structured/interactions), including complete/structured: this service
// never writes to a domain entity (GR-8 — AI is advisory, draft-only), so
// using it is a read-like action available to every role including viewer,
// exactly like this codebase's other read endpoints.

// WP-166 — the capability probe, deliberately NOT behind checkProjectEnabled.
// It exists to report what that middleware WOULD decide, so putting it behind
// the gate would make it answer only when the answer is already yes. Still
// requires an authenticated member of the project with 'read': whether a tool
// is switched on is not secret from the people who would use it, but it is not
// public either.
//
// Mounted before /health because the frontend asks this FIRST, to decide
// whether to render an AI entry point at all. Five components currently render
// theirs unconditionally and then fail on a 403 — see the controller comment.
router.get('/availability', keycloak.protect(), requireProjectScope(), authorize('read'), availability);
router.get('/health', keycloak.protect(), requireProjectScope(), authorize('read'), checkProjectEnabled, health);
router.post(
  '/complete',
  keycloak.protect(),
  requireProjectScope(),
  authorize('read'),
  checkProjectEnabled,
  complete
);
router.post(
  '/structured',
  keycloak.protect(),
  requireProjectScope(),
  authorize('read'),
  checkProjectEnabled,
  completeStructured
);
// WP-051 -- generate-testcases. 'read', same reasoning as /complete and
// /structured (controllers/ai.js's header comment on generateTestCases):
// this route never writes to a domain entity, it only returns candidates
// for a human to review; acceptance is a separate, later call the frontend
// makes directly against testRepoService/linkIssueService's own APIs.
router.post(
  '/generate-testcases',
  keycloak.protect(),
  requireProjectScope(),
  authorize('read'),
  checkProjectEnabled,
  generateTestCases
);
router.get(
  '/interactions',
  keycloak.protect(),
  requireProjectScope(),
  authorize('read'),
  listInteractions
);

// WP-052 -- duplicate detection. Both check/audit are 'read', same
// reasoning as generate-testcases: neither writes to a domain entity, only
// returns advisory candidates. dismiss-duplicate DOES write (a persisted
// dismissal, aiService's own bookkeeping -- see
// models/DismissedDuplicate.js), so it's gated on 'write' like any other
// mutation, even though what it mutates never leaves aiService's own
// database.
router.post(
  '/check-duplicate-testcase',
  keycloak.protect(),
  requireProjectScope(),
  authorize('read'),
  checkProjectEnabled,
  checkDuplicateTestCase
);
router.post(
  '/audit-duplicates',
  keycloak.protect(),
  requireProjectScope(),
  authorize('read'),
  checkProjectEnabled,
  auditDuplicates
);
router.post(
  '/dismiss-duplicate',
  keycloak.protect(),
  requireProjectScope(),
  authorize('write'),
  checkProjectEnabled,
  dismissDuplicate
);
router.delete(
  '/dismiss-duplicate',
  keycloak.protect(),
  requireProjectScope(),
  authorize('write'),
  checkProjectEnabled,
  undismissDuplicate
);

// WP-052 -- requirement ambiguity linting. lint-requirement is 'read' (runs
// on a requirement in ANY lifecycle status, never writes). apply-lint-
// finding is 'write' -- it results in a real requirementService update
// (through that service's own governed API, see controllers/ai.js's header
// comment on applyLintFinding) and is additionally lifecycle-gated
// server-side inside the controller itself (draft/review only -- see that
// same comment for why the gate lives there rather than as a UI-only
// restriction).
router.post(
  '/lint-requirement',
  keycloak.protect(),
  requireProjectScope(),
  authorize('read'),
  checkProjectEnabled,
  lintRequirement
);
router.post(
  '/apply-lint-finding',
  keycloak.protect(),
  requireProjectScope(),
  authorize('write'),
  checkProjectEnabled,
  applyLintFinding
);

// WP-053 -- AI-assisted reporting. 'read', same reasoning as every other
// route in this controller that only returns advisory content and writes
// to no domain entity (see controllers/ai.js#summarizeReport's own header
// comment): it reads reportingService's aggregates and returns a markdown
// narrative, nothing is persisted anywhere.
router.post(
  '/summarize-report',
  keycloak.protect(),
  requireProjectScope(),
  authorize('read'),
  checkProjectEnabled,
  summarizeReport
);

// Settings are readable by anyone who can read the project, but only
// changeable by manage_project (same action level as project rename/
// archive/restore, WP-022's permission matrix) — NOT gated by
// checkProjectEnabled itself, so an admin can always see/flip the flag even
// while it's off.
router
  .route('/settings')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), getSettings)
  .put(keycloak.protect(), requireProjectScope(), authorize('manage_project'), updateSettings);

module.exports = router;
