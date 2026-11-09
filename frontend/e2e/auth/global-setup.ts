// WP-063 — runs once before the whole Playwright suite. Creates a real,
// disposable Keycloak user (see persona.ts's header comment for why this
// is the only viable approach — the service account cannot log into a
// browser session), drives the REAL Keycloak-hosted login form (not a
// stub: `src/index.tsx`'s `keycloak.init({ onLoad: 'login-required' })`
// redirects an unauthenticated session to Keycloak's own
// `/realms/srckube/protocol/openid-connect/auth` page, which this
// function navigates and fills exactly as a human would), and saves the
// resulting authenticated browser storage state to disk so every spec
// file can start already logged in via Playwright's `storageState` option
// instead of repeating the login flow per-test.
import { chromium, FullConfig, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { createE2EPersona } from './persona';

const AUTH_DIR = path.join(__dirname, '..', '.auth');
export const STORAGE_STATE_PATH = path.join(AUTH_DIR, 'user.json');
const RUNTIME_STATE_PATH = path.join(AUTH_DIR, 'persona-runtime.json');

export default async function globalSetup(config: FullConfig) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const baseURL = config.projects[0]?.use?.baseURL || 'http://localhost:3000';

  const persona = await createE2EPersona('main');
  // Persisted so global-teardown.ts (a separate process invocation) can
  // clean this persona up without re-deriving it.
  fs.writeFileSync(RUNTIME_STATE_PATH, JSON.stringify({ userId: persona.userId }), 'utf-8');

  const browser = await chromium.launch();
  const page = await browser.newPage();

  await page.goto(baseURL, { waitUntil: 'load' });
  // keycloak-js's onLoad:'login-required' redirects immediately; give it a
  // moment to land on Keycloak's own hosted login page.
  await page.waitForURL(/\/realms\/srckube\/protocol\/openid-connect\/auth/, { timeout: 15000 });
  await expect(page).toHaveTitle(/Sign in/i);

  await page.locator('input[name="username"]').fill(persona.username);
  await page.locator('input[name="password"]').fill(persona.password);
  await page.locator('button#login').click();

  // Successful login redirects back to the app's own origin (mern-app's
  // registered redirect URI is exactly "http://localhost:3000/*").
  await page.waitForURL((url) => url.origin === new URL(baseURL).origin, { timeout: 15000 });
  // Give the SPA a beat to finish keycloak-js's token exchange + first
  // React render before snapshotting storage state.
  await page.waitForTimeout(1000);

  await page.context().storageState({ path: STORAGE_STATE_PATH });
  await browser.close();
}
