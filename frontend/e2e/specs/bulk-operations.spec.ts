// WP-F03 Task 4 -- the browser proof that bulk operations (Tasks 1-3 of this
// WP: backend endpoints for requirements/test plans/test runs, and the
// frontend list configs/API client wiring them up) actually work end to
// end, for every module a CONTRIBUTOR (the shared e2e persona,
// e2e/auth/persona.ts) can reach, plus the one module that genuinely needs
// more privilege than that persona has.
//
// Permissions decide what a persona can even SEE here --
// buildBulkActions({ canWrite, canDelete }) (workbench/list/
// entityListConfigs.tsx) gates every action, and the RBAC matrix
// (permissions.ts) gives 'contributor' write:true, delete:false. Read
// live against the actual configs (not assumed), the consequences are:
//   - Module 2 (Requirements): buildBulkActions only pushes 'status' when
//     canWrite and 'delete' when canDelete. A contributor sees "Change
//     status" ONLY -- there is no reachable Delete control for this
//     persona here.
//
//     ** This corrects an assumption in this task's own brief. ** The
//     brief's step 1 called for the shared contributor persona to "select
//     two rows... bulk delete" requirements directly. That path does not
//     exist: canDelete is false for contributor, identically to every
//     other module's bulk config (and identically to the single-entity
//     delete gating entity-creation.spec.ts's header comment already
//     documents for module 1). Proving bulk delete needs a persona that
//     actually has 'delete' -- this file's requirements test opens its OWN
//     throwaway 'manager' persona on a fresh browser context, the exact
//     precedent entity-creation.spec.ts's clone/delete journey already set
//     (see that file's header comment for why the shared persona's role is
//     never inflated for this), rather than skipping delete coverage.
//   - Module 3 (Test Plans): delete is TestPlan's ONLY bulk action (no
//     status, no assignedTo -- the model has neither field), so a
//     contributor's buildBulkActions array is EMPTY: checkboxSelection
//     stays false and BulkActionBar renders nothing at all. This is
//     correct behaviour, not a gap -- asserted below, not routed around.
//   - Module 4 (Test Runs): a contributor sees "Assign" only (canWrite),
//     never "Delete" -- covered here with the shared persona; every
//     fixture this test creates is cleaned up through serviceApi(), the
//     same reasoning entity-creation.spec.ts's header comment gives for
//     every other spec in this suite (the shared persona cannot delete,
//     full stop).
//
// Fixture discipline (this WP's own brief, and the register's existing D4
// entry about seeded-data drift from an earlier spec's failed restore
// step): nothing seeded (PLN-1..PLN-7, Run-1..Run-14, TC-*, the seeded
// requirements) is ever selected or acted on below. Every record a test
// here touches is created by that same test and destroyed by it, confirmed
// gone by re-querying the real REST API through serviceApi() -- never
// assumed from a 2xx response or from the DOM alone.
//
// Selectors -- read from source, not guessed:
//   - BulkActionBar.tsx: the bar is data-testid="bulk-action-bar"; each
//     action button's accessible name is its `label` verbatim ("Assign" /
//     "Change status" / "Delete"); the confirmation dialog's value field is
//     labelled by `valueLabel` ("New status" / "Assign to (user id)"), and
//     its submit button reads `Confirm ${label.toLowerCase()}` ("Confirm
//     change status" / "Confirm assign" / "Confirm delete") -- exactly what
//     workbench/list/__tests__/EntityList.test.tsx already drives in jsdom.
//   - DataGrid (EntityList.tsx, MUI x-data-grid v6): the grid root is
//     role="grid" (useGridAriaAttributes.js); a row is role="row"
//     (GridRow.js, unconditional); a data cell is role="cell", NOT
//     "gridcell" -- this install has no `experimentalFeatures.ariaV7`, and
//     GridCell.js's role is conditional on that flag (verified by reading
//     node_modules directly rather than assumed). A row selection checkbox
//     has accessible name "Select row" (matched case-insensitively, same
//     as this suite's jsdom tests and the task brief's own confirmed
//     selector). A specific row is found by its ID cell's EXACT text
//     (`getByRole('cell', { name: id, exact: true })`) then that cell's
//     ancestor `[role="row"]` -- never by index, so this can never
//     mis-select a seeded row that happens to share a page with a fixture.
//   - Navigation: identical to navigation.spec.ts / module-smoke.spec.ts --
//     the drawer's `getByRole('link', { name: 'Workbench' })` lands on
//     /workbench/testcases; ModuleRail buttons, scoped to
//     getByTestId('workbench-module-rail') (search.spec.ts's own reason:
//     "Releases" collides with a drawer link, none of this file's three
//     modules do), switch modules; SourcePanel's
//     `getByRole('button', { name: 'List view' })` switches into the
//     module config `<EntityList>` renders.
//
// Out of scope, deliberately (see this WP's register entry): bulk
// status-change for defects (module 5) -- defectService's status
// transition validates against istatusservice over HTTP and fails closed
// (503), making N-item all-or-nothing validation a different risk profile
// from these three modules' local enum checks; OPEN, its own package. Bulk
// ops for module 6 (releases) -- no list config exists yet.
import { test, expect, Page } from '@playwright/test';
import { assertApiReachable } from '../support/requireApi';
import { serviceApi } from '../support/api';
import {
  createTestExecutionFixture,
  deleteTestExecutionFixture,
  TestExecutionFixture,
  createRequirementFixture,
  RequirementFixture,
} from '../support/fixtures';
import { createE2EPersona } from '../auth/persona';
import { loginAsPersona } from '../support/login';

