// WP-F06 Task 6 -- the browser journey that closes the work package.
//
// THE ONE THING THIS PROVES, which nothing else in WP-F06 proves end to
// end: editing a shared step once updates every test case that references
// it. Tasks 1-5 each proved a component or a route in isolation (the
// picker inserts a reference, the manager CRUDs the library, TableRows.tsx
// renders a reference row and never flattens it); only a real browser,
// against a real Mongo, through the real Kong gateway, proves the whole
// chain holds together.
//
// Second thing only a browser/API round trip can prove: a reload does NOT
// flatten the stored reference into two copied rows. jsdom coverage
// (SharedStepPicker.test.tsx, AddDeleteTableRows.sharedSteps.test.tsx)
// proves the COMPONENT preserves `sharedStepId` through a re-render; only
// a document that actually survived a write and a read back out of Mongo
// proves the STORED form survived.
//
// Why "reopen the test case" (the brief's own phrasing for the edit-
// propagation check) is proven via the API and not by reading DOM text:
// TableRows.tsx's `row.sharedStepId` branch deliberately renders only
// `sharedStepTitle` + a "Shared" chip, never the referenced step's actual
// testStep/Expected text -- the Steps tab editor never asks for
// `?expand=steps` (see that file's own header comment, and
// TestCaseDetail.tsx's entityQuery). That is a deliberate design choice
// (R2 in the register entry this task adds to PRODUCT_GAP_REGISTER.md):
// implicit expansion would let this same editor read the flattened rows,
// PUT them straight back on the next save, and silently convert a
// reference into a dead copy with no error anywhere. The only place a
// reference is ever resolved back into real text is the opt-in
// `GET /testrepo?...&expand=steps` route (testRepoService/controllers/
// testrepo.js) -- the same mechanism test execution enrichment and CSV
// export use -- so THAT is what this spec calls, through the same
// `serviceApi()` used for every other server-side assertion in this
// suite, to prove the edit really propagated. The test case is still
// genuinely reopened in the browser (a fresh `page.reload()` + re-click
// into the Steps tab) to prove the reference itself survived the edit
// undamaged -- just not as the mechanism for reading the resolved text.
//
// Persona: needs BOTH `write` (create/insert/edit) and `delete` (to even
// see the shared-step library's Delete icon, gated on `can('delete')` in
// SharedStepManagerDialog.tsx) in the SAME session, so this does not reuse
// the suite's shared 'contributor' persona (write:true, delete:false --
// e2e/support/api.ts's own header comment explains why that persona stays
// at 'contributor' rather than being inflated). Follows entity-creation
// .spec.ts's delete/clone journey: its own throwaway 'manager' persona,
// logged in via e2e/support/login.ts on a fresh browser context.
//
// Cleanup ordering (has bitten this package three times per this task's
// brief): a shared step cannot be deleted while ANY test case still
// references it -- the delete guard (controllers/sharedStep.js's
// deleteSharedStep) refuses with 409. So `finally` deletes the TEST CASE
// (which removes the only reference there is, along with it) BEFORE
// deleting the SHARED STEP. Reversing that order leaks the shared step
// document on every run. Cleanup uses the SERVICE identity
// (e2e/support/api.ts's serviceApi()), never Mongo directly, exactly like
// every other spec in this suite.
import { test, expect } from '@playwright/test';
import { AxiosInstance } from 'axios';
import { assertApiReachable } from '../support/requireApi';
import { serviceApi } from '../support/api';
import { createE2EPersona } from '../auth/persona';
import { loginAsPersona } from '../support/login';
// ed3f06d moved this out of the panel header into the "New" menu.
import { createDraft } from '../support/sourcePanelMenus';

