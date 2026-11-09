const axios = require('axios');

// WP-137 regression guard — "an account is never created with zero credentials".
//
// WHY THIS EXISTS SEPARATELY FROM THE WP-137 WORK.
//
// WP-137 was verified by hand, over HTTP, and then left with no automated
// test. That was a gap, and the trigger for closing it is concrete: another
// session is editing keycloak-themes/themes/kdk/login/ for a rebrand, and
// register.ftl is a file whose auth-critical parts look cosmetic. The guard
// that puts the password fields on the form is a FreeMarker <#if> buried in
// template markup; deleting it is a one-line, visually plausible edit whose
// consequence is that signup silently starts creating accounts with no
// credentials again.
//
// WHAT MAKES THIS WORTH ASSERTING RATHER THAN TRUSTING: the behaviour depends
// on TWO things that live in different places and cannot see each other --
//
//   1. the template guard  <#if passwordRequired?? && ...>   (register.ftl)
//   2. the realm's registration-password-action config
//      always_set_password_on_register_form=true             (Postgres only)
//
// Neither is version-controlled together with the other. Realm config cannot
// be committed at all here, because scripts/keycloak-export.sh writes to a
// gitignored directory precisely so exports (which embed signing keys and
// password hashes) never land in git. So there is NO diff anybody could review
// that would catch this regressing. That is the shape of thing a test has to
// hold.
//
// It drives the real pages over HTTP rather than reading the .ftl, because
// reading the template would pass just as happily while the realm config was
// off -- and that exact combination is what produced the original defect.

const KC = process.env.TEST_KEYCLOAK_URL || 'http://localhost:8080';
const REALM = process.env.TEST_KEYCLOAK_REALM || 'srckube';
const CLIENT = process.env.TEST_KEYCLOAK_BROWSER_CLIENT || 'mern-app';

const AUTH_URL =
  `${KC}/realms/${REALM}/protocol/openid-connect/auth` +
  `?client_id=${encodeURIComponent(CLIENT)}&response_type=code&scope=openid` +
  '&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2F';

let loginHtml = null;
let registerHtml = null;
let reason = null;

