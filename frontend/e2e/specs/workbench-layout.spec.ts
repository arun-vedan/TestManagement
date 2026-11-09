import { test, expect } from '@playwright/test';

// Regression guard for a bug the owner hit while reviewing: with two
// entity tabs open, clicking one did nothing and the app appeared stuck
// between the two tickets.
//
// ROOT CAUSE (not a loading bug at all): MainLayout's `fillHeight` branch
// -- used only by the workbench -- renders <Box component="main"
// sx={{ height: '100vh' }}> starting at y:0 with NO offset for the
// position="fixed" AppBar, which is 5vh tall. The non-fillHeight branch
// accidentally clears it with mt:'3vh'. So the workbench's top 5vh renders
// UNDERNEATH the AppBar, the entity tab strip sits exactly there, and the
// AppBar's toolbar intercepts every pointer event over it.
//
// Pre-existing since WP-078 Part A introduced fillHeight; it only became
// obvious once a user tried to work several tickets across tabs.
test('the workbench tab strip is not covered by the fixed app bar', async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto('/');
  await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 20000 });
  await page.getByRole('link', { name: 'Workbench' }).click();
  await page.waitForURL(/workbench\/testcases/, { timeout: 20000 });
  await page.waitForTimeout(2500);

  // Open one entity so the tab strip has a tab in it.
  await page.getByRole('treeitem').nth(1).click();
  await page.waitForTimeout(3000);

  const geom = await page.evaluate(() => {
    const header = document.querySelector('header.MuiAppBar-root') as HTMLElement | null;
    const tab = Array.from(document.querySelectorAll('[role="tab"]')).find((t) =>
      /^(TC|Req|PLN|Run|Bug)-/.test((t as HTMLElement).getAttribute('aria-label') || '')
    ) as HTMLElement | undefined;
    return {
      headerBottom: header ? header.getBoundingClientRect().bottom : null,
      tabTop: tab ? tab.getBoundingClientRect().top : null,
      tabLabel: tab ? tab.getAttribute('aria-label') : null
    };
  });

  expect(geom.tabTop, 'expected an entity tab to be open').not.toBeNull();
  expect(geom.headerBottom, 'expected the fixed AppBar to be present').not.toBeNull();
  // The tab must start at or below the app bar, or the bar eats its clicks.
  expect(geom.tabTop!).toBeGreaterThanOrEqual(geom.headerBottom!);
});

test('a second entity tab can actually be clicked and becomes selected', async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto('/');
  await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 20000 });
  await page.getByRole('link', { name: 'Workbench' }).click();
  await page.waitForURL(/workbench\/testcases/, { timeout: 20000 });
  await page.waitForTimeout(2500);

  const rows = page.getByRole('treeitem');
  await rows.nth(1).click();
  await page.waitForTimeout(2500);
  await rows.nth(2).click();
  await page.waitForTimeout(2500);

  const entityTabs = page.locator('[role="tab"][aria-label^="TC-"]');
  await expect(entityTabs).toHaveCount(2, { timeout: 15000 });

  // Target whichever tab is NOT currently selected, rather than assuming
  // an order -- opening an entity selects its own tab, and the strip's
  // ordering is not this spec's concern.
  const labels: string[] = [];
  for (let i = 0; i < 2; i++) labels.push((await entityTabs.nth(i).getAttribute('aria-label')) || '');
  let target = '';
  for (const l of labels) {
    const sel = await page.locator(`[role="tab"][aria-label="${l}"]`).getAttribute('aria-selected');
    if (sel !== 'true') target = l;
  }
  expect(target, 'expected exactly one of the two tabs to be unselected').not.toBe('');

  // The click the owner reported doing nothing.
  await page.locator(`[role="tab"][aria-label="${target}"]`).click({ timeout: 10000 });
  await expect(page.locator(`[role="tab"][aria-label="${target}"]`)).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
});