const BASE_URL = 'http://localhost:3000';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test.describe('shared steps (WP-F06 Task 6 -- one edit, every test case)', () => {
  test.setTimeout(150000);

  test('author a shared step, reference it, edit it once, and see the edit everywhere it is used', async ({
    browser,
  }) => {
    const persona = await createE2EPersona('sharedsteps', 'manager');
    // See this file's own header comment on why a fresh context is
    // required here (identical reasoning to entity-creation.spec.ts's
    // delete/clone journey): the `browser` fixture's `newContext()`
    // otherwise inherits playwright.config.ts's shared storageState
    // (the suite's 'contributor' persona), defeating the point of this
    // spec logging in as its own 'manager' persona.
    // Declared here but CREATED inside the try below. Everything created
    // before the try is outside the finally's reach: a throw from
    // newContext() or serviceApi() used to skip cleanup entirely and leak
    // the persona created one line earlier -- the same leak class the
    // finally's own comment describes, one level further out.
    let context: BrowserContext | undefined;
    let api: AxiosInstance | undefined;

    let testCaseMongoId: string | undefined;
    let testCaseId: string | undefined;
    let sharedStepMongoId: string | undefined;

    try {
      context = await browser.newContext({ storageState: undefined });
      api = await serviceApi();
      const page = await context.newPage();
      await loginAsPersona(page, BASE_URL, persona);
      await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 15000 });

      await page.evaluate((target) => {
        window.history.pushState({}, '', target);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, '/projects/1/workbench/testcases');
      await page.waitForURL(/\/projects\/1\/workbench\/testcases/, { timeout: 15000 });

      await assertApiReachable(page);

      const tree = page.getByRole('tree');
      await tree.waitFor({ state: 'visible', timeout: 30000 });

      const marker = Date.now();
      const sharedTitle = `e2e-sharedsteps-${marker}`;
      const step1Text = 'Open the login page';
      const step1Expected = 'The login page is shown';
      const step2Text = 'Enter admin credentials and submit';
      const step2Expected = 'The admin dashboard loads';
      const plainStepText = 'Verify the dashboard widgets render';
      const plainExpectedText = 'All widgets are visible with no errors';
      const editedStep1Text = `${step1Text} (edited by the e2e journey)`;

      // --- Open a draft test case shell -- the ONLY reachable entry point
      // to the shared-step library. SharedStepManagerDialog/SharedStepPicker
      // are imported nowhere except TestCaseDetail.tsx (verified: no
      // standalone Settings/Admin route renders either), so "create a
      // shared step through the manager dialog" (step 1 of this journey)
      // necessarily starts from inside a test case's own Steps tab. ---
      await createDraft(page, 'New Test Case');
      await expect(page.getByRole('heading', { name: 'New Test Case' })).toBeVisible({ timeout: 15000 });

      await page.getByRole('tab', { name: 'Steps' }).click();

      // A fresh draft's Steps tab starts with one blank plain row
      // (TestCaseDetail.tsx's DEFAULT_STEPS). Remove it so the final step
      // order is exactly [reference row, one plain row] -- what the brief
      // describes, not [blank row, reference row, plain row].
      await page.getByRole('button', { name: 'Delete step' }).click();

      // --- Step 1: create the shared step through the manager dialog ---
      await page.getByRole('button', { name: /manage shared steps/i }).click();
      const managerDialog = page.getByRole('dialog', { name: 'Manage shared steps' });
      await expect(managerDialog).toBeVisible({ timeout: 10000 });

      await managerDialog.getByRole('button', { name: 'New shared step' }).click();
      const createFormDialog = page.getByRole('dialog', { name: 'New shared step' });
      await expect(createFormDialog).toBeVisible({ timeout: 10000 });

      await createFormDialog.getByLabel('Title', { exact: true }).fill(sharedTitle);
      await createFormDialog.getByLabel('Description', { exact: true }).fill('Log in as admin -- e2e fixture, WP-F06 Task 6.');
      await createFormDialog.getByLabel('Step 1', { exact: true }).fill(step1Text);
      await createFormDialog.getByLabel('Expected 1', { exact: true }).fill(step1Expected);
      await createFormDialog.getByRole('button', { name: 'Add step' }).click();
      await createFormDialog.getByLabel('Step 2', { exact: true }).fill(step2Text);
      await createFormDialog.getByLabel('Expected 2', { exact: true }).fill(step2Expected);
      await createFormDialog.getByRole('button', { name: 'Create' }).click();
      await expect(createFormDialog).not.toBeVisible({ timeout: 15000 });

      await expect(managerDialog.getByText(sharedTitle)).toBeVisible({ timeout: 10000 });
      await managerDialog.getByRole('button', { name: 'Close' }).click();
      await expect(managerDialog).not.toBeVisible({ timeout: 10000 });

      // Capture the fixture's Mongo _id now, right after it is known to
      // exist, so `finally` can always find it regardless of where a
      // later assertion in this test throws.
      const sharedStepLookup = await api.get('/sharedstep', { params: { title: sharedTitle } });
      const sharedStepDocs = (sharedStepLookup.data?.data || []) as Array<{ _id: string; SharedStepId: string }>;
      expect(sharedStepDocs.length, `Expected to find the fixture shared step "${sharedTitle}" via GET /sharedstep`).toBe(1);
      sharedStepMongoId = sharedStepDocs[0]._id;
      const sharedStepBusinessId = sharedStepDocs[0].SharedStepId;

      // --- Step 2: create a test case; insert that shared step; add one
      // plain step after it ---
      await page.getByRole('tab', { name: 'Details' }).click();
      const summaryMarker = `E2E sharedsteps ${marker}`;
      await page.getByLabel('Summary').fill(summaryMarker);

      const descriptionEditor = page.locator('.ql-editor');
      await descriptionEditor.click();
      await page.keyboard.type('Created by the WP-F06 Task 6 shared-steps e2e journey.');

      await page.getByRole('combobox', { name: 'Priority' }).click();
      await page.getByRole('option', { name: 'High' }).click();

      await page.getByRole('tab', { name: 'Steps' }).click();

      await page.getByRole('button', { name: /insert shared step/i }).click();
      const pickerDialog = page.getByRole('dialog', { name: 'Insert shared step' });
      await expect(pickerDialog).toBeVisible({ timeout: 10000 });
      await pickerDialog.getByLabel('Search shared steps', { exact: true }).fill(sharedTitle);
      await expect(pickerDialog.getByText(sharedTitle, { exact: true })).toBeVisible({ timeout: 10000 });
      await pickerDialog.getByRole('button', { name: 'Insert' }).click();
      await expect(pickerDialog).not.toBeVisible({ timeout: 10000 });

      // The reference row: a "Shared" chip and the shared step's title --
      // never the underlying testStep/Expected text (TableRows.tsx).
      await expect(page.getByText(sharedTitle, { exact: true })).toBeVisible({ timeout: 10000 });
      await expect(page.getByText('Shared', { exact: true })).toBeVisible();

      // Add one plain step after the reference, using that row's own "Add
      // step" icon (TableRows.tsx keeps add/delete affordances on a
      // reference row for module 1).
      await page.getByRole('button', { name: 'Add step' }).click();
      await page.locator('textarea[name="testStep"]').fill(plainStepText);
      await page.locator('textarea[name="Expected"]').fill(plainExpectedText);

      await page.getByRole('button', { name: /^create$/i }).click();

      const summaryPattern = escapeRegex(summaryMarker);
      const heading = page.getByRole('heading', { name: new RegExp(`^TC-\\d+ : ${summaryPattern}`) });
      await expect(heading).toBeVisible({ timeout: 20000 });
      const headingText = (await heading.textContent()) || '';
      testCaseId = headingText.match(/^(TC-\d+)/)?.[1];
      expect(testCaseId, `Could not parse a TestCaseId out of heading text "${headingText}"`).toBeTruthy();

      const foundTc = await api.get('/testrepo', { params: { TestCaseId: testCaseId } });
      const tcDocs = (foundTc.data?.data || []) as Array<{ _id: string }>;
      expect(tcDocs.length, `Expected to find the created ${testCaseId} via GET /testrepo`).toBeGreaterThan(0);
      testCaseMongoId = tcDocs[0]._id;

      // --- Step 3: reload. The reference row must still render as a
      // shared row -- not as two flattened copies. DetailTabs' active tab
      // is local React state, reset by a remount, so the Steps tab has to
      // be re-selected after the reload before this can be checked. ---
      await page.reload();
      await expect(
        page.getByRole('heading', { name: new RegExp(`^${testCaseId} : ${summaryPattern}`) })
      ).toBeVisible({ timeout: 20000 });
      await page.getByRole('tab', { name: 'Steps' }).click();

      await expect(page.getByText(sharedTitle, { exact: true })).toBeVisible({ timeout: 15000 });
      await expect(page.getByText('Shared', { exact: true })).toBeVisible();
      // Exactly ONE editable plain-text step row (the one we typed) --
      // if the reference had flattened into copies on the round trip,
      // this would be 3 (the fixture's own two entries plus ours).
      await expect(page.locator('textarea[name="testStep"]')).toHaveCount(1);
      await expect(page.locator('textarea[name="testStep"]')).toHaveValue(plainStepText);
      await expect(page.locator('textarea[name="Expected"]')).toHaveValue(plainExpectedText);

      // --- Step 4: edit the shared step's first row through the manager ---
      await page.getByRole('button', { name: /manage shared steps/i }).click();
      const managerDialog2 = page.getByRole('dialog', { name: 'Manage shared steps' });
      await expect(managerDialog2).toBeVisible({ timeout: 10000 });

      await managerDialog2.getByRole('button', { name: `Edit ${sharedTitle}` }).click();
      const editFormDialog = page.getByRole('dialog', { name: 'Edit shared step' });
      await expect(editFormDialog).toBeVisible({ timeout: 10000 });
      await expect(editFormDialog.getByLabel('Step 1', { exact: true })).toHaveValue(step1Text);

      await editFormDialog.getByLabel('Step 1', { exact: true }).fill(editedStep1Text);
      await editFormDialog.getByRole('button', { name: 'Save' }).click();
      await expect(editFormDialog).not.toBeVisible({ timeout: 15000 });

      await managerDialog2.getByRole('button', { name: 'Close' }).click();
      await expect(managerDialog2).not.toBeVisible({ timeout: 10000 });

      // --- Step 5: reopen the test case. THE FEATURE -- one edit, every
      // referencing case updated. The reload+re-open proves the reference
      // itself survived the edit intact (still a clean "Shared" row, not
      // corrupted); the live expand=steps read proves the actual text
      // propagated -- see this file's header comment for why that read,
      // not the Steps tab's DOM, is where the resolved text is ever
      // shown. ---
      await page.reload();
      await expect(
        page.getByRole('heading', { name: new RegExp(`^${testCaseId} : ${summaryPattern}`) })
      ).toBeVisible({ timeout: 20000 });
      await page.getByRole('tab', { name: 'Steps' }).click();
      await expect(page.getByText(sharedTitle, { exact: true })).toBeVisible({ timeout: 15000 });
      await expect(page.getByText('Shared', { exact: true })).toBeVisible();

      await expect
        .poll(
          async () => {
            const resp = await api.get('/testrepo', { params: { TestCaseId: testCaseId, expand: 'steps' } });
            const doc = (resp.data?.data || []).find((d: { TestCaseId: string }) => d.TestCaseId === testCaseId);
            return (doc?.TestSteps || []).map((s: { testStep: string }) => s.testStep);
          },
          { timeout: 20000 }
        )
        .toContain(editedStep1Text);

      const expandedAfterEdit = await api.get('/testrepo', { params: { TestCaseId: testCaseId, expand: 'steps' } });
      const expandedDoc = (expandedAfterEdit.data?.data || []).find(
        (d: { TestCaseId: string }) => d.TestCaseId === testCaseId
      );
      const expandedTexts = (expandedDoc?.TestSteps || []).map((s: { testStep: string }) => s.testStep);
      // The OLD text must be gone -- not just the new text present
      // somewhere -- so this cannot pass by accident (e.g. a stray extra
      // row appended instead of the real one being updated).
      expect(expandedTexts).not.toContain(step1Text);
      expect(expandedTexts).toContain(step2Text);
      expect(expandedTexts).toContain(plainStepText);

      // --- Step 6: attempt to delete the in-use shared step; the refusal
      // must name the test case ---
      await page.getByRole('button', { name: /manage shared steps/i }).click();
      const managerDialog3 = page.getByRole('dialog', { name: 'Manage shared steps' });
      await expect(managerDialog3).toBeVisible({ timeout: 10000 });

      await managerDialog3.getByRole('button', { name: `Delete ${sharedTitle}` }).click();
      const deleteDialog = page.getByRole('dialog', { name: new RegExp(`^Delete ${escapeRegex(sharedTitle)}\\?$`) });
      await expect(deleteDialog).toBeVisible({ timeout: 10000 });
      await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click();

      await expect(
        deleteDialog.getByText(new RegExp(`${escapeRegex(sharedStepBusinessId)} is used by 1 test case\\(s\\) and cannot be deleted`))
      ).toBeVisible({ timeout: 15000 });
      await expect(deleteDialog.getByText(new RegExp(escapeRegex(testCaseId!)))).toBeVisible();
      // Refused, not silently accepted -- the dialog is still open and the
      // shared step is still there to prove it.
      await expect(deleteDialog).toBeVisible();
      const stillThere = await api.get('/sharedstep', { params: { title: sharedTitle } });
      expect((stillThere.data?.data || []).length, 'The shared step must still exist after a refused delete').toBe(1);

      await deleteDialog.getByRole('button', { name: 'Cancel' }).click();
      await managerDialog3.getByRole('button', { name: 'Close' }).click();
    } finally {
      // Cleanup ordering: the test case (which carries the reference) must
      // go BEFORE the shared step, or the delete guard refuses the shared
      // step's cleanup with the same 409 this test just proved. That part
      // was always correct -- what was NOT correct here before fix round 1
      // is that a `finally` block gets none of this for free: an uncaught
      // throw partway through it still aborts everything after it, same as
      // anywhere else. The verify-gone `expect()` below sat unguarded
      // between the two deletes, so a failed assertion there skipped the
      // shared-step delete, `context.close()`, AND `persona.cleanup()` --
      // leaking a Keycloak user on every run where it fired. Each cleanup
      // step below is now independently guarded (its own try/catch,
      // logged rather than thrown) so a failure in one can never skip a
      // later one, and `context.close()`/`persona.cleanup()` run from
      // their own nested `finally` so they are genuinely unconditional.
      try {
        if (api && testCaseMongoId) {
          await api!.delete(`/testrepo/${testCaseMongoId}`).catch(() => {});
          if (testCaseId) {
            try {
              const verifyTc = await api!.get('/testrepo', { params: { TestCaseId: testCaseId } });
              expect(verifyTc.data?.data || [], `${testCaseId} should be gone after cleanup`).toHaveLength(0);
            } catch (verifyErr) {
              // eslint-disable-next-line no-console
              console.error(`shared-steps.spec.ts cleanup: verify-gone check for ${testCaseId} failed`, verifyErr);
            }
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('shared-steps.spec.ts cleanup: deleting the test case failed', err);
      }
      try {
        if (sharedStepMongoId) {
          await api!.delete(`/sharedstep/${sharedStepMongoId}`).catch(() => {});
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('shared-steps.spec.ts cleanup: deleting the shared step failed', err);
      }
      try {
        if (context) await context.close();
      } finally {
        await persona.cleanup();
      }
    }
  });
});
