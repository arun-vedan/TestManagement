// Wave D-1 — Settings > Fields, the admin CRUD surface for field
// definitions (backend/fieldsService, secured end-to-end by Wave A-1).
//
// THIS IS THE MOST DANGEROUS JOURNEY IN THIS SUITE SO FAR: field
// definitions drive every detail form's FieldGrid
// (workbench/detail/FieldGrid.tsx) for every record in a module, for
// every user of the project. A leaked test field would silently change
// what every test-case/requirement/etc. form in project 1 looks like for
// everyone, not just this test run. This spec therefore:
//   - creates exactly one field, on module 1 (Test Cases), with an
//     unmistakable "E2E Temp Field ..." name carrying a timestamp,
//   - deletes it again through the real UI in the same test,
//   - confirms the delete via a fresh API re-query (not just the DOM),
//   - and additionally verifies via the API, in a `finally` block, that no
//     field matching this run's generated name survives even if an
//     assertion above it failed -- a genuine best-effort second line of
//     defence, on top of (not instead of) the in-test UI delete.
// It never touches any OTHER field. In particular it does NOT edit or
// delete TC-2 (the pre-existing "seeded drift" in folder `test44` noted in
// this WP's brief) or any other seeded/pre-existing field row.
//
// PERSONA: 'contributor' (the shared, storageState-backed persona every
// other spec in this suite reuses) has no 'delete' in the RBAC matrix
// (backend/shared/service-core/permissions.js) and Wave D-1's own
// FieldsPanel gates its Delete control on can('delete') -- so, per this
// suite's own established pattern (entity-creation.spec.ts's delete/clone
// journey), this logs in as its own throwaway 'manager' persona on a
// fresh browser context rather than inflating the shared persona's role.
//
// Navigation note: same constraint as every other spec here --
// package.json's "homepage": "." makes a cold page.goto() of a deep URL
// fail to boot the app (relative <script src> resolves wrong). Land on
// '/' first, then hop to Settings > Fields via the SPA's own router.
import { test, expect, Page } from '@playwright/test';
import { AxiosInstance } from 'axios';
import { assertApiReachable } from '../support/requireApi';
import { serviceApi } from '../support/api';
import { createE2EPersona } from '../auth/persona';
import { loginAsPersona } from '../support/login';

const BASE_URL = 'http://localhost:3000';
const TEST_CASES_MODULE_ID = 1;
const RELEASES_MODULE_ID = 6;

