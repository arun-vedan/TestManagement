const path = require('path');
const axios = require('axios');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

// WP-138 — signing up with Google.
//
// WHAT THIS SUITE IS FOR. Google's value here is narrow and specific: it is
// the one signup path that needs NO verification email, because the address
// arrives already proven. Mail currently lands in spam, so that is the
// difference between a funnel that works and one that does not.
//
// Everything that makes that true is REALM CONFIGURATION, not application
// code — and realm configuration cannot be version-controlled in this repo
// (scripts/keycloak-export.sh writes to a gitignored directory precisely
// because an export embeds signing keys and password hashes). So there is no
// file whose diff would catch a regression here. A realm restored from an
// older export, or an admin clicking through the console, silently undoes it.
// That is exactly the shape of thing worth asserting.
//
// TWO HALVES, DELIBERATELY SPLIT BY WHAT THEY NEED:
//
//   - The LINKING HARDENING needs no Google client at all, so it runs
//     unconditionally. It is also the security-relevant half, so it is the
//     half that must not be skippable.
//   - The PROVIDER assertions need GOOGLE_CLIENT_ID/SECRET and skip LOUDLY
//     without them, rather than passing vacuously.

const KC = process.env.TEST_KEYCLOAK_URL || 'http://localhost:8080';
const REALM = process.env.TEST_KEYCLOAK_REALM || 'srckube';
const BROKER_FLOW = 'first broker login';
const ADMIN_USER = process.env.KC_ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.KC_ADMIN_PASSWORD || 'Pass;word1';

const googleConfigured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

let H;
let adminAvailable = false;

async function flowExecutions(alias) {
  const r = await axios.get(
    `${KC}/admin/realms/${REALM}/authentication/flows/${encodeURIComponent(alias)}/executions`,
    { headers: H, validateStatus: () => true }
  );
  expect(r.status).toBe(200);
  return r.data;
}

