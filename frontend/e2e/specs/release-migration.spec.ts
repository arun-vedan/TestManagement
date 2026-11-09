// WP-F18b Task 4 -- the browser journey that closes this work package.
//
// F15/F18 put releases in the workbench (a list, a detail view, links, the
// lens -- release-wiring.spec.ts proves that chain) but deliberately left
// the old standalone nav page (Pages/releases.tsx, routed at
// /projects/:id/releases) in place, owning release create/delete, quality-
// gate EDITING, and environments (ruling R2 of this WP's plan). The owner
// then hit the consequence directly: "the release is wired in the main app
// drawer and not the workbench" -- the same concept in two places, with
// quality gates split down the middle (edited on the nav page, status shown
// in the workbench). Tasks 1-3 moved every one of those capabilities into
// the workbench and Settings; this task deleted the nav page and its drawer
// entry. This spec is the proof that nothing was lost in that move: it
// creates a release, edits its gates, reads their live status, links a
// defect, and manages an environment -- all from the ONE place any of that
// now lives -- then deletes both the environment and the release, from the
// specific new homes WP-F18b Tasks 1/3 gave those two actions.
//
// TWO DELIBERATE BEHAVIOUR CHANGES this journey exercises, not ports:
//   1. Environments gained edit AND delete. The old nav page's own
//      environments section was CREATE-ONLY -- no edit or delete UI ever
//      existed there (see Components/settings/EnvironmentsPanel.tsx's own
//      header comment). This journey deletes the environment it creates,
//      through a control that has no predecessor to compare it to.
//   2. Delete moved from a list row to the detail header. The old nav
//      page offered delete from its releases table, one click away, no
//      need to open the record first. ReleaseDetail.tsx offers it only
//      after opening the release (ruling Z6 of this WP's plan: opening
//      before deleting is safer for an entity that aggregates other work,
//      and EntityList.tsx has no per-row delete for ANY module -- adding
//      one only for releases would make module 6 an exception twice over).
//      This journey opens the release (via the list's own id-cell click,
//      entityListConfigs.tsx's ReleaseIdCell -- the same mechanism
//      release-wiring.spec.ts's own header comment documents fixing) before
//      it can delete it, on purpose.
//
// Fixed setup shape, matching release-wiring.spec.ts (WP-F15/F18 Task 5)
// exactly: persona, browser context and the API client are all created
// INSIDE the `try`, so nothing created can escape the `finally` if a later
// setup step throws -- the same lesson WP-F06's shared-steps.spec.ts learned
// the hard way (a persona created OUTSIDE the try leaked a Keycloak user
// when a step between persona creation and the try's own body threw).
//
// Own throwaway 'manager' persona (write + delete), not the suite's shared
// 'contributor' (write, no delete -- this journey's own delete steps need
// real delete rights, and inflating the shared persona would be the wrong
// fix per e2e/support/api.ts's own header comment on that exact question).
//
// ORDERING NOTE: this journey creates the defect fixture it links to the
// release AFTER editing the release's own gates, and reopens the release
// through the list's id-cell click both after that detour and after the
// Settings detour -- not because the workbench "forgets" the release (its
// tabs persist across a project, workbenchStore.ts's own `persist`
// middleware), but because opening a DIFFERENT tab (the new defect) moves
// `activeTabKey` off the release, and EntityDetail.tsx derives what a
// module's detail region shows SOLELY from the active tab, never from the
// URL's own `:entityId` segment -- so a same-session re-navigation to the
// release's own deep-link URL is not enough on its own to bring it back.
import { test, expect, Page, BrowserContext } from '@playwright/test';
import { AxiosInstance } from 'axios';
import { assertApiReachable } from '../support/requireApi';
import { serviceApi } from '../support/api';
import { createE2EPersona } from '../auth/persona';
import { loginAsPersona } from '../support/login';
// ed3f06d moved these out of the panel header into the "New" menu.
import { chooseCreate, createDraft } from '../support/sourcePanelMenus';

