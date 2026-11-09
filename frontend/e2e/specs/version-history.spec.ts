import { test, expect } from '@playwright/test';
import { assertApiReachable } from '../support/requireApi';

// WP-F02 -- the dialog already listed versions and dates. This asserts the
// thing that was missing: a reader can see what a version CONTAINED.
test('a test case version history shows what each version contained', async ({ page }) => {
  test.setTimeout(90000);

  await page.goto('/');
  await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 20000 });
  await assertApiReachable(page);
  await page.getByRole('link', { name: 'Workbench' }).click();
  await page.waitForURL(/\/projects\/1\/workbench\/testcases/, { timeout: 20000 });

  await page.getByRole('button', { name: 'Search view' }).click();
  await page.getByRole('searchbox', { name: /search test cases/i }).fill('TC-1');
  const hit = page.getByRole('button', { name: /^TC-1(?!\d)/ });
  await expect(hit.first()).toBeVisible({ timeout: 20000 });
  await hit.first().click();

  await page.getByRole('button', { name: /history/i }).click();
  const firstVersion = page.getByRole('button', { name: /Version \d/ }).first();
  await expect(firstVersion).toBeVisible({ timeout: 20000 });

  await firstVersion.click();
  // The real assertion: a step count is on screen, which is what makes a
  // dropped-steps edit visible at all.
  await expect(page.getByText(/\d+ steps?$/).first()).toBeVisible({ timeout: 20000 });
});
