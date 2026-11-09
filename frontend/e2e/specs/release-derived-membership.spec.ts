// WP-F15b Task 3 -- the browser journey that proves derivation, end to end.
//
// Tasks 1 (backend/reportingService/services/releaseLens.js) and 2
// (ReleaseDetail.tsx's Lens tab) built the traversal and the UI that shows
// its output distinctly from an explicit link. Neither proved the thing the
// owner actually asked for: attach a test plan to a release and its test
// cases -- and THEIR requirements -- show up as release members without
// anyone linking a single one of them by hand. That is this spec's only
// job. It creates a plan with two test cases (one of which is linked to a
// requirement), attaches the plan to a release, opens the release and reads
// 2 derived test cases + 1 derived requirement off the Lens tab having
// linked none of them -- then detaches the plan and watches them disappear.
// That last step is R1 (derive, never write a link row) made concrete: a
// detach with nothing to unwind and no stale row left behind.
//
// TWO TRAPS CARRIED FORWARD FROM release-wiring.spec.ts (WP-F15/F18 Task 5)
// -- both documented there at length after costing real time; restated here
// briefly because this spec repeats the same shapes:
//
// 1. FIXTURE ORDERING. The release is created LAST, after the test plan and
//    both test cases already exist. The workbench's "New Release" dialog
//    opens straight into the release's own tab, which mounts
//    ReleaseDetail.tsx and fires its `pickable-test-plans` query
//    immediately -- and queryClient.ts gives every query a 30s staleTime,
//    shared across the whole session. Creating the release before the plan
//    exists would cache an incomplete plan list for the next 30s, and the
//    "attach the test plan" step below would then hang waiting for an
//    option already excluded from that stale cache. Reordering ahead of the
//    release (the same order a real user attaching an EXISTING plan to a
//    NEW release would follow) means the query's first-ever fetch already
//    sees everything the attach step needs.
//
// 2. SETUP SHAPE. Persona, browser context and the API client are all
//    created INSIDE the `try`, so nothing created can escape the `finally`
//    if a later setup step throws -- release-wiring.spec.ts's own header
//    comment records a prior spec in this suite that leaked a Keycloak user
//    by creating its persona outside the try. Own throwaway 'manager'
//    persona rather than the suite's shared 'contributor', for isolation
//    -- the shared persona is session-wide, so a spec that fails midway
//    can leave another spec's identity in a state it did not choose.
//    NOT for delete rights: every cleanup call in the finally goes through
//    serviceApi()'s service identity, not the persona, and the journey
//    itself only ever needs authorize('write') (releaseService's own
//    /plans and /plans/:testPlanId routes are both 'write'). 'contributor'
//    would in fact have served the whole journey.
//
// A THIRD TRAP, new to this spec, NOW FIXED IN THE PRODUCT (fix round,
// Finding 1) -- kept here because the shape it warns about is still worth
// naming: the Lens tab's own query shares the app's 30s staleTime
// (queryClient.ts), and DetailTabs.tsx unmounts an inactive tab's content
// entirely (`{active && children}`, not a CSS `hidden`), so switching away
// from Lens and back re-mounts ReleaseLensPanel. Before this fix round,
// attaching/detaching a plan invalidated only `qk.entity` -- never the
// lens's own key (['project', pid, 6, 'release-lens', <human releaseId>],
// different at every position after the module id) -- so a remount within
// 30s of the last fetch served the cached, now-wrong response: a detached
// plan's derived rows would keep showing, captioned "via" a plan that was
// no longer attached. `linkPlan`/`unlinkPlan` in ReleaseDetail.tsx now both
// invalidate the lens key in their own `onSuccess`, so Step 9 below proves
// this with a PLAIN TAB CLICK back to "Lens" -- no `page.reload()` -- and
// that is the stronger proof, not merely the shorter one: a full reload
// reconstructs `queryClient` with an empty cache regardless of whether
// invalidation ever fires, so it would have passed identically whether or
// not this bug was ever fixed. A bare tab click only comes back fresh
// because the invalidation call is real.
//
// via SHAPES DIFFER BETWEEN THE TWO DERIVED GROUPS (Task 2's own note,
// repeated here since this spec is what actually exercises it): a derived
// REQUIREMENT's `via` names the TEST CASE that reaches it
// (`r.via.map(v => v.TestCaseId)`); a derived TEST CASE's `via` names the
// PLAN that contains it (`tc.via.map(v => v.TestPlanId)`). This spec reads
// each accordingly, not assuming a common shape.
import { test, expect, Page, BrowserContext, Locator } from '@playwright/test';
import { AxiosInstance } from 'axios';
import { assertApiReachable } from '../support/requireApi';
import { serviceApi } from '../support/api';
import { createE2EPersona, E2EPersona } from '../auth/persona';
import { loginAsPersona } from '../support/login';
// ed3f06d moved these out of the panel header into the "New" menu.
import { chooseCreate, createDraft } from '../support/sourcePanelMenus';