// Reported by the owner after the layout fix above: with tabs open across
// two modules, clicking a tab belonging to the OTHER module left the app
// showing neither ticket.
//
// ROOT CAUSE: Workbench.tsx derives the URL from `activeEntityIdForModule`,
// which yields the active tab's entityId ONLY when that tab's module equals
// the module in the URL slug. Activating a cross-module tab sets
// activeTabKey but nothing changes the URL's module, so the guard returns
// null and the sync effect navigates to the CURRENT module's bare route --
// dropping the entity and staying on the wrong module.
//
// Measured before the fix: from /workbench/testplans/PLN-259, clicking the
// TC-1824 tab produced two navigations, both to /workbench/testplans, and
// zero API calls.
test('clicking a tab from another module switches to that module and entity', async ({ page }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto('/');
  await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 20000 });
  await page.getByRole('link', { name: 'Workbench' }).click();
  await page.waitForURL(/workbench\/testcases/, { timeout: 20000 });
  const rail = page.getByTestId('workbench-module-rail');
  await page.waitForTimeout(2500);

  // Open a test case (module 1).
  await page.getByRole('treeitem').nth(1).click();
  await page.waitForTimeout(3000);
  const tcLabel = await page.locator('[role="tab"][aria-label^="TC-"]').first().getAttribute('aria-label');

  // Open a test plan (module 3), leaving the test-case tab open.
  await rail.getByRole('button', { name: 'Test Plans' }).click();
  await page.waitForURL(/workbench\/testplans/, { timeout: 20000 });
  await page.waitForTimeout(2500);
  await page.getByRole('treeitem').nth(0).click();
  await page.waitForTimeout(3000);
  await expect(page).toHaveURL(/workbench\/testplans\/PLN-/);

  // Now click the test-case tab. It must take us back to module 1 AND to
  // that entity -- not to the test-plan module's bare route.
  await page.locator(`[role="tab"][aria-label="${tcLabel}"]`).click({ timeout: 15000 });

  await expect(page).toHaveURL(new RegExp(`workbench/testcases/${tcLabel}`), { timeout: 15000 });
  await expect(page.getByRole('heading', { name: new RegExp(`^${tcLabel} : `) })).toBeVisible({ timeout: 15000 });
});

// The bug the owner kept hitting, and the one the two fixes above did NOT
// address: open a second entity and the app snaps back to the first.
//
// ROOT CAUSE: react-accessible-treeview fires onSelect for the node being
// DESELECTED as well as the one being selected -- its payload carries
// `isSelected` precisely so a handler can tell them apart. EntityTree's
// handleSelect ignored it and called openTab() for both, so clicking a
// second entity opened its tab and was immediately followed by a second
// openTab() for the previous one, which reset activeTabKey. The store was
// doing exactly what it was told.
//
// The same file already learned this for expansion -- handleExpand's own
// comment says "TreeView calls onExpand for both expand AND collapse
// actions" -- and guards it. Selection was missed.
//
// Traced live: clicking TC-695 with TC-1824 already open produced
//   openTab 1:TC-695  from 1:TC-1824
//   openTab 1:TC-1824 from 1:TC-695
// leaving activeTabKey on the first entity with zero navigations.
test('opening a second entity activates it, and does not snap back to the first', async ({ page }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto('/');
  await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 20000 });
  await page.getByRole('link', { name: 'Workbench' }).click();
  await page.waitForURL(/workbench\/testcases/, { timeout: 20000 });
  await page.waitForTimeout(2500);

  const rows = page.getByRole('treeitem');
  await rows.nth(1).click();
  await page.waitForTimeout(2500);
  const firstUrl = page.url();

  await rows.nth(2).click();
  await page.waitForTimeout(3000);

  // The URL must have moved to the second entity and stayed there.
  expect(page.url()).not.toBe(firstUrl);
  await expect(page).toHaveURL(/workbench\/testcases\/TC-/, { timeout: 10000 });

  const settled = page.url();
  await page.waitForTimeout(4000);
  expect(page.url(), 'the URL must not drift back after settling').toBe(settled);

  // And the store must agree: the active tab is the one just opened.
  const state = await page.evaluate(() => {
    const raw = localStorage.getItem('workbench:1');
    const s = raw ? JSON.parse(raw).state : null;
    return { activeTabKey: s?.activeTabKey ?? null, tabCount: (s?.tabs || []).length };
  });
  expect(state.tabCount).toBe(2);
  expect(settled).toContain(String(state.activeTabKey).split(':')[1]);
});

