// WP-F19 -- the two navigation gaps the owner reported by using the tool:
// the workbench had no drawer entry at all, and the module rail was too
// small to read as navigation.
//
// These assertions live in Playwright rather than jsdom for a specific
// reason, not convenience: Components/NavBar/__tests__/MainDrawer.test.tsx
// is one of the 35 frontend suites that FAIL TO RUN on the pre-existing
// keycloak-js ESM parse error (MainDrawer.tsx imports Components/Menu/
// userMenu.tsx, which imports src/keycloak.js). That suite's expectations
// were updated for the new entry, but jest cannot execute them here, so a
// browser test is the only verification available -- see the gap register's
// WP-F01 entry for the 35-suite finding.
//
// Selectors are read from source: MainDrawer renders each nav item as a
// ListItemText inside a react-router <Link>, so the accessible name is the
// label; ModuleRail.tsx gives its <nav> aria-label="Modules" and
// data-testid="workbench-module-rail".
import { test, expect } from '@playwright/test';
import { assertApiReachable } from '../support/requireApi';

test('the drawer has a Workbench entry, and it lands in the workbench', async ({ page }) => {
  test.setTimeout(90000);

  await page.goto('/');
  await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 15000 });
  await assertApiReachable(page);

  // The gap: before WP-F19 the workbench was reachable only from a
  // dashboard drill-down link, a legacy redirect, or a typed URL. The rail
  // that navigates between modules renders INSIDE the workbench
  // (Workbench.tsx), so it could never be the way in.
  const workbenchLink = page.getByRole('link', { name: 'Workbench' });
  await expect(workbenchLink).toBeVisible({ timeout: 15000 });
  await workbenchLink.click();

  await page.waitForURL(/\/projects\/1\/workbench\/testcases/, { timeout: 15000 });
  await expect(page.getByTestId('workbench-module-rail')).toBeVisible({ timeout: 15000 });
});

test('the drawer still does not carry the five retired per-module entries', async ({ page }) => {
  test.setTimeout(90000);

  await page.goto('/');
  await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 15000 });

  // WP-078's recorded decision stands: those five duplicated rail entries
  // under mismatched labels ("Test Repository" vs the rail's "Test Cases",
  // and so on), which was the actual source of confusion. WP-F19 adds ONE
  // area entry; it does not put the modules back.
  for (const label of ['Test Repository', 'Test Execution', 'Defect', 'Test Plan', 'Requirements']) {
    await expect(page.getByRole('link', { name: label, exact: true })).toHaveCount(0);
  }
});

test('the module rail is wide enough to read, and every module is labelled', async ({ page }) => {
  test.setTimeout(90000);

  // Same preamble as the specs above rather than a direct deep-link goto:
  // going straight to the workbench URL races the auth redirect, and
  // assertApiReachable's in-page cross-origin fetch then runs before the
  // app origin has settled. Reaching it through the drawer entry also
  // exercises the real path a user takes.
  await page.goto('/');
  await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 15000 });
  await assertApiReachable(page);
  await page.getByRole('link', { name: 'Workbench' }).click();
  await page.waitForURL(/\/projects\/1\/workbench\/testcases/, { timeout: 15000 });

  const rail = page.getByTestId('workbench-module-rail');
  await expect(rail).toBeVisible({ timeout: 15000 });

  // The rail was 96px with a 12px caption, so "Requirements" and "Test
  // Plans" wrapped and read as decoration. 148px is the WP-F19 width; the
  // assertion is a floor, not an equality, so a later design change that
  // makes it roomier still passes.
  const box = await rail.boundingBox();
  expect(box, 'the module rail should have a layout box').not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(140);

  // Every module is reachable by its visible label -- the accessible name
  // is still exactly MODULE_LABELS[moduleId], unchanged by the resize.
  for (const label of ['Test Cases', 'Requirements', 'Test Plans', 'Test Runs', 'Defects', 'Releases']) {
    await expect(rail.getByRole('button', { name: label, exact: true })).toBeVisible();
  }
});
