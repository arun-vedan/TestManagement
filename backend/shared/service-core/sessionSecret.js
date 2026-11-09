const crypto = require('crypto');

// WP-101 — session secret from env.
//
// WHAT WAS THERE. Every service hardcoded its express-session secret:
// 'mySecret' in 18 server.js files, and 'test' in this library's own
// keycloak.js. All of them are in git history and in any published image, so
// they are public knowledge, identical across every deployment of this
// product, and unchangeable without a code release.
//
// WHAT THE SECRET ACTUALLY PROTECTS HERE, STATED HONESTLY. keycloak-connect is
// configured bearerOnly, so request authorization comes from the Authorization
// header and is verified against the realm public key — a forged session
// cookie does not authenticate anybody. The session is also backed by an
// in-process MemoryStore, so it is not shared between services or between
// replicas. The practical exposure is therefore narrow, and this is not a
// standing authentication bypass.
//
// It is still worth fixing, for two reasons. The signing key for cookies this
// product sets should not be a public constant; and the moment anything starts
// keeping state in the session (a login flow, a CSRF token, a flash message)
// the constant becomes a real forgery primitive, silently, with no code change
// at the call site to notice. Taking it out of the source now removes a
// landmine rather than defusing an explosion.
//
// WHY A RANDOM FALLBACK RATHER THAN A DEFAULT VALUE. A default is what is being
// removed; shipping one here would reintroduce the same shared constant under a
// new name. Generating a random secret per process is safe precisely because the
// store is already per-process: nothing can be sharing a session across a
// restart today, so nothing can break when the key changes at one. Production
// refuses to start instead, matching how keycloak.js already treats missing
// config (TD-19/TD-20) — a silently-wrong security value is worse than a
// failure to boot.

let generated;
let warned = false;

function resolveSessionSecret() {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv && fromEnv.trim()) {
    return fromEnv;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Missing required env var SESSION_SECRET. Refusing to start in production with a ' +
        'hardcoded or generated session secret (WP-101). Generate one with: ' +
        "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    );
  }

  if (!generated) {
    generated = crypto.randomBytes(32).toString('hex');
  }
  if (!warned) {
    warned = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[session] SESSION_SECRET is not set; using a random per-process secret. ' +
        'Sessions will not survive a restart. Set SESSION_SECRET in backend/.env.'
    );
  }
  return generated;
}

module.exports = { resolveSessionSecret };
