// WP-F23 Task 3 -- the browser proof jsdom cannot give.
//
// Tasks 1/2 (reviewed, merged) turned the release Lens's flat per-row lists
// into paged, sorted DataGrids so a release with hundreds of members reads
// as a page rather than a wall (the owner's own report, this WP's spec).
// Every jsdom test proving that shape (ReleaseDetail.test.tsx) mounts a
// fixture already small enough to fit on one page -- jsdom performs no
// layout at all, so "does this actually overflow, and does the overflow
// stay inside the grid's own container instead of widening the page body"
// is not a question jsdom can even ask, let alone answer. This spec asks a
// REAL browser, with a REAL 30-case release (30 crosses the 25-row default
// page size without making the spec slow -- this WP's own brief), the
// three things that follow from that:
//
//   1. A large set renders as ONE PAGE, not a wall -- 25 rows on screen,
//      not 30, with the true total stated beside the group's own title.
//   2. The grid scrolls in its OWN container; the page body never scrolls
//      sideways for it -- forced by narrowing the grid's own wrapping div
//      directly, not the whole browser viewport (see Proof 2's own comment
//      for why: the latter tripped over an unrelated, pre-existing layout
//      defect in this app's shared page chrome).
//   3. R2's actual point: a failing case sorts to the very first row with
//      ZERO interaction, and a passing case sorts so far down it is not
//      even on the first page -- exactly "the default sort lands the
//      reader on the problems" this task's own brief asks for, proven with
//      no click of a column header.
//
// Fixtures are built entirely through scaleFixtures.ts's bulk, API-only
// helpers (that file's own header comment: this spec is one of its two
// named consumers) -- driving 30 "New Test Case" dialogs one at a time
// would make this spec slow and brittle for no proof value the API-created
// rows don't already carry, since the Lens reads whatever is really in the
// database either way, not how it got there.
//
// Setup shape matches release-derived-membership.spec.ts (WP-F15b Task 3)
// and release-wiring.spec.ts (WP-F15/F18 Task 5), NOT release-wiring's own
// header comment, which claims its persona/context/api are created inside
// the `try` when they are actually created above it -- recorded during
// WP-F13, still true, not repeated here. Persona, context and api are all
// created INSIDE the `try` below, so nothing created can escape the
// `finally` if a later setup step throws.
import { test, expect, Page, BrowserContext, Locator } from '@playwright/test';
import { AxiosInstance } from 'axios';
import { assertApiReachable } from '../support/requireApi';
import { serviceApi } from '../support/api';
import { createE2EPersona, E2EPersona } from '../auth/persona';
import { loginAsPersona } from '../support/login';
import {
  createTestCase,
  deleteTestCase,
  createReleaseDoc,
  deleteReleaseDoc,
  createTestPlan,
  deleteTestPlan,
  attachPlanToRelease,
  createExecutionForPlan,
  deleteExecution,
} from '../support/scaleFixtures';

