const { ErrorResponse } = require('@srckube/service-core');
const AiProjectSettings = require('../models/AiProjectSettings');

// WP-050 -- gates every AI-usage route (health/complete/structured) on the
// per-project enable/disable flag (models/AiProjectSettings.js). Mount
// AFTER requireProjectScope() + authorize() (needs req.projectScope) and
// BEFORE any provider call, same insertion-point convention every other
// gate in this codebase follows.
//
// Deliberately its OWN 403, textually distinct from both
// requireProjectScope()'s and authorize()'s 403s -- see the three
// distinguishable failure responses this WP requires:
//   1. Unauthorised (no membership / role can't 'read')
//        -> 403 "You are not a member of this project" / "Role '...' is
//           not permitted..." (service-core's existing middleware)
//   2. Feature not enabled for this project (WP-156: the default)
//        -> 403 "AI feature is disabled for this project..." (here)
//        The leading phrase is deliberately UNCHANGED from WP-050. WP-156
//        only appends who can turn it on; rewording it broke five existing
//        assertions in this service's suites for no benefit.
//   2b. Enabled, but the time box has expired (WP-156)
//        -> 403 "AI was enabled for this project until <when>..." (here)
//   3. Provider unavailable
//        -> 503 "AI is currently unavailable; please try again later"
//           (controllers/ai.js's runProviderCall())
// Same status code as (1) for (2) is fine -- 403 is the correct HTTP
// semantics for both ("you are authenticated, but this action is not
// permitted") -- what matters is the message text is never ambiguous
// between them, exactly like this codebase's existing "project is
// archived" vs "not a member" distinction in authorize.js.
// WP-156 extended the failure list above with a fourth, deliberately distinct
// case: an enablement window that has EXPIRED. It is a different thing from
// "never enabled" -- someone turned this on and the window ran out -- and an
// admin chasing it needs to know which, so the message names the expiry.
//
// The expiry is evaluated HERE, on every request, rather than by a job that
// flips `enabled` back to false. A scheduled job that fails silently leaves a
// metered feature switched on indefinitely; an expiry compared at request time
// cannot fail that way, because there is nothing to run.
// WP-166 — a DEPLOYMENT-wide kill switch, checked before the per-project flag.
//
// WHY A SECOND SWITCH WHEN WP-156 ALREADY ADDED ONE. The per-project flag
// answers "should this project use AI?" and a project admin owns it. This one
// answers a different question — "should this deployment offer AI at all?" —
// and only whoever runs the deployment can answer it. During the closed beta
// the answer is no, because the AI features are not good enough to put in
// front of testers yet, and that judgement must not be overridable by a
// project admin finding a toggle in the settings UI.
//
// It is also the clause that makes the beta terms honest. Those terms say
// customer content never leaves vedan's infrastructure during the beta; the
// per-project flag alone could not support that sentence, because any admin
// could flip it. This can only be changed by editing the environment and
// restarting the service.
//
// Fails CLOSED on a malformed value: anything other than an explicit opt-in
// string leaves AI off. The usual direction for a feature flag is to fail
// open, and that is wrong here — a typo that silently re-enabled a feature
// which ships content to a third party is a worse outcome than a typo that
// disables one.
function aiDisabledGlobally() {
  const raw = process.env.AI_GLOBALLY_ENABLED;
  if (raw === undefined || raw === '') return true; // absent => off
  return String(raw).trim().toLowerCase() !== 'true';
}

async function checkProjectEnabled(req, res, next) {
  try {
    if (aiDisabledGlobally()) {
      // Textually distinct from the per-project 403 below, on purpose. An
      // admin who has already set `enabled: true` and still sees a refusal
      // needs to know the switch they can reach is not the one saying no.
      return next(
        new ErrorResponse(
          'AI features are turned off for this deployment and cannot be enabled per project. ' +
            'Contact the operator of this vedan instance.',
          403
        )
      );
    }

    const projectId = req.projectScope.projectId;
    const settings = await AiProjectSettings.findOne({ projectId });

    // WP-156: no document means OFF. This is the opt-in default and the
    // inverse of the original behaviour -- see AiProjectSettings.js.
    if (!settings || settings.enabled !== true) {
      return next(
        new ErrorResponse(
          'AI feature is disabled for this project. A project admin can enable it in the project settings.',
          403
        )
      );
    }

    if (settings.enabledUntil instanceof Date && settings.enabledUntil.getTime() <= Date.now()) {
      return next(
        new ErrorResponse(
          `AI was enabled for this project until ${settings.enabledUntil.toISOString()} and that period has ended. ` +
            'A project admin can enable it again.',
          403
        )
      );
    }

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { checkProjectEnabled, aiDisabledGlobally };
