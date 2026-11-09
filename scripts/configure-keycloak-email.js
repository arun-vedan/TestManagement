#!/usr/bin/env node
/**
 * configure-keycloak-email.js — WP-130
 *
 * Configures the srckube realm's SMTP and turns on the self-serve signup flow,
 * idempotently, from credentials in backend/.env.
 *
 * WHY THIS IS A SCRIPT AND NOT A README SECTION. The realm is runtime state in
 * Postgres, not a tracked file, so a manual admin-console walkthrough is
 * unreproducible: nothing records what was set, and a rebuilt realm silently
 * loses it. This is the half of WP-130 that can live in the repo. WP-151
 * ("one-command setup") can call it directly.
 *
 * ORDER IS DELIBERATE, NOT COSMETIC:
 *   1. test SMTP   2. write SMTP   3. email verification
 *   4. password reset   5. terms   6. registration LAST
 *
 * Registration goes last because turning public signup on before verification
 * works would admit unverified accounts through a half-built flow, with no way
 * to verify them afterwards. The script refuses to go past step 1 if the SMTP
 * test fails, for the same reason.
 *
 * SECRETS: read from backend/.env (gitignored). Never printed, and never
 * written to a tracked file — the realm stores the password itself, and
 * Keycloak masks it on read.
 *
 * USAGE
 *   node scripts/configure-keycloak-email.js            # configure
 *   node scripts/configure-keycloak-email.js --status   # report, change nothing
 *
 * ENV (backend/.env)
 *   SMTP_HOST SMTP_PORT SMTP_USER SMTP_PASSWORD SMTP_FROM
 *   SMTP_FROM_NAME   optional, defaults to 'vedan'
 *   SMTP_REPLY_TO    optional, defaults to SMTP_FROM
 *   KC_URL           optional, defaults to http://localhost:8080
 *   KC_REALM         optional, defaults to srckube
 *   KC_ADMIN_USER / KC_ADMIN_PASSWORD   optional, default to the bootstrap admin
 */

const fs = require('fs');
const path = require('path');
const axios = require(path.join(__dirname, '..', 'backend', 'reportingService', 'node_modules', 'axios'));

const REPO = path.join(__dirname, '..');
const STATUS_ONLY = process.argv.includes('--status');

