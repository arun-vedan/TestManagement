// WP-063 feasibility probe #3 — what does the REAL Keycloak login page
// (reached via keycloak-js's onLoad:'login-required' redirect) actually
// look like in this environment? This dev realm uses a custom Quasar-based
// theme (see repo-root keycloak-themes/), not Keycloak's stock theme, so
// the usual id="username"/id="kc-login" guesses don't apply -- this probe
// found the real, stable selectors used by e2e/auth/global-setup.ts:
//   input[name="username"], input[name="password"], button#login
// Run: node e2e/feasibility/probe-login-form.mjs   (from frontend/, dev
// server already running on :3000)
import { chromium } from '@playwright/test';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto('http://localhost:3000/', { waitUntil: 'load', timeout: 20000 });
await page.waitForTimeout(2000);
console.log('URL_AFTER_REDIRECT:', page.url());
console.log('TITLE:', await page.title());
console.log('HAS_username_field:', await page.locator('input[name="username"]').count());
console.log('HAS_password_field:', await page.locator('input[name="password"]').count());
console.log('HAS_login_button:', await page.locator('button#login').count());
await browser.close();
