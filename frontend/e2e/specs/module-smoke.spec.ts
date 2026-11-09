// Wave A-3 (Task 2, D-series test debt). Permanent regression coverage
// consolidated from six temporary screenshot harnesses --
// `_chrome-shot.spec.ts`, `_defect-shot.spec.ts`, `_list-shot.spec.ts`,
// `_plan-run-shot.spec.ts`, `_req-shot.spec.ts`, `_workbench-shot.spec.ts` --
// all deleted by this change. Those specs existed only to let an
// orchestrator SEE a screenshot of each newly-migrated module against the
// live stack during WP-074 through WP-078; the screenshots themselves carry
// no regression value once reviewed, but three of those specs (chased down
// in EXECUTION_LOG.md's 2026-09-03 entries) caught REAL bugs a fully green
// jsdom suite never saw: a detail view crashing on real seeded data,
// straight into `RegionErrorBoundary`'s "Something went wrong" fallback.
// That crash-detection value is what this spec keeps, permanently, for
// every migrated module -- not the screenshots.
//
// For each of the five migrated modules (Test Cases, Requirements, Test
// Plans, Test Runs, Defects) this:
//   1. opens that module in the workbench (via the rail, not a fresh
//      cold-load per module -- see the navigation note below)
//   2. asserts the tree renders
//   3. opens the first real entity found in the tree
//   4. asserts its detail view actually rendered (a heading is visible)
//      AND that it did NOT crash into RegionErrorBoundary's fallback --
//      this is the assertion that matters, per this WP's own brief:
//      "three real bugs in this wave were caught by a detail view crashing
//      against real data, and a green jsdom suite never saw any of them."
//
// Read-only by design: no test here creates, edits, or deletes anything --
// only navigation and tree/detail queries (GETs the app's own hooks already
// issue on render). This suite runs against project 1's SEEDED data as-is.
//
// Known, deliberately untouched seeded drift (D4,
// docs/superpowers/PRODUCT_GAP_REGISTER.md): TC-2 sits in folder `test44`
// instead of at the tree root, left by an earlier temporary drag-and-drop
// spec whose restore step failed. This spec does not depend on which
// specific entity is "first" in any module's tree -- it accepts whichever
// leaf it finds -- so that drift neither breaks this spec nor needs fixing
// here. Do not "fix" it as a side effect of touching this file.
//
// Navigation note: identical constraint every other spec in this suite
// documents -- package.json's "homepage": "." makes CRA/webpack-dev-server
// emit a RELATIVE <script src="main.bundle.js">, so a cold page.goto() of
// any deep URL never boots the app. Land on '/' first, then reach each
// module via the SPA's own client-side router: the dashboard's "View
// assigned tests" link (always rendered, even for this suite's
// 'contributor' persona -- see test-execution.spec.ts's matching comment)
// lands in the workbench once, then ModuleRail's own buttons (real
// accessible names, WP-072) switch modules from there without re-navigating
// from a cold '/' each time.
import { test, expect, Page } from '@playwright/test';
import { assertApiReachable } from '../support/requireApi';

const MODULES: Array<{ label: string; slug: string }> = [
  { label: 'Test Cases', slug: 'testcases' },
  { label: 'Requirements', slug: 'requirements' },
  { label: 'Test Plans', slug: 'testplans' },
  { label: 'Test Runs', slug: 'testruns' },
  { label: 'Defects', slug: 'defects' },
];

// Finds and clicks the first LEAF node (no aria-expanded attribute at all --
// EntityTreeNode.tsx's header comment documents this exact distinction
// between a branch and a leaf in react-accessible-treeview), expanding
// folders along the way if the root only has folders. Returns the clicked
// leaf's text, or null if none was found. Ported verbatim from the
// _req-shot/_defect-shot/_plan-run-shot harnesses this spec replaces.
async function openFirstLeaf(page: Page): Promise<string | null> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const items = page.getByRole('treeitem');
    const count = await items.count();
    for (let i = 0; i < count; i += 1) {
      const item = items.nth(i);
      const ariaExpanded = await item.getAttribute('aria-expanded');
      if (ariaExpanded === null) {
        const text = (await item.textContent())?.trim() ?? null;
        await item.click();
        return text;
      }
    }
    let expandedOne = false;
    for (let i = 0; i < count; i += 1) {
      const item = items.nth(i);
      if ((await item.getAttribute('aria-expanded')) === 'false') {
        await item.click();
        expandedOne = true;
        await page.waitForTimeout(1000);
        break;
      }
    }
    if (!expandedOne) break;
  }
  return null;
}

