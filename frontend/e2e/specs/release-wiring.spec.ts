// WP-F15/F18 Task 5 -- the browser journey that closes this work package.
//
// Tasks 1-4 (reviewed, merged) gave module 6 a list (Task 1) and a detail
// view (Task 2), let a release be linked to the defects/requirements/test
// cases it covers via the generic link graph (Task 3), and answered "what
// is IN this release" with a derived lens (Task 4,
// backend/reportingService/services/releaseLens.js). This spec is the
// first thing in the whole package that opens a real browser and proves
// the chain end to end: create a release -> link a defect and a
// requirement to it -> link a test plan -> open the release and see the
// lens count them -> confirm the link is visible from the DEFECT's own
// detail (not assumed, the same "assert bidirectionality, don't assume
// it" discipline ReleaseDetail.test.tsx's own Links describe block
// already applies in jsdom) -> clean up.
//
// WP-F18b Task 4 update: the release is now created LAST of the four
// fixtures (Step 4 below), not first. It originally was created first,
// through the old standalone nav page (Pages/releases.tsx, routed at
// /projects/:id/releases) -- the only create surface module 6 had at the
// time this spec was written, and a plain useState/useEffect page that
// never touched the shared react-query cache at all. WP-F18b Task 3 added
// a workbench-native "New Release" dialog (SourcePanel.tsx's CreateActions)
// and Task 4 retired that nav page entirely -- but that dialog opens
// straight into the new release's own tab, mounting ReleaseDetail.tsx and
// firing its `pickable-test-plans` query immediately. Creating the release
// FIRST, before Step 3's test-plan fixture existed, cached an INCOMPLETE
// test-plan list for `queryClient.ts`'s own 30s staleTime (one shared
// QueryClient for the whole session, not per-entity) -- Step 7's "link the
// test plan" then hung waiting for an option already excluded from that
// stale cache, timing out the whole spec twice in a row before this was
// diagnosed from a failure screenshot (the dropdown was open and visibly
// missing the just-created plan). Reordering the fixtures ahead of the
// release -- the same order a real user creating a release FROM existing
// work would follow -- means the query's first-ever fetch already sees
// everything Step 7 needs, so staleness afterward never matters. Step 5's
// "open the release via the list" stays exactly as it always was: after
// Step 4 creates the release, re-finding it through the list once this
// spec has navigated away is still a real, worthwhile assertion of the gap
// this spec's own header comment closed (see below), not shortcut away.
//
// A REAL GAP THIS SPEC HAD TO CLOSE FIRST: module 6 has neither a tree
// (releases carry no parentId -- Hooks/queries/useTreeChildren.ts's own
// fetchLeaves falls through to `default: return []` for module 6) nor a
// search config (EntitySearchPanel's own "not available" branch for
// module 6) -- and EntityList.tsx (the List view every module including
// releases gets) wires NO click handler on ANY row, for ANY module. Before
// this task, a release that appeared in the list had no way to be OPENED
// from it -- the "open the release" step below was not actually possible
// through the product. Fixed narrowly in entityListConfigs.tsx
// (`ReleaseIdCell`, module 6's id column only) rather than in EntityList.tsx
// itself, which five other modules' own tree already gives a working entry
// point to and which this task has no mandate to touch.
//
// Fixed setup shape, matching parameterised-cases.spec.ts (WP-F07a Task 5)
// exactly: persona, browser context and the API client are all created
// INSIDE the `try`, so nothing created can escape the `finally` if a later
// setup step throws. An earlier spec in this suite (WP-F06's
// shared-steps.spec.ts, before its own fix) created its persona OUTSIDE
// the try and leaked a Keycloak user when a step between persona creation
// and the try's own body threw -- proven fixed there (pre-fix leaked 1,
// post-fix 0) and followed here from the start rather than re-discovered.
//
// Own throwaway 'manager' persona (not the shared 'contributor' one this
// suite's other specs reuse): the shared persona is session-wide
// (e2e/auth/global-setup.ts) and this spec's own entities/links need to be
// attributable to, and cleaned up by, an identity this spec alone owns.
// 'manager' (write + delete) is a superset of what any single step here
// needs -- most cleanup below goes through the SERVICE identity
// (e2e/support/api.ts's serviceApi(), same as every other spec's fixture
// teardown), not the persona directly.
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
// the app (deep-link.spec.ts's whole point) -- every spec in this suite
// lands on '/' first, then hops via the SPA's own client-side router,
// reproducing what a same-origin link click does.
async function clientSideNavigate(page: Page, url: string): Promise<void> {
  await page.evaluate((target) => {
    window.history.pushState({}, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, url);
}

// A generic MUI <Select>'s trigger is role="combobox"; its menu renders on
// click, not hover. Shared shape for every combobox this journey drives
// (Issue type / Link type on the Links tab, Priority on the defect draft).
async function selectMuiOption(page: Page, comboName: string | RegExp, optionName: string | RegExp): Promise<void> {
  const combo = page.getByRole('combobox', { name: comboName });
  await expect(combo).toBeVisible({ timeout: 15000 });
  await combo.click();
  await page.getByRole('option', { name: optionName }).click();
}

test.describe('release wiring (WP-F15/F18 Task 5 -- the lens in the UI, end to end)', () => {
  test.setTimeout(240000);

  test('create a release, link a defect/requirement/test plan to it, see the lens count them, and confirm bidirectionality from the defect', async ({
    browser,
  }) => {
    const marker = Date.now();
    const persona = await createE2EPersona('release-wiring', 'manager');

    // Declared here, CREATED inside the try below -- see this file's
    // header comment on why that ordering is load-bearing, not style.
    let context: BrowserContext | undefined;
    let api: AxiosInstance | undefined;

    let releaseMongoId: string | undefined;
    let releaseHumanId: string | undefined;
    let defectId: string | undefined;
    let reqId: string | undefined;
    let planId: string | undefined;
    // The four generic-link documents the Links tab's forward+reverse
    // double-write creates (release<->defect, release<->requirement) --
    // NOT the test-plan link, which is release-side-only via
    // linkTestPlan/Release.linkedTestPlanIds (Task 4's own documented
    // scope choice: the lens does not count module-3 generic links to
    // test plans at all, so this journey doesn't create one).
    const linkDocIds: string[] = [];

    const releaseName = `E2E Release Wiring ${marker}`;
    const defectSummary = `E2E relwiring defect ${marker}`;
    const reqSummary = `E2E relwiring requirement ${marker}`;

    try {
      context = await browser.newContext({ storageState: undefined });
      api = await serviceApi();
      const page = await context.newPage();
      await loginAsPersona(page, BASE_URL, persona);
      await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 15000 });

      // === Step 1: create a defect fixture (module 5 draft flow, same
      // shape entity-creation.spec.ts's own module-5 journey proved).
      // WP-F18b Task 4 moved this AHEAD of release creation (below) --
      // see this file's own header comment on why that ordering is now
      // load-bearing, not cosmetic. ===
      await clientSideNavigate(page, '/projects/1/workbench/defects');
      await page.waitForURL(/\/projects\/1\/workbench\/defects/, { timeout: 15000 });
      await assertApiReachable(page);
      await page.getByRole('tree').waitFor({ state: 'visible', timeout: 30000 });

      await createDraft(page, 'New Defect');
      await expect(page.getByRole('heading', { name: 'New Defect' })).toBeVisible({ timeout: 15000 });
      await page.getByLabel('Summary', { exact: false }).fill(defectSummary);
      await page.locator('.ql-editor').click();
      await page.keyboard.type('Created by release-wiring.spec.ts (WP-F15/F18 Task 5).');
      await selectMuiOption(page, 'Priority', 'High');
      await page.getByRole('button', { name: /^create$/i }).click();

      const defectHeading = page.getByRole('heading', { name: new RegExp(`^Bug-\\d+ : ${escapeRegex(defectSummary)}`) });
      await expect(defectHeading).toBeVisible({ timeout: 20000 });
      defectId = ((await defectHeading.textContent()) || '').match(/^(Bug-\d+)/)?.[1];
      expect(defectId, 'Could not parse a defectId out of the created defect heading').toBeTruthy();

      // === Step 2: create a requirement fixture (module 2 draft flow). ===
      await clientSideNavigate(page, '/projects/1/workbench/requirements');
      await page.waitForURL(/\/projects\/1\/workbench\/requirements/, { timeout: 15000 });
      await page.getByRole('tree').waitFor({ state: 'visible', timeout: 30000 });

      await createDraft(page, 'New Requirement');
      await expect(page.getByRole('heading', { name: 'New Requirement' })).toBeVisible({ timeout: 15000 });
      await page.getByLabel('Summary').fill(reqSummary);
      // EditorField only commits its draft buffer onBlur (see
      // entity-creation.spec.ts's own comment on this exact race) --
      // Description is the first of two Editors on this form.
      await page.locator('.ql-editor').first().click();
      await page.keyboard.type('Created by release-wiring.spec.ts (WP-F15/F18 Task 5).');
      await page.getByLabel('Summary').click();
      await page.getByRole('button', { name: /^create$/i }).click();

      const reqHeading = page.getByRole('heading', { name: new RegExp(`^Req-\\d+ : ${escapeRegex(reqSummary)}`) });
      await expect(reqHeading).toBeVisible({ timeout: 20000 });
      reqId = ((await reqHeading.textContent()) || '').match(/^(Req-\d+)/)?.[1];
      expect(reqId, 'Could not parse a reqId out of the created requirement heading').toBeTruthy();

      // === Step 3: create a test plan fixture (module 3 draft flow --
      // no fields are required; test-case selection is optional). ===
      await clientSideNavigate(page, '/projects/1/workbench/testplans');
      await page.waitForURL(/\/projects\/1\/workbench\/testplans/, { timeout: 15000 });
      await page.getByRole('tree').waitFor({ state: 'visible', timeout: 30000 });

      await createDraft(page, 'New Test Plan');
      await expect(page.getByRole('heading', { name: 'New Test Plan' })).toBeVisible({ timeout: 15000 });
      await page.getByRole('button', { name: /^create$/i }).click();

      const planHeading = page.getByRole('heading', { name: /^PLN-\d+$/ });
      await expect(planHeading).toBeVisible({ timeout: 20000 });
      planId = (await planHeading.textContent()) || '';
      expect(planId, 'Could not read a TestPlanId out of the created plan heading').toMatch(/^PLN-\d+$/);

      // === Step 4: create the release, through the real UI it is
      // actually created from (SourcePanel.tsx's workbench-native "New
      // Release" dialog -- module 6 is NOT draft-capable, per
      // workbench/SourcePanel.tsx's own DRAFT_CAPABLE_MODULES comment, so
      // this is a small dialog that calls createRelease directly rather
      // than the blank-draft-tab flow defects/requirements/test plans use;
      // see this file's own header comment for why this replaced the old
      // standalone nav page as of WP-F18b Task 4).
      //
      // DELIBERATELY LAST OF THE FOUR CREATES, not first: the dialog opens
      // straight into the new release's own tab (NewReleaseButton's own
      // handleCreate -- openTab + setSelection), which mounts
      // ReleaseDetail.tsx and fires its `pickable-test-plans` query
      // (queryClient.ts's own 30s staleTime, shared across the WHOLE
      // session, not per-entity) the instant this dialog closes. Creating
      // the release FIRST (an earlier version of this step) fired that
      // query before the test plan fixture above existed, caching an
      // incomplete list for the next 30s -- Step 7 below then hung waiting
      // for an option (`planId`) that had already been silently excluded
      // from that stale cache, timing out the whole spec. Fixtures now
      // exist before the release's OWN first mount ever queries for them,
      // so the cached list is complete from the start; staleness after
      // that point is moot because nothing about it needs to change again
      // before Step 7 reads it. ===
      await clientSideNavigate(page, '/projects/1/workbench/releases');
      await page.waitForURL(/\/projects\/1\/workbench\/releases/, { timeout: 15000 });
      await assertApiReachable(page);

      await chooseCreate(page, 'New Release');

      const createDialog = page.getByRole('dialog', { name: 'New Release' });
      await expect(createDialog).toBeVisible({ timeout: 10000 });
      await createDialog.getByLabel('Name', { exact: true }).fill(releaseName);
      await createDialog.getByRole('button', { name: /^create$/i }).click();
      await expect(createDialog).not.toBeVisible({ timeout: 15000 });

      // Unlike the old nav page's table, there is no row to read the human
      // id off; it comes off the detail heading instead, same shape as the
      // defect/requirement fixtures above.
      const createdHeading = page.getByRole('heading', { name: new RegExp(`^REL-\\d+ : ${escapeRegex(releaseName)}`) });
      await expect(createdHeading).toBeVisible({ timeout: 20000 });
      releaseHumanId = ((await createdHeading.textContent()) || '').match(/^(REL-\d+)/)?.[1];
      expect(releaseHumanId, `Could not parse a releaseId out of the created release heading for "${releaseName}"`).toBeTruthy();

      const releaseLookup = await api.get('/releases', { params: { releaseId: releaseHumanId } });
      const releaseDocs = (releaseLookup.data?.data || []) as Array<{ _id: string }>;
      expect(releaseDocs.length, `Expected to find ${releaseHumanId} via GET /releases`).toBe(1);
      releaseMongoId = releaseDocs[0]._id;

      // === Step 5: open the release. This is the gap this task's header
      // comment describes -- List view is the ONLY panel mode that shows a
      // release at all, and its id cell is what this task made clickable. ===
      await clientSideNavigate(page, '/projects/1/workbench/releases');
      await page.waitForURL(/\/projects\/1\/workbench\/releases/, { timeout: 15000 });
      await page.getByRole('button', { name: 'List view' }).click();

      const releaseIdCell = page.getByRole('button', { name: releaseHumanId });
      await expect(releaseIdCell).toBeVisible({ timeout: 20000 });
      await releaseIdCell.click();

      const releaseDetailHeading = page.getByRole('heading', {
        name: new RegExp(`^${escapeRegex(releaseHumanId)} : ${escapeRegex(releaseName)}`),
      });
      await expect(releaseDetailHeading).toBeVisible({ timeout: 20000 });

      // === Step 6: link the defect and the requirement, through the
      // release's own Links tab (LinksSection, srcModule=6 -- Task 3). ===
      await page.getByRole('tab', { name: 'Links' }).click();
      await expect(page.getByText('Linked Issues')).toBeVisible({ timeout: 10000 });

      await selectMuiOption(page, 'Issue type', 'Defects');
      await page.getByLabel('Search issue').fill(defectSummary);
      await page.getByRole('option', { name: new RegExp(`${escapeRegex(defectId!)}.*${escapeRegex(defectSummary)}`) }).click({
        timeout: 15000,
      });
      await selectMuiOption(page, 'Link type', 'relates-to');
      await page.getByRole('button', { name: /^link$/i }).click();
      // Scoped to the ACTIVE detail tabpanel (DetailTabs.tsx's own
      // role="tabpanel", the only place this repo uses that role -- see
      // this file's header comment on why an unscoped text search is
      // unsafe here): by this point in the journey the defect, the
      // requirement and the test plan each already have their OWN tab
      // open in the workbench's top TabStrip (created earlier in this
      // same session), so their human ids are ALSO present as plain text
      // elsewhere on the page -- an unscoped `getByText` would find both
      // and fail Playwright's strict-mode uniqueness check.
      await expect(page.getByRole('tabpanel').getByText(new RegExp(escapeRegex(defectId!)))).toBeVisible({ timeout: 15000 });

      await selectMuiOption(page, 'Issue type', 'Requirements');
      await page.getByLabel('Search issue').fill(reqSummary);
      await page.getByRole('option', { name: new RegExp(`${escapeRegex(reqId!)}.*${escapeRegex(reqSummary)}`) }).click({
        timeout: 15000,
      });
      await selectMuiOption(page, 'Link type', 'relates-to');
      await page.getByRole('button', { name: /^link$/i }).click();
      await expect(page.getByRole('tabpanel').getByText(new RegExp(escapeRegex(reqId!)))).toBeVisible({ timeout: 15000 });

      // Both forward+reverse pairs actually landed (linkissue.tsx's
      // client-side double write, premise 3 of this WP's plan -- verified
      // via the API here, not assumed from the UI alone).
      await expect
        .poll(async () => (await api!.get('/linkIssue', { params: { sourceId: releaseHumanId } })).data?.data?.length, {
          timeout: 15000,
        })
        .toBeGreaterThanOrEqual(2);
      const relSourced = (await api.get('/linkIssue', { params: { sourceId: releaseHumanId } })).data?.data || [];
      const relDestined = (await api.get('/linkIssue', { params: { destinationId: releaseHumanId } })).data?.data || [];
      linkDocIds.push(...[...relSourced, ...relDestined].map((d: { _id: string }) => d._id));
      expect(linkDocIds.length, 'Expected 4 link documents: release<->defect and release<->requirement, each mirrored').toBe(4);

      // === Step 7: link the test plan, through the release's OWN
      // dedicated mechanism (linkTestPlan/Release.linkedTestPlanIds) --
      // NOT LinksSection. Task 4's documented scope: the lens counts a
      // test plan only via this field, never via a module-3 generic link. ===
      await page.getByRole('tab', { name: 'Linked Test Plans' }).click();
      await selectMuiOption(page, 'Test plan', planId);
      await page.getByRole('button', { name: /^link$/i }).click();
      // The Unlink icon button's own accessible name ("Unlink PLN-N") is
      // unique by construction -- plain text would collide with both the
      // plan's own still-open TabStrip tab AND the "Test plan" combobox's
      // last-selected display value (hit exactly this in an earlier run of
      // this spec: `getByText('PLN-N')` resolved to both).
      await expect(page.getByRole('button', { name: `Unlink ${planId}` })).toBeVisible({ timeout: 15000 });

      // === Step 8: the lens. R5 -- every count ships with its
      // denominator; assert the SENTENCES, not just the digits. ===
      await page.getByRole('tab', { name: 'Lens' }).click();
      const lensPanel = page.getByRole('tabpanel');
      await expect(lensPanel.getByText(/nothing linked yet/i)).toHaveCount(0);
      await expect(lensPanel.getByText(/1 linked defect/)).toBeVisible({ timeout: 20000 });
      await expect(lensPanel.getByText(/1 linked requirement/)).toBeVisible();
      await expect(lensPanel.getByText(/1 linked test plan/)).toBeVisible();
      await expect(lensPanel.getByText(/Counted from 2 linked items/)).toBeVisible();
      // The SUMMARY sentences above render whatever the groups are doing.
      // The per-item rows below do not: 539e7e6 (WP-F23 Task 1) gave LensGroup
      // a real collapse and made it start COLLAPSED -- deliberately, because
      // "the part that becomes a wall at scale" is exactly this list -- and it
      // uses Collapse `unmountOnExit`, so a closed group's rows are not in the
      // DOM at all rather than merely hidden.
      //
      // That landed 2026-09-24, two days after this spec was last really
      // updated, and the spec has not run since. So this was stale, not
      // broken: the ids were always absent, nobody looked. Expanding here
      // keeps the assertion honest -- it still proves the row is rendered,
      // rather than being softened to a data check that would pass with the
      // panel showing nothing.
      for (const group of ['lens-group-defects', 'lens-group-requirements', 'lens-group-test-plans']) {
        await page.getByTestId(`${group}-toggle`).click();
      }
      await expect(lensPanel.getByText(new RegExp(escapeRegex(defectId!)))).toBeVisible({ timeout: 15000 });
      await expect(lensPanel.getByText(new RegExp(escapeRegex(reqId!)))).toBeVisible();
      await expect(lensPanel.getByText(planId)).toBeVisible();

      // === Step 9: confirm the link is visible from the DEFECT's own
      // detail -- bidirectionality asserted from the OTHER side, in a
      // real browser, not assumed from the release side alone. ===
      await clientSideNavigate(page, '/projects/1/workbench/defects');
      await page.waitForURL(/\/projects\/1\/workbench\/defects/, { timeout: 15000 });
      // `panelMode` (workbenchStore.ts) is a SINGLE global field, not
      // per-module -- switching to List view to open the release earlier
      // (Step 5) left every OTHER module's source panel in list mode too,
      // so the tree this step needs has to be switched back on explicitly.
      await page.getByRole('button', { name: 'Tree view' }).click();
      await page.getByRole('tree').waitFor({ state: 'visible', timeout: 30000 });
      const defectTreeRow = page.getByRole('treeitem', { name: defectId!, exact: true });
      await expect(defectTreeRow).toBeVisible({ timeout: 15000 });
      await defectTreeRow.click();
      await expect(page.getByRole('heading', { name: new RegExp(`^${escapeRegex(defectId!)} : `) })).toBeVisible({
        timeout: 15000,
      });
      await page.getByRole('tab', { name: 'Links' }).click();
      await expect(page.getByRole('tabpanel').getByText(new RegExp(escapeRegex(releaseHumanId!)))).toBeVisible({
        timeout: 15000,
      });
    } finally {
      // Cleanup, children before parents, every step independently
      // guarded so a failure in one can never skip a later one -- the
      // exact shape of leak that has cost this programme a Keycloak user
      // before (this file's header comment; parameterised-cases.spec.ts's
      // own header comment records the same lesson for a dataset/test-case
      // pair). Link documents first: deleting an entity does NOT delete
      // its links (this WP's own register entry records a live orphan,
      // Bug-1072 -> TC-4788, as proof) -- leaving them would leak
      // linkIssue documents even though every entity they reference is
      // about to be deleted too.
      for (const id of linkDocIds) {
        try {
          if (api) await api.delete(`/linkIssue/${id}`).catch(() => {});
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`release-wiring.spec.ts cleanup: deleting link ${id} failed`, err);
        }
      }
      try {
        if (api && releaseMongoId) await api.delete(`/releases/${releaseMongoId}`).catch(() => {});
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('release-wiring.spec.ts cleanup: deleting the release failed', err);
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
        console.error('release-wiring.spec.ts cleanup: deleting the defect failed', err);
      }
      try {
        if (api && reqId) {
          const found = await api.get('/requirement', { params: { reqId } });
          for (const doc of (found.data?.data || []) as Array<{ _id: string }>) {
            await api.delete(`/requirement/${doc._id}`).catch(() => {});
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('release-wiring.spec.ts cleanup: deleting the requirement failed', err);
      }
      try {
        if (api && planId) {
          const found = await api.get('/testplan', { params: { TestPlanId: planId } });
          for (const doc of (found.data?.data || []) as Array<{ _id: string }>) {
            await api.delete(`/testplan/${doc._id}`).catch(() => {});
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('release-wiring.spec.ts cleanup: deleting the test plan failed', err);
      }
      try {
        if (context) await context.close();
      } finally {
        await persona.cleanup();
      }
    }
  });
});