const BASE_URL = 'http://localhost:3000';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// WP-F23 Task 3 repair -- this spec predates Task 1's move of the Lens's
// requirement/test-case rows into a DataGrid. Two of that move's
// consequences land squarely on this spec, both fixed here rather than
// worked around:
//
// 1. Per-row testids retired. `lens-requirement-linked-row`,
//    `lens-testcase-linked-row`, `lens-requirement-derived-row` and
//    `lens-testcase-derived-row` no longer exist anywhere in the product --
//    a DataGrid row's own identity is its native `[data-id="<id>"]`
//    (`getRowId` in ReleaseDetail.tsx returns the row's human id), not a
//    hand-authored testid per row. `gridRow` below is that same lookup,
//    reused everywhere this spec used to reach for one of the four retired
//    names.
//
// 2. THE TRAP: six of the eight retired-testid references this spec used
//    to make were `toHaveCount(0)` assertions -- and a RETIRED testid has
//    count 0 by definition, whether or not the thing being tested (no
//    explicitly-linked row rendered; every derived row vanished after
//    detach) is actually true. Simply swapping in the new selector for
//    those six would leave six assertions that pass unconditionally,
//    guarding nothing. Every one below is rewritten to assert the SAME
//    fact through a selector that can actually fail: "nothing was
//    explicitly linked" is now `lens-asserted-chip` (still a live,
//    non-retired testid) having zero matches inside the relevant grid, and
//    "every derived row is gone after detach" is now the grid itself not
//    existing at all (both groups fall back to their own "No ... linked."
//    text once linkedCount and derivedCount both read zero -- see
//    ReleaseLensPanel's own branch on that pair) plus `lens-derived-chip`
//    reading zero.
//
// 3. Groups are COLLAPSED BY DEFAULT (R1, Task 1's `LensGroup`), and
//    `Collapse ... unmountOnExit` means a collapsed group's children --
//    grid, rows, chips, the "No X linked." fallback text, all of it -- are
//    not in the DOM AT ALL until that group's own toggle is clicked. A
//    `toHaveCount(0)` assertion against an unexpanded group is vacuous for
//    a second, independent reason on top of (2): it would read zero
//    whether the group holds nothing or holds three hundred rows nobody
//    expanded to see. Every assertion below that reads a group's contents
//    clicks that group's own `${testId}-toggle` first.
function gridRow(grid: Locator, id: string): Locator {
  return grid.locator(`[data-id="${id}"]`);
}

// Same relative-<script src> reasoning as release-wiring.spec.ts's own
// helper: every deep navigation in this spec goes through the SPA's own
// client-side router, never a cold `page.goto()` of a deep URL.
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

