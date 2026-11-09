// WP-F07a Task 5 -- the browser journey that closes the work package, and
// R3's proof of record: SUBSTITUTED TEXT MUST NEVER BE WRITTEN BACK.
//
// A parameterised case stores `Log in as {{role}}`. With a preview row
// selected the author SEES `Log in as admin`. If that substituted string
// ever reached storage the placeholder would be gone and the case would
// silently stop being parameterised -- it would still render, still pass,
// and simply never be data-driven again. Nothing would surface the loss.
//
// Why this needs a real browser + real Mongo round trip, not just the
// jsdom guard (TestCaseDetail.parameterised.test.tsx): that jsdom guard was
// itself VACUOUS the first time it was written, and it passed while the
// feature was broken. The cause was a render-ordering race -- the
// read-only preview cell (TableRows.tsx) reads its `previewRow` prop
// directly and updates the instant the preview query resolves, but the
// EDITABLE field's value comes from AddDeleteTableRows' own local
// `rowsData` state, which only mirrors the `rows` prop inside its own
// `useEffect` -- one render behind. An assertion about the editable field
// gated only on "the preview cell arrived" ran a tick too early and
// happened to observe the not-yet-corrupted render, regardless of whether
// the underlying code was actually safe. jsdom's fix was a manual
// `flushPendingRenders()` timer tick; this spec sidesteps the whole class
// of "did I get React's render timing right" by never asserting on a
// DOM snapshot taken mid-render at all. Instead: edit an unrelated step
// while a preview row is active, do a genuine `page.reload()` (a fresh
// mount, not a re-render), and then read the stored steps back through
// `GET /testrepo` -- server truth from Mongo, not the browser's React tree
// at some particular instant.
//
// The journey (brief's own order): create a dataset (2 columns, 2 rows)
// through the manager dialog -> author a test case with `{{placeholders}}`
// in its steps -> bind the dataset -> preview row 0, assert the
// substituted text shows -> preview row 1, assert it changes -> edit an
// unrelated step WHILE STILL PREVIEWING, reload, assert the stored steps
// still hold `{{placeholders}}` (the R3 proof above) -> attempt to delete
// the bound dataset, assert the 409 refusal names the blocking case ->
// clean up.
//
// Persona: needs BOTH `write` (create the case, bind the dataset, edit a
// step) and `delete` (see the dataset library's Delete icon at all, gated
// on `can('delete')` in DatasetManagerDialog.tsx, AND clean up afterward)
// in the SAME session -- so, exactly like shared-steps.spec.ts (WP-F06
// Task 6), this does not reuse the suite's shared 'contributor' persona
// (write:true, delete:false, e2e/support/api.ts's own header comment).
// Its own throwaway 'manager' persona is used instead, logged in via
// e2e/support/login.ts on a fresh browser context.
//
// Cleanup ordering (has bitten this programme repeatedly, per this task's
// brief): a dataset cannot be deleted while ANY test case still
// references it -- Task 1's delete guard (controllers/dataset.js's
// deleteDataset) refuses with 409. So `finally` deletes the TEST CASE
// (the only reference there is) BEFORE the DATASET. Reversing that order
// leaks the dataset document on every run. Every cleanup step below is
// independently guarded (its own try/catch, logged rather than thrown) so
// a failure in one can never skip a later one -- the exact shape of leak
// that cost this programme a Keycloak user in the WP-F06 spec, where an
// unguarded `expect()` sitting between two deletes in `finally` skipped
// everything after it, `persona.cleanup()` included.
import { test, expect, Page, BrowserContext } from '@playwright/test';
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

// A generic-looking MUI Select is a `role="combobox"` trigger whose menu
// renders on a click, not a mousedown-then-visible native <select> -- and
// both the "Dataset" and "Preview row" controls in DatasetBindControl.tsx
// start out disabled (canWrite still loading / the bound dataset's rows
// not fetched yet), so a click that lands before that resolves is
// silently a no-op and every assertion downstream fails for a reason that
// has nothing to do with what is being tested. This waits the control
// enabled first, exactly like TestCaseDetail.parameterised.test.tsx's own
// `selectPreviewRow` helper does for the jsdom version of the same
// control.
async function selectMuiOption(page: Page, comboName: RegExp, optionName: string | RegExp): Promise<void> {
  const combo = page.getByRole('combobox', { name: comboName });
  await expect(combo).toBeVisible({ timeout: 15000 });
  await expect
    .poll(async () => (await combo.getAttribute('aria-disabled')) || 'false', { timeout: 15000 })
    .not.toBe('true');
  await combo.click();
  await page.getByRole('option', { name: optionName }).click();
}

