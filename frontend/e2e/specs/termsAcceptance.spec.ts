import { test, expect } from '@playwright/test';
import { createE2EPersona } from '../auth/persona';

// WP-130's terms gate, covered ON PURPOSE.
//
// WHY THIS FILE EXISTS. TERMS_AND_CONDITIONS is a realm DEFAULT required
// action (WP-130, commit 2feb0fe sets `enabled: true, defaultAction: true`),
// so Keycloak attaches it to every newly created user. That means every
// genuinely new human hits this page before they ever reach the app.
//
// Until now nothing exercised it, and worse, nothing asserted it was even
// switched ON. It was only ever worked AROUND: auth/persona.ts and
// backend/shared/test-utils/keycloakTestPersona.js both clear
// requiredActions so their fixtures can log in. That combination is the
// dangerous one -- the gate could be disabled on the realm to make a test
// pass and the entire suite would stay green while live signup quietly
// stopped asking anyone to accept anything. The only symptom would be legal,
// and it would arrive late.
//
// So this spec deliberately takes a persona WITHOUT the usual clearing
// (`keepRequiredActions: true`) and drives the real page, which is the only
// way to assert the gate exists rather than assert a config flag that a
// restored realm export could silently differ on.
//
// SCOPE, deliberately narrow. This asserts the gate is PRESENT and that
// accepting it lets a user through. It does not assert the terms COPY: there
// isn't any yet. The page currently renders Keycloak's placeholder, "Terms
// and conditions to be defined", because WP-155 (writing the actual terms)
// is still open. That is a real launch blocker and it is called out in
// LAUNCH_PLAN.md, not something to paper over with a test that pretends the
// placeholder is acceptable content.

test.describe('WP-130: the terms gate on a brand-new account', () => {
  // Each test logs in as its own throwaway persona, so this file must not
  // reuse global-setup's storageState (that persona is already past terms,
  // by design -- see auth/persona.ts).
  test.use({ storageState: { cookies: [], origins: [] } });

  test('a new user is stopped at terms, and accepting it lets them into the app', async ({ page }) => {
    const persona = await createE2EPersona('terms-accept', 'contributor', {
      keepRequiredActions: true
    });

    try {
      await page.goto('/');
      // keycloak-js's onLoad:'login-required' bounces straight to Keycloak's
      // own hosted login page.
      await page.waitForURL(/\/realms\/srckube\/protocol\/openid-connect\/auth/, { timeout: 20000 });

      await page.locator('input[name="username"]').fill(persona.username);
      await page.locator('input[name="password"]').fill(persona.password);
      await page.locator('button#login').click();

      // THE GATE. Correct credentials are NOT enough: Keycloak diverts to the
      // required-action page instead of returning to the app. This is exactly
      // what broke the e2e global setup before auth/persona.ts cleared
      // requiredActions, so pinning it here means the next person to meet
      // that timeout finds the cause documented rather than re-deriving it.
      await page.waitForURL(/\/login-actions\/required-action/, { timeout: 20000 });
      expect(page.url()).toContain('execution=TERMS_AND_CONDITIONS');

      // Both choices must be offered. A gate with no Decline is not consent.
      const accept = page.locator('input[name="accept"], #kc-accept, button[name="accept"]').first();
      const decline = page.locator('input[name="cancel"], #kc-decline, button[name="cancel"]').first();
      await expect(accept).toBeVisible();
      await expect(decline).toBeVisible();

      await accept.click();

      // Accepting clears the required action and completes the original
      // authorization-code flow, landing back on the app's own origin.
      await page.waitForURL((url) => url.origin === new URL(page.url()).origin && !url.pathname.includes('/realms/'), {
        timeout: 20000
      });
      await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 20000 });

      // ...and it is a real authenticated session, not just a redirect: the
      // nav is mounted from real route config. The drawer starts collapsed
      // (1befece), so the label is present but hidden -- assert presence, not
      // visibility, because this spec is about the gate, not the drawer.
      await expect(page.getByText('Home', { exact: true })).toHaveCount(1);
    } finally {
      await persona.cleanup();
    }
  });

  test('the gate is actually ON for new accounts, not merely configured', async ({ page }) => {
    // Separate from the test above because they fail for different reasons
    // and a reader needs to tell them apart: this one failing means the realm
    // stopped applying the required action to new users at all (someone turned
    // defaultAction off), which is the silent-regression case. The one above
    // failing means the page itself is broken.
    const persona = await createE2EPersona('terms-gate', 'contributor', {
      keepRequiredActions: true
    });

    try {
      await page.goto('/');
      await page.waitForURL(/\/realms\/srckube\/protocol\/openid-connect\/auth/, { timeout: 20000 });
      await page.locator('input[name="username"]').fill(persona.username);
      await page.locator('input[name="password"]').fill(persona.password);
      await page.locator('button#login').click();

      // If TERMS_AND_CONDITIONS were disabled as a realm default, this login
      // would succeed straight through to the dashboard and this assertion
      // would fail -- which is precisely the alarm this spec is here to raise.
      await expect(page).toHaveURL(/execution=TERMS_AND_CONDITIONS/, { timeout: 20000 });
    } finally {
      await persona.cleanup();
    }
  });
});
