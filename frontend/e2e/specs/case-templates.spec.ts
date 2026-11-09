// WP-F08 Task 3 -- the browser journey that closes this work package, and
// R4's proof of record: A TEMPLATE CAPTURES A RECORD AS IT WAS AND NEVER
// UPDATES.
//
// Tasks 1-2 (reviewed, merged) gave `CaseTemplate` a model/CRUD/RBAC
// surface (Task 1, backend/testRepoService/{models,controllers,routes}/
// caseTemplate.js) and wired "Save as template" / "Start from template"
// into the workbench, reusing useCloneEntity's own draft-open mechanism
// (openDraftFromPrefill) rather than a parallel one (Task 2,
// workbench/entityPrefill.ts's buildEntityPrefill, Hooks/mutations/
// useStartFromTemplate.ts). This spec is the first thing in the whole
// package that opens a real browser and proves the chain end to end:
// author a test case with steps -> save it as a template -> start a new
// case from that template -> assert the new case carries the template's
// fields and steps -> EDIT THE ORIGINAL CASE -> reopen the template and
// confirm it did NOT change -> clean up.
//
// That last pair is the point of this whole spec. WP-F06's SharedStep is a
// LIVE reference: editing a shared step updates every test case that
// references it. A CaseTemplate is the opposite (R4, models/CaseTemplate.js's
// own header comment): saving one captures the source record's fields
// AT THAT MOMENT, and neither side ever touches the other again. Both
// behaviours now exist in the same product; this spec pins which is which
// by editing the ORIGINAL test case's step text AFTER the template was
// saved from it, then reopening the template (via "Start from template…"
// again) and asserting the freshly-opened draft still shows the
// PRE-EDIT text -- not the edit -- corroborated by a direct read of the
// stored `CaseTemplate.prefill` through the API, not just the DOM.
//
// Fixed setup shape, matching release-wiring.spec.ts (WP-F15/F18 Task 5)
// and parameterised-cases.spec.ts (WP-F07a Task 5) exactly: persona,
// browser context and the API client are all created INSIDE the `try`, so
// nothing created can escape the `finally` if a later setup step throws.
// An earlier spec in this suite (WP-F06's shared-steps.spec.ts, before its
// own fix) created its persona OUTSIDE the try and leaked a Keycloak user
// when a step between persona creation and the try's own body threw.
//
// Own throwaway 'manager' persona (write + delete), not the shared
// 'contributor' one this suite's other specs reuse: the shared persona is
// session-wide (e2e/auth/global-setup.ts) and has no 'delete'
// (e2e/support/api.ts's own header comment on why that shared persona
// stays at 'contributor'), and this spec's cleanup needs to delete both
// test cases and the template it creates.
import { test, expect, Page, BrowserContext } from '@playwright/test';
import { AxiosInstance } from 'axios';
import { assertApiReachable } from '../support/requireApi';
import { serviceApi } from '../support/api';
import { createE2EPersona } from '../auth/persona';
import { loginAsPersona } from '../support/login';
// ed3f06d moved these out of the panel header into the "New" menu.
import { createDraft, chooseCreate } from '../support/sourcePanelMenus';

