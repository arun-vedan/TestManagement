// Wave B-3/B-4 -- extracted from e2e/auth/global-setup.ts's own login
// sequence (lines ~34-49) so a spec that needs a SECOND, differently-
// privileged persona (e.g. entity-creation.spec.ts's delete/clone journey,
// which needs a 'manager' rather than the suite's shared 'contributor')
// can drive the same real Keycloak-hosted login form on a fresh browser
// context, without touching the shared storageState every other spec
// reuses. Not a stub: this navigates the actual
// `/realms/srckube/protocol/openid-connect/auth` page and types real
// credentials into the real form, exactly like global-setup.ts does.
import { Page, expect } from '@playwright/test';

export interface LoginablePersona {
  username: string;
  password: string;
}

export async function loginAsPersona(page: Page, baseURL: string, persona: LoginablePersona): Promise<void> {
  await page.goto(baseURL, { waitUntil: 'load' });
  await page.waitForURL(/\/realms\/srckube\/protocol\/openid-connect\/auth/, { timeout: 15000 });
  await expect(page).toHaveTitle(/Sign in/i);

  await page.locator('input[name="username"]').fill(persona.username);
  await page.locator('input[name="password"]').fill(persona.password);
  await page.locator('button#login').click();

  await page.waitForURL((url) => url.origin === new URL(baseURL).origin, { timeout: 15000 });
  // Give the SPA a beat to finish keycloak-js's token exchange + first
  // React render, same as global-setup.ts.
  await page.waitForTimeout(1000);
}
