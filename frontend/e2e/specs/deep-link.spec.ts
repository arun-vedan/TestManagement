import { test, expect } from '@playwright/test';

// Wave A-2. Cold-loading a deep URL never booted the app: craco.config.js
// replaced webpack's output config and dropped `publicPath`, so the emitted
// <script src> was relative and resolved against the deep URL's own
// directory, returning index.html instead of the bundle. Every existing spec
// works around this by going to '/' first. THIS spec deliberately does not --
// that is the whole point.
test('a cold deep link boots the app', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));

  await page.goto('/projects/1/workbench/testcases');

  await expect(page.getByRole('tree')).toBeVisible({ timeout: 20000 });
  expect(errors.filter((e) => /Unexpected token/.test(e))).toEqual([]);
});

test('a cold deep link to a detail URL boots too', async ({ page }) => {
  await page.goto('/projects/1/workbench/requirements');
  await expect(page.getByRole('tree')).toBeVisible({ timeout: 20000 });
});