// bulk-operations.spec.ts's own helper, reused verbatim: an MUI DataGrid
// row's own accessible role is "row", and TestPlanDetail's test-case picker
// (TestPlanDetail.tsx's `draft-available-test-cases-grid`) is the same
// @mui/x-data-grid component that spec already proved this locator shape
// against.
function rowByCellText(page: Page, exactCellText: string) {
  const cell = page.getByRole('cell', { name: exactCellText, exact: true });
  return cell.locator('xpath=ancestor::div[@role="row"]');
}

test.describe('release derived membership (WP-F15b Task 3 -- the lens derivation, end to end)', () => {
  test.setTimeout(300000);

  test('attaching a test plan derives its test cases and their requirements as release members, and detaching removes them cleanly', async ({
    browser,
  }) => {
    const marker = Date.now();

    // Declared here, CREATED inside the try -- see this file's header
    // comment (trap 2) for why that ordering is load-bearing. `persona`
    // joins `context`/`api` in that same shape (fix round, Finding 5b):
    // it used to be created ABOVE this try, the one statement in this
    // function that could actually throw (a real network call to
    // Keycloak) sitting outside the block whose `finally` is the only
    // thing that cleans it up.
    let context: BrowserContext | undefined;
    let api: AxiosInstance | undefined;
    let persona: E2EPersona | undefined;

    let releaseMongoId: string | undefined;
    let releaseHumanId: string | undefined;
    let reqId: string | undefined;
    let tc1Id: string | undefined;
    let tc2Id: string | undefined;
    let planId: string | undefined;
    // Only the TC1<->requirement link -- there is no other generic link in
    // this journey. The plan->case membership and the plan->release
    // attachment are BOTH represented elsewhere (TestPlan.TestCases,
    // Release.linkedTestPlanIds) and neither writes a linkIssue row.
    const linkDocIds: string[] = [];

    const reqSummary = `E2E derived-membership requirement ${marker}`;
    const tc1Summary = `E2E derived-membership tc1 ${marker}`;
    const tc2Summary = `E2E derived-membership tc2 ${marker}`;
    const releaseName = `E2E Derived Release ${marker}`;

    try {
      persona = await createE2EPersona('release-derived-membership', 'manager');
      context = await browser.newContext({ storageState: undefined });
      api = await serviceApi();
      const page = await context.newPage();
      await loginAsPersona(page, BASE_URL, persona);
      await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 15000 });

      // === Step 1: create the requirement TC1 will link to. ===
      await clientSideNavigate(page, '/projects/1/workbench/requirements');
      await page.waitForURL(/\/projects\/1\/workbench\/requirements/, { timeout: 15000 });
      await assertApiReachable(page);
      await page.getByRole('tree').waitFor({ state: 'visible', timeout: 30000 });

      await createDraft(page, 'New Requirement');
      await expect(page.getByRole('heading', { name: 'New Requirement' })).toBeVisible({ timeout: 15000 });
      await page.getByLabel('Summary').fill(reqSummary);
      // EditorField only commits its draft buffer onBlur -- Description is
      // the first of two Editors on this form (entity-creation.spec.ts's
      // own comment on this exact race).
      await page.locator('.ql-editor').first().click();
      await page.keyboard.type('Created by release-derived-membership.spec.ts (WP-F15b Task 3).');
      await page.getByLabel('Summary').click();
      await page.getByRole('button', { name: /^create$/i }).click();

      const reqHeading = page.getByRole('heading', { name: new RegExp(`^Req-\\d+ : ${escapeRegex(reqSummary)}`) });
      await expect(reqHeading).toBeVisible({ timeout: 20000 });
      reqId = ((await reqHeading.textContent()) || '').match(/^(Req-\d+)/)?.[1];
      expect(reqId, 'Could not parse a reqId out of the created requirement heading').toBeTruthy();

      // === Step 2: create TWO test cases, module 1's draft flow (same
      // shape entity-creation.spec.ts's own module-1 journey proved). Only
      // TC1 will be linked to the requirement above -- TC2 stays
      // unlinked, so the derived-requirement count below stays at exactly
      // 1, not 2. ===
      await clientSideNavigate(page, '/projects/1/workbench/testcases');
      await page.waitForURL(/\/projects\/1\/workbench\/testcases/, { timeout: 15000 });
      await page.getByRole('tree').waitFor({ state: 'visible', timeout: 30000 });

      await createDraft(page, 'New Test Case');
      await expect(page.getByRole('heading', { name: 'New Test Case' })).toBeVisible({ timeout: 15000 });
      await page.getByLabel('Summary').fill(tc1Summary);
      await page.locator('.ql-editor').click();
      await page.keyboard.type('Created by release-derived-membership.spec.ts (WP-F15b Task 3).');
      await selectMuiOption(page, 'Priority', 'High');
      await page.getByLabel('Scenario').fill('E2E scenario 1');
      await page.getByRole('button', { name: /^create$/i }).click();

      const tc1Heading = page.getByRole('heading', { name: new RegExp(`^TC-\\d+ : ${escapeRegex(tc1Summary)}`) });
      await expect(tc1Heading).toBeVisible({ timeout: 20000 });
      tc1Id = ((await tc1Heading.textContent()) || '').match(/^(TC-\d+)/)?.[1];
      expect(tc1Id, 'Could not parse a TestCaseId out of the first created test case heading').toBeTruthy();

      // SourcePanel's "New Test Case" control stays available regardless of
      // which tab is active -- no re-navigation needed for the second one.
      await createDraft(page, 'New Test Case');
      await expect(page.getByRole('heading', { name: 'New Test Case' })).toBeVisible({ timeout: 15000 });
      await page.getByLabel('Summary').fill(tc2Summary);
      await page.locator('.ql-editor').click();
      await page.keyboard.type('Created by release-derived-membership.spec.ts (WP-F15b Task 3).');
      await selectMuiOption(page, 'Priority', 'High');
      await page.getByLabel('Scenario').fill('E2E scenario 2');
      await page.getByRole('button', { name: /^create$/i }).click();

      const tc2Heading = page.getByRole('heading', { name: new RegExp(`^TC-\\d+ : ${escapeRegex(tc2Summary)}`) });
      await expect(tc2Heading).toBeVisible({ timeout: 20000 });
      tc2Id = ((await tc2Heading.textContent()) || '').match(/^(TC-\d+)/)?.[1];
      expect(tc2Id, 'Could not parse a TestCaseId out of the second created test case heading').toBeTruthy();

      // === Step 3: link TC1 (only) to the requirement, from TC1's OWN
      // Links tab (LinksSection, srcModule=1 -- premise 4: case<->requirement
      // links exist both directions in live data). TabStrip's own tabs
      // carry the entity's human id as their accessible name
      // (module-smoke.spec.ts's own proof of this), so switching back to
      // TC1 (currently not the active tab, TC2 is) is a plain tab click,
      // not a re-navigation. ===
      await page.getByRole('tab', { name: tc1Id!, exact: true }).click();
      await expect(page.getByRole('heading', { name: new RegExp(`^${escapeRegex(tc1Id!)} : `) })).toBeVisible({
        timeout: 15000,
      });
      await page.getByRole('tab', { name: 'Links' }).click();
      await expect(page.getByText('Linked Issues')).toBeVisible({ timeout: 10000 });

      await selectMuiOption(page, 'Issue type', 'Requirements');
      await page.getByLabel('Search issue').fill(reqSummary);
      await page.getByRole('option', { name: new RegExp(`${escapeRegex(reqId!)}.*${escapeRegex(reqSummary)}`) }).click({
        timeout: 15000,
      });
      await selectMuiOption(page, 'Link type', 'relates-to');
      await page.getByRole('button', { name: /^link$/i }).click();
      await expect(page.getByRole('tabpanel').getByText(new RegExp(escapeRegex(reqId!)))).toBeVisible({ timeout: 15000 });

      // Both forward+reverse pairs actually landed (linkissue.tsx's
      // client-side double write) -- verified via the API, not assumed
      // from the UI alone, same discipline release-wiring.spec.ts applies.
      await expect
        .poll(async () => (await api!.get('/linkIssue', { params: { sourceId: tc1Id } })).data?.data?.length, {
          timeout: 15000,
        })
        .toBeGreaterThanOrEqual(1);
      const tc1Sourced = (await api.get('/linkIssue', { params: { sourceId: tc1Id } })).data?.data || [];
      const tc1Destined = (await api.get('/linkIssue', { params: { destinationId: tc1Id } })).data?.data || [];
      linkDocIds.push(...[...tc1Sourced, ...tc1Destined].map((d: { _id: string }) => d._id));
      expect(linkDocIds.length, 'Expected 2 link documents: TC1<->requirement, mirrored').toBe(2);

      // === Step 4: create the test plan, module 3's draft flow, WITH both
      // test cases selected at draft time (TestPlanDetail.tsx's own
      // `draft-available-test-cases-grid` -- test-case selection at create
      // time is exactly the checkbox picker the non-draft "Add test cases"
      // panel also uses, TestPlanDetail.tsx's `availableColumns`). Neither
      // test case is linked to the PLAN via the generic link graph --
      // membership here is real containment, `TestPlan.TestCases`
      // (premise 3), which is the hop this whole spec exists to prove. ===
      await clientSideNavigate(page, '/projects/1/workbench/testplans');
      await page.waitForURL(/\/projects\/1\/workbench\/testplans/, { timeout: 15000 });
      await page.getByRole('tree').waitFor({ state: 'visible', timeout: 30000 });

      await createDraft(page, 'New Test Plan');
      await expect(page.getByRole('heading', { name: 'New Test Plan' })).toBeVisible({ timeout: 15000 });

      const draftGrid = page.getByTestId('draft-available-test-cases-grid');
      await expect(draftGrid).toBeVisible({ timeout: 15000 });
      await rowByCellText(page, tc1Id!).getByRole('checkbox', { name: /select row/i }).click();
      await rowByCellText(page, tc2Id!).getByRole('checkbox', { name: /select row/i }).click();

      await page.getByRole('button', { name: /^create$/i }).click();

      const planHeading = page.getByRole('heading', { name: /^PLN-\d+$/ });
      await expect(planHeading).toBeVisible({ timeout: 20000 });
      planId = (await planHeading.textContent()) || '';
      expect(planId, 'Could not read a TestPlanId out of the created plan heading').toMatch(/^PLN-\d+$/);

      // Verified via the API, not assumed from the checkbox click alone:
      // the plan's own TestCases array really contains both human ids.
      const planLookup = await api.get('/testplan', { params: { TestPlanId: planId } });
      const planDoc = (planLookup.data?.data || [])[0] as { TestCases?: Array<{ TestCaseId: string }> } | undefined;
      const planCaseIds = (planDoc?.TestCases || []).map((tc) => tc.TestCaseId);
      expect(planCaseIds.sort(), `Expected ${planId} to contain both ${tc1Id} and ${tc2Id}`).toEqual(
        [tc1Id!, tc2Id!].sort()
      );

      // === Step 5: create the release, DELIBERATELY LAST -- see this
      // file's header comment (trap 1) on why creating it before the plan
      // exists would cache an incomplete pickable-test-plans list. ===
      await clientSideNavigate(page, '/projects/1/workbench/releases');
      await page.waitForURL(/\/projects\/1\/workbench\/releases/, { timeout: 15000 });
      await assertApiReachable(page);

      await chooseCreate(page, 'New Release');

      const createDialog = page.getByRole('dialog', { name: 'New Release' });
      await expect(createDialog).toBeVisible({ timeout: 10000 });
      await createDialog.getByLabel('Name', { exact: true }).fill(releaseName);
      await createDialog.getByRole('button', { name: /^create$/i }).click();
      await expect(createDialog).not.toBeVisible({ timeout: 15000 });

      const createdHeading = page.getByRole('heading', { name: new RegExp(`^REL-\\d+ : ${escapeRegex(releaseName)}`) });
      await expect(createdHeading).toBeVisible({ timeout: 20000 });
      releaseHumanId = ((await createdHeading.textContent()) || '').match(/^(REL-\d+)/)?.[1];
      expect(releaseHumanId, `Could not parse a releaseId out of the created release heading for "${releaseName}"`).toBeTruthy();

      const releaseLookup = await api.get('/releases', { params: { releaseId: releaseHumanId } });
      const releaseDocs = (releaseLookup.data?.data || []) as Array<{ _id: string }>;
      expect(releaseDocs.length, `Expected to find ${releaseHumanId} via GET /releases`).toBe(1);
      releaseMongoId = releaseDocs[0]._id;

      // Deliberately NOT checking "Nothing linked yet" here before
      // attaching: since the fix round (Finding 1), `linkPlan`'s own
      // `onSuccess` invalidates the lens query the moment the plan attaches
      // (this file's header comment, trap 3), so mounting the panel once
      // here would no longer even risk serving stale data at Step 7 --
      // but it would still be redundant. Step 7's first ever mount of this
      // release's lens query is already the first proof that nothing was
      // linked going in; a separate pre-check buys nothing its own
      // assertions don't already cover (every "0 linked ..." assertion in
      // Step 7 is exactly that fact, read at the same time as the derived
      // counts).

      // === Step 6: attach the plan, through the release's OWN dedicated
      // mechanism (linkTestPlan/Release.linkedTestPlanIds), never
      // LinksSection -- Task 1's documented scope: the lens's plan hop
      // reads only this field. Nothing on the Links tab is touched in this
      // entire spec; every derived row below is reached ONLY through this
      // one attach action. ===
      await page.getByRole('tab', { name: 'Linked Test Plans' }).click();
      await selectMuiOption(page, 'Test plan', planId);
      await page.getByRole('button', { name: /^link$/i }).click();
      const unlinkButton = page.getByRole('button', { name: `Unlink ${planId}` });
      await expect(unlinkButton).toBeVisible({ timeout: 15000 });

      // === Step 7: the point of this whole spec. Open the Lens tab and
      // read 2 derived test cases + 1 derived requirement, having linked
      // NONE of them by hand -- only the plan attachment above happened,
      // and that touched no link row at all. ===
      await page.getByRole('tab', { name: 'Lens' }).click();
      const lensPanel = page.getByRole('tabpanel');
      await expect(lensPanel.getByText(/nothing linked yet/i)).toHaveCount(0);

      // R5's sentence: what was actually linked (nothing) vs. what is now
      // derived. Proves the members below did NOT come from a hand link.
      await expect(lensPanel.getByText(/0 linked requirements/)).toBeVisible({ timeout: 20000 });
      await expect(lensPanel.getByText(/0 linked test cases/)).toBeVisible();
      await expect(lensPanel.getByText(/1 linked test plan/)).toBeVisible();
      await expect(lensPanel.getByText(/plus 1 configured test plan/)).toBeVisible();

      // R2/R4 -- the group titles carry both the "nothing was hand-linked"
      // fact and the derivation's own denominator (Task 2's exact format,
      // pinned in ReleaseDetail.test.tsx).
      await expect(lensPanel.getByText('Requirements (0 linked, 1 derived via 1 test case)')).toBeVisible();
      await expect(lensPanel.getByText('Test cases (0 linked, 2 derived via 1 plan)')).toBeVisible();

      // R1's groups are collapsed by default -- their DataGrids (and every
      // chip/row inside them) are not mounted at all until expanded (this
      // file's header comment, point 3). Expand both before reading either
      // grid's contents; a `toHaveCount` against a collapsed group would be
      // vacuous regardless of what it names.
      await page.getByTestId('lens-group-requirements-toggle').click();
      await page.getByTestId('lens-group-test-cases-toggle').click();
      const requirementsGrid = lensPanel.getByTestId('lens-requirements-grid');
      const testCasesGrid = lensPanel.getByTestId('lens-test-cases-grid');
      await expect(requirementsGrid).toBeVisible({ timeout: 15000 });
      await expect(testCasesGrid).toBeVisible({ timeout: 15000 });

      // Not a single explicitly-linked row exists -- everything visible is
      // derived. `lens-asserted-chip` (still a live testid -- this file's
      // header comment, point 2) is the tell for an explicitly-linked row;
      // its absence inside each grid is the same fact the retired
      // `lens-requirement-linked-row`/`lens-testcase-linked-row` testids
      // used to assert, through a selector that can actually fail.
      await expect(requirementsGrid.getByTestId('lens-asserted-chip')).toHaveCount(0);
      await expect(testCasesGrid.getByTestId('lens-asserted-chip')).toHaveCount(0);

      // Exactly one derived requirement (REQ, via TC1 -- never TC2, which
      // was never linked to it), and exactly two derived test cases (TC1
      // and TC2, both via the same plan). A row's identity is now the
      // grid's own native `[data-id="<id>"]`, not a per-row testid.
      const allReqRows = requirementsGrid.locator('[role="row"][data-id]');
      await expect(allReqRows).toHaveCount(1);
      const derivedReqRow = gridRow(requirementsGrid, reqId!);
      await expect(derivedReqRow).toContainText(reqId!);
      await expect(derivedReqRow.getByTestId('lens-derived-chip')).toBeVisible();
      // A requirement's `via` names the TEST CASE that reaches it -- TC1's
      // id, verbatim, never a plan id.
      await expect(derivedReqRow.getByTestId('lens-requirement-derived-via')).toHaveText(
        new RegExp(`via ${escapeRegex(tc1Id!)}$`)
      );

      const allCaseRows = testCasesGrid.locator('[role="row"][data-id]');
      await expect(allCaseRows).toHaveCount(2);
      for (const tcId of [tc1Id!, tc2Id!]) {
        const derivedCaseRow = gridRow(testCasesGrid, tcId);
        await expect(derivedCaseRow).toBeVisible();
        await expect(derivedCaseRow.getByTestId('lens-derived-chip')).toBeVisible();
        // A test case's `via` names the PLAN that contains it -- deliberately
        // the OPPOSITE shape from the requirement's `via` above.
        await expect(derivedCaseRow.getByTestId('lens-testcase-derived-via')).toContainText(planId);
      }

      // The "Derived" chip is the R2 tell -- one per derived row, three
      // total, and it must never appear next to a linked row (there are no
      // linked rows here, so this also re-confirms the counts above).
      await expect(lensPanel.getByTestId('lens-derived-chip')).toHaveCount(3);

      // === Step 8: detach the plan. R1's whole argument in one action --
      // nothing to unwind (there was never a link row to delete), no stale
      // rows anywhere. ===
      await page.getByRole('tab', { name: 'Linked Test Plans' }).click();
      await unlinkButton.click();
      await expect(unlinkButton).toHaveCount(0);
      await expect(page.getByText('No test plans linked yet.')).toBeVisible({ timeout: 15000 });

      // Verified server-side too: linkedTestPlanIds is genuinely empty now,
      // not just optimistically hidden in the UI.
      await expect
        .poll(async () => (await api!.get('/releases', { params: { releaseId: releaseHumanId } })).data?.data?.[0]?.linkedTestPlanIds
          ?.length, { timeout: 15000 })
        .toBe(0);

      // === Step 9: return to the Lens tab -- fix round (Finding 1) removed
      // the `page.reload()` this step used to need; see this file's header
      // comment (the third trap) for the full account of why a plain tab
      // click is now the stronger proof, not merely a shorter one. ===
      await page.getByRole('tab', { name: 'Lens' }).click();

      // THE STRONGEST ASSERTION IN THIS SPEC: everything derived is gone,
      // and the release reads exactly as it did before Step 7 ever ran --
      // back to a plain "Nothing linked yet", not a lingering partial
      // state. Nothing was ever explicitly linked in this whole journey, so
      // there is nothing left to see at all.
      //
      // Both groups are a FRESH mount here (ReleaseLensPanel unmounts
      // entirely when its tab goes inactive -- this file's header comment,
      // the third trap), so `expanded` resets to `false` and each must be
      // re-opened before its contents mean anything -- the same point-3
      // reasoning Step 7 above already applies. With linkedCount AND
      // derivedCount now both zero for requirements and test cases,
      // ReleaseLensPanel's own branch renders each group's plain "No X
      // linked." text INSTEAD OF a DataGrid at all -- so "the grid itself
      // no longer exists" replaces the retired `lens-testcase-derived-row`/
      // `lens-requirement-derived-row` zero-count checks this step used to
      // make, and is the stronger version of the same fact, not merely a
      // renamed one.
      const lensPanelAfterDetach = page.getByRole('tabpanel');
      await expect(lensPanelAfterDetach.getByText(/nothing linked yet/i)).toBeVisible({ timeout: 20000 });
      await lensPanelAfterDetach.getByTestId('lens-group-requirements-toggle').click();
      await lensPanelAfterDetach.getByTestId('lens-group-test-cases-toggle').click();
      await expect(lensPanelAfterDetach.getByText('No requirements linked.')).toBeVisible();
      await expect(lensPanelAfterDetach.getByText('No test cases linked.')).toBeVisible();
      await expect(lensPanelAfterDetach.getByTestId('lens-requirements-grid')).toHaveCount(0);
      await expect(lensPanelAfterDetach.getByTestId('lens-test-cases-grid')).toHaveCount(0);
      await expect(lensPanelAfterDetach.getByTestId('lens-derived-chip')).toHaveCount(0);
      await expect(lensPanelAfterDetach.getByTestId('lens-asserted-chip')).toHaveCount(0);
    } finally {
      // Cleanup, children before parents, every step independently guarded
      // -- release-wiring.spec.ts's own header comment on why (a prior spec
      // in this suite leaked a Keycloak user from a less careful shape).
      // Link documents first: deleting an entity does not delete its links
      // (this WP's own register entry, Bug-1072 -> TC-4788, is the live
      // proof), so leaving them would leak a linkIssue document even though
      // every entity it references is about to be deleted too.
      for (const id of linkDocIds) {
        try {
          if (api) await api.delete(`/linkIssue/${id}`).catch(() => {});
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`release-derived-membership.spec.ts cleanup: deleting link ${id} failed`, err);
        }
      }
      try {
        if (api && releaseMongoId) await api.delete(`/releases/${releaseMongoId}`).catch(() => {});
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('release-derived-membership.spec.ts cleanup: deleting the release failed', err);
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
        console.error('release-derived-membership.spec.ts cleanup: deleting the test plan failed', err);
      }
      try {
        if (api && tc1Id) {
          const found = await api.get('/testrepo', { params: { TestCaseId: tc1Id } });
          for (const doc of (found.data?.data || []) as Array<{ _id: string }>) {
            await api.delete(`/testrepo/${doc._id}`).catch(() => {});
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('release-derived-membership.spec.ts cleanup: deleting test case 1 failed', err);
      }
      try {
        if (api && tc2Id) {
          const found = await api.get('/testrepo', { params: { TestCaseId: tc2Id } });
          for (const doc of (found.data?.data || []) as Array<{ _id: string }>) {
            await api.delete(`/testrepo/${doc._id}`).catch(() => {});
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('release-derived-membership.spec.ts cleanup: deleting test case 2 failed', err);
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
        console.error('release-derived-membership.spec.ts cleanup: deleting the requirement failed', err);
      }
      try {
        if (context) await context.close();
      } finally {
        if (persona) await persona.cleanup();
      }
    }
  });
});