for (const { label, slug } of MODULES) {
  test(`${label} (module) -- tree renders, and the first entity's detail view renders without a RegionErrorBoundary crash`, async ({ page }) => {
    test.setTimeout(90000);

    await page.goto('/');
    await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 15000 });
    await page.getByRole('link', { name: 'View assigned tests →' }).click();
    await page.waitForURL(/\/projects\/1\/workbench\/testruns/, { timeout: 15000 });

    await assertApiReachable(page);

    // Test Runs is already the landing module; every other module switches
    // via the rail's own real, accessibly-named buttons (ModuleRail.tsx).
    if (slug !== 'testruns') {
      await page.getByRole('button', { name: label }).click();
      await page.waitForURL(new RegExp(`/projects/1/workbench/${slug}`), { timeout: 15000 });
    }

    // 1. The tree renders.
    const tree = page.getByRole('tree');
    await expect(tree).toBeVisible({ timeout: 30000 });
    await page.waitForTimeout(1000); // let the root query's children settle

    // 2. Open the first real entity this module's tree offers.
    const leafText = await openFirstLeaf(page);
    expect(leafText, `${label}: no leaf entity found in the tree -- nothing to open`).not.toBeNull();

    // 3. The detail view actually rendered real content...
    const detailRegion = page.getByTestId('workbench-detail');
    await expect(detailRegion).toBeVisible({ timeout: 15000 });
    // Give the entity fetch (getFields/get<Module>List against the live
    // backend) a moment to resolve before checking either assertion below.
    await page.waitForTimeout(2000);
    await expect(detailRegion.getByRole('heading').first()).toBeVisible({ timeout: 15000 });

    // 4. ...and, the assertion that matters (see this file's header
    // comment): it did NOT crash into RegionErrorBoundary's fallback.
    // RegionErrorBoundary.tsx's exact fallback text, scoped to the whole
    // page (not just `detailRegion`) -- a crash replaces the boundary's
    // entire subtree, which can take `workbench-detail`'s own testid with
    // it depending on exactly where in the tree the boundary sits.
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  });
}

// Wave B-2 (workbench search, PRODUCT_GAP_REGISTER.md A2) -- the "search"
// panel mode's real implementation against the live stack. Test Cases
// (module 1) has a genuine backend wildcard-search route
// (testRepoService's GET /api/v1/testrepo/wildcardsearch), unlike Test
// Plans/Test Runs (modules 3/4), so this is where an end-to-end proof
// belongs.
//
// Read-only, same discipline as the rest of this file: the id searched for
// is discovered live from the tree (never assumed/hardcoded) via a
// read-only variant of `openFirstLeaf` that only expands folders --
// expanding is a pure UI-state change, not a mutation -- and never clicks
// the leaf itself, so no tab exists before the search does the opening.
async function findFirstLeafText(page: Page): Promise<string | null> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const items = page.getByRole('treeitem');
    const count = await items.count();
    for (let i = 0; i < count; i += 1) {
      const item = items.nth(i);
      const ariaExpanded = await item.getAttribute('aria-expanded');
      if (ariaExpanded === null) {
        return (await item.textContent())?.trim() ?? null;
      }
    }
    let expandedOne = false;
    for (let i = 0; i < count; i += 1) {
      const item = items.nth(i);
      if ((await item.getAttribute('aria-expanded')) === 'false') {
        await item.click();
        expandedOne = true;
        await page.waitForTimeout(1000);
        break;
      }
    }
    if (!expandedOne) break;
  }
  return null;
}

test('Search panel mode -- searching a real seeded test case id surfaces it and opens it as a tab', async ({ page }) => {
  test.setTimeout(90000);

  await page.goto('/');
  await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 15000 });
  await page.getByRole('link', { name: 'View assigned tests →' }).click();
  await page.waitForURL(/\/projects\/1\/workbench\/testruns/, { timeout: 15000 });

  await assertApiReachable(page);

  await page.getByRole('button', { name: 'Test Cases' }).click();
  await page.waitForURL(/\/projects\/1\/workbench\/testcases/, { timeout: 15000 });

  const tree = page.getByRole('tree');
  await expect(tree).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(1000); // let the root query's children settle

  const leafId = await findFirstLeafText(page);
  expect(leafId, 'Test Cases: no leaf entity found in the tree -- nothing to search for').not.toBeNull();

  // No tab is open yet for this id -- confirms whatever tab appears below
  // came from the search selection, not a pre-existing one.
  await expect(page.getByRole('tab', { name: leafId! })).toHaveCount(0);

  // Switch tree -> search (SourcePanel.tsx's PanelModeToggle) and search
  // for the id the tree itself just reported.
  await page.getByRole('button', { name: 'Search view' }).click();
  const searchBox = page.getByRole('searchbox', { name: /search test cases/i });
  await expect(searchBox).toBeVisible({ timeout: 15000 });
  await searchBox.fill(leafId!);

  const escapedId = leafId!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const result = page.getByRole('button', { name: new RegExp(escapedId) });
  await expect(result).toBeVisible({ timeout: 15000 });
  await result.click();

  // Selecting a search result opens it as a tab, exactly like selecting a
  // tree node does (EntitySearchPanel.tsx reuses setSelection/openTab, not
  // a parallel path) -- the real <Tab> (TabStrip.tsx) for this id now
  // exists and is visible.
  await expect(page.getByRole('tab', { name: leafId! })).toBeVisible({ timeout: 15000 });
});