async function clientSideNavigate(page: Page, url: string) {
  await page.evaluate((target) => {
    window.history.pushState({}, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, url);
}

async function countFields(api: AxiosInstance, moduleId: number): Promise<number> {
  const resp = await api.get('/fields', { params: { moduleId } });
  return (resp.data?.data || []).length;
}

test.describe('Settings > Fields (Wave D-1)', () => {
  test.setTimeout(90000);

  test('create a field, confirm it appears, then delete it -- verified via the API', async ({ browser }) => {
    const persona = await createE2EPersona('fields-config', 'manager');
    // Fresh context, storageState explicitly cleared -- see entity-creation
    // .spec.ts's identical delete/clone journey for why (otherwise this
    // "fresh" context would silently inherit the shared contributor
    // session from playwright.config.ts).
    const context = await browser.newContext({ storageState: undefined });
    const api = await serviceApi();

    const runMarker = `E2E Temp Field ${Date.now()}`;
    const fieldNameMarker = `e2eTempField${Date.now()}`;

    // Baseline: every module's field count, before this test touches
    // anything. Recorded for the final report, and reused below to prove
    // the count returns to exactly this after cleanup.
    // All six modules, not just the four the Settings panel now offers
    // (WP-F24 Task 2, R3): modules 3/4 keep their existing field documents
    // in the backend (module 4 still carries the orphaned 'Step Status'
    // document -- the owner's explicit decision was to leave it, not
    // delete it) even though the UI no longer exposes them, so this
    // journey's "nothing else moved" check must still watch them.
    const beforeCounts: Record<number, number> = {};
    for (const moduleId of [1, 2, 3, 4, 5, 6]) {
      beforeCounts[moduleId] = await countFields(api, moduleId);
    }
    // eslint-disable-next-line no-console
    console.log('[fields-configuration] field counts before:', beforeCounts);

    try {
      const page = await context.newPage();
      await loginAsPersona(page, BASE_URL, persona);
      await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 15000 });

      await clientSideNavigate(page, '/projects/1/settings/fields');
      await page.waitForURL(/\/projects\/1\/settings\/fields/, { timeout: 15000 });
      await assertApiReachable(page);

      // 0. WP-F24 Task 2 -- Test Plans (module 3) is no longer offered here
      // at all (R3: the panel must not offer what the product ignores;
      // TestPlanDetail.tsx never reads module-3 field definitions). Module
      // 6 (Releases) is the real honest-empty-state case now -- seeded with
      // genuinely zero fields in every project but one (orchestrator-
      // verified live). Confirm that empty state shows up in the real app
      // -- not a spinner, not an error -- before touching module 1 at all.
      // getByRole('combobox', ...) rather than getByLabel: MUI's closing
      // Menu <ul> transiently keeps the same aria-labelledby as the
      // trigger, which made getByLabel('Module') match both and throw a
      // strict-mode violation on the second selection.
      const moduleSelect = page.getByRole('combobox', { name: 'Module' });
      await moduleSelect.click();
      expect(await page.getByRole('option', { name: 'Test Plans' }).count()).toBe(0);
      expect(await page.getByRole('option', { name: 'Test Runs' }).count()).toBe(0);
      await page.getByRole('option', { name: 'Releases' }).click();
      await expect(page.getByText(/no fields defined for releases/i)).toBeVisible({ timeout: 15000 });
      expect(beforeCounts[RELEASES_MODULE_ID]).toBe(0);

      // 1. Switch to module 1 (Test Cases) -- where this journey creates
      // its throwaway field.
      await moduleSelect.click();
      await page.getByRole('option', { name: 'Test Cases' }).click();
      await expect(page.getByRole('button', { name: /^new field$/i })).toBeVisible({ timeout: 15000 });

      // 2. Create.
      await page.getByRole('button', { name: /^new field$/i }).click();
      const createDialog = page.getByRole('dialog');
      await expect(createDialog).toBeVisible({ timeout: 10000 });
      await createDialog.getByLabel(/display name/i).fill(runMarker);
      await createDialog.getByLabel(/field name/i).fill(fieldNameMarker);
      // Type defaults to "Text" (CREATABLE_FIELD_TYPES[0]) -- no Select
      // interaction needed for the happy path; the type picker itself is
      // covered by FieldsPanel's own unit tests.
      await createDialog.getByRole('button', { name: /^create$/i }).click();
      await expect(createDialog).not.toBeVisible({ timeout: 15000 });

      // 3. Confirm it appears in the table.
      await expect(page.getByText(runMarker)).toBeVisible({ timeout: 15000 });

      // 4. Confirm via the API that it was really persisted (not just
      // rendered) -- exactly one new field on module 1, with this run's
      // field name.
      const afterCreate = (await api.get('/fields', { params: { moduleId: TEST_CASES_MODULE_ID } })).data?.data as Array<{
        _id: string;
        fieldName: string;
        displayName: string;
      }>;
      expect(afterCreate.length).toBe(beforeCounts[TEST_CASES_MODULE_ID] + 1);
      const created = afterCreate.find((f) => f.fieldName === fieldNameMarker);
      expect(created, `Expected a persisted field named "${fieldNameMarker}"`).toBeTruthy();
      expect(created!.displayName).toBe(runMarker);

      // 5. Delete it through the real UI -- confirmation dialog, naming
      // the field, warning about every record's form in the module.
      await page.getByRole('button', { name: new RegExp(`Delete ${runMarker}`, 'i') }).click();
      const deleteDialog = page.getByRole('dialog');
      await expect(deleteDialog).toBeVisible({ timeout: 10000 });
      await expect(deleteDialog.getByText(new RegExp(`Delete ${runMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))).toBeVisible();
      await expect(deleteDialog.getByText(/every record/i)).toBeVisible();
      await deleteDialog.getByRole('button', { name: /^delete$/i }).click();
      await expect(deleteDialog).not.toBeVisible({ timeout: 15000 });

      // 6. Confirm it's gone from the table...
      await expect(page.getByText(runMarker)).not.toBeVisible({ timeout: 15000 });

      // 7. ...and confirm via a FRESH API re-query (never just trust the
      // 2xx on the DELETE call, or the DOM) that it is really gone, and
      // that module 1's field count is back to exactly its baseline.
      const afterDelete = (await api.get('/fields', { params: { moduleId: TEST_CASES_MODULE_ID } })).data?.data as Array<{
        fieldName: string;
      }>;
      expect(afterDelete.find((f) => f.fieldName === fieldNameMarker)).toBeUndefined();
      expect(afterDelete.length).toBe(beforeCounts[TEST_CASES_MODULE_ID]);

      // No other module was touched by this journey -- including 3/4
      // (no longer reachable through the Settings dropdown at all) and 6
      // (only viewed above, never written to).
      for (const moduleId of [2, 3, 4, 5, 6]) {
        expect(await countFields(api, moduleId)).toBe(beforeCounts[moduleId]);
      }
    } finally {
      // Context teardown lives here (not after the assertions above) so it
      // still runs even if one of those assertions throws.
      // Best-effort second line of defence: if any assertion above threw
      // before the UI delete completed, make sure nothing matching this
      // run's own generated field name survives on module 1 regardless.
      // Never touches any field this run didn't itself create.
      const leftover = (await api.get('/fields', { params: { moduleId: TEST_CASES_MODULE_ID } })).data?.data as Array<{
        _id: string;
        fieldName: string;
      }>;
      const stragglers = leftover.filter((f) => f.fieldName === fieldNameMarker);
      for (const f of stragglers) {
        // eslint-disable-next-line no-console
        console.warn(`[fields-configuration] cleaning up a straggler field left by a failed run: ${f._id}`);
        await api.delete(`/fields/${f._id}`).catch(() => {});
      }

      const finalCounts: Record<number, number> = {};
      for (const moduleId of [1, 2, 3, 4, 5, 6]) {
        finalCounts[moduleId] = await countFields(api, moduleId);
      }
      // eslint-disable-next-line no-console
      console.log('[fields-configuration] field counts after:', finalCounts);

      await context.close().catch(() => {});
      await persona.cleanup();
    }
  });
});