const BASE_URL = 'http://localhost:3000';

async function landOnDashboard(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 15000 });
}

/** From the dashboard, reach a module's List view via the real drawer/rail/toggle controls. */
async function openModuleListView(page: Page, moduleLabel: string, slug: string): Promise<void> {
  await page.getByRole('link', { name: 'Workbench' }).click();
  await page.waitForURL(/\/projects\/1\/workbench\/testcases/, { timeout: 15000 });
  await assertApiReachable(page);

  if (slug !== 'testcases') {
    await page.getByTestId('workbench-module-rail').getByRole('button', { name: moduleLabel }).click();
    await page.waitForURL(new RegExp(`/projects/1/workbench/${slug}`), { timeout: 15000 });
  }

  await page.getByRole('button', { name: 'List view' }).click();
  await expect(page.getByRole('grid')).toBeVisible({ timeout: 15000 });
}

/** The row (role="row") whose ID cell's text is an EXACT match -- never an index. */
function rowByCellText(page: Page, exactCellText: string) {
  const cell = page.getByRole('cell', { name: exactCellText, exact: true });
  return cell.locator('xpath=ancestor::div[@role="row"]');
}

test.describe('bulk operations across the workbench (WP-F03)', () => {
  test('a contributor sees no selection at all for Test Plans -- delete is its only action and canDelete is false', async ({
    page,
  }) => {
    test.setTimeout(60000);

    await landOnDashboard(page);
    await openModuleListView(page, 'Test Plans', 'testplans');

    // Seeded data (PLN-1..PLN-7) is genuinely present -- this proves the
    // grid actually rendered rows, not that it's trivially empty and so
    // has no checkboxes for that reason instead.
    await expect(page.getByRole('cell', { name: /^PLN-\d+$/ }).first()).toBeVisible({ timeout: 15000 });

    await expect(page.getByTestId('bulk-action-bar')).toHaveCount(0);
    await expect(page.getByRole('checkbox', { name: /select row/i })).toHaveCount(0);
  });

  test('a contributor bulk-assigns two test runs, and the assignment is persisted', async ({ page }) => {
    test.setTimeout(90000);

    const api = await serviceApi();
    let fixtureA: TestExecutionFixture | undefined;
    let fixtureB: TestExecutionFixture | undefined;
    try {
      fixtureA = await createTestExecutionFixture(api, 'bulk-assign-a');
      fixtureB = await createTestExecutionFixture(api, 'bulk-assign-b');

      await landOnDashboard(page);
      await openModuleListView(page, 'Test Runs', 'testruns');

      await expect(page.getByRole('cell', { name: fixtureA.testExecutionId, exact: true })).toBeVisible({
        timeout: 15000,
      });
      await expect(page.getByRole('cell', { name: fixtureB.testExecutionId, exact: true })).toBeVisible({
        timeout: 15000,
      });

      await rowByCellText(page, fixtureA.testExecutionId).getByRole('checkbox', { name: /select row/i }).click();
      await rowByCellText(page, fixtureB.testExecutionId).getByRole('checkbox', { name: /select row/i }).click();

      const bar = page.getByTestId('bulk-action-bar');
      await expect(bar).toBeVisible({ timeout: 10000 });
      await expect(bar.getByText(/2 selected/)).toBeVisible();
      await expect(bar.getByRole('button', { name: 'Assign' })).toBeVisible();
      // Table 4 in this file's header comment: a contributor never sees
      // Delete here -- canDelete is false, identically to every module.
      await expect(bar.getByRole('button', { name: 'Delete' })).toHaveCount(0);

      await bar.getByRole('button', { name: 'Assign' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible({ timeout: 10000 });
      const assignee = `e2e-bulk-${Date.now()}`;
      await dialog.getByLabel(/assign to/i).fill(assignee);
      await dialog.getByRole('button', { name: /^confirm assign$/i }).click();
      await expect(dialog).not.toBeVisible({ timeout: 15000 });

      await expect(page.getByText(/Updated 2 test runs\./)).toBeVisible({ timeout: 15000 });

      // The assertion that matters: the grid reflects the new assignee for
      // BOTH rows (not just that a control was clickable)...
      await expect(
        rowByCellText(page, fixtureA.testExecutionId).getByRole('cell', { name: assignee, exact: true })
      ).toBeVisible({ timeout: 15000 });
      await expect(
        rowByCellText(page, fixtureB.testExecutionId).getByRole('cell', { name: assignee, exact: true })
      ).toBeVisible({ timeout: 15000 });

      // ...and it actually reached the backend, not just the DOM.
      for (const fixture of [fixtureA, fixtureB]) {
        const found = await api.get('/testexecution', { params: { TestExecutionId: fixture.testExecutionId } });
        const docs = (found.data?.data || []) as Array<{ assignedTo?: string }>;
        expect(docs.length, `Expected to find ${fixture.testExecutionId} via GET /testexecution`).toBeGreaterThan(0);
        expect(docs[0].assignedTo).toBe(assignee);
      }
    } finally {
      await deleteTestExecutionFixture(api, fixtureA);
      await deleteTestExecutionFixture(api, fixtureB);
      for (const fixture of [fixtureA, fixtureB]) {
        if (!fixture) continue;
        const verify = await api.get('/testexecution', { params: { TestExecutionId: fixture.testExecutionId } });
        expect(verify.data?.data || [], `${fixture.testExecutionId} should be gone after cleanup`).toHaveLength(0);
      }
    }
  });

  // The module-2 journey: status change AND delete, both against records
  // this test creates and neither ever touching PLN-1..PLN-7/Run-*/TC-*/
  // the seeded requirements. Needs its own 'manager' persona -- see this
  // file's header comment on why the shared contributor cannot reach
  // Delete here at all (this is the brief's corrected assumption).
  test('a manager bulk-changes status then bulk-deletes two requirements, both persisted', async ({ browser }) => {
    test.setTimeout(90000);

    const api = await serviceApi();
    const persona = await createE2EPersona('bulk-requirements', 'manager');
    // Fresh context, storageState explicitly cleared -- otherwise this
    // "fresh" context would inherit playwright.config.ts's shared
    // contributor storageState instead of actually logging in as the new
    // manager persona (same reasoning entity-creation.spec.ts's clone/
    // delete journey documents).
    const context = await browser.newContext({ storageState: undefined });
    let reqA: RequirementFixture | undefined;
    let reqB: RequirementFixture | undefined;
    try {
      reqA = await createRequirementFixture(api, 'bulk-status-delete-a');
      reqB = await createRequirementFixture(api, 'bulk-status-delete-b');

      const page = await context.newPage();
      await loginAsPersona(page, BASE_URL, persona);
      await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 15000 });

      await openModuleListView(page, 'Requirements', 'requirements');

      await expect(page.getByRole('cell', { name: reqA.reqId, exact: true })).toBeVisible({ timeout: 15000 });
      await expect(page.getByRole('cell', { name: reqB.reqId, exact: true })).toBeVisible({ timeout: 15000 });

      // --- 1. Bulk status change ---
      await rowByCellText(page, reqA.reqId).getByRole('checkbox', { name: /select row/i }).click();
      await rowByCellText(page, reqB.reqId).getByRole('checkbox', { name: /select row/i }).click();

      const bar = page.getByTestId('bulk-action-bar');
      await expect(bar).toBeVisible({ timeout: 10000 });
      await expect(bar.getByText(/2 selected/)).toBeVisible();
      // A manager (unlike the shared contributor) genuinely has both.
      await expect(bar.getByRole('button', { name: 'Change status' })).toBeVisible();
      await expect(bar.getByRole('button', { name: 'Delete' })).toBeVisible();

      await bar.getByRole('button', { name: 'Change status' }).click();
      const statusDialog = page.getByRole('dialog');
      await expect(statusDialog).toBeVisible({ timeout: 10000 });
      // createRequirementFixture creates with status 'approved'. 'deprecated'
      // is a genuine, distinct change, not a no-op -- and, per
      // shared/service-core/lifecycle.js's VALID_TRANSITIONS graph, it's
      // also the only legal edge out of 'approved' (WP-F03e final review,
      // Fix 1d: this used to target 'archived', which is not reachable from
      // 'approved' -- that edge only opens up from 'deprecated' -- so this
      // journey was exercising an illegal transition that bulkUpdateRequirements
      // wrongly allowed before Fix 1a closed that gap).
      await statusDialog.getByLabel(/new status/i).fill('deprecated');
      await statusDialog.getByRole('button', { name: /^confirm change status$/i }).click();
      await expect(statusDialog).not.toBeVisible({ timeout: 15000 });

      await expect(page.getByText(/Updated 2 requirements\./)).toBeVisible({ timeout: 15000 });

      // The grid shows the new status for both rows...
      await expect(rowByCellText(page, reqA.reqId).getByText('deprecated')).toBeVisible({ timeout: 15000 });
      await expect(rowByCellText(page, reqB.reqId).getByText('deprecated')).toBeVisible({ timeout: 15000 });

      // ...and it was actually persisted, not just rendered.
      for (const req of [reqA, reqB]) {
        const found = await api.get('/requirement', { params: { reqId: req.reqId } });
        const docs = (found.data?.data || []) as Array<{ status?: string }>;
        expect(docs.length, `Expected to find ${req.reqId} via GET /requirement`).toBeGreaterThan(0);
        expect(docs[0].status).toBe('deprecated');
      }

      // --- 2. Bulk delete -- selection was cleared by the successful
      // status change above, so both rows are re-selected here. ---
      await rowByCellText(page, reqA.reqId).getByRole('checkbox', { name: /select row/i }).click();
      await rowByCellText(page, reqB.reqId).getByRole('checkbox', { name: /select row/i }).click();
      await expect(bar).toBeVisible({ timeout: 10000 });

      await bar.getByRole('button', { name: 'Delete' }).click();
      const deleteDialog = page.getByRole('dialog');
      await expect(deleteDialog).toBeVisible({ timeout: 10000 });
      await expect(deleteDialog.getByText(/permanently deletes 2 items/i)).toBeVisible();
      await deleteDialog.getByRole('button', { name: /^confirm delete$/i }).click();
      await expect(deleteDialog).not.toBeVisible({ timeout: 15000 });

      await expect(page.getByText(/Deleted 2 requirements\./)).toBeVisible({ timeout: 15000 });

      // Gone from the grid...
      await expect(page.getByRole('cell', { name: reqA.reqId, exact: true })).toHaveCount(0);
      await expect(page.getByRole('cell', { name: reqB.reqId, exact: true })).toHaveCount(0);

      // ...and actually gone from the backend, not just off-screen.
      for (const req of [reqA, reqB]) {
        const verify = await api.get('/requirement', { params: { reqId: req.reqId } });
        expect(verify.data?.data || [], `${req.reqId} should be gone after the bulk delete`).toHaveLength(0);
      }
    } finally {
      await context.close();
      await persona.cleanup();
      // Best-effort: only relevant if an assertion above threw before the
      // bulk delete step ran, leaving a fixture behind.
      for (const req of [reqA, reqB]) {
        if (!req) continue;
        const remaining = await api.get('/requirement', { params: { reqId: req.reqId } });
        for (const doc of (remaining.data?.data || []) as Array<{ _id: string }>) {
          await api.delete(`/requirement/${doc._id}`);
        }
      }
    }
  });
});
