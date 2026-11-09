const { execFileSync } = require('child_process');

// WP-166 — is AI switched on for THIS deployment?
//
// WHY A TEST HELPER NEEDS THIS. aiService's live suites are black-box: they
// drive the running container over HTTP (GR-6). WP-166 added a
// deployment-wide kill switch in front of the per-project flag, and it is OFF
// for the closed beta — the AI features are not considered good enough to put
// in front of testers, and the beta terms state that customer content does not
// leave vedan. With it off, every route those suites exercise answers 403
// before reaching a provider. They cannot pass, and they are not broken.
//
// So they SKIP, loudly, exactly as the Jira suites do without JIRA_*. The
// alternative — leaving 28 red tests for a feature that is deliberately
// disabled — trains everyone to ignore this service's results, which is how a
// real regression gets through.
//
// WHY IT READS THE CONTAINER'S ENVIRONMENT, not an HTTP probe. The decision
// has to be made while Jest is collecting test files, which is synchronous,
// so an async probe cannot gate a `describe`. The container's env var is the
// same value the middleware itself reads, so this is the service's own source
// of truth rather than an inference from a response body. `docker exec` is
// already the established way these suites reach into the stack (see
// linkIssueService's jiraIssues.test.js, which shells out to mongosh).
//
// FAILS CLOSED, matching the middleware. If the probe cannot run — no docker,
// container not up, renamed — this reports DISABLED and says why, rather than
// letting a suite run and attribute an infrastructure problem to the code.
// The risk it accepts is skipping suites that could have run; the warning
// makes that visible, and a silent vacuous pass would be worse.

let cached;

function aiDeploymentState() {
  if (cached !== undefined) return cached;
  const container = process.env.TEST_AI_CONTAINER || 'aiservice';
  try {
    const out = execFileSync('docker', ['exec', container, 'printenv', 'AI_GLOBALLY_ENABLED'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const value = String(out).trim();
    cached = {
      enabled: value.toLowerCase() === 'true',
      reason: `AI_GLOBALLY_ENABLED=${JSON.stringify(value)} in container '${container}'`
    };
  } catch (err) {
    // printenv exits non-zero when the variable is unset, which is itself a
    // legitimate "disabled" answer and indistinguishable here from docker
    // being absent. Both mean the same thing for our purposes.
    cached = {
      enabled: false,
      reason: `could not read AI_GLOBALLY_ENABLED from container '${container}' (${err.code || err.message}); treating AI as disabled, same as the middleware does`
    };
  }
  return cached;
}

// Use as: const liveDescribe = describeIfAiEnabled('WP-0xx');
//         liveDescribe('...', () => { ... });
function describeIfAiEnabled(label) {
  const state = aiDeploymentState();
  if (state.enabled) return describe;
  // process.stderr.write, NOT console.warn. This fires while Jest is
  // COLLECTING test files, before any test exists to attach output to, and
  // Jest's console capture swallows it in a multi-file run — measured: the
  // warning showed on a single-file run and vanished from the full sweep's
  // log, leaving "6 skipped" with no reason anywhere. A skip whose cause is
  // invisible is the vacuous pass this helper exists to prevent.
  process.stderr.write(
    `\n[${label}] SUITE SKIPPED — AI is disabled for this deployment (WP-166).` +
      `\n[${label}] ${state.reason}` +
      `\n[${label}] Nothing below was verified. To run these, set AI_GLOBALLY_ENABLED=true` +
      `\n[${label}] in backend/.env and recreate the aiservice container.\n\n`
  );
  return describe.skip;
}

module.exports = { aiDeploymentState, describeIfAiEnabled };