const BASE_URL = 'http://localhost:3000';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function clientSideNavigate(page: Page, url: string): Promise<void> {
  await page.evaluate((target) => {
    window.history.pushState({}, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, url);
}

async function selectMuiOption(page: Page, comboName: string | RegExp, optionName: string | RegExp): Promise<void> {
  const combo = page.getByRole('combobox', { name: comboName });
  await expect(combo).toBeVisible({ timeout: 15000 });
  await combo.click();
  await page.getByRole('option', { name: optionName }).click();
}

test.describe('case templates (WP-F08 Task 3 -- authoring, and the R4 proof)', () => {
  test.setTimeout(180000);

  test('save a test case as a template, start a new case from it, then prove editing the original never touches the template', async ({
    browser,
  }) => {
    const persona = await createE2EPersona('case-templates', 'manager');

    // Declared here, CREATED inside the try below -- see this file's
    // header comment on why that ordering is load-bearing, not style.
    let context: BrowserContext | undefined;
    let api: AxiosInstance | undefined;

    let originalTestCaseId: string | undefined;
    let originalMongoId: string | undefined;
    let templateMongoId: string | undefined;
    let clonedTestCaseId: string | undefined;
    let clonedMongoId: string | undefined;

    const marker = Date.now();
    const summaryText = `E2E case-templates origin ${marker}`;
    const templateName = `E2E CaseTemplate ${marker}`;
    const step1Text = 'Navigate to the login page';
    const step1Expected = 'Login form is shown';
    const step2Text = 'Enter valid credentials and submit';
    const step2Expected = 'Dashboard is shown';
    const editedStep1Text = `${step1Text} (edited after the template was saved -- e2e R4 proof)`;

    try {
      context = await browser.newContext({ storageState: undefined });
      api = await serviceApi();
      const page = await context.newPage();
      await loginAsPersona(page, BASE_URL, persona);
      await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 15000 });

      // === Step 1: author a test case with steps (module 1 draft flow,
      // same shape parameterised-cases.spec.ts's own module-1 journey
      // proved). ===
      await clientSideNavigate(page, '/projects/1/workbench/testcases');
      await page.waitForURL(/\/projects\/1\/workbench\/testcases/, { timeout: 15000 });
      await assertApiReachable(page);
      await page.getByRole('tree').waitFor({ state: 'visible', timeout: 30000 });

      await createDraft(page, 'New Test Case');
      await expect(page.getByRole('heading', { name: 'New Test Case' })).toBeVisible({ timeout: 15000 });

      await page.getByRole('tab', { name: 'Steps' }).click();
      await page.locator('textarea[name="testStep"]').nth(0).fill(step1Text);
      await page.locator('textarea[name="Expected"]').nth(0).fill(step1Expected);
      await page.getByRole('button', { name: 'Add step' }).click();
      await page.locator('textarea[name="testStep"]').nth(1).fill(step2Text);
      await page.locator('textarea[name="Expected"]').nth(1).fill(step2Expected);

      // Summary lives OUTSIDE the tab content (always visible), but
      // Priority is a FieldGrid field on the Details tab -- has to be
      // selected there, same ordering parameterised-cases.spec.ts's own
      // module-1 journey uses.
      await page.getByRole('tab', { name: 'Details' }).click();
      await page.getByLabel('Summary').fill(summaryText);
      // TestCaseDescription is a required field on this schema (models/
      // testrepo.js) -- omitting it 400s the create with "Please add a
      // Display name", found the hard way on a first run of this spec.
      const descriptionEditor = page.locator('.ql-editor');
      await descriptionEditor.click();
      await page.keyboard.type('Created by the WP-F08 Task 3 case-templates e2e journey.');
      await selectMuiOption(page, 'Priority', 'High');

      await page.getByRole('tab', { name: 'Steps' }).click();
      await page.getByRole('button', { name: /^create$/i }).click();

      const originalHeading = page.getByRole('heading', { name: new RegExp(`^TC-\\d+ : ${escapeRegex(summaryText)}`) });
      await expect(originalHeading).toBeVisible({ timeout: 20000 });
      originalTestCaseId = ((await originalHeading.textContent()) || '').match(/^(TC-\d+)/)?.[1];
      expect(originalTestCaseId, 'Could not parse a TestCaseId out of the created test case heading').toBeTruthy();

      const foundOriginal = await api.get('/testrepo', { params: { TestCaseId: originalTestCaseId } });
      const originalDocs = (foundOriginal.data?.data || []) as Array<{ _id: string }>;
      expect(originalDocs.length, `Expected to find ${originalTestCaseId} via GET /testrepo`).toBe(1);
      originalMongoId = originalDocs[0]._id;

      // === Step 2: save it as a template, through the control this task's
      // predecessor put on the detail view's own header row. ===
      await page.getByRole('button', { name: /save as template/i }).click();
      const saveDialog = page.getByRole('dialog', { name: 'Save as template' });
      await expect(saveDialog).toBeVisible({ timeout: 10000 });
      await saveDialog.getByLabel('Template name').fill(templateName);
      await saveDialog.getByLabel('Description').fill('Login journey template -- e2e fixture, WP-F08 Task 3.');
      await saveDialog.getByRole('button', { name: 'Save' }).click();
      await expect(saveDialog).not.toBeVisible({ timeout: 15000 });

      const templateLookup = await api.get('/casetemplate', { params: { name: templateName } });
      const templateDocs = (templateLookup.data?.data || []) as Array<{ _id: string; prefill: Record<string, unknown> }>;
      expect(templateDocs.length, `Expected to find the template "${templateName}" via GET /casetemplate`).toBe(1);
      templateMongoId = templateDocs[0]._id;
      // The prefill was captured from the record AS IT STOOD at save time --
      // asserted here on the STORED document (server truth), not just what
      // the picker will later render, so a captured-vs-live confusion has
      // nowhere to hide.
      const capturedSteps = templateDocs[0].prefill.TestSteps as Array<{ testStep: string; Expected: string }>;
      expect(templateDocs[0].prefill.TestCaseSummary).toBe(summaryText);
      expect(capturedSteps[0].testStep).toBe(step1Text);
      expect(capturedSteps[1].testStep).toBe(step2Text);

      // === Step 3: start a new case FROM that template, through
      // SourcePanel's "Start from template…" control (CaseTemplatePicker ->
      // useStartFromTemplate -> openDraftFromPrefill -- the exact mechanism
      // Clone uses, fed a STORED prefill instead of a freshly-fetched live
      // record). ===
      await chooseCreate(page, 'Start from template…');
      const pickerDialog = page.getByRole('dialog', { name: 'Start from template' });
      await expect(pickerDialog).toBeVisible({ timeout: 10000 });
      await pickerDialog.getByLabel('Search templates').fill(templateName);
      await expect(pickerDialog.getByText(templateName)).toBeVisible({ timeout: 10000 });
      await pickerDialog.getByRole('button', { name: 'Use' }).click();
      await expect(pickerDialog).not.toBeVisible({ timeout: 10000 });

      // === Step 4: assert the new draft carries the template's fields and
      // steps -- BEFORE it is even created, proving the prefill actually
      // reached the form, not just that the eventual save happened to match. ===
      await expect(page.getByRole('heading', { name: 'New Test Case' })).toBeVisible({ timeout: 15000 });
      await expect(page.getByLabel('Summary')).toHaveValue(summaryText);
      await expect(page.getByRole('combobox', { name: 'Priority' })).toHaveText('High');

      await page.getByRole('tab', { name: 'Steps' }).click();
      await expect(page.locator('textarea[name="testStep"]').nth(0)).toHaveValue(step1Text);
      await expect(page.locator('textarea[name="Expected"]').nth(0)).toHaveValue(step1Expected);
      await expect(page.locator('textarea[name="testStep"]').nth(1)).toHaveValue(step2Text);
      await expect(page.locator('textarea[name="Expected"]').nth(1)).toHaveValue(step2Expected);

      await page.getByRole('button', { name: /^create$/i }).click();
      const clonedHeading = page.getByRole('heading', { name: new RegExp(`^TC-\\d+ : ${escapeRegex(summaryText)}`) });
      await expect(clonedHeading).toBeVisible({ timeout: 20000 });
      const clonedHeadingText = (await clonedHeading.textContent()) || '';
      clonedTestCaseId = clonedHeadingText.match(/^(TC-\d+)/)?.[1];
      expect(clonedTestCaseId, 'Could not parse a TestCaseId out of the template-started test case heading').toBeTruthy();
      expect(clonedTestCaseId, 'The template-started case must be a NEW record, not the original').not.toBe(originalTestCaseId);

      const foundCloned = await api.get('/testrepo', { params: { TestCaseId: clonedTestCaseId } });
      const clonedDocs = (foundCloned.data?.data || []) as Array<{
        _id: string;
        TestCaseSummary: string;
        TestSteps: Array<{ testStep: string; Expected: string }>;
      }>;
      expect(clonedDocs.length, `Expected to find ${clonedTestCaseId} via GET /testrepo`).toBe(1);
      clonedMongoId = clonedDocs[0]._id;
      expect(clonedDocs[0].TestCaseSummary).toBe(summaryText);
      expect(clonedDocs[0].TestSteps[0].testStep).toBe(step1Text);
      expect(clonedDocs[0].TestSteps[1].testStep).toBe(step2Text);

      // === Step 5: edit the ORIGINAL test case's first step, through its
      // own tab (still open in the TabStrip from Step 1 -- navigating via
      // the tree, same as release-wiring.spec.ts's bidirectionality check,
      // rather than the tab strip, whose accessible name gains a
      // "— unsaved changes" suffix while dirty and would make an exact-name
      // lookup brittle). ===
      const originalTreeRow = page.getByRole('treeitem', { name: originalTestCaseId!, exact: true });
      await expect(originalTreeRow).toBeVisible({ timeout: 15000 });
      await originalTreeRow.click();
      await expect(
        page.getByRole('heading', { name: new RegExp(`^${escapeRegex(originalTestCaseId!)} : `) })
      ).toBeVisible({ timeout: 15000 });

      await page.getByRole('tab', { name: 'Steps' }).click();
      const originalStep0 = page.locator('textarea[name="testStep"]').nth(0);
      await expect(originalStep0).toHaveValue(step1Text);
      await originalStep0.fill(editedStep1Text);
      await originalStep0.blur();

      // Confirm the edit actually reached Mongo before checking the
      // template -- same discipline parameterised-cases.spec.ts's own R3
      // proof uses: the point below is what SURVIVED a real write, not an
      // optimistic local cache.
      await expect
        .poll(
          async () => {
            const resp = await api!.get('/testrepo', { params: { TestCaseId: originalTestCaseId } });
            const doc = (resp.data?.data || [])[0];
            return doc?.TestSteps?.[0]?.testStep;
          },
          { timeout: 20000 }
        )
        .toBe(editedStep1Text);

      // === Step 6: THE R4 PROOF. Reopen the template (start ANOTHER draft
      // from the same CaseTemplate) and confirm it still shows the
      // PRE-EDIT step text -- not the edit just made to the original. ===
      await chooseCreate(page, 'Start from template…');
      const pickerDialog2 = page.getByRole('dialog', { name: 'Start from template' });
      await expect(pickerDialog2).toBeVisible({ timeout: 10000 });
      await pickerDialog2.getByLabel('Search templates').fill(templateName);
      await expect(pickerDialog2.getByText(templateName)).toBeVisible({ timeout: 10000 });
      await pickerDialog2.getByRole('button', { name: 'Use' }).click();
      await expect(pickerDialog2).not.toBeVisible({ timeout: 10000 });

      await expect(page.getByRole('heading', { name: 'New Test Case' })).toBeVisible({ timeout: 15000 });
      await expect(page.getByLabel('Summary')).toHaveValue(summaryText);
      await page.getByRole('tab', { name: 'Steps' }).click();
      // The load-bearing assertion: still the ORIGINALLY captured text.
      // If this ever reads `editedStep1Text` instead, the template
      // silently started tracking its source record -- exactly the
      // SharedStep-style live-propagation behaviour R4 says a template
      // must never have.
      await expect(page.locator('textarea[name="testStep"]').nth(0)).toHaveValue(step1Text);
      await expect(page.locator('textarea[name="testStep"]').nth(0)).not.toHaveValue(editedStep1Text);

      // Corroborated server-side too: the STORED CaseTemplate document
      // itself, read fresh (not the picker's possibly-cached list query).
      const templateAfterEdit = await api.get('/casetemplate', { params: { name: templateName } });
      const templateAfterEditDocs = (templateAfterEdit.data?.data || []) as Array<{ prefill: Record<string, unknown> }>;
      expect(templateAfterEditDocs.length).toBe(1);
      const stepsAfterEdit = templateAfterEditDocs[0].prefill.TestSteps as Array<{ testStep: string }>;
      expect(stepsAfterEdit[0].testStep).toBe(step1Text);
      expect(stepsAfterEdit[0].testStep).not.toBe(editedStep1Text);

      // And the reverse half of R4, for completeness: the ORIGINAL case's
      // own stored steps still show the edit -- the template's snapshot
      // being frozen does not mean the live record's own edit was somehow
      // rolled back either. Two independent records, neither touching the
      // other.
      const originalAfterEdit = await api.get('/testrepo', { params: { TestCaseId: originalTestCaseId } });
      expect((originalAfterEdit.data?.data || [])[0]?.TestSteps?.[0]?.testStep).toBe(editedStep1Text);
    } finally {
      // Cleanup, children before parents where that ordering matters, every
      // step independently guarded so a failure in one can never skip a
      // later one -- the exact shape of leak that has cost this programme a
      // Keycloak user before (release-wiring.spec.ts's own header comment).
      // Unlike parameterised-cases.spec.ts's dataset/test-case pair, there
      // is no delete-guard ordering constraint here at all (R5: a
      // CaseTemplate has no usage query and nothing ever references it
      // after creation) -- the three deletes below could run in any order.
      try {
        if (api && clonedMongoId) await api.delete(`/testrepo/${clonedMongoId}`).catch(() => {});
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('case-templates.spec.ts cleanup: deleting the template-started test case failed', err);
      }
      try {
        if (api && originalMongoId) await api.delete(`/testrepo/${originalMongoId}`).catch(() => {});
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('case-templates.spec.ts cleanup: deleting the original test case failed', err);
      }
      try {
        if (api && templateMongoId) await api.delete(`/casetemplate/${templateMongoId}`).catch(() => {});
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('case-templates.spec.ts cleanup: deleting the template failed', err);
      }
      try {
        if (context) await context.close();
      } finally {
        await persona.cleanup();
      }
    }
  });
});