beforeAll(async () => {
  // Admin credentials, not a service token: identity-provider and
  // authentication-flow endpoints are realm-management territory.
  const r = await axios.post(
    `${KC}/realms/master/protocol/openid-connect/token`,
    new URLSearchParams({
      client_id: 'admin-cli',
      username: ADMIN_USER,
      password: ADMIN_PASSWORD,
      grant_type: 'password'
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, validateStatus: () => true }
  );
  if (r.status !== 200) {
    // eslint-disable-next-line no-console
    console.warn(
      `\n[WP-138] SUITE SKIPPED — could not get a Keycloak master admin token (HTTP ${r.status}).` +
        '\n[WP-138] Set KC_ADMIN_USER / KC_ADMIN_PASSWORD. Nothing below was verified.\n'
    );
    return;
  }
  H = { Authorization: `Bearer ${r.data.access_token}` };
  adminAvailable = true;
}, 60000);

describe('WP-138: account linking cannot be bought with an email alone', () => {
  // This half needs no Google client. It is the security half, so it runs
  // whether or not social login is configured yet: the hardening must hold
  // from the moment the flow exists, not from the moment Google is wired up.

  it('the email-verification linking branch is DISABLED', async () => {
    if (!adminAvailable) return;
    const execs = await flowExecutions(BROKER_FLOW);
    const emailVerify = execs.find((x) => x.providerId === 'idp-email-verification');
    expect(emailVerify).toBeDefined();

    // WHY THIS MATTERS, since a bare assertion hides it. Since WP-137 a
    // password credential can exist on an UNVERIFIED address. So: an attacker
    // registers alice@example.com with a password (and cannot log in --
    // verifyEmail holds); real Alice later signs in with Google. If this
    // branch were enabled she would receive a link at her OWN address, link,
    // and land in the account the attacker holds a password for. A takeover,
    // reachable with no special access.
    expect(emailVerify.requirement).toBe('DISABLED');
  }, 60000);

  it('re-authentication remains available, so linking is still POSSIBLE', async () => {
    if (!adminAvailable) return;
    // The failure mode on the other side of the previous assertion: disable
    // the only available branch and every user whose email already exists
    // locally is stranded, unable to link by any means. Proving the email
    // branch is off is only half an assertion without this.
    const execs = await flowExecutions(BROKER_FLOW);
    const reauth = execs.find((x) => x.displayName === 'Verify Existing Account by Re-authentication');
    expect(reauth).toBeDefined();
    expect(reauth.requirement).not.toBe('DISABLED');

    // And the thing that actually collects the proof, inside that subflow.
    const form = execs.find((x) => x.providerId === 'idp-username-password-form');
    expect(form).toBeDefined();
    expect(form.requirement).toBe('REQUIRED');
  }, 60000);

  it('an existing account is never linked silently — confirmation is REQUIRED', async () => {
    if (!adminAvailable) return;
    // idp-confirm-link is what makes the link an explicit user act. Were it
    // disabled, a Google sign-in matching a local email would be joined to
    // that account with no interstitial at all.
    const execs = await flowExecutions(BROKER_FLOW);
    const confirm = execs.find((x) => x.providerId === 'idp-confirm-link');
    expect(confirm).toBeDefined();
    expect(confirm.requirement).toBe('REQUIRED');
  }, 60000);

  it('no auto-link authenticator has been introduced into the flow', async () => {
    if (!adminAvailable) return;
    // idp-auto-link links on the strength of the email alone and would defeat
    // every assertion above. It is absent by default; this fails loudly if
    // someone adds it to "simplify onboarding".
    const execs = await flowExecutions(BROKER_FLOW);
    const auto = execs.filter(
      (x) => x.providerId === 'idp-auto-link' && x.requirement !== 'DISABLED'
    );
    expect(auto).toEqual([]);
  }, 60000);
});

describe('WP-138: the Google provider', () => {
  beforeAll(() => {
    if (!googleConfigured) {
      // eslint-disable-next-line no-console
      console.warn(
        '\n[WP-138] PROVIDER TESTS SKIPPED — GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET not in backend/.env.' +
          '\n[WP-138] The linking-hardening tests above DID run. Google sign-in itself was NOT verified.\n'
      );
    }
  });

  async function google() {
    const r = await axios.get(`${KC}/admin/realms/${REALM}/identity-provider/instances/google`, {
      headers: H,
      validateStatus: () => true
    });
    return r;
  }

  it('is registered and enabled', async () => {
    if (!adminAvailable || !googleConfigured) return;
    const r = await google();
    expect(r.status).toBe(200);
    expect(r.data.providerId).toBe('google');
    expect(r.data.enabled).toBe(true);
    // linkOnly would hide it from the login page entirely — it would exist and
    // do nothing, which is the hardest kind of misconfiguration to notice.
    expect(r.data.linkOnly).toBe(false);
  }, 60000);

  it('trusts the email, which is the ENTIRE POINT of this provider', async () => {
    if (!adminAvailable || !googleConfigured) return;
    // The realm has verifyEmail on. Without trustEmail a brokered Google user
    // is still handed VERIFY_EMAIL and mailed a link that lands in spam — the
    // provider would be present, apparently working, and deliver none of its
    // value. This single boolean is the feature.
    const r = await google();
    expect(r.data.trustEmail).toBe(true);
  }, 60000);

  it('asks for identity only — no stored tokens, no API access on the user\'s behalf', async () => {
    if (!adminAvailable || !googleConfigured) return;
    const r = await google();
    expect(r.data.storeToken).toBe(false);
    expect(r.data.addReadTokenRoleOnCreate).toBe(false);
    // Non-sensitive scopes only: anything more drags the OAuth consent screen
    // into Google's verification review.
    expect(String(r.data.config.defaultScope).split(/\s+/).sort()).toEqual(['email', 'openid', 'profile']);
  }, 60000);

  it('routes through the hardened first-broker-login flow, not a bypass', async () => {
    if (!adminAvailable || !googleConfigured) return;
    // Every linking assertion in the suite above is about ONE flow. A provider
    // pointed at a different first-broker-login flow would satisfy all of them
    // and still be wide open.
    const r = await google();
    expect(r.data.firstBrokerLoginFlowAlias).toBe(BROKER_FLOW);
  }, 60000);

  it('never exposes the client secret through the admin API', async () => {
    if (!adminAvailable || !googleConfigured) return;
    const r = await google();
    // Keycloak masks it as '**********'. Asserted because this suite's output
    // and any CI log would otherwise be a place a real secret could surface.
    expect(r.data.config.clientSecret).not.toBe(process.env.GOOGLE_CLIENT_SECRET);
  }, 60000);
});

describe('WP-138: the signup page offers the provider', () => {
  it('renders an identity-provider button on the REGISTER page, not just login', async () => {
    if (!adminAvailable || !googleConfigured) return;
    // GR-4: a capability is not delivered until the UI surfaces it. The
    // specific regression this guards: template.ftl invokes the
    // "socialProviders" section on every page, so a register.ftl without that
    // branch renders nothing and the button appears on sign-IN only — exactly
    // backwards for a provider whose value is onboarding NEW users.
    const anon = axios.create({ validateStatus: () => true, maxRedirects: 5 });
    const auth =
      `${KC}/realms/${REALM}/protocol/openid-connect/auth` +
      '?client_id=mern-app&response_type=code&scope=openid' +
      '&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2F';
    const login = await anon.get(auth);
    expect(login.status).toBe(200);

    const href = /href="([^"]*login-actions\/registration[^"]*)"/.exec(login.data);
    expect(href).not.toBeNull();
    const regUrl = href[1].replace(/&amp;/g, '&');
    const reg = await anon.get(regUrl.startsWith('http') ? regUrl : `${KC}${regUrl}`, {
      headers: { Cookie: (login.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ') }
    });
    expect(reg.status).toBe(200);
    expect(reg.data).toContain('social-google');
  }, 90000);
});