function readEnvFile(p) {
  const out = {};
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#') || !t.includes('=')) continue;
    const i = t.indexOf('=');
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

const fileEnv = readEnvFile(path.join(REPO, 'backend', '.env'));
const E = (k, d) => process.env[k] || fileEnv[k] || d;

const KC = E('KC_URL', 'http://localhost:8080');
const REALM = E('KC_REALM', 'srckube');

async function adminToken() {
  const r = await axios.post(
    `${KC}/realms/master/protocol/openid-connect/token`,
    new URLSearchParams({
      client_id: 'admin-cli',
      username: E('KC_ADMIN_USER', 'admin'),
      password: E('KC_ADMIN_PASSWORD', 'Pass;word1'),
      grant_type: 'password'
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return r.data.access_token;
}

(async () => {
  const H = { Authorization: `Bearer ${await adminToken()}` };
  const getRealm = async () => (await axios.get(`${KC}/admin/realms/${REALM}`, { headers: H })).data;

  // WP-137 — reported because "does signup collect a password?" is not
  // answerable from the realm's own fields; it lives on the registration
  // flow's password authenticator, and its default is false whenever
  // verifyEmail is on. A --status that omitted it would read as healthy while
  // the funnel still deferred the password.
  const passwordOnFormState = async () => {
    try {
      const alias = (await getRealm()).registrationFlow;
      const execs = (
        await axios.get(`${KC}/admin/realms/${REALM}/authentication/flows/${encodeURIComponent(alias)}/executions`, {
          headers: H
        })
      ).data;
      const ex = execs.find((x) => x.providerId === 'registration-password-action');
      if (!ex) return 'no password authenticator in the registration flow';
      if (!ex.authenticationConfig) return `false (default) — requirement=${ex.requirement}`;
      const cfg = (
        await axios.get(`${KC}/admin/realms/${REALM}/authentication/config/${ex.authenticationConfig}`, { headers: H })
      ).data;
      return `${cfg.config && cfg.config.always_set_password_on_register_form === 'true'} — requirement=${ex.requirement}`;
    } catch (e) {
      return `unknown (${e.message})`;
    }
  };

  const report = async (label) => {
    const r = await getRealm();
    const ra = (
      await axios.get(`${KC}/admin/realms/${REALM}/authentication/required-actions`, { headers: H })
    ).data.find((a) => a.alias === 'TERMS_AND_CONDITIONS');
    const pwOnForm = await passwordOnFormState();
    console.log(`${label}`);
    console.log(`  password on signup: ${pwOnForm}`);
    console.log(`  smtp configured   : ${Boolean(r.smtpServer && r.smtpServer.host)}${r.smtpServer && r.smtpServer.host ? ` (${r.smtpServer.host}:${r.smtpServer.port}, from ${r.smtpServer.from})` : ''}`);
    console.log(`  verifyEmail       : ${r.verifyEmail}`);
    console.log(`  resetPassword     : ${r.resetPasswordAllowed}`);
    console.log(`  terms             : enabled=${ra ? ra.enabled : 'n/a'} defaultAction=${ra ? ra.defaultAction : 'n/a'}`);
    console.log(`  registration      : ${r.registrationAllowed}`);
    return r;
  };

  if (STATUS_ONLY) {
    await report('current realm email/signup state:');
    return;
  }

  const need = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'];
  const missing = need.filter((k) => !E(k));
  if (missing.length) {
    console.error(`missing in backend/.env: ${missing.join(', ')}`);
    process.exit(1);
  }

  const smtpServer = {
    host: E('SMTP_HOST'),
    port: E('SMTP_PORT'),
    from: E('SMTP_FROM'),
    fromDisplayName: E('SMTP_FROM_NAME', 'vedan'),
    replyTo: E('SMTP_REPLY_TO', E('SMTP_FROM')),
    ssl: String(E('SMTP_PORT') === '465'),
    starttls: String(E('SMTP_PORT') !== '465'),
    auth: 'true',
    user: E('SMTP_USER'),
    password: E('SMTP_PASSWORD')
  };

  // --- 1. test before changing anything -----------------------------------
  // NOTE: this endpoint wants a JSON body on current Keycloak. Form-encoding
  // it returns an opaque HTTP 500 whose only clue is in the container log:
  // IllegalArgumentException: argument "content" is null.
  //
  // The test mail goes to the ADMIN USER'S OWN email address. If that user has
  // no email set, the failure is the unhelpful 'Failed to send email — null'.
  console.log('testing SMTP credentials...');
  const t = await axios.post(`${KC}/admin/realms/${REALM}/testSMTPConnection`, smtpServer, {
    headers: { ...H, 'Content-Type': 'application/json' },
    validateStatus: () => true
  });
  if (!(t.status >= 200 && t.status < 300)) {
    console.error(`  SMTP test FAILED (HTTP ${t.status}). Nothing was changed.`);
    console.error('  Check, in order:');
    console.error('    - the sending IP is authorised with your provider (Brevo rejects with 525 5.7.1 Unauthorized IP address)');
    console.error('    - SMTP_PASSWORD is the SMTP key, not a v3 API key');
    console.error('    - SMTP_USER is the provider-issued login, not your account email');
    console.error('    - the admin user has an email address set (the test mail is sent to it)');
    console.error(`    - "docker logs ${E('KC_CONTAINER', 'keycloak')}" for the underlying exception`);
    process.exit(1);
  }
  console.log('  SMTP test passed');

  // --- 2..6 ----------------------------------------------------------------
  const patch = async (partial) => {
    const realm = await getRealm();
    await axios.put(`${KC}/admin/realms/${REALM}`, { ...realm, ...partial }, { headers: H });
  };

  await patch({ smtpServer });
  console.log('  smtp written to the realm');
  // Customer-visible product name. With displayName unset Keycloak falls
  // back to the realm NAME, so the login tab read "Sign in to srckube" and
  // Keycloak's own emails named the internal realm. The realm name itself
  // stays `srckube` (frontend/src/keycloak.js, every redirect URI).
  await patch({ displayName: E('KC_REALM_DISPLAY_NAME', 'vedan'), displayNameHtml: E('KC_REALM_DISPLAY_NAME', 'vedan') });
  console.log('  realm display name set');
  await patch({ verifyEmail: true });
  console.log('  email verification on');
  await patch({ resetPasswordAllowed: true });
  console.log('  password reset on');

  const actions = (
    await axios.get(`${KC}/admin/realms/${REALM}/authentication/required-actions`, { headers: H })
  ).data;
  const terms = actions.find((a) => a.alias === 'TERMS_AND_CONDITIONS');
  if (terms) {
    // defaultAction matters as much as enabled: without it the action exists
    // but is never applied to a new registration.
    await axios.put(
      `${KC}/admin/realms/${REALM}/authentication/required-actions/${terms.alias}`,
      { ...terms, enabled: true, defaultAction: true },
      { headers: H }
    );
    console.log('  terms and conditions on (enabled + default)');
  } else {
    console.log('  terms and conditions action not present in this realm — skipped');
  }

  // --- password ON the registration form (WP-137) --------------------------
  //
  // WHY THIS STEP EXISTS. WP-137 was filed as "the signup form collects no
  // password", on the hypothesis that the kdk theme was missing a
  // register.ftl. Measured, that hypothesis was wrong: base's register.ftl
  // DOES render password fields, guarded by `passwordRequired`, and that
  // variable was absent. The cause is this authenticator config, whose own
  // help text reads:
  //
  //   "When this option is false and 'Verify Email' is enabled for the realm,
  //    then the password will not be set by the user on the registration form,
  //    but rather in the later stage once user's email address is successfully
  //    verified. This is recommended for security reasons. [...] This option
  //    is deprecated and might be removed in the future."
  //
  // Step 3 above turns verifyEmail ON, so Keycloak was deliberately omitting
  // the password box and adding UPDATE_PASSWORD after verification. The
  // zero-credential account was intended behaviour, not a theme bug.
  //
  // WHY WE OVERRIDE IT ANYWAY. The deferred-password flow makes the entire
  // signup funnel depend on a verification email arriving; that is the
  // weakest link in this stack today. Setting the password on the form does
  // NOT open a login hole, because verifyEmail stays on and an unverified
  // account still cannot authenticate -- measured: direct grant returns 400
  // "Account is not fully set up" before verification, 200 after.
  //
  // TWO THINGS TO KNOW. (1) The security property we give up is that a
  // credential can now exist on an address the registrant has not proven they
  // own. (2) The option is DEPRECATED upstream; if a future Keycloak drops it,
  // this step becomes a no-op and signup silently reverts to the
  // UPDATE_PASSWORD detour -- degraded UX, not a breakage. Both are worth
  // revisiting once email deliverability is solid, which is the real fix for
  // the problem this works around.
  const PW_FLAG = 'always_set_password_on_register_form';
  const flowAlias = (await getRealm()).registrationFlow;
  const execs = (
    await axios.get(`${KC}/admin/realms/${REALM}/authentication/flows/${encodeURIComponent(flowAlias)}/executions`, {
      headers: H
    })
  ).data;
  const pwExec = execs.find((x) => x.providerId === 'registration-password-action');
  if (!pwExec) {
    console.log('  password-on-register-form: no registration-password-action in the flow — skipped');
  } else if (pwExec.requirement !== 'REQUIRED') {
    // Not forced on: if an operator has deliberately disabled password
    // validation, silently re-enabling it would be a different decision from
    // the one this script is making.
    console.log(`  password-on-register-form: Password Validation is ${pwExec.requirement}, not REQUIRED — skipped`);
  } else if (pwExec.authenticationConfig) {
    const cfgUrl = `${KC}/admin/realms/${REALM}/authentication/config/${pwExec.authenticationConfig}`;
    const cfg = (await axios.get(cfgUrl, { headers: H })).data;
    await axios.put(cfgUrl, { ...cfg, config: { ...cfg.config, [PW_FLAG]: 'true' } }, { headers: H });
    console.log('  password-on-register-form on (updated existing config)');
  } else {
    await axios.post(
      `${KC}/admin/realms/${REALM}/authentication/executions/${pwExec.id}/config`,
      { alias: 'wp137-password-on-register-form', config: { [PW_FLAG]: 'true' } },
      { headers: H }
    );
    console.log('  password-on-register-form on (config created)');
  }

  // --- Google identity provider (WP-138) -----------------------------------
  //
  // Google is the one signup path that needs NO verification email: the
  // address arrives already proven. That is the point, given mail currently
  // lands in spam.
  //
  // Runs BEFORE registration is switched on, for the same reason every other
  // step does: a signup route must not open onto a half-built flow.
  //
  // Skipped, loudly, when GOOGLE_CLIENT_ID/SECRET are absent -- this script
  // has to stay runnable on an environment that has no Google client, and a
  // silent skip would let someone believe social login was configured.
  const googleId = E('GOOGLE_CLIENT_ID');
  const googleSecret = E('GOOGLE_CLIENT_SECRET');
  if (!googleId || !googleSecret) {
    console.log('  google sign-in SKIPPED — GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET not in backend/.env');
    console.log(`    redirect URI to register with Google: ${KC}/realms/${REALM}/broker/google/endpoint`);
  } else {
    // trustEmail is REQUIRED here, not a convenience. The realm has
    // verifyEmail on (step 3), so without it a brokered Google user is still
    // handed VERIFY_EMAIL, mails them into spam, and the feature delivers
    // nothing at all.
    //
    // It costs nothing in linking safety, which is the obvious worry and is
    // misplaced: in keycloak-services 26.7.3, `isTrustEmail` is referenced by
    // exactly two classes -- OIDCIdentityProvider (where it feeds
    // setEmailVerified) and AbstractTokenExchangeProvider. None of the broker
    // linking authenticators consult it. Linking is governed purely by the
    // "first broker login" flow, hardened below.
    const googleIdp = {
      alias: 'google',
      providerId: 'google',
      enabled: true,
      trustEmail: true,
      storeToken: false,
      // We want Google for identity, not for API access on the user's behalf.
      addReadTokenRoleOnCreate: false,
      linkOnly: false,
      firstBrokerLoginFlowAlias: 'first broker login',
      config: {
        clientId: googleId,
        clientSecret: googleSecret,
        // Non-sensitive scopes only: no Google verification review needed.
        defaultScope: 'openid email profile',
        syncMode: 'IMPORT'
      }
    };
    const idpUrl = `${KC}/admin/realms/${REALM}/identity-provider/instances`;
    const existing = await axios.get(`${idpUrl}/google`, { headers: H, validateStatus: () => true });
    if (existing.status === 200) {
      await axios.put(`${idpUrl}/google`, { ...existing.data, ...googleIdp }, { headers: H });
      console.log('  google sign-in on (provider updated)');
    } else {
      await axios.post(idpUrl, googleIdp, { headers: H });
      console.log('  google sign-in on (provider created)');
    }
  }

  // --- harden account linking ------------------------------------------
  //
  // RUNS WHETHER OR NOT GOOGLE IS CONFIGURED, deliberately. It is inert with
  // no identity provider (the flow never executes), it costs nothing, and it
  // means ANY provider added later -- through this script or by an admin
  // clicking through the console -- inherits safe linking instead of
  // depending on whoever added it knowing to come back and fix the flow.
  //
  // The default "first broker login" flow offers two ALTERNATIVE ways to
  // prove you own a pre-existing local account with the same email:
  // verify by email, or re-authenticate with that account's password.
  // The email branch is disabled here for two independent reasons:
  //
  //  1. It reintroduces the dependency this provider exists to escape --
  //     someone who signed up with a password and later clicks Sign in with
  //     Google is mailed a link that lands in spam, and is stuck.
  //
  //  2. It closes the account pre-hijacking path that WP-137 opened. Since
  //     WP-137 a password credential can exist on an UNVERIFIED address. An
  //     attacker registers alice@example.com with a password (and cannot log
  //     in -- verifyEmail holds); real Alice later signs in with Google. On
  //     the email branch she gets a link at her OWN address, links, and
  //     lands in the account the attacker holds a password for. On the
  //     re-auth branch she is asked for the attacker's password, cannot
  //     supply it, and no link happens.
  //
  // Residual risk, accepted: re-auth turns that takeover into a denial of
  // service -- a squatter can block the real owner of an address from using
  // Google sign-up. Strictly better than a takeover, and it is a consequence
  // of WP-137's flag rather than of this provider.
  const BROKER_FLOW = 'first broker login';
  const brokerExecs = (
    await axios.get(
      `${KC}/admin/realms/${REALM}/authentication/flows/${encodeURIComponent(BROKER_FLOW)}/executions`,
      { headers: H }
    )
  ).data;
  const emailVerify = brokerExecs.find((x) => x.providerId === 'idp-email-verification');
  const reauth = brokerExecs.find(
    (x) => x.displayName === 'Verify Existing Account by Re-authentication'
  );
  if (!emailVerify) {
    console.log('  account linking: no idp-email-verification execution — nothing to disable');
  } else if (emailVerify.requirement === 'DISABLED') {
    console.log('  account linking: email branch already disabled');
  } else if (!reauth) {
    // Refuse rather than leave NO way to link: disabling the only available
    // branch would strand every user whose email already exists locally.
    console.log('  account linking: re-authentication branch absent — email branch LEFT ENABLED');
    console.log('    disabling it would leave no way to link an existing account');
  } else {
    await axios.put(
      `${KC}/admin/realms/${REALM}/authentication/flows/${encodeURIComponent(BROKER_FLOW)}/executions`,
      { ...emailVerify, requirement: 'DISABLED' },
      { headers: H }
    );
    console.log('  account linking: email branch disabled, re-authentication required');
  }

  // LAST, deliberately.
  await patch({ registrationAllowed: true });
  console.log('  registration on');

  console.log('');
  await report('final realm email/signup state:');
})().catch((e) => {
  console.error('FAILED:', e.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 300)}` : e.message);
  process.exit(1);
});
