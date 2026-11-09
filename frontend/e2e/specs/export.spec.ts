// Wave C-2 (Register A3) -- browser verification for CSV export. Confirms
// the real browser download event fires, the file's header row matches
// exactly what api/exportApi.ts's testCaseExportConfig defines (which is
// deliberately the same header names api/importApi.ts's ALLOWED_FIELDS
// uses, for round-trip with "Import CSV"), and that a real seeded test
// case id shows up in the body -- not a mocked network layer, the genuine
// paginated /api/v1/testrepo list endpoint against the live backend.
//
// READ-ONLY, same discipline module-smoke.spec.ts and its "Search panel
// mode" test document: this creates/edits/deletes nothing. Export is
// itself a read (CsvExportToolbar.tsx's own header comment), and the id
// used for the assertion is discovered live from the tree rather than
// hardcoded, exactly like module-smoke.spec.ts's findFirstLeafText -- so
// this test does not care whether that id is TC-1, TC-2 (which the
// project's own known seeded drift, docs/superpowers/
// PRODUCT_GAP_REGISTER.md D4, currently has sitting in folder `test44`
// instead of at the tree root), or anything else. Nothing here drags that
// drift further or attempts to fix it.
import fs from 'fs';
import { test, expect, Page } from '@playwright/test';
import { assertApiReachable } from '../support/requireApi';
import { startCsvExport } from '../support/sourcePanelMenus';

// Read-only variant of module-smoke.spec.ts's own openFirstLeaf: expands
// folders (a pure UI-state change, not a mutation) but never clicks the
// leaf itself, so this never opens a tab or otherwise changes app state --
// only navigation and the tree's own GET queries fire.
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

test('Export CSV (Test Cases) -- downloads a file with the importer-matching header row and a real seeded id', async ({ page }) => {
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
  expect(leafId, 'Test Cases: no leaf entity found in the tree -- nothing to assert the export contains').not.toBeNull();

  // ed3f06d moved Export CSV out of the panel header and into the "More
  // actions" menu, so this is now two clicks rather than one. The download
  // wait is still attached BEFORE the click: Playwright drops a download that
  // completes before waitForEvent is listening, and the menu's close
  // transition makes that window wider, not narrower.
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30000 }),
    startCsvExport(page)
  ]);

  // A meaningful, non-generic filename: module + project + date (see
  // api/exportApi.ts's buildExportFilename), not the browser's own
  // fallback naming.
  expect(download.suggestedFilename()).toMatch(/^testcases-project1-\d{4}-\d{2}-\d{2}\.csv$/);

  const savedPath = await download.path();
  expect(savedPath, 'Playwright did not persist the downloaded file to disk').not.toBeNull();
  const content = fs.readFileSync(savedPath as string, 'utf-8');

  const [headerLine] = content.split('\r\n');
  // Exactly the importer's ALLOWED_FIELDS (api/importApi.ts), plus the
  // leading TestCaseId readability column -- see exportApi.ts's
  // testCaseExportConfig header comment for why this is a deliberate,
  // verified choice rather than an incidental column order.
  expect(headerLine).toBe('TestCaseId,TestCaseSummary,TestCaseDescription,parentId');

  expect(content, `exported CSV did not contain the seeded id "${leafId}" the tree itself just reported`).toContain(leafId!);

  // Genuinely read-only: still on the same tree, nothing was created,
  // edited, or removed by exporting.
  await expect(tree).toBeVisible();
});