test.describe('parameterised test cases (WP-F07a Task 5 -- authoring, and the R3 proof)', () => {
  test.setTimeout(180000);

  test('bind a dataset, preview two rows, prove an unrelated edit never destroys the placeholders, and prove a bound dataset refuses deletion', async ({
    browser,
  }) => {
    const persona = await createE2EPersona('parameterised', 'manager');
    // Fresh context: the `browser` fixture's `newContext()` would otherwise
    // inherit playwright.config.ts's shared storageState (the suite's
    // 'contributor' persona), defeating the point of logging in as this
    // spec's own 'manager' persona -- same reasoning as shared-steps.spec.ts.
    // Declared here but CREATED inside the try below. Everything created
    // before the try is outside the finally's reach: a throw from
    // newContext() or serviceApi() used to skip cleanup entirely and leak
    // the persona created one line earlier -- the same leak class the
    // finally's own comment describes, one level further out.
    let context: BrowserContext | undefined;
    let api: AxiosInstance | undefined;

    let testCaseMongoId: string | undefined;
    let testCaseId: string | undefined;
    let datasetMongoId: string | undefined;
    const marker = Date.now();
    const datasetTitle = `e2e-dataset-${marker}`;

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

      const step1Text = 'Log in as {{role}}';
      const step1Expected = 'Dashboard shown for {{role}} in {{env}}';
      const plainStepText = 'Open the settings page';
      const plainExpectedText = 'Settings page loads';
      const editedPlainStepText = `${plainStepText} (edited while previewing row 2 -- e2e R3 proof)`;

      // --- Open a draft test case shell -- the ONLY reachable entry point
      // to the dataset library (DatasetManagerDialog is imported nowhere
      // except TestCaseDetail.tsx, verified the same way shared-steps.spec.ts
      // verified it for SharedStepManagerDialog: no standalone
      // Settings/Admin route renders it either). ---
      await createDraft(page, 'New Test Case');
      await expect(page.getByRole('heading', { name: 'New Test Case' })).toBeVisible({ timeout: 15000 });

      await page.getByRole('tab', { name: 'Steps' }).click();

      // --- Step 1: create the dataset through the manager dialog: 2
      // columns, 2 rows ---
      await page.getByRole('button', { name: /manage datasets/i }).click();
      const managerDialog = page.getByRole('dialog', { name: 'Manage datasets' });
      await expect(managerDialog).toBeVisible({ timeout: 10000 });

      await managerDialog.getByRole('button', { name: 'New dataset' }).click();
      const createFormDialog = page.getByRole('dialog', { name: 'New dataset' });
      await expect(createFormDialog).toBeVisible({ timeout: 10000 });

      await createFormDialog.getByLabel('Title', { exact: true }).fill(datasetTitle);
      await createFormDialog.getByLabel('Description', { exact: true }).fill('Login roles -- e2e fixture, WP-F07a Task 5.');
      await createFormDialog.getByLabel('Column 1', { exact: true }).fill('role');
      await createFormDialog.getByRole('button', { name: 'Add column' }).click();
      await createFormDialog.getByLabel('Column 2', { exact: true }).fill('env');

      await createFormDialog.getByRole('button', { name: 'Add row' }).click();
      await createFormDialog.getByLabel('Row 1, role', { exact: true }).fill('admin');
      await createFormDialog.getByLabel('Row 1, env', { exact: true }).fill('prod');
      await createFormDialog.getByRole('button', { name: 'Add row' }).click();
      await createFormDialog.getByLabel('Row 2, role', { exact: true }).fill('viewer');
      await createFormDialog.getByLabel('Row 2, env', { exact: true }).fill('staging');

      await createFormDialog.getByRole('button', { name: 'Create' }).click();
      await expect(createFormDialog).not.toBeVisible({ timeout: 15000 });

      await expect(managerDialog.getByText(new RegExp(escapeRegex(datasetTitle)))).toBeVisible({ timeout: 10000 });
      await managerDialog.getByRole('button', { name: 'Close' }).click();
      await expect(managerDialog).not.toBeVisible({ timeout: 10000 });

      // Capture the fixture's Mongo _id and business DatasetId now, right
      // after it is known to exist, so `finally` can always find it and
      // the bind step below has a concrete business id to match the
      // dropdown option against.
      const dsLookup = await api.get('/dataset', { params: { title: datasetTitle } });
      const dsDocs = (dsLookup.data?.data || []) as Array<{ _id: string; DatasetId: string }>;
      expect(dsDocs.length, `Expected to find the fixture dataset "${datasetTitle}" via GET /dataset`).toBe(1);
      datasetMongoId = dsDocs[0]._id;
      const datasetBusinessId = dsDocs[0].DatasetId;

      // --- Step 2: author a test case whose steps carry {{placeholders}} ---
      // Row 0 is the placeholder step this whole test protects. Row 1 is
      // the UNRELATED plain step edited later, while a preview row is
      // active -- it carries no placeholder at all, so any placeholder
      // text that turns up in ITS stored value could only have leaked in
      // from the preview.
      await page.locator('textarea[name="testStep"]').nth(0).fill(step1Text);
      await page.locator('textarea[name="Expected"]').nth(0).fill(step1Expected);
      await page.getByRole('button', { name: 'Add step' }).click();
      await page.locator('textarea[name="testStep"]').nth(1).fill(plainStepText);
      await page.locator('textarea[name="Expected"]').nth(1).fill(plainExpectedText);

      await page.getByRole('tab', { name: 'Details' }).click();
      const summaryMarker = `E2E parameterised ${marker}`;
      await page.getByLabel('Summary').fill(summaryMarker);

      const descriptionEditor = page.locator('.ql-editor');
      await descriptionEditor.click();
      await page.keyboard.type('Created by the WP-F07a Task 5 parameterised-cases e2e journey.');

      await page.getByRole('combobox', { name: 'Priority' }).click();
      await page.getByRole('option', { name: 'High' }).click();

      await page.getByRole('tab', { name: 'Steps' }).click();
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

      // --- Step 3: bind the dataset. Creating swaps this component's
      // entityId (draft sentinel -> real TestCaseId) and remounts it, so
      // the Steps tab has to be re-selected before DatasetBindControl
      // exists to click at all -- same remount behaviour shared-steps.spec.ts
      // documents for its own reference row after Create. ---
      await page.getByRole('tab', { name: 'Steps' }).click();

      await selectMuiOption(page, /dataset/i, new RegExp(`^${escapeRegex(datasetBusinessId)}.*${escapeRegex(datasetTitle)}$`));

      // Binding writes `datasetId` through commitField -> PUT -> the
      // entity query re-fetches -> DatasetBindControl's `datasetId` prop
      // goes from null to truthy -> the "Preview row" control mounts. Its
      // rows come from a SECOND query (getDataset(datasetId)) behind the
      // one that filled the dropdown, so it is not simply "visible the
      // instant the dropdown closes" -- selectMuiOption's own disabled-wait
      // covers exactly that gap for the row select below.
      await expect(page.getByRole('combobox', { name: /preview row/i })).toBeVisible({ timeout: 15000 });

      // --- Step 4: preview row 0 (admin, prod); assert the substituted
      // text is shown, in its own read-only column, never in the editable
      // field. ---
      await selectMuiOption(page, /preview row/i, 'Row 1: admin, prod');
      const previewCell = page.getByTestId('preview-cell-0');
      await expect(previewCell).toContainText('Log in as admin', { timeout: 15000 });
      await expect(previewCell).toContainText('Dashboard shown for admin in prod');
      // The editable control must still hold the authored placeholder --
      // never the substituted text -- with the preview visibly active.
      await expect(page.locator('textarea[name="testStep"]').nth(0)).toHaveValue(step1Text);

      // --- Step 5: switch to row 1 (viewer, staging); assert the DISPLAY
      // changes, and the authored field still does not. ---
      await selectMuiOption(page, /preview row/i, 'Row 2: viewer, staging');
      await expect(previewCell).toContainText('Log in as viewer', { timeout: 15000 });
      await expect(previewCell).not.toContainText('Log in as admin');
      await expect(page.locator('textarea[name="testStep"]').nth(0)).toHaveValue(step1Text);

      // --- Step 6: THE R3 PROOF. With row 2 (viewer/staging) still being
      // previewed, edit the UNRELATED step -- never touching the
      // placeholder row at all -- then prove via a genuine reload + a
      // fresh server read (not a DOM snapshot mid-render, see this file's
      // header comment) that the placeholder row's stored text is exactly
      // what was authored. ---
      const unrelatedField = page.locator('textarea[name="testStep"]').nth(1);
      await expect(unrelatedField).toHaveValue(plainStepText);
      await unrelatedField.fill(editedPlainStepText);
      await unrelatedField.blur();

      // Confirm the edit actually reached Mongo (not just the local
      // optimistic cache) before reloading -- the reload's whole point is
      // to prove what SURVIVED a real round trip, so it has to start from
      // a write that is known to have landed.
      await expect
        .poll(
          async () => {
            const resp = await api.get('/testrepo', { params: { TestCaseId: testCaseId } });
            const doc = (resp.data?.data || [])[0];
            return doc?.TestSteps?.[1]?.testStep;
          },
          { timeout: 20000 }
        )
        .toBe(editedPlainStepText);

      await page.reload();
      await expect(
        page.getByRole('heading', { name: new RegExp(`^${testCaseId} : ${summaryPattern}`) })
      ).toBeVisible({ timeout: 20000 });
      await page.getByRole('tab', { name: 'Steps' }).click();

      // DOM-level corroboration: a fresh mount defaults preview off, so
      // the placeholder row's editable field should show the authored
      // form with no preview interference at all.
      await expect(page.locator('textarea[name="testStep"]').nth(0)).toHaveValue(step1Text);
      await expect(page.locator('textarea[name="testStep"]').nth(1)).toHaveValue(editedPlainStepText);

      // The authoritative proof: read the STORED document straight back
      // out of Mongo via the same REST route the browser itself used,
      // from this Node-side client -- not the browser's React Query cache.
      const afterReload = await api.get('/testrepo', { params: { TestCaseId: testCaseId } });
      const afterDoc = (afterReload.data?.data || [])[0] as {
        TestSteps: Array<{ testStep: string; Expected: string }>;
      };
      expect(afterDoc.TestSteps[0].testStep).toBe(step1Text);
      expect(afterDoc.TestSteps[0].Expected).toBe(step1Expected);
      expect(afterDoc.TestSteps[1].testStep).toBe(editedPlainStepText);
      // Belt and braces: neither substituted value reached storage at all,
      // under either dataset row's text -- checked on the PARSED field
      // values (fix round 1), not a `JSON.stringify` substring match over
      // the whole array, which would false-fail the day any legitimately
      // authored field elsewhere in this fixture happens to contain the
      // literal word "admin" or "viewer".
      const parsedStepFields = afterDoc.TestSteps.flatMap((s) => [s.testStep, s.Expected]);
      expect(parsedStepFields.some((text) => text.includes('admin'))).toBe(false);
      expect(parsedStepFields.some((text) => text.includes('viewer'))).toBe(false);

      // --- Step 7: attempt to delete the bound dataset; the refusal must
      // name the blocking test case. ---
      await page.getByRole('button', { name: /manage datasets/i }).click();
      const managerDialog2 = page.getByRole('dialog', { name: 'Manage datasets' });
      await expect(managerDialog2).toBeVisible({ timeout: 10000 });

      await managerDialog2.getByRole('button', { name: `Delete ${datasetTitle}` }).click();
      const deleteDialog = page.getByRole('dialog', { name: new RegExp(`^Delete ${escapeRegex(datasetTitle)}\\?$`) });
      await expect(deleteDialog).toBeVisible({ timeout: 10000 });
      await deleteDialog.getByRole('button', { name: 'Delete', exact: true }).click();

      await expect(
        deleteDialog.getByText(new RegExp(`${escapeRegex(datasetBusinessId)} is used by 1 test case\\(s\\) and cannot be deleted`))
      ).toBeVisible({ timeout: 15000 });
      await expect(deleteDialog.getByText(new RegExp(escapeRegex(testCaseId!)))).toBeVisible();
      // Refused, not silently accepted -- the dialog is still open and the
      // dataset is still there to prove it.
      await expect(deleteDialog).toBeVisible();
      const stillThere = await api.get('/dataset', { params: { title: datasetTitle } });
      expect((stillThere.data?.data || []).length, 'The dataset must still exist after a refused delete').toBe(1);

      await deleteDialog.getByRole('button', { name: 'Cancel' }).click();
      await managerDialog2.getByRole('button', { name: 'Close' }).click();
    } finally {
      // Cleanup ordering: the test case (which carries the datasetId
      // reference) must go BEFORE the dataset, or the delete guard refuses
      // the dataset's cleanup with the same 409 Step 7 just proved. Each
      // step below is independently guarded so a failure in one can never
      // skip a later one -- see this file's header comment.
      try {
        if (api && testCaseMongoId) {
          await api!.delete(`/testrepo/${testCaseMongoId}`).catch(() => {});
          if (testCaseId) {
            try {
              const verifyTc = await api!.get('/testrepo', { params: { TestCaseId: testCaseId } });
              expect(verifyTc.data?.data || [], `${testCaseId} should be gone after cleanup`).toHaveLength(0);
            } catch (verifyErr) {
              // eslint-disable-next-line no-console
              console.error(`parameterised-cases.spec.ts cleanup: verify-gone check for ${testCaseId} failed`, verifyErr);
            }
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('parameterised-cases.spec.ts cleanup: deleting the test case failed', err);
      }
      try {
        if (datasetMongoId) {
          await api!.delete(`/dataset/${datasetMongoId}`).catch(() => {});
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('parameterised-cases.spec.ts cleanup: deleting the dataset failed', err);
      }
      try {
        if (context) await context.close();
      } finally {
        await persona.cleanup();
      }
    }
  });
});