// WP-F21e Fix 3 -- none of the four tests above ever reload the page, and
// 4749bb0's entire bug is a mount/rehydration phenomenon that only shows up
// on a FRESH mount with tabs already persisted in localStorage: MUI's
// <Tabs> fires onChange during mount as it resolves its `value` against its
// children, and without the no-op guard in Workbench.tsx's onActivate every
// one of those internal firings was treated as a real tab click.
//
// Measured live before the guard existed: with tabs open across two
// modules, a reload produced ELEVEN navigations oscillating
// PLN-6 -> PLN-7 -> PLN-6 while the persisted activeTabKey never moved --
// the exact "app stuck flipping between two tickets" symptom this WP set
// out to fix, just triggered by a reload instead of a click.
test('reloading with tabs open across two modules does not oscillate the URL', async ({ page }) => {
  test.setTimeout(120000);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.goto('/');
  await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 20000 });
  await page.getByRole('link', { name: 'Workbench' }).click();
  await page.waitForURL(/workbench\/testcases/, { timeout: 20000 });
  const rail = page.getByTestId('workbench-module-rail');
  await page.waitForTimeout(2500);

  // Open two test cases (module 1).
  await page.getByRole('treeitem').nth(1).click();
  await page.waitForTimeout(2500);
  await page.getByRole('treeitem').nth(2).click();
  await page.waitForTimeout(3000);

  // Switch to test plans (module 3) and open two of them -- four tabs
  // total, spanning two modules, matching the exact configuration under
  // which the eleven-navigation oscillation was measured.
  await rail.getByRole('button', { name: 'Test Plans' }).click();
  await page.waitForURL(/workbench\/testplans/, { timeout: 20000 });
  await page.waitForTimeout(2500);
  await page.getByRole('treeitem').nth(0).click();
  await page.waitForTimeout(2500);
  await page.getByRole('treeitem').nth(1).click();
  await page.waitForTimeout(3000);
  await expect(page).toHaveURL(/workbench\/testplans\/PLN-/);

  const beforeReload = await page.evaluate(() => {
    const raw = localStorage.getItem('workbench:1');
    const s = raw ? JSON.parse(raw).state : null;
    return { activeTabKey: s?.activeTabKey ?? null, tabCount: (s?.tabs || []).length };
  });
  expect(beforeReload.tabCount).toBeGreaterThanOrEqual(4);
  expect(beforeReload.activeTabKey).not.toBeNull();

  // Attached BEFORE the reload, so it captures every navigation the
  // mount/rehydration path produces, not just the ones after we start
  // polling below.
  let navCount = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navCount += 1;
  });

  await page.reload();
  await page.waitForURL(/workbench\/testplans\/PLN-/, { timeout: 20000 });

  // Poll the URL through the settling window. If the guard is doing its
  // job, the URL that comes back from rehydration is the one it lands on
  // for good; if not, it flips between the two modules'/tickets' routes
  // the way it did live.
  const urlsSeen: string[] = [];
  for (let i = 0; i < 10; i++) {
    urlsSeen.push(page.url());
    await page.waitForTimeout(400);
  }
  const distinctUrls = new Set(urlsSeen);

  const afterReload = await page.evaluate(() => {
    const raw = localStorage.getItem('workbench:1');
    const s = raw ? JSON.parse(raw).state : null;
    return { activeTabKey: s?.activeTabKey ?? null };
  });

  // The persisted active tab must not have moved just because of a reload.
  expect(afterReload.activeTabKey).toBe(beforeReload.activeTabKey);
  expect(distinctUrls.size, `URL must settle, not oscillate; saw: ${[...distinctUrls].join(', ')}`).toBe(1);
  expect(page.url()).toContain(String(afterReload.activeTabKey).split(':')[1]);
  // Generous headroom over the ~2 navigations a clean reload produces
  // (the document load itself, plus the URL-sync effect's one `replace`),
  // while still well below the eleven that were measured with the guard
  // gone.
  expect(navCount, `expected only a couple of navigations on reload, saw ${navCount}`).toBeLessThanOrEqual(5);
});