function cookiesFrom(res) {
  return (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
}

beforeAll(async () => {
  const anon = axios.create({ validateStatus: () => true, timeout: 30000 });

  const login = await anon.get(AUTH_URL);
  if (login.status !== 200) {
    reason = `the login page returned HTTP ${login.status}`;
    return;
  }
  loginHtml = login.data;

  // Registration must be reachable FROM the login page. Constructing the URL
  // by hand would hide the case where the entry point disappears but the page
  // behind it still works -- a funnel nobody can enter.
  const href = /href="([^"]*login-actions\/registration[^"]*)"/.exec(loginHtml);
  if (!href) {
    reason = 'the login page has no link to registration (registrationAllowed off, or the entry point was removed)';
    return;
  }
  const url = href[1].replace(/&amp;/g, '&');
  const reg = await anon.get(url.startsWith('http') ? url : `${KC}${url}`, {
    headers: { Cookie: cookiesFrom(login) }
  });
  if (reg.status !== 200) {
    reason = `the registration page returned HTTP ${reg.status}`;
    return;
  }
  registerHtml = reg.data;
}, 90000);

function requirePages() {
  if (registerHtml === null) {
    throw new Error(
      `[WP-137] Could not reach the signup form: ${reason}. ` +
        'This is a FAILURE, not a skip — signup being unreachable is the thing ' +
        'this suite exists to catch.'
    );
  }
}

describe('WP-137: the signup form collects a password', () => {
  it('reaches the signup form from the login page at all', () => {
    // Deliberately a hard failure rather than a loud skip. Everything else
    // here is meaningless if the funnel's front door is gone, and a skip would
    // let that pass as green.
    requirePages();
    expect(registerHtml).toContain('kc-register-form');
  });

  it('renders BOTH password fields', () => {
    requirePages();
    // The acceptance, stated as the two field names Keycloak's
    // registration-password-action actually reads. Without these the POST
    // succeeds and creates an ENABLED account with ZERO credentials, pushed
    // onto an UPDATE_PASSWORD required action that depends on mail nobody
    // receives.
    expect(registerHtml).toContain('name="password"');
    expect(registerHtml).toContain('name="password-confirm"');
  });

  it('still collects the identifying profile fields alongside the password', () => {
    requirePages();
    // Guards the opposite failure from the one above: a template rewrite that
    // keeps the password block but drops the profile loop would produce a form
    // that cannot identify anybody.
    expect(registerHtml).toContain('name="username"');
    expect(registerHtml).toContain('name="email"');
  });

  it('seeds submitted values WITHOUT turning them into extra submitted fields', () => {
    requirePages();
    // The re-render seed (WP-137). Two properties matter and they pull in
    // opposite directions: the values must be present to survive a validation
    // error, and the seed inputs must carry no `name`, or every field is
    // posted twice.
    expect(registerHtml).toContain('id="register-seed"');
    const block = /<div id="register-seed"[^>]*>([\s\S]*?)<\/div>/.exec(registerHtml);
    expect(block).not.toBeNull();
    const seedInputs = block[1].match(/<input[^>]*>/g) || [];
    expect(seedInputs.length).toBeGreaterThan(0);
    seedInputs.forEach((tag) => {
      expect(tag).toContain('data-field=');
      expect(tag).not.toMatch(/\sname=/);
    });
  });

  it('keeps the typed values after a password mismatch', async () => {
    requirePages();
    // The likeliest error on this form, and the one whose regression is
    // invisible until a real person hits it. Asserted end to end because the
    // seed is only exercised on a re-render.
    const anon = axios.create({ validateStatus: () => true, timeout: 30000 });
    const login = await anon.get(AUTH_URL);
    const href = /href="([^"]*login-actions\/registration[^"]*)"/.exec(login.data);
    const regUrl = href[1].replace(/&amp;/g, '&');
    const cookie = cookiesFrom(login);
    const reg = await anon.get(regUrl.startsWith('http') ? regUrl : `${KC}${regUrl}`, {
      headers: { Cookie: cookie }
    });
    const action = /action="([^"]*registration[^"]*)"/.exec(reg.data);
    expect(action).not.toBeNull();

    const stamp = Date.now();
    const username = `wp137guard${stamp}`;
    const body = new URLSearchParams({
      username,
      email: `wp137guard+${stamp}@example.com`,
      firstName: "O'Brien",
      lastName: 'Guard',
      password: 'Abc12345!x',
      'password-confirm': 'DIFFERENT9!z'
    });
    const posted = await anon.post(action[1].replace(/&amp;/g, '&'), body.toString(), {
      headers: { Cookie: cookiesFrom(reg) || cookie, 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    // 200 means re-rendered with errors. A 302 here would mean the mismatch
    // was ACCEPTED, which is a far worse failure than a lost field.
    expect(posted.status).toBe(200);
    expect(posted.data).toMatch(/password-confirm/);
    // The typed values came back...
    expect(posted.data).toContain(username);
    // ...and an apostrophe survived the attribute escaping rather than
    // breaking the seed. ?js_string / ?json_string both get this wrong under
    // Keycloak's HTML auto-escaping; this is why the seed uses attributes.
    expect(posted.data).toContain('O&#39;Brien');
  }, 120000);
});

describe('WP-137/138: the identity-provider section never renders empty', () => {
  it('shows no provider heading when the realm has no identity providers', () => {
    requirePages();
    // Keycloak 26 leaves `social.providers` DEFINED but EMPTY, so a `??` test
    // renders a divider plus "Or sign up with" above nothing — a real
    // regression right after the 25->26 upgrade. Both pages must use
    // ?has_content. This assertion inverts once a provider exists, so it is
    // written to hold in whichever state the realm is in rather than assuming
    // zero providers.
    const providerConfigured = /id="social-[a-z0-9]/i.test(loginHtml) || /id="social-[a-z0-9]/i.test(registerHtml);
    if (providerConfigured) {
      // A provider exists: the heading SHOULD be there, on the signup page too.
      expect(registerHtml).toMatch(/sign up with|inscrivez-vous avec/i);
      return;
    }
    expect(loginHtml).not.toMatch(/Or sign in with/i);
    expect(registerHtml).not.toMatch(/Or sign up with/i);
  });
});
