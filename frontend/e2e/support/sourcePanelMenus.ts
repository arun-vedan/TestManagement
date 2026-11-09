import { Page, expect } from '@playwright/test';

// The source panel's "New" and "More actions" menus.
//
// WHY THIS EXISTS. ed3f06d ("source panel redesign") moved every create and
// export control out of the panel's header and into two dropdown menus. What
// used to be one click —
//
//     await page.getByRole('button', { name: /^new test case$/i }).click();
//
// is now three steps: open the menu, pick the item, and wait for whatever the
// item actually produces, because the action runs after the menu's close
// transition. Twenty-nine call sites across eleven specs needed that change.
// Inlining it twenty-nine times would mean twenty-nine chances to forget the
// wait, and one shared implementation to fix when the panel moves again —
// which it has now done twice.
//
// WHAT IS NOT CHANGED, and matters more than it looks: assertions of the form
//
//     getByRole('heading', { name: 'New Test Case' })
//
// are NOT menu controls. They assert the DRAFT FORM'S OWN TITLE, which still
// reads "New Test Case" after the menu item is clicked, and they must keep
// working untouched. Across these specs there are 29 button locators to
// migrate and 23 heading assertions to leave alone; a find-and-replace over
// all 52 would quietly break half of them while appearing to succeed. If you
// are tempted to widen a grep here, don't.
//
// Menu names and item labels are from the redesign's own author; the item
// labels are unchanged from the old button labels, which is why only the
// INTERACTION moved, not the vocabulary.

const MENU_OPEN_TIMEOUT = 15000;

// The create menu's items, exactly as they read in the UI.
export type CreateItem =
  | 'New Test Case'
  | 'New Requirement'
  | 'New Test Plan'
  | 'New Defect'
  | 'New Release'
  | 'New folder'
  | 'Start from template…';

// The "More actions" menu's items. "Audit duplicates (AI)" is absent whenever
// AI is unavailable (afd8482 hides it), so with AI off this menu is exactly
// [Export CSV, Import CSV]. No spec clicks the AI item.
export type MoreActionsItem = 'Export CSV' | 'Import CSV' | 'Audit duplicates (AI)';

async function openMenu(page: Page, button: string, menu: string) {
  await expect(page.getByRole('button', { name: button, exact: true })).toBeVisible({
    timeout: MENU_OPEN_TIMEOUT
  });
  await page.getByRole('button', { name: button, exact: true }).click();
  const panel = page.getByRole('menu', { name: menu });
  await expect(panel).toBeVisible({ timeout: MENU_OPEN_TIMEOUT });
  return panel;
}

// Opens "New" and clicks one item. Does NOT wait for the result — the caller
// knows what its item produces, and the waits differ per item (a draft tab, a
// dialog, a focused textbox). Prefer the specific helpers below where one
// exists; they encode the right wait so a spec cannot forget it.
export async function chooseCreate(page: Page, item: CreateItem): Promise<void> {
  const menu = await openMenu(page, 'New', 'Create');
  await menu.getByRole('menuitem', { name: item }).click();
}

export async function chooseMoreAction(page: Page, item: MoreActionsItem): Promise<void> {
  const menu = await openMenu(page, 'More actions', 'More actions');
  await menu.getByRole('menuitem', { name: item }).click();
}

// --- the waits, one per outcome -------------------------------------------
//
// Each of these encodes what the redesign's author said the action actually
// produces. They exist because "the action runs after the menu's close
// transition" means a click followed immediately by an assertion on the old
// target is a race, and a race in a suite this slow surfaces as a flake
// nobody can reproduce.

// New Test Case / Requirement / Test Plan / Defect open a DRAFT TAB. Nothing
// is persisted until the detail view's own Create button, so this is purely a
// UI state the spec can then act on.
export async function createDraft(
  page: Page,
  item: 'New Test Case' | 'New Requirement' | 'New Test Plan' | 'New Defect'
): Promise<void> {
  await chooseCreate(page, item);
  // The tab, in the "Open tabs" tablist...
  await expect(page.getByRole('tab', { name: new RegExp(item, 'i') })).toBeVisible({
    timeout: MENU_OPEN_TIMEOUT
  });
  // ...and the draft detail itself. Both, because a tab can appear before its
  // body renders, and specs go straight on to typing into the body.
  await expect(page.getByRole('heading', { name: item })).toBeVisible({ timeout: MENU_OPEN_TIMEOUT });
}

// New Release opens a dialog FIRST; the REL-n tab appears only after Create.
export async function openNewReleaseDialog(page: Page): Promise<void> {
  await chooseCreate(page, 'New Release');
  await expect(page.getByRole('dialog', { name: 'New Release' })).toBeVisible({
    timeout: MENU_OPEN_TIMEOUT
  });
}

export async function openTemplatePicker(page: Page): Promise<void> {
  await chooseCreate(page, 'Start from template…');
  await expect(page.getByRole('dialog', { name: /start from template/i })).toBeVisible({
    timeout: MENU_OPEN_TIMEOUT
  });
}

// "New folder" reveals a focused textbox. Confirming it calls the API and the
// row appears only after the children query refetches, so a spec that needs
// the row must assert on the treeitem by name, not on the textbox vanishing.
// Folders exist only in Test Cases and Requirements since ed3f06d.
export async function startNewFolder(page: Page): Promise<void> {
  await chooseCreate(page, 'New folder');
  await expect(page.getByRole('textbox', { name: 'New folder name' })).toBeFocused({
    timeout: MENU_OPEN_TIMEOUT
  });
}

export async function openCsvImportDialog(page: Page): Promise<void> {
  await chooseMoreAction(page, 'Import CSV');
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: MENU_OPEN_TIMEOUT });
}

// Export has no dialog: the only observable outcome is the download. The
// caller starts waiting BEFORE clicking, which is why this takes the promise
// rather than creating it — Playwright drops a download that completes before
// waitForEvent is attached.
export async function startCsvExport(page: Page): Promise<void> {
  await chooseMoreAction(page, 'Export CSV');
}