const BASE_URL = 'http://localhost:3000';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// package.json's "homepage": "." makes CRA/webpack-dev-server emit a
// RELATIVE <script src>, so a cold page.goto() of a deep URL never boots
// the app -- every spec in this suite lands on '/' first, then hops via the
// SPA's own client-side router, reproducing what a same-origin link click
// does. Same helper as release-wiring.spec.ts, duplicated rather than
// shared -- this suite has no shared e2e-test-utility module for it yet.
async function clientSideNavigate(page: Page, url: string): Promise<void> {
  await page.evaluate((target) => {
    window.history.pushState({}, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, url);
}

// A generic MUI <Select>'s trigger is role="combobox"; its menu renders on
// click, not hover.
async function selectMuiOption(page: Page, comboName: string | RegExp, optionName: string | RegExp): Promise<void> {
  const combo = page.getByRole('combobox', { name: comboName });
  await expect(combo).toBeVisible({ timeout: 15000 });
  await combo.click();
  await page.getByRole('option', { name: optionName }).click();
}

// Reopens the release from the workbench's List view -- the same
// ReleaseIdCell click release-wiring.spec.ts's own Step 5 uses, and the
// only reliable way back into it once some OTHER tab has become active
// (see this file's own header comment on why).
async function reopenReleaseFromList(page: Page, releaseHumanId: string): Promise<void> {
  await clientSideNavigate(page, '/projects/1/workbench/releases');
  await page.waitForURL(/\/projects\/1\/workbench\/releases/, { timeout: 15000 });
  await page.getByRole('button', { name: 'List view' }).click();
  const releaseIdCell = page.getByRole('button', { name: releaseHumanId });
  await expect(releaseIdCell).toBeVisible({ timeout: 20000 });
  await releaseIdCell.click();
}

test.describe('release migration (WP-F18b Task 4 -- releases live only in the workbench now)', () => {
  test.setTimeout(240000);

  test('create a release, edit its gates, see gate status, link a defect, manage an environment in Settings, delete both, clean up', async ({
    browser,
  }) => {
    const marker = Date.now();
    const persona = await createE2EPersona('release-migration', 'manager');

    // Declared here, CREATED inside the try below -- see this file's header
    // comment on why that ordering is load-bearing, not style.
    let context: BrowserContext | undefined;
    let api: AxiosInstance | undefined;

    let releaseMongoId: string | undefined;
    let releaseHumanId: string | undefined;
    let defectId: string | undefined;
    let environmentId: string | undefined;
    // The two generic-link documents the Links tab's forward+reverse
    // double-write creates (release<->defect) -- same accounting
    // release-wiring.spec.ts's own linkDocIds does.
    const linkDocIds: string[] = [];

    const releaseName = `E2E Release Migration ${marker}`;
    const defectSummary = `E2E relmigration defect ${marker}`;
    const envName = `E2E Migration Env ${marker}`;

    try {
      context = await browser.newContext({ storageState: undefined });
      api = await serviceApi();
      const page = await context.newPage();
      await loginAsPersona(page, BASE_URL, persona);
      await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 15000 });

      // === Step 1: create the release -- the workbench's OWN "New
      // Release" dialog (SourcePanel.tsx's CreateActions, WP-F18b Task 3).
      // This is now the ONLY create surface: Pages/releases.tsx is deleted
      // and /projects/1/releases no longer renders a page of its own (this
      // task redirects it straight back into this same workbench route). ===
      await clientSideNavigate(page, '/projects/1/workbench/releases');
      await page.waitForURL(/\/projects\/1\/workbench\/releases/, { timeout: 15000 });
      await assertApiReachable(page);

      await chooseCreate(page, 'New Release');

      const createDialog = page.getByRole('dialog', { name: 'New Release' });
      await expect(createDialog).toBeVisible({ timeout: 10000 });
      await createDialog.getByLabel('Name', { exact: true }).fill(releaseName);
      await createDialog.getByRole('button', { name: /^create$/i }).click();
      await expect(createDialog).not.toBeVisible({ timeout: 15000 });

      // The dialog opens straight into the new release's own, already-saved
      // tab (SourcePanel.tsx's NewReleaseButton.handleCreate) -- the human
      // id comes off the detail heading, not a table row.
      const releaseHeading = page.getByRole('heading', { name: new RegExp(`^REL-\\d+ : ${escapeRegex(releaseName)}`) });
      await expect(releaseHeading).toBeVisible({ timeout: 20000 });
      releaseHumanId = ((await releaseHeading.textContent()) || '').match(/^(REL-\d+)/)?.[1];
      expect(releaseHumanId, `Could not parse a releaseId out of the created release heading for "${releaseName}"`).toBeTruthy();

      const releaseLookup = await api.get('/releases', { params: { releaseId: releaseHumanId } });
      const releaseDocs = (releaseLookup.data?.data || []) as Array<{ _id: string }>;
      expect(releaseDocs.length, `Expected to find ${releaseHumanId} via GET /releases`).toBe(1);
      releaseMongoId = releaseDocs[0]._id;

      // === Step 2: edit its gates -- ReleaseDetail.tsx's QualityGatesPanel
      // (WP-F18b Task 2), the exact capability the owner reported split
      // across two pages. A freshly-created release has none yet; the
      // editor says so plainly rather than showing an empty results table
      // that would imply gates already exist (this WP's plan, Task 2). ===
      await page.getByRole('tab', { name: 'Quality Gates' }).click();
      await expect(page.getByText('No quality gates configured for this release.')).toBeVisible({ timeout: 10000 });
      await page.getByRole('button', { name: /^add rule$/i }).click();
      await page.getByLabel('Threshold').fill('90');
      await page.getByRole('button', { name: /^save gates$/i }).click();

      // === Step 3: see gate status -- the SAME tab, refreshed by the save
      // above (QualityGatesPanel's own onSuccess invalidates the live
      // gate-status query) -- status and editing are now beside each
      // other, not on two different pages. ===
      await expect(page.getByText('Overall:')).toBeVisible({ timeout: 15000 });
      await expect(page.getByRole('cell', { name: 'minPassRate' })).toBeVisible({ timeout: 15000 });
      await expect(page.getByRole('cell', { name: '90' })).toBeVisible();

      // === Step 4: create a defect fixture to link (module 5 draft flow,
      // same shape release-wiring.spec.ts's own Step 2 uses). Opening this
      // tab moves `activeTabKey` off the release -- see this file's header
      // comment on why the release then needs reopening below. ===
      await clientSideNavigate(page, '/projects/1/workbench/defects');
      await page.waitForURL(/\/projects\/1\/workbench\/defects/, { timeout: 15000 });
      await page.getByRole('tree').waitFor({ state: 'visible', timeout: 30000 });

      await createDraft(page, 'New Defect');
      await expect(page.getByRole('heading', { name: 'New Defect' })).toBeVisible({ timeout: 15000 });
      await page.getByLabel('Summary', { exact: false }).fill(defectSummary);
      await page.locator('.ql-editor').click();
      await page.keyboard.type('Created by release-migration.spec.ts (WP-F18b Task 4).');
      await selectMuiOption(page, 'Priority', 'High');
      await page.getByRole('button', { name: /^create$/i }).click();

      const defectHeading = page.getByRole('heading', { name: new RegExp(`^Bug-\\d+ : ${escapeRegex(defectSummary)}`) });
      await expect(defectHeading).toBeVisible({ timeout: 20000 });
      defectId = ((await defectHeading.textContent()) || '').match(/^(Bug-\d+)/)?.[1];
      expect(defectId, 'Could not parse a defectId out of the created defect heading').toBeTruthy();

      // === Step 5: link the defect, through the release's own Links tab
      // (LinksSection, srcModule=6 -- WP-F15/F18 Task 3). Reopen the
      // release first (this file's header comment). ===
      await reopenReleaseFromList(page, releaseHumanId!);
      await expect(releaseHeading).toBeVisible({ timeout: 20000 });
      await page.getByRole('tab', { name: 'Links' }).click();
      await expect(page.getByText('Linked Issues')).toBeVisible({ timeout: 10000 });

      await selectMuiOption(page, 'Issue type', 'Defects');
      await page.getByLabel('Search issue').fill(defectSummary);
      await page.getByRole('option', { name: new RegExp(`${escapeRegex(defectId!)}.*${escapeRegex(defectSummary)}`) }).click({
        timeout: 15000,
      });
      await selectMuiOption(page, 'Link type', 'relates-to');
      await page.getByRole('button', { name: /^link$/i }).click();
      // Scoped to the active tabpanel -- the defect's own id is also
      // present elsewhere on the page by now (its TabStrip tab), same
      // ambiguity release-wiring.spec.ts's header comment documents.
      await expect(page.getByRole('tabpanel').getByText(new RegExp(escapeRegex(defectId!)))).toBeVisible({ timeout: 15000 });

      // Both forward+reverse pairs actually landed (linkissue.tsx's
      // client-side double write) -- verified via the API, not assumed
      // from the UI alone.
      await expect
        .poll(async () => (await api!.get('/linkIssue', { params: { sourceId: releaseHumanId } })).data?.data?.length, {
          timeout: 15000,
        })
        .toBeGreaterThanOrEqual(1);
      const relSourced = (await api.get('/linkIssue', { params: { sourceId: releaseHumanId } })).data?.data || [];
      const relDestined = (await api.get('/linkIssue', { params: { destinationId: releaseHumanId } })).data?.data || [];
      linkDocIds.push(...[...relSourced, ...relDestined].map((d: { _id: string }) => d._id));
      expect(linkDocIds.length, 'Expected 2 link documents: release<->defect, mirrored').toBe(2);

      // === Step 6: create an environment in Settings -- moved there by
      // WP-F18b Task 1 (ruling R1: project-scoped configuration, the same
      // shape as Fields, not a test asset). ===
      await clientSideNavigate(page, '/projects/1/settings/environments');
      await page.waitForURL(/\/projects\/1\/settings\/environments/, { timeout: 15000 });
      await assertApiReachable(page);

      await page.getByRole('button', { name: /^new environment$/i }).click();
      const envDialog = page.getByRole('dialog', { name: 'New Environment' });
      await expect(envDialog).toBeVisible({ timeout: 10000 });
      await envDialog.getByLabel('Name', { exact: true }).fill(envName);
      await envDialog.getByRole('button', { name: /^create$/i }).click();
      await expect(envDialog).not.toBeVisible({ timeout: 15000 });

      const envRow = page.getByRole('row', { name: new RegExp(escapeRegex(envName)) });
      await expect(envRow).toBeVisible({ timeout: 15000 });

      const envLookup = await api.get('/environments', { params: { limit: 1000 } });
      const envDoc = ((envLookup.data?.data || []) as Array<{ _id: string; name: string }>).find((e) => e.name === envName);
      expect(envDoc, `Expected to find environment "${envName}" via GET /environments`).toBeTruthy();
      environmentId = envDoc!._id;

      // === Step 7: delete it -- DELIBERATE BEHAVIOUR CHANGE #1 (this
      // file's own header comment): the old nav page's environments
      // section never had an edit or delete control at all. This is not a
      // port; it is new capability, exercised here for the first time in
      // this suite. ===
      await envRow.getByRole('button', { name: `Delete ${envName}` }).click();
      const envDeleteDialog = page.getByRole('dialog', { name: `Delete ${envName}?` });
      await expect(envDeleteDialog).toBeVisible({ timeout: 10000 });
      await envDeleteDialog.getByRole('button', { name: /^delete$/i }).click();
      await expect(envDeleteDialog).not.toBeVisible({ timeout: 15000 });
      await expect(page.getByRole('row', { name: new RegExp(escapeRegex(envName)) })).not.toBeVisible({ timeout: 15000 });

      await expect
        .poll(
          async () => {
            const resp = await api!.get('/environments', { params: { limit: 1000 } });
            return ((resp.data?.data || []) as Array<{ name: string }>).some((e) => e.name === envName);
          },
          { timeout: 15000 }
        )
        .toBe(false);
      // Confirmed gone through the real UI and the API -- nothing left for
      // the `finally` block below to (re-)delete.
      environmentId = undefined;

      // === Step 8: delete the release -- DELIBERATE BEHAVIOUR CHANGE #2
      // (this file's own header comment): the old nav page offered delete
      // from its table row directly; ReleaseDetail.tsx offers it only
      // after opening the release (ruling Z6). Reopen it first. ===
      await reopenReleaseFromList(page, releaseHumanId!);
      await expect(releaseHeading).toBeVisible({ timeout: 20000 });
      await page.getByRole('button', { name: /^delete$/i }).click();
      const releaseDeleteDialog = page.getByRole('dialog', { name: new RegExp(`^Delete ${escapeRegex(releaseHumanId!)}\\?`) });
      await expect(releaseDeleteDialog).toBeVisible({ timeout: 10000 });
      await releaseDeleteDialog.getByRole('button', { name: /^delete$/i }).click();
      await expect(releaseDeleteDialog).not.toBeVisible({ timeout: 15000 });
      await expect(releaseHeading).not.toBeVisible({ timeout: 15000 });

      await expect
        .poll(
          async () => {
            const resp = await api!.get('/releases', { params: { releaseId: releaseHumanId } });
            return (resp.data?.data || []).length;
          },
          { timeout: 15000 }
        )
        .toBe(0);
      // Confirmed gone through the real UI and the API -- nothing left for
      // the `finally` block below to (re-)delete.
      releaseMongoId = undefined;
    } finally {
      // Cleanup, children before parents, every step independently guarded
      // so a failure in one can never skip a later one -- the exact shape
      // release-wiring.spec.ts's own `finally` block uses, following the
      // same lesson WP-F06's shared-steps.spec.ts learned (a leaked
      // Keycloak user from setup done outside a guarded try/finally).
      // Steps 7/8 above already delete the environment and the release
      // through the product and verify it via the API; these are a
      // best-effort SECOND line of defence for whichever assertion above
      // failed first, not the primary cleanup path.
      for (const id of linkDocIds) {
        try {
          if (api) await api.delete(`/linkIssue/${id}`).catch(() => {});
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`release-migration.spec.ts cleanup: deleting link ${id} failed`, err);
        }
      }
      try {
        if (api && releaseMongoId) await api.delete(`/releases/${releaseMongoId}`).catch(() => {});
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('release-migration.spec.ts cleanup: deleting the release failed', err);
      }
      try {
        if (api && defectId) {
          const found = await api.get('/defects', { params: { defectId } });
          for (const doc of (found.data?.data || []) as Array<{ _id: string }>) {
            await api.delete(`/defects/${doc._id}`).catch(() => {});
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('release-migration.spec.ts cleanup: deleting the defect failed', err);
      }
      try {
        if (api && environmentId) await api.delete(`/environments/${environmentId}`).catch(() => {});
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('release-migration.spec.ts cleanup: deleting the environment failed', err);
      }
      try {
        if (context) await context.close();
      } finally {
        await persona.cleanup();
      }
    }
  });
});