const BASE_URL = 'http://localhost:3000';
const CASE_COUNT = 30; // crosses the 25-row default page size (this WP's own brief).
const PAGE_SIZE = 25;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function clientSideNavigate(page: Page, url: string): Promise<void> {
  await page.evaluate((target) => {
    window.history.pushState({}, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, url);
}

// A grid's own row is its native `[data-id="<id>"]` (DataGrid's own
// GridRow -- verified directly in node_modules/@mui/x-data-grid, not
// assumed), scoped to whichever grid container is passed in.
function gridRow(grid: Locator, id: string): Locator {
  return grid.locator(`[data-id="${id}"]`);
}

test.describe('release Lens at scale (WP-F23 Task 3 -- the browser proof)', () => {
  test.setTimeout(180000);

  test('30 test cases page the Lens, the failing one sorts first with no interaction, and the grid -- not the page -- scrolls sideways', async ({
    browser,
  }) => {
    const marker = Date.now();

    let persona: E2EPersona | undefined;
    let context: BrowserContext | undefined;
    let api: AxiosInstance | undefined;

    let planId: string | undefined;
    let executionId: string | undefined;
    let releaseId: string | undefined; // Mongo _id
    let releaseHumanId: string | undefined;

    try {
      persona = await createE2EPersona('lens-density');
      context = await browser.newContext({ storageState: undefined });
      api = await serviceApi();
      const page = await context.newPage();
      await loginAsPersona(page, BASE_URL, persona);
      await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 15000 });

      // === Fixtures, entirely via the API (scaleFixtures.ts). 30 test
      // cases, index 0 is the ONE that will read 'Fail', index 29 the ONE
      // that will read 'Pass', the other 28 left at 'No Run' -- enough to
      // prove R2's rank groups (Fail < everything-else < Pass) without
      // needing more than one of each extreme. `Promise.all` preserves
      // input order in its result array regardless of completion order, so
      // `docs[0]`/`docs[29]` reliably name the fail/pass cases below. ===
      const docs = await Promise.all(
        Array.from({ length: CASE_COUNT }, (_, i) => createTestCase(api!, `E2E lens density case ${marker} #${i}`))
      );
      const caseHumanIds = docs.map((d) => d.TestCaseId);
      const failCaseId = caseHumanIds[0];
      const passCaseId = caseHumanIds[CASE_COUNT - 1];

      const plan = await createTestPlan(api, caseHumanIds);
      planId = plan.id;
      executionId = await createExecutionForPlan(
        api,
        plan.id,
        caseHumanIds.map((TestCaseId, i) => ({
          TestCaseId,
          TestStatus: i === 0 ? 'Fail' : i === CASE_COUNT - 1 ? 'Pass' : 'No Run',
        }))
      );

      const release = await createReleaseDoc(api, `E2E Lens Density Release ${marker}`);
      releaseId = release.id;
      releaseHumanId = release.releaseId;
      // Attached by the PLAN's own Mongo `_id` -- releaseService's
      // `linkTestPlan` stores whatever string it is handed verbatim into
      // `linkedTestPlanIds`, and releaseLens.js resolves that set against
      // `p._id`, never `p.TestPlanId` (ReleaseDetail.tsx's own
      // `linkPlan.mutate` sends `p._id` for the identical reason -- see
      // its `<MenuItem value={p._id}>`).
      await attachPlanToRelease(api, releaseId, plan.id);

      // === Open the release through the real UI. It was created via the
      // API, not the "New Release" dialog, so it has no tab open yet --
      // the workbench's own module list (EntityList, defaultSortModel
      // createdAt desc) is how a real user would find it too, and puts
      // this freshly-created release at/near the very top. The source
      // panel defaults to its "Tree view" (SourcePanel.tsx's own
      // `panelMode`), which renders EntityTree, not EntityList -- module 6
      // (Releases) has no tree presence at all (ReleaseDetail.tsx's own
      // header comment), so the release row (and the clickable id button
      // that opens it, entityListConfigs.tsx's own `ReleaseIdCell`) only
      // exists once "List view" is selected. ===
      await clientSideNavigate(page, '/projects/1/workbench/releases');
      await page.waitForURL(/\/projects\/1\/workbench\/releases/, { timeout: 15000 });
      await assertApiReachable(page);
      await page.getByRole('button', { name: 'List view' }).click();

      const releaseButton = page.getByRole('button', { name: releaseHumanId!, exact: true });
      await expect(releaseButton).toBeVisible({ timeout: 20000 });
      await releaseButton.click();

      const heading = page.getByRole('heading', { name: new RegExp(`^${escapeRegex(releaseHumanId!)}`) });
      await expect(heading).toBeVisible({ timeout: 15000 });

      await page.getByRole('tab', { name: 'Lens' }).click();
      const lensPanel = page.getByRole('tabpanel');

      // R1's groups are collapsed by default -- the grid (and every row in
      // it) is not mounted at all until expanded.
      await page.getByTestId('lens-group-test-cases-toggle').click();
      const grid = lensPanel.getByTestId('lens-test-cases-grid');
      await expect(grid).toBeVisible({ timeout: 15000 });

      // === Proof 1: a page, not a wall. All 30 are DERIVED (via the one
      // attached plan, none hand-linked), so the group's own title states
      // the true total the same way R4's denominator rule requires
      // everywhere else in this lens. ===
      await expect(
        lensPanel.getByText('Test cases (0 linked, 30 derived via 1 plan)')
      ).toBeVisible({ timeout: 20000 });
      const bodyRows = grid.locator('[role="row"][data-id]');
      await expect(bodyRows).toHaveCount(PAGE_SIZE);

      // === Proof 4 (R2): with the 30 cases at exactly one Fail, one Pass
      // and 28 No Run, the default sort (`initialState.sorting.sortModel`,
      // ReleaseDetail.tsx -- Fail first, Pass last, everything else
      // between) puts the ONE failing case at the very first row with no
      // sort click, and pushes the ONE passing case so far down it is not
      // even on the first page -- "the default sort lands the reader on
      // the problems" (this task's own brief), observed with zero
      // interaction. ===
      await expect(bodyRows.first()).toHaveAttribute('data-id', failCaseId);
      await expect(gridRow(grid, passCaseId)).toHaveCount(0);
      // Scoped to THIS grid -- the workbench's own source-panel release
      // list (EntityList, module 6) renders an identically-labelled
      // pagination control of its own on the same page.
      await grid.getByRole('button', { name: 'Go to next page' }).click();
      await expect(gridRow(grid, passCaseId)).toBeVisible({ timeout: 15000 });
      await grid.getByRole('button', { name: 'Go to previous page' }).click();
      await expect(bodyRows).toHaveCount(PAGE_SIZE);

      // === Proof 2: the grid scrolls in its OWN container; the page body
      // does not.
      //
      // First, at the normal viewport this test has run at so far: the
      // page body genuinely does not scroll sideways for this grid under
      // ordinary use.
      const bodyBefore = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(
        bodyBefore.scrollWidth,
        `Page body scrolled sideways at a normal viewport (scrollWidth ${bodyBefore.scrollWidth} vs clientWidth ${bodyBefore.clientWidth})`
      ).toBeLessThanOrEqual(bodyBefore.clientWidth + 1);

      // Second, the actual containment mechanism -- proven by forcing THIS
      // grid's own wrapping div (`data-testid="lens-test-cases-grid"`)
      // narrower directly via an injected stylesheet rule, not by shrinking
      // the whole browser viewport. Deliberately NOT a viewport resize: a
      // sibling proof (traceability-matrix.spec.ts's own density test, same
      // WP) found this app's shared page chrome (Components/NavBar/
      // MainDrawer.tsx's content `<Box>`) has no `minWidth: 0` of its own,
      // so narrowing the real browser window there left the WHOLE PAGE
      // stuck at its desktop width regardless of viewport -- a real,
      // pre-existing defect, unrelated to this grid and outside this
      // task's own file list to fix (recorded in the register instead).
      // Forcing THIS component's own box narrow, independent of whatever
      // its ancestors do, is what actually isolates "does this grid contain
      // its own overflow" -- the one claim in scope here. jsdom performs no
      // layout at all, so none of this is checkable there. ===
      await page.addStyleTag({
        content: '[data-testid="lens-test-cases-grid"] { width: 220px !important; max-width: 220px !important; }',
      });
      const scrollInfo = await page.evaluate(() => {
        const outer = document.querySelector('[data-testid="lens-test-cases-grid"]') as HTMLElement | null;
        const scroller = outer?.querySelector('.MuiDataGrid-virtualScroller') as HTMLElement | null;
        return {
          docScrollWidth: document.documentElement.scrollWidth,
          docClientWidth: document.documentElement.clientWidth,
          outerScrollWidth: outer?.scrollWidth,
          outerClientWidth: outer?.clientWidth,
          scrollerScrollWidth: scroller?.scrollWidth,
          scrollerClientWidth: scroller?.clientWidth,
        };
      });
      // The page body still does not scroll -- the forced-narrow grid never
      // leaked its overflow up past its own wrapping div.
      expect(
        scrollInfo.docScrollWidth,
        `Page body scrolled sideways once the grid was forced narrow (scrollWidth ${scrollInfo.docScrollWidth} vs clientWidth ${scrollInfo.docClientWidth})`
      ).toBeLessThanOrEqual(scrollInfo.docClientWidth + 1);
      // The wrapping div stayed exactly the width it was forced to -- it
      // did not grow to accommodate its now-too-wide child either.
      expect(scrollInfo.outerClientWidth).toBe(220);
      expect(
        scrollInfo.outerScrollWidth,
        'Expected the wrapping div itself to show no overflow of its own -- DataGrid contains its own scrolling one level deeper, in .MuiDataGrid-virtualScroller'
      ).toBeLessThanOrEqual((scrollInfo.outerClientWidth ?? 0) + 1);
      // The actual overflow lives exactly where it should: DataGrid's own
      // internal scroll container, genuinely wider than it can display at
      // 220px -- proof that a real scrollbar exists here, not merely that
      // nothing overflowed anywhere.
      expect(scrollInfo.scrollerClientWidth, 'Expected the grid to render its own MuiDataGrid-virtualScroller').not.toBeUndefined();
      expect(
        scrollInfo.scrollerScrollWidth!,
        `Expected the grid's own scroll container to overflow horizontally once forced narrower than its columns' combined minimum width (scrollWidth ${scrollInfo.scrollerScrollWidth} vs clientWidth ${scrollInfo.scrollerClientWidth})`
      ).toBeGreaterThan(scrollInfo.scrollerClientWidth!);
    } finally {
      // Cleanup, children before parents, every step independently guarded
      // and QUERIED FRESH rather than trusted off happy-path arrays -- the
      // same discipline traceability-matrix.spec.ts's own finally follows
      // (WP-F13 final fix round, Finding 3): a throw between one fixture
      // call succeeding and the next means the "happy path" ids captured
      // above may be incomplete, but everything that actually exists is
      // still found and removed by querying the service each entity's own
      // human/business id, not by trusting a running total.
      try {
        if (api && releaseId) await deleteReleaseDoc(api, releaseId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('release-lens-density.spec.ts cleanup: deleting the release failed', err);
      }
      try {
        if (api && executionId) await deleteExecution(api, executionId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('release-lens-density.spec.ts cleanup: deleting the execution failed', err);
      }
      try {
        if (api && planId) await deleteTestPlan(api, planId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('release-lens-density.spec.ts cleanup: deleting the test plan failed', err);
      }
      // QUERIED FRESH by the marker embedded in every one of the 30 test
      // cases' own summaries, rather than trusting an array only populated
      // after `Promise.all` above fully resolved -- the same lesson
      // traceability-matrix.spec.ts's own finally already applies to its
      // link documents (WP-F13 final fix round, Finding 3): a throw
      // partway through 30 concurrent creates (e.g. request 17 of 30
      // rejects) would leave `Promise.all` itself rejected and never
      // assigning `docs` at all, so an array built from `docs.map(...)`
      // would name NONE of the up-to-29 cases that actually landed in the
      // database. `wildcardsearch` finds whatever really exists under this
      // run's own marker, independent of how far the happy path got.
      try {
        if (api) {
          const found = await api.get('/testrepo/wildcardsearch', { params: { search: String(marker) } });
          for (const doc of (found.data?.data || []) as Array<{ _id: string }>) {
            await deleteTestCase(api, doc._id);
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('release-lens-density.spec.ts cleanup: deleting test cases failed', err);
      }
      try {
        if (context) await context.close();
      } finally {
        if (persona) await persona.cleanup();
      }
    }
  });
});
