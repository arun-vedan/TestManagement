// WP-F01 (search parity for test plans and test runs) -- the browser proof
// that Task 5's brief calls for: a jsdom test proves the mapping, not that a
// user can actually find a plan or a run. Mirrors module-smoke.spec.ts's own
// "Search panel mode" journey (line 177) exactly -- same login/navigation
// preamble, same assertApiReachable() call, same module-switch-via-rail
// pattern, same tab assertion -- rather than inventing a second way to do
// the same thing.
//
// Selectors here are read from source, not guessed (module-smoke.spec.ts's
// existing search test already proves them against module 1):
//   - SourcePanel.tsx's PANEL_MODE_OPTIONS gives the search toggle the
//     accessible name "Search view" (a real MUI ToggleButton).
//   - EntitySearchPanel.tsx:54,77 makes the input role="searchbox" with
//     aria-label `Search ${entityLabelPlural}` -- "Search test plans" /
//     "Search test runs" here.
//   - A result row is a ListItemButton whose accessible name is
//     `${item.id} ${item.summary}` (MUI ListItemText) -- primary always
//     contains the id, so matching on the id (escaped) is enough regardless
//     of whether a summary is present.
//   - Selecting a result calls the same setSelection/openTab path a tree
//     node does, so a real <Tab> (TabStrip.tsx) appears for the id.
//   - EntitySearchPanel.tsx:44-50 renders `Search is not available for
//     ${MODULE_LABELS[module]} yet.` for any module absent from
//     moduleSearchConfigs -- module 6 (releases) has no entry
//     (entitySearchConfigs.ts:143) and never will until WP-F15 decides what
//     module 6 becomes.
//
// Live fixtures used (project 1, seeded): PLN-3 (of PLN-1..PLN-7) and Run-1
// (of Run-1..Run-14). Read-only: every test here only searches and opens a
// tab, exactly like module-smoke.spec.ts's own search test.
import { test, expect } from '@playwright/test';
import { assertApiReachable } from '../support/requireApi';

test('a test plan can be found by searching for its id, and opens as a tab', async ({ page }) => {
  test.setTimeout(90000);

  await page.goto('/');
  await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 15000 });
  await page.getByRole('link', { name: 'View assigned tests →' }).click();
  await page.waitForURL(/\/projects\/1\/workbench\/testruns/, { timeout: 15000 });

  await assertApiReachable(page);

  await page.getByRole('button', { name: 'Test Plans' }).click();
  await page.waitForURL(/\/projects\/1\/workbench\/testplans/, { timeout: 15000 });

  const planId = 'PLN-3';

  // No tab is open yet for this id -- confirms whatever tab appears below
  // came from the search selection, not a pre-existing one.
  await expect(page.getByRole('tab', { name: planId })).toHaveCount(0);

  await page.getByRole('button', { name: 'Search view' }).click();
  const searchBox = page.getByRole('searchbox', { name: /search test plans/i });
  await expect(searchBox).toBeVisible({ timeout: 15000 });
  await searchBox.fill(planId);

  // Anchored and followed by a non-digit (or end of string), same reasoning
  // as the test-run spec below: the live fixtures run PLN-1..PLN-7, so this
  // guards against the same kind of prefix collision even though none
  // exists today.
  const escapedId = planId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const result = page.getByRole('button', { name: new RegExp(`^${escapedId}(?!\\d)`) });
  await expect(result).toBeVisible({ timeout: 15000 });
  await result.click();

  await expect(page.getByRole('tab', { name: planId })).toBeVisible({ timeout: 15000 });
});

test('a test run can be found by searching for its id, with no assignee UUID shown', async ({ page }) => {
  test.setTimeout(90000);

  await page.goto('/');
  await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 15000 });
  await page.getByRole('link', { name: 'View assigned tests →' }).click();
  await page.waitForURL(/\/projects\/1\/workbench\/testruns/, { timeout: 15000 });

  await assertApiReachable(page);

  await page.getByRole('button', { name: 'Test Runs' }).click();
  await page.waitForURL(/\/projects\/1\/workbench\/testruns/, { timeout: 15000 });

  const runId = 'Run-1';

  await expect(page.getByRole('tab', { name: runId })).toHaveCount(0);

  await page.getByRole('button', { name: 'Search view' }).click();
  const searchBox = page.getByRole('searchbox', { name: /search test runs/i });
  await expect(searchBox).toBeVisible({ timeout: 15000 });
  await searchBox.fill(runId);

  // Anchored and followed by a non-digit (or end of string): the live
  // fixtures include Run-1 AND Run-10..Run-14, so an unanchored regex on
  // "Run-1" matches all five and trips Playwright's strict mode.
  const escapedId = runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const result = page.getByRole('button', { name: new RegExp(`^${escapedId}(?!\\d)`) });
  await expect(result).toBeVisible({ timeout: 15000 });

  // A run's search result line is deliberately empty (entitySearchConfigs.ts:
  // testRunSearchConfig) because assignedTo holds a raw Keycloak subject
  // UUID, not a name -- nobody types a UUID, and nobody should be shown one
  // as if it were a readable label. Assert the accessible name of the
  // result carries no UUID, so a regression that started surfacing the raw
  // assignedTo value would fail this test.
  const resultName = await result.evaluate((el) => el.textContent ?? '');
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  expect(resultName).not.toMatch(uuidPattern);

  await result.click();
  await expect(page.getByRole('tab', { name: runId })).toBeVisible({ timeout: 15000 });
});

test('releases still report that search is unavailable', async ({ page }) => {
  test.setTimeout(90000);

  await page.goto('/');
  await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 15000 });
  await page.getByRole('link', { name: 'View assigned tests →' }).click();
  await page.waitForURL(/\/projects\/1\/workbench\/testruns/, { timeout: 15000 });

  await assertApiReachable(page);

  // Scoped to the module rail (ModuleRail.tsx's own
  // data-testid="workbench-module-rail"): MainDrawer.tsx still carries a
  // "Releases" nav link elsewhere on the page, so an unscoped
  // getByRole('button', { name: 'Releases' }) is ambiguous (strict-mode
  // violation) in a way the other four module labels in this file are not.
  await page.getByTestId('workbench-module-rail').getByRole('button', { name: 'Releases' }).click();
  await page.waitForURL(/\/projects\/1\/workbench\/releases/, { timeout: 15000 });

  // Module 6 has no backend wildcardsearch route (entitySearchConfigs.ts
  // leaves it out of moduleSearchConfigs entirely). The panel must say so
  // explicitly rather than silently rendering nothing, which would read as
  // "no results" instead of "not offered".
  await page.getByRole('button', { name: 'Search view' }).click();
  await expect(page.getByText('Search is not available for Releases yet.')).toBeVisible({ timeout: 15000 });
  await expect(page.getByRole('searchbox')).toHaveCount(0);
});
