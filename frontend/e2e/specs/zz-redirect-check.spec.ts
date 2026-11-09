import { test, expect } from '@playwright/test';

// WP-074 Step 7. Deep page.goto() is avoided deliberately: package.json's
// "homepage": "." emits a RELATIVE <script src="main.bundle.js">, so a cold
// load of any deep URL never boots the app (see _workbench-shot.spec.ts).
// The flat /testrepo entry point is shallow, boots fine, and exercises the
// WHOLE chain: LegacyRedirect -> /projects/1/testrepo -> TestRepoRedirect
// -> /projects/1/workbench/testcases.
test('flat /testrepo chains through the project-scoped redirect into the workbench', async ({ page }) => {
  await page.goto('/testrepo');
  await page.waitForURL(/\/projects\/\d+\/workbench\/testcases/);
  await expect(page.getByRole('tree')).toBeVisible();
});

test('the redirect chain preserves the query string', async ({ page }) => {
  await page.goto('/testrepo?foo=bar');
  await page.waitForURL(/\/projects\/\d+\/workbench\/testcases/);
  await expect(page.getByRole('tree')).toBeVisible();
  expect(page.url()).toContain('foo=bar');
});

// WP-077 Step 4 — same chain, now for Defects: flat /defects ->
// LegacyRedirect (unchanged) -> /projects/1/defects ->
// WorkbenchModuleRedirect (App.tsx, WP-077) -> /projects/1/workbench/defects.
// /defects is shallow (one segment) so a cold page.goto() boots fine, same
// reasoning as /testrepo above (see this file's own header comment on why
// a deep multi-segment page.goto() cannot be used instead).
test('flat /defects chains through the project-scoped redirect into the workbench', async ({ page }) => {
  await page.goto('/defects');
  await page.waitForURL(/\/projects\/\d+\/workbench\/defects/);
  await expect(page.getByRole('tree')).toBeVisible();
});

// WP-077 Step 4 — the thing most likely to break in this cutover: the
// dashboard's own `?assignedTo=`/`severity=` drill-down links
// (dashboardLinks.ts's myOpenDefectsLink/defectsBySeverityLink) still need
// to land on DefectFilterPanel's filtered list, not the unfiltered tree,
// now that <EntityDetail> (not Pages/defects.tsx) is what mounts module 5.
// EntityDetail.tsx renders DefectFilterPanel BEFORE its tab-dispatch branch
// whenever a recognized filter param is present and no tab is open (see
// App.tsx/EntityDetail.tsx's own WP-077 comments and
// workbench/__tests__/EntityDetail.test.tsx for the jest-level proof) --
// this is the same assertion made against real, live, seeded data instead
// of a mock. Read-only: DefectFilterPanel only fetches
// (api/apiCalls.ts's getDefectList), it never mutates a seeded record.
test('the dashboard drill-down survives the redirect chain into a filtered defects list', async ({ page }) => {
  await page.goto('/defects?severity=High');
  await page.waitForURL(/\/projects\/\d+\/workbench\/defects/);
  expect(page.url()).toContain('severity=High');
  await expect(page.getByTestId('defect-filter-panel')).toBeVisible();
  // The unfiltered tree (what a plain /defects visit shows, proven by the
  // test above) must NOT also be rendered underneath the filter panel --
  // EntityDetail's drill-down branch returns early instead of falling
  // through to the module-5 tab dispatch.
  await expect(page.getByRole('tree')).not.toBeVisible();
});
