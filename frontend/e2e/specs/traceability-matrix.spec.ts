// WP-F13 Task 4 -- the browser journey that closes this work package.
//
// Tasks 1-3 (reviewed, merged) fixed a requirement-coverage figure that had
// always read 0% (Task 1, backend/reportingService/services/coverage.js),
// built the per-requirement rows behind it (Task 2, services/
// traceability.js), and put both on screen with a CSV export (Task 3,
// Pages/dashboard/sections/TraceabilityMatrixSection.tsx, mounted on
// Pages/reports.tsx). This spec is the first thing in the whole package
// that opens a real browser and proves the chain end to end: create a
// requirement and two test cases -> link both to the requirement -> run
// ONE of them to a Pass, leave the other unrun -> open the matrix -> see
// one row with 2 cases, one Pass and one No Run, testCount 2, and the
// segment "Tests linked, not fully verified" -- the exact case R2's
// amendment exists for: the old rule (one Pass, none Fail -> "all
// passing") would have misread this requirement as fully verified, when
// one of its two linked cases has never actually run -- then export the
// CSV and assert its content matches that same row, then clean up.
//
// Fixed setup shape, matching release-wiring.spec.ts (WP-F15/F18 Task 5)
// exactly: persona, browser context and the API client are all created
// INSIDE the `try`, so nothing created can escape the `finally` if a later
// setup step throws. This suite's own shared-steps.spec.ts (WP-F06, before
// its own fix) created its persona OUTSIDE the try and leaked a Keycloak
// user when a step between persona creation and the try's own body threw --
// proven fixed there and followed here from the start rather than
// re-discovered.
//
// Default 'contributor' persona (not 'manager'): every write this journey
// makes -- creating a test case/requirement, linking, creating a test plan
// and an execution, recording a result -- is an authorize('write') action,
// and 'contributor' has write. Cleanup below goes entirely through
// serviceApi()'s SERVICE identity (its Keycloak client_credentials token is
// itself an admin member of project 1 -- confirmed live, not assumed:
// decoding the token's own `sub` and matching it against
// srckube-user.projects{id:1}.members finds it at role 'admin'), never the
// persona -- so the persona's own role has no bearing on whether cleanup
// can run. An earlier note in this programme claimed a 'manager' persona
// was needed for delete rights in a spec exactly like this one; that claim
// was corrected elsewhere in this repo (release-wiring.spec.ts's own header
// comment) and is not repeated here.
import fs from 'fs';
import { test, expect, Page, BrowserContext, Locator } from '@playwright/test';
import { AxiosInstance } from 'axios';
import { assertApiReachable } from '../support/requireApi';
import { serviceApi } from '../support/api';
import { createE2EPersona, E2EPersona } from '../auth/persona';
import { loginAsPersona } from '../support/login';
// ed3f06d moved these out of the panel header into the "New" menu.
import { createDraft } from '../support/sourcePanelMenus';
import {
  createTestCase,
  deleteTestCase,
  createRequirement,
  deleteRequirement,
  createDefect,
  deleteDefect,
  createTestPlan,
  deleteTestPlan,
  createExecutionForPlan,
  deleteExecution,
} from '../support/scaleFixtures';

const BASE_URL = 'http://localhost:3000';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// package.json's "homepage": "/" (craco.config.js sets publicPath: '/' to
// match) means a cold load of a deep URL boots the app correctly today --
// verified directly via e2e/specs/deep-link.spec.ts, run against this same
// live stack before writing this file, both of its cases green. Every
// OTHER spec in this suite still lands on '/' first purely by inherited
// convention (most of them predate that fix); this file does too, for the
// same reason release-wiring.spec.ta does -- it's how a real user reaches
// the app, and clientSideNavigate below is how one moves around it
// afterward without a full reload on every hop.
async function clientSideNavigate(page: Page, url: string): Promise<void> {
  await page.evaluate((target) => {
    window.history.pushState({}, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, url);
}

// A generic MUI <Select>'s trigger is role="combobox"; its menu renders on
// click, not hover. Shared shape for every combobox this journey drives
// (Priority on the test-case draft, Issue type / Link type on the
// requirement's Links tab).
async function selectMuiOption(page: Page, comboName: string | RegExp, optionName: string | RegExp): Promise<void> {
  const combo = page.getByRole('combobox', { name: comboName });
  await expect(combo).toBeVisible({ timeout: 15000 });
  await combo.click();
  await page.getByRole('option', { name: optionName }).click();
}

// A DataGrid row's own identity is its native `[data-id="<id>"]` (verified
// directly against @mui/x-data-grid's own GridRow, not assumed) -- shared
// by both tests in this file since WP-F23 Task 2 moved the matrix off the
// old flat `<table>`.
function gridRow(grid: Locator, id: string): Locator {
  return grid.locator(`[data-id="${id}"]`);
}

test.describe('traceability matrix (WP-F13 Task 4 -- the numbers, proven end to end)', () => {
  test.setTimeout(240000);

  test('a requirement with one passed and one unrun linked case reads "Tests linked, not fully verified", and the CSV export matches', async ({
    browser,
  }) => {
    const marker = Date.now();

    // Declared here, CREATED inside the try below -- see this file's
    // header comment on why that ordering is load-bearing, not style.
    let persona: E2EPersona | undefined;
    let context: BrowserContext | undefined;
    let api: AxiosInstance | undefined;

    let reqId: string | undefined;
    let testCaseIdA: string | undefined; // run to Pass
    let testCaseIdB: string | undefined; // left at No Run
    let planId: string | undefined;
    let executionId: string | undefined;
    const linkDocIds: string[] = [];

    const reqSummary = `E2E traceability requirement ${marker}`;
    const caseSummaryA = `E2E traceability case A ${marker}`;
    const caseSummaryB = `E2E traceability case B ${marker}`;

    // A test case's real, human-facing "New Test Case" draft form (module 1
    // draft flow, same shape entity-creation.spec.ts's own journey proved).
    // Used twice (case A, case B) -- re-navigates to the module route first
    // each time rather than assuming the "New Test Case" affordance is
    // still reachable from wherever the previous create left the URL, the
    // same defensive habit every OTHER module-switch in this journey
    // follows.
    async function createTestCase(page: Page, summary: string): Promise<string> {
      await clientSideNavigate(page, '/projects/1/workbench/testcases');
      await page.waitForURL(/\/projects\/1\/workbench\/testcases/, { timeout: 15000 });
      await page.getByRole('tree').waitFor({ state: 'visible', timeout: 30000 });

      await createDraft(page, 'New Test Case');
      await expect(page.getByRole('heading', { name: 'New Test Case' })).toBeVisible({ timeout: 15000 });

      await page.getByLabel('Summary').fill(summary);
      await page.locator('.ql-editor').click();
      await page.keyboard.type('Created by traceability-matrix.spec.ts (WP-F13 Task 4).');
      await selectMuiOption(page, 'Priority', 'High');
      await page.getByLabel('Scenario').fill('E2E scenario');

      await page.getByRole('button', { name: /^create$/i }).click();

      const heading = page.getByRole('heading', { name: new RegExp(`^TC-\\d+ : ${escapeRegex(summary)}`) });
      await expect(heading).toBeVisible({ timeout: 20000 });
      const headingText = (await heading.textContent()) || '';
      const id = headingText.match(/^(TC-\d+)/)?.[1];
      expect(id, `Could not parse a TestCaseId out of heading text "${headingText}"`).toBeTruthy();
      return id!;
    }

    // The requirement's own Links tab (LinksSection -> LinkIssues,
    // srcModule=2), Issue type "TestCase" (linkissue.tsx's own issueTypes
    // array literally names it that, singular, id 1) rather than
    // "Defects"/"Requirements" the way release-wiring.spec.ts exercises the
    // same component -- otherwise an identical flow.
    //
    // Called twice against the SAME "Issue type" selection (both links are
    // test cases), unlike release-wiring's two calls, which switch issue
    // type between them and get a free reset for it: IssueSearch
    // (Components/Lists/issueSearch.tsx) only clears its own inputValue/
    // selectedValue on `props.selectedIssueType` CHANGING, so with the type
    // unchanged between calls, the second `.fill()` must (and does, since
    // Playwright's fill() dispatches a real input event MUI's Autocomplete
    // reacts to) overwrite the first search's leftover text rather than
    // relying on that effect to clear it first.
    async function linkTestCase(page: Page, summary: string, testCaseId: string): Promise<void> {
      await selectMuiOption(page, 'Issue type', 'TestCase');
      await page.getByLabel('Search issue').fill(summary);
      await page
        .getByRole('option', { name: new RegExp(`${escapeRegex(testCaseId)}.*${escapeRegex(summary)}`) })
        .click({ timeout: 15000 });
      await selectMuiOption(page, 'Link type', 'relates-to');
      await page.getByRole('button', { name: /^link$/i }).click();
      // Scoped to the active tabpanel -- same "unscoped getByText hits the
      // TabStrip's own still-open tab for this id too" trap
      // release-wiring.spec.ts's header comment documents.
      await expect(page.getByRole('tabpanel').getByText(new RegExp(escapeRegex(testCaseId)))).toBeVisible({
        timeout: 15000,
      });
    }

    try {
      persona = await createE2EPersona('traceability');
      context = await browser.newContext({ storageState: undefined });
      api = await serviceApi();
      const page = await context.newPage();
      await loginAsPersona(page, BASE_URL, persona);
      await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 15000 });

      // === Step 1: two test cases. ===
      testCaseIdA = await createTestCase(page, caseSummaryA);
      testCaseIdB = await createTestCase(page, caseSummaryB);

      // === Step 2: the requirement (module 2 draft flow). ===
      await clientSideNavigate(page, '/projects/1/workbench/requirements');
      await page.waitForURL(/\/projects\/1\/workbench\/requirements/, { timeout: 15000 });
      await assertApiReachable(page);
      await page.getByRole('tree').waitFor({ state: 'visible', timeout: 30000 });

      await createDraft(page, 'New Requirement');
      await expect(page.getByRole('heading', { name: 'New Requirement' })).toBeVisible({ timeout: 15000 });
      await page.getByLabel('Summary').fill(reqSummary);
      // EditorField only commits its draft buffer onBlur -- Description is
      // the first of two Editors on this form (Acceptance Criteria is the
      // second), same race release-wiring.spec.ts's identical step guards
      // against.
      await page.locator('.ql-editor').first().click();
      await page.keyboard.type('Created by traceability-matrix.spec.ts (WP-F13 Task 4).');
      await page.getByLabel('Summary').click();
      await page.getByRole('button', { name: /^create$/i }).click();

      const reqHeading = page.getByRole('heading', { name: new RegExp(`^Req-\\d+ : ${escapeRegex(reqSummary)}`) });
      await expect(reqHeading).toBeVisible({ timeout: 20000 });
      reqId = ((await reqHeading.textContent()) || '').match(/^(Req-\d+)/)?.[1];
      expect(reqId, 'Could not parse a reqId out of the created requirement heading').toBeTruthy();

      // === Step 3: link both test cases to the requirement. ===
      await page.getByRole('tab', { name: 'Links' }).click();
      await expect(page.getByText('Linked Issues')).toBeVisible({ timeout: 10000 });

      await linkTestCase(page, caseSummaryA, testCaseIdA);
      await linkTestCase(page, caseSummaryB, testCaseIdB);

      // Both forward+reverse pairs actually landed for BOTH cases (premise
      // 3: bidirectionality is a client-side double write, verified via the
      // API, not assumed from the UI alone) -- 4 documents: 2 links x
      // (forward + reverse).
      await expect
        .poll(async () => (await api!.get('/linkIssue', { params: { sourceId: reqId } })).data?.data?.length, {
          timeout: 15000,
        })
        .toBeGreaterThanOrEqual(2);
      const reqSourced = (await api.get('/linkIssue', { params: { sourceId: reqId } })).data?.data || [];
      const reqDestined = (await api.get('/linkIssue', { params: { destinationId: reqId } })).data?.data || [];
      linkDocIds.push(...[...reqSourced, ...reqDestined].map((d: { _id: string }) => d._id));
      expect(linkDocIds.length, 'Expected 4 link documents: requirement<->case A and requirement<->case B, each mirrored').toBe(
        4
      );

      // === Step 4: a test plan carrying both cases (TestPlanDetail's own
      // draft flow -- module 3's "Test cases (optional)" picker IS the
      // whole draft form, per that file's header comment). The picker's
      // DataGrid has no search box of its own; `getTcList('')` (GET
      // /testrepo with no filter) sorts `-createdAt` and defaults to the
      // first 25 rows (advancedResults' own defaults) -- the two cases just
      // created above are guaranteed to be the newest two in the project,
      // so they are inside that window regardless of the other ~200 real
      // test cases the seeded project already holds. Rows are matched by
      // their own TestCaseId text, not by position, so this does not
      // depend on which of the two sorts first. ===
      await clientSideNavigate(page, '/projects/1/workbench/testplans');
      await page.waitForURL(/\/projects\/1\/workbench\/testplans/, { timeout: 15000 });
      await page.getByRole('tree').waitFor({ state: 'visible', timeout: 30000 });

      await createDraft(page, 'New Test Plan');
      await expect(page.getByRole('heading', { name: 'New Test Plan' })).toBeVisible({ timeout: 15000 });

      const draftGrid = page.getByTestId('draft-available-test-cases-grid');
      await expect(draftGrid).toBeVisible({ timeout: 15000 });
      for (const tcId of [testCaseIdA, testCaseIdB]) {
        const row = draftGrid.locator('[role="row"]', { hasText: tcId });
        await expect(row).toBeVisible({ timeout: 20000 });
        await row.getByRole('checkbox').click();
      }

      await page.getByRole('button', { name: /^create$/i }).click();
      const planHeading = page.getByRole('heading', { name: /^PLN-\d+$/ });
      await expect(planHeading).toBeVisible({ timeout: 20000 });
      planId = ((await planHeading.textContent()) || '').match(/^(PLN-\d+)/)?.[1];
      expect(planId, 'Could not parse a TestPlanId out of the created plan heading').toBeTruthy();

      // === Step 5: create an execution from BOTH membership rows
      // (TestPlanDetail's "Create Execution" -- module 4 is not
      // draft-capable, per workbench/modules.ts's own DRAFT_CAPABLE_MODULES
      // comment: a run is created FROM a plan, never from a blank tab). ===
      const membershipGrid = page.getByTestId('plan-test-cases-grid');
      for (const tcId of [testCaseIdA, testCaseIdB]) {
        const row = membershipGrid.locator('[role="row"]', { hasText: tcId });
        await expect(row).toBeVisible({ timeout: 15000 });
        await row.getByRole('checkbox').click();
      }
      await page.getByRole('button', { name: 'Create Execution' }).click();

      // 1b696ae (2026-10-03, "assign a test execution to someone other than
      // the creator") put a dialog in the middle of this: "Create Execution"
      // now only OPENS a chooser for the assignee, and the run is created when
      // its own Create is clicked (TestPlanDetail.tsx:630-642). This spec never
      // clicked it, so no execution was created and the tab never moved.
      //
      // Worth recording how that misled me: the Test Runs tree showed a Run-N
      // at the top and I read it as this journey's own. It was not -- it was
      // seeded data from 2026-10-02, confirmed by its createdAt in Mongo. The
      // tree listing an entity proves nothing about who created it, and a
      // screenshot cannot tell you an id's age.
      const createExecDialog = page.getByRole('dialog', { name: 'Create test execution' });
      await expect(createExecDialog).toBeVisible({ timeout: 15000 });
      await createExecDialog.getByRole('button', { name: 'Create', exact: true }).click();
      await expect(createExecDialog).not.toBeVisible({ timeout: 20000 });

      // createExecution's onSuccess (TestPlanDetail.tsx) opens the new
      // module-4 tab and makes it the active tab, but -- unlike
      // handleRaiseDefect's identical situation in TestRunDetail.tsx,
      // which explicitly `navigate()`s for exactly this reason -- it never
      // changes the URL away from /workbench/testplans. EntityDetail.tsx
      // only renders the active tab's content when the active tab's own
      // module matches the CURRENT URL's module slug (confirmed live: the
      // tab strip shows "Run-N" as the active tab immediately after this
      // click, but the detail pane still reads "Select an item..." until
      // the URL is moved onto testruns), so this navigation is required,
      // not optional.
      await clientSideNavigate(page, '/projects/1/workbench/testruns');
      await page.waitForURL(/\/projects\/1\/workbench\/testruns/, { timeout: 15000 });

      const runHeading = page.getByRole('heading', { name: /^Run-\d+$/ });
      await expect(runHeading).toBeVisible({ timeout: 20000 });
      executionId = ((await runHeading.textContent()) || '').match(/^(Run-\d+)/)?.[1];
      expect(executionId, 'Could not parse a TestExecutionId out of the created run heading').toBeTruthy();

      // === Step 6: run case A to Pass; leave case B untouched at No Run.
      // A freshly created test case's own draft defaults to exactly ONE
      // step (TestCaseDetail.tsx's own DEFAULT_STEPS), and this run's
      // membership rows were created without an embedded TestSteps array,
      // so getExecutionTestCaseDetails (testexecution.js) round-trips to
      // testRepoService for the real, single step -- same mechanics
      // e2e/specs/test-execution.spec.ts already proved, adapted here to
      // one step instead of two. ===
      const caseRowA = page.getByRole('button', { name: new RegExp(escapeRegex(testCaseIdA)) });
      await expect(caseRowA).toBeVisible({ timeout: 15000 });
      await caseRowA.click();
      await expect(
        page.getByRole('heading', { name: new RegExp(`^${escapeRegex(testCaseIdA)} : `) })
      ).toBeVisible({ timeout: 15000 });

      const playButton = page.getByRole('button', { name: 'Run', exact: true });
      const saveButton = page.getByRole('button', { name: 'Save' });
      await expect(playButton).toBeEnabled({ timeout: 10000 });
      await expect(saveButton).toBeDisabled();
      await playButton.click();

      const status = page.getByLabel('Status for step 1');
      await expect(status).toBeVisible();
      await status.click();
      await page.getByRole('option', { name: 'Pass', exact: true }).click();
      await expect(status).toHaveText('Pass');

      await expect(saveButton).toBeEnabled();
      await saveButton.click();

      // Edit mode exits only once the PUT resolved (handleSave ->
      // setEdit(false) after the mutation settles) -- the same signal
      // test-execution.spec.ts uses to confirm the write actually
      // persisted, not just optimistic UI.
      await expect(playButton).toBeEnabled({ timeout: 15000 });
      await expect(saveButton).toBeDisabled();
      await expect(page.getByText('Pass', { exact: true }).first()).toBeVisible();

      // The assertion that makes this an end-to-end write, not a DOM one:
      // read the run back out of the API and confirm case A really
      // persisted as Pass, and case B is still exactly what it started as
      // (No Run, never touched).
      const runDoc = (
        await api.get('/testexecution', { params: { TestExecutionId: executionId } })
      ).data?.data?.[0];
      const persistedCaseA = (runDoc?.TestCases || []).find((tc: { TestCaseId: string }) => tc.TestCaseId === testCaseIdA);
      const persistedCaseB = (runDoc?.TestCases || []).find((tc: { TestCaseId: string }) => tc.TestCaseId === testCaseIdB);
      expect(persistedCaseA?.TestStatus).toBe('Pass');
      expect(persistedCaseB?.TestStatus).toBe('No Run');

      // === Step 7: force reportingService's OWN materialized cache
      // (ReportCache, controllers/reports.js's getOrCompute) to recompute
      // against what this journey just created. That cache serves an
      // entry as fresh for up to REPORT_STALE_MS (5 minutes) regardless of
      // what changed underneath it -- verified live before writing this
      // spec that project 1's own 'coverage' entry already had a
      // computedAt inside that window from the background cron sweep, so
      // a plain GET here could have silently served pre-fixture numbers
      // depending on timing. POST /reports/refresh (authorize('write');
      // the service identity is an admin member of project 1, confirmed
      // above) recomputes and re-caches every report type synchronously,
      // including 'traceability' -- the one deterministic way to guarantee
      // the reads below see this journey's own data, rather than hoping
      // the 5-minute window happened to have already elapsed.
      await api.post('/reports/refresh');

      // === Step 8: open the matrix.
      //
      // A DELIBERATE page.reload(), not a plain client-side nav. Why: this
      // browser session's Dashboard landing page (Step 0, after login)
      // already mounted usePersonaReports() and warmed react-query's
      // `['report','coverage',projectId]` cache entry -- the SAME key
      // Pages/reports.tsx reads for this section's four segment tiles --
      // well inside queryClient.ts's own 30s staleTime (one shared
      // QueryClient for the whole session). A plain clientSideNavigate to
      // /projects/1/reports would very plausibly reuse that pre-fixture
      // cache entry instead of refetching, exactly the react-query trap
      // this suite has hit twice before (release-wiring.spec.ts's own
      // header comment records the first). This journey is not testing
      // invalidation -- nothing in linkissue.tsx's own `invalidateCoverage`
      // call fires for a test-case link in the first place (it only
      // triggers when either end of the link is a requirement<->defect
      // pair), so there is no invalidation path here to exercise, and a
      // reload -- which discards the whole in-memory QueryClient and forces
      // a genuine network fetch -- is the right tool for "read once, after
      // everything is set up", not a workaround standing in for a gap this
      // task is meant to prove. Confirmed live (e2e/specs/deep-link.spec.ts,
      // run against this stack before writing this file) that a cold load
      // of a deep URL boots the app correctly under this app's current
      // homepage/publicPath configuration, so this reload is not the stale
      // "homepage: '.'" trap release-wiring.spec.ts's header comment
      // separately documents for an OLDER build configuration.
      await clientSideNavigate(page, '/projects/1/reports');
      await page.waitForURL(/\/projects\/1\/reports/, { timeout: 15000 });
      await page.reload();
      // A reload re-runs keycloak-js's own onLoad:'login-required' redirect
      // dance; with a live SSO session already established by this test's
      // own interactive login above, Keycloak returns an auth code without
      // re-showing the form, but the round trip still takes a moment --
      // generous timeouts below account for it, matching this suite's own
      // precedent (tags.spec.ts's identical post-reload wait).
      await page.waitForURL(/\/projects\/1\/reports/, { timeout: 30000 });

      const section = page.getByTestId('traceability-section');
      await expect(section).toBeVisible({ timeout: 30000 });
      await expect(page.getByTestId('traceability-grid')).toBeVisible({ timeout: 20000 });

      // === Step 9: THE assertion. One row, 2 cases, one Pass and one No
      // Run, testCount 2, segment "Tests linked, not fully verified" --
      // exactly the case the old rule (classify "any ran, none failed" as
      // all-passing) would have misread as fully verified.
      //
      // WP-F23 Task 2 repair (Task 3) -- the old flat <table>/<tr> markup
      // this step used to read (`traceability-table`, `traceability-row-
      // ${reqId}`, a `<td>` position, and the case/defect text directly
      // inside the row) is gone: the matrix is a DataGrid now. The row is
      // located by the grid's own `[data-id]` (getRowId returns
      // `row.reqId`), the Test Count and Segment cells are read by their
      // column's own `data-field` attribute rather than a `<td>` index, and
      // the on-screen Test Cases/Defects cells are the COMPACT summary R1
      // now renders there -- the exact "id: status" text this step used to
      // read straight out of the row moved behind that row's own "View
      // details" toggle, opened below before reading it. ===
      const row = page.getByTestId('traceability-grid').locator(`[data-id="${reqId}"]`);
      await expect(row).toBeVisible({ timeout: 20000 });

      await expect(row.locator('[data-field="testCount"]')).toHaveText('2'); // Test count -- a plain count (R4), no percentage.
      await expect(row.getByTestId(`traceability-row-${reqId}-cases-summary`)).toHaveText('2 cases · 1 not yet verified');
      await expect(row.getByTestId(`traceability-row-${reqId}-defects-summary`)).toHaveText('None'); // Defects -- none linked.
      await expect(row.locator('[data-field="segment"]')).toHaveText('Tests linked, not fully verified');

      // The full per-case detail (R1: compact on screen, full detail behind
      // this toggle) -- proves the compact cell above did not silently DROP
      // the per-case detail this journey's own header comment says the CSV
      // must still carry, only move where the screen shows it.
      await row.getByTestId(`traceability-row-${reqId}-detail-toggle`).click();
      const detailPanel = page.getByTestId(`traceability-detail-panel-${reqId}`);
      await expect(detailPanel).toBeVisible({ timeout: 10000 });
      await expect(detailPanel.getByTestId(`traceability-detail-testcase-${testCaseIdA}`)).toHaveText(
        `${testCaseIdA}: Pass`
      );
      await expect(detailPanel.getByTestId(`traceability-detail-testcase-${testCaseIdB}`)).toHaveText(
        `${testCaseIdB}: No Run`
      );

      // === Step 10: export CSV, assert the DOWNLOADED FILE's content --
      // not a DOM check -- matches this exact row. ===
      const exportButton = page.getByTestId('traceability-export-button');
      await expect(exportButton).toBeVisible({ timeout: 15000 });
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30000 }),
        exportButton.click(),
      ]);
      const savedPath = await download.path();
      expect(savedPath, 'Playwright did not persist the downloaded traceability CSV to disk').not.toBeNull();
      const csvContent = fs.readFileSync(savedPath as string, 'utf-8');
      const lines = csvContent.split('\r\n');
      expect(lines[0]).toBe(
        'Requirement ID,Requirement Summary,Test Count,Test Cases (id: status),Defects (id: status (severity)),Segment'
      );
      const reqLine = lines.find((l) => l.startsWith(`${reqId},`));
      expect(reqLine, `Expected a CSV row starting with "${reqId},"`).toBeTruthy();
      expect(reqLine).toContain(`${testCaseIdA}: Pass`);
      expect(reqLine).toContain(`${testCaseIdB}: No Run`);
      expect(reqLine).toContain(',2,'); // Test Count column, verbatim what the table showed.
      expect(reqLine).toContain(',None,'); // Defects column.
      expect(reqLine).toContain('"Tests linked, not fully verified"'); // RFC-4180 quoted -- the label contains a comma.
    } finally {
      // Cleanup, children before parents, every step independently guarded
      // so a failure in one can never skip a later one -- release-wiring.
      // spec.ts's own teardown shape, and the exact kind of leak this
      // programme has been burned by before (its header comment; this
      // file's own header comment on shared-steps.spec.ts).
      //
      // Link documents BEFORE the requirement/cases they reference:
      // deleting an entity does not delete its links (release-wiring.
      // spec.ts's own header comment records a live orphan as proof), so
      // deleting the requirement/cases first would leak linkIssue documents
      // even though every entity on either end is about to be removed too.
      //
      // WP-F13 final fix round, Finding 3 -- queried FRESH here (by
      // sourceId/destinationId against every id this run actually created),
      // rather than trusting `linkDocIds`. `linkDocIds` is only populated
      // AFTER both linkTestCase() calls succeed (see the `expect(linkDocIds
      // .length...).toBe(4)` assertion above) -- if the run fails between
      // case A's link succeeding and that point (this spec flaked exactly
      // there during development), `linkDocIds` stays empty while case A's
      // two link rows (forward + reverse) are already live, and this same
      // `finally` still deletes the requirement/cases unconditionally
      // below. Deleting only what `linkDocIds` happened to record would
      // leave those two rows behind, naming a requirement that no longer
      // exists -- byte-for-byte the `newReq51` orphan shape this package's
      // own register entry exists to warn about, permanently added to the
      // seeded census by the very spec meant to prove the fix. Querying
      // fresh, on every id this run touched (reqId and both test case
      // ids), finds whatever links actually exist regardless of where in
      // the happy path the run failed -- the same "found by query, delete
      // what's actually there" pattern this `finally` already uses below
      // for the test execution/test plan/requirement/test cases.
      try {
        if (api) {
          const touchedIds = [reqId, testCaseIdA, testCaseIdB].filter((v): v is string => Boolean(v));
          const foundLinkIds = new Set<string>();
          for (const id of touchedIds) {
            const [sourced, destined] = await Promise.all([
              api.get('/linkIssue', { params: { sourceId: id } }),
              api.get('/linkIssue', { params: { destinationId: id } }),
            ]);
            [...(sourced.data?.data || []), ...(destined.data?.data || [])].forEach((d: { _id: string }) =>
              foundLinkIds.add(d._id)
            );
          }
          for (const id of foundLinkIds) {
            await api.delete(`/linkIssue/${id}`).catch(() => {});
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('traceability-matrix.spec.ts cleanup: deleting link documents failed', err);
      }
      try {
        if (api && executionId) {
          const found = await api.get('/testexecution', { params: { TestExecutionId: executionId } });
          for (const doc of (found.data?.data || []) as Array<{ _id: string }>) {
            await api.delete(`/testexecution/${doc._id}`).catch(() => {});
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('traceability-matrix.spec.ts cleanup: deleting the test execution failed', err);
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
        console.error('traceability-matrix.spec.ts cleanup: deleting the test plan failed', err);
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
        console.error('traceability-matrix.spec.ts cleanup: deleting the requirement failed', err);
      }
      for (const testCaseId of [testCaseIdA, testCaseIdB]) {
        try {
          if (api && testCaseId) {
            const found = await api.get('/testrepo', { params: { TestCaseId: testCaseId } });
            for (const doc of (found.data?.data || []) as Array<{ _id: string }>) {
              await api.delete(`/testrepo/${doc._id}`).catch(() => {});
            }
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`traceability-matrix.spec.ts cleanup: deleting test case ${testCaseId} failed`, err);
        }
      }
      try {
        if (context) await context.close();
      } finally {
        if (persona) await persona.cleanup();
      }
    }
  });

  // WP-F23 Task 3 -- the browser proof jsdom cannot give. WP-F13's own test
  // above proves the matrix's NUMBERS are correct at a handful of rows;
  // this one proves the RENDERING/EXPORT holds at the scale the owner
  // actually reported (the Lens tab, and this matrix "in a worse form" per
  // this task's own plan) -- a large project pages rather than walls, the
  // page body never scrolls sideways for it, the default sort lands the
  // reader on what is broken with no interaction, and -- R4, "the most
  // likely thing to break silently in this package" -- the CSV downloaded
  // from a PAGED grid still contains every row, full nested detail intact.
  //
  // Fixtures are built entirely through scaleFixtures.ts's bulk, API-only
  // helpers (that file's own header comment: this is one of its two named
  // consumers) -- 30 real "New Requirement" dialogs would make this spec
  // slow and brittle for no proof value the API-created rows don't already
  // carry, since the matrix reads whatever is really in the database
  // either way.
  //
  // Design: 1 executedFailing requirement (two linked cases, one Fail, so
  // the CSV's nested-detail check has more than one case AND a defect to
  // prove neither gets dropped by the on-screen cell's move to a compact
  // summary), 1 executedPassing requirement (one linked case, Pass), and
  // 28 noTestsLinked requirements -- 30 total, comfortably crossing the
  // 25-row default page size. SEGMENT_PRIORITY (this file's own
  // `compareSegmentPriority`) ranks executedFailing above noTestsLinked
  // above executedPassing, so with 29 of the 30 fixture rows ranked ABOVE
  // executedPassing, the passing row is guaranteed off the first page
  // regardless of how many of project 1's own pre-existing 5 seeded
  // requirements land in any given segment -- this spec never needs to
  // know or assume that seeded composition, only compare AFTER creating
  // fixtures against a baseline read BEFORE.
  //
  // Setup shape matches release-lens-density.spec.ts / release-derived-
  // membership.spec.ts, not release-wiring.spec.ts's own header comment
  // (which claims its persona/context/api are created inside the `try`
  // when they are actually created above it -- recorded during WP-F13,
  // still true, not repeated here): persona, context and api are all
  // created INSIDE the `try` below.
  test('30+ requirements page the matrix, the failing one sorts first, and the CSV export keeps every row with full nested detail', async ({
    browser,
  }) => {
    const marker = Date.now();
    const FILLER_COUNT = 28;
    const PAGE_SIZE = 25;

    let persona: E2EPersona | undefined;
    let context: BrowserContext | undefined;
    let api: AxiosInstance | undefined;

    let planId: string | undefined;
    let executionId: string | undefined;
    let defectId: string | undefined;
    let reqPassId: string | undefined;
    let reqFailId: string | undefined;
    let casePassAId: string | undefined;
    let casePassBId: string | undefined;
    let caseFailId: string | undefined;

    try {
      persona = await createE2EPersona('traceability-density');
      context = await browser.newContext({ storageState: undefined });
      api = await serviceApi();
      const page = await context.newPage();
      await loginAsPersona(page, BASE_URL, persona);
      await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 15000 });

      // Baseline read BEFORE creating anything -- see this test's own
      // header comment on why every downstream total is computed relative
      // to this, never hardcoded against project 1's own seeded count.
      const baselineReqCount = ((await api.get('/requirement')).data?.data || []).length;

      // === Fixtures, entirely via the API. ===
      const [casePassA, casePassB, caseFail] = await Promise.all([
        createTestCase(api, `E2E traceability density case pass A ${marker}`),
        createTestCase(api, `E2E traceability density case pass B ${marker}`),
        createTestCase(api, `E2E traceability density case fail ${marker}`),
      ]);
      casePassAId = casePassA.TestCaseId;
      casePassBId = casePassB.TestCaseId;
      caseFailId = caseFail.TestCaseId;

      const plan = await createTestPlan(api, [casePassAId, casePassBId, caseFailId]);
      planId = plan.id;
      executionId = await createExecutionForPlan(api, plan.id, [
        { TestCaseId: casePassAId, TestStatus: 'Pass' },
        { TestCaseId: casePassBId, TestStatus: 'Pass' },
        { TestCaseId: caseFailId, TestStatus: 'Fail' },
      ]);

      const defect = await createDefect(api, `E2E traceability density defect ${marker}`, {
        Status: 'Open',
        Severity: 'High',
      });
      defectId = defect.defectId;

      const reqPass = await createRequirement(api, `E2E traceability density req pass ${marker}`);
      reqPassId = reqPass.reqId;
      await Promise.all(
        Array.from({ length: FILLER_COUNT }, (_, i) =>
          createRequirement(api!, `E2E traceability density filler ${marker} #${i}`)
        )
      );
      const reqFail = await createRequirement(api, `E2E traceability density req fail ${marker}`);
      reqFailId = reqFail.reqId;

      // reqPass <-> casePassA (executedPassing: one linked case, Pass).
      await api.post('/linkIssue', {
        sourceId: reqPassId,
        destinationId: casePassAId,
        srcModule: 2,
        destinationModule: 1,
        linkType: 'relates-to',
      });
      // reqFail <-> caseFail, reqFail <-> casePassB (executedFailing: TWO
      // linked cases, one Fail -- the CSV proof below needs more than one
      // case here to show nested detail survives, not just one).
      await api.post('/linkIssue', {
        sourceId: reqFailId,
        destinationId: caseFailId,
        srcModule: 2,
        destinationModule: 1,
        linkType: 'relates-to',
      });
      await api.post('/linkIssue', {
        sourceId: reqFailId,
        destinationId: casePassBId,
        srcModule: 2,
        destinationModule: 1,
        linkType: 'relates-to',
      });
      // reqFail <-> defectA -- so the CSV proof also covers the DEFECT half
      // of "full nested detail", not only test cases.
      await api.post('/linkIssue', {
        sourceId: reqFailId,
        destinationId: defectId,
        srcModule: 2,
        destinationModule: 5,
        linkType: 'relates-to',
      });

      // Force reportingService's own cache (ReportCache, controllers/
      // reports.js's getOrCompute) to recompute against what this test just
      // created -- same reasoning, same call, as the spec above.
      await api.post('/reports/refresh');

      await clientSideNavigate(page, '/projects/1/reports');
      await page.waitForURL(/\/projects\/1\/reports/, { timeout: 15000 });
      await page.reload();
      await page.waitForURL(/\/projects\/1\/reports/, { timeout: 30000 });

      const section = page.getByTestId('traceability-section');
      await expect(section).toBeVisible({ timeout: 30000 });
      const grid = page.getByTestId('traceability-grid');
      await expect(grid).toBeVisible({ timeout: 20000 });

      // === Proof 1: a page, not a wall -- total stated, only 25 rendered.
      // "N requirement(s)" (no leading "of") is unique to this Typography;
      // the segment tiles' own captions all read "of N requirement(s)". ===
      const totalLocator = section.getByText(/^\d+ requirements?$/);
      await expect(totalLocator).toBeVisible({ timeout: 15000 });
      const total = Number((await totalLocator.innerText()).match(/^(\d+)/)?.[1]);
      expect(total).toBe(baselineReqCount + 1 /* reqPass */ + FILLER_COUNT + 1 /* reqFail */);

      const bodyRows = grid.locator('[role="row"][data-id]');
      await expect(bodyRows).toHaveCount(PAGE_SIZE);

      // === Proof 4 (R2): the ONE executedFailing row lands on page 1 with
      // no sort click; the ONE executedPassing row is ranked below every
      // noTestsLinked row (this test's own header comment explains why 29
      // of the 30 fixture rows alone guarantee it is off this page), so it
      // is NOT on page 1 -- until the reader actually goes looking. ===
      await expect(gridRow(grid, reqFailId)).toBeVisible({ timeout: 15000 });
      await expect(gridRow(grid, reqPassId)).toHaveCount(0);
      // Scoped to THIS grid, in case another paginated control ever shares
      // this page (this section's own coverage tiles do not today, but the
      // Lens's sibling density spec found the workbench's source-panel
      // release list collides on this exact label).
      await grid.getByRole('button', { name: 'Go to next page' }).click();
      await expect(gridRow(grid, reqPassId)).toBeVisible({ timeout: 15000 });
      await grid.getByRole('button', { name: 'Go to previous page' }).click();
      await expect(bodyRows).toHaveCount(PAGE_SIZE);

      // === Proof 2: the grid scrolls in its OWN container; the page body
      // does not.
      //
      // First, at the normal viewport this whole test has run at so far:
      // the page body genuinely does not scroll sideways for this grid
      // under ordinary use.
      const bodyBefore = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      }));
      expect(
        bodyBefore.scrollWidth,
        `Page body scrolled sideways at a normal viewport (scrollWidth ${bodyBefore.scrollWidth} vs clientWidth ${bodyBefore.clientWidth})`
      ).toBeLessThanOrEqual(bodyBefore.clientWidth + 1);

      // Second, the actual containment mechanism. NOT proven by shrinking
      // the whole browser viewport: this app's shared page chrome
      // (Components/NavBar/MainDrawer.tsx's `<Box component="main"
      // sx={{flexGrow:1, ...}}>`, wrapping every non-workbench page) has no
      // `minWidth: 0` of its own, so as a flex item its minimum width
      // defaults to its CONTENT's intrinsic width -- confirmed live
      // (narrowing the real browser down to 500px left `document.
      // documentElement.scrollWidth` stuck at ~1276px regardless) -- a
      // real, pre-existing defect, unrelated to this grid and outside this
      // task's own file list to fix (recorded in the register instead).
      // Narrowing the whole viewport would only prove or disprove THAT
      // ancestor's behaviour, not this component's own claim.
      //
      // Instead, this grid's own wrapping Box (`data-testid="traceability-
      // grid"`, the one element TraceabilityMatrixSection.tsx's own comment
      // makes the claim about) is forced narrower directly via an injected
      // stylesheet rule -- independent of the ancestor chain above it --
      // which is what actually isolates "does THIS component contain its
      // own overflow" from "does the surrounding page layout respond to a
      // narrow viewport" (a separate, unrelated question this task does not
      // own). jsdom performs no layout at all, so none of this is checkable
      // there. ===
      await page.addStyleTag({
        content: '[data-testid="traceability-grid"] { width: 220px !important; max-width: 220px !important; }',
      });
      const scrollInfo = await page.evaluate(() => {
        const outer = document.querySelector('[data-testid="traceability-grid"]') as HTMLElement | null;
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
      // leaked its overflow up past its own wrapping Box.
      expect(
        scrollInfo.docScrollWidth,
        `Page body scrolled sideways once the grid was forced narrow (scrollWidth ${scrollInfo.docScrollWidth} vs clientWidth ${scrollInfo.docClientWidth})`
      ).toBeLessThanOrEqual(scrollInfo.docClientWidth + 1);
      // The grid's own wrapping Box stayed exactly the width it was forced
      // to -- it did not grow to accommodate its now-too-wide child either.
      expect(scrollInfo.outerClientWidth).toBe(220);
      expect(
        scrollInfo.outerScrollWidth,
        'Expected the wrapping Box itself to show no overflow of its own -- DataGrid contains its own scrolling one level deeper, in .MuiDataGrid-virtualScroller'
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

      // === Proof 3 (R4 -- "the most likely thing to break silently in
      // this package"): the CSV downloaded from this PAGED grid (25 shown)
      // contains EVERY one of the `total` rows, and reqFail's own row still
      // carries its FULL nested detail -- BOTH linked cases (not just the
      // on-screen cell's compact "2 cases · 1 failing") and its defect --
      // proving the compact cell did not silently become a compact export
      // too. ===
      const exportButton = page.getByTestId('traceability-export-button');
      await expect(exportButton).toBeVisible({ timeout: 15000 });
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30000 }),
        exportButton.click(),
      ]);
      const savedPath = await download.path();
      expect(savedPath, 'Playwright did not persist the downloaded traceability CSV to disk').not.toBeNull();
      const csvContent = fs.readFileSync(savedPath as string, 'utf-8');
      const lines = csvContent.split('\r\n').filter((l) => l.length > 0);
      expect(lines[0]).toBe(
        'Requirement ID,Requirement Summary,Test Count,Test Cases (id: status),Defects (id: status (severity)),Segment'
      );
      // header + one line per requirement -- the SAME `total` the grid
      // itself stated above, not a hardcoded 30: a CSV silently capped at
      // the visible page (25) would fail this by exactly the gap R4 warns
      // about, and one silently capped at MAX_EXPORT_ROWS would fail it
      // too if that ceiling were ever lower than this project's real count.
      expect(lines.length - 1).toBe(total);

      const reqFailLine = lines.find((l) => l.startsWith(`${reqFailId},`));
      expect(reqFailLine, `Expected a CSV row starting with "${reqFailId},"`).toBeTruthy();
      expect(reqFailLine).toContain(`${caseFailId}: Fail`);
      expect(reqFailLine).toContain(`${casePassBId}: Pass`); // the SECOND case -- proves the export isn't just the worst one.
      expect(reqFailLine).toContain(`${defectId}: Open (High)`);

      const reqPassLine = lines.find((l) => l.startsWith(`${reqPassId},`));
      expect(reqPassLine, `Expected a CSV row starting with "${reqPassId},"`).toBeTruthy();
      expect(reqPassLine).toContain(`${casePassAId}: Pass`);
      expect(reqPassLine).toContain(',None,'); // Defects column -- none linked to reqPass.
    } finally {
      // Cleanup, children before parents, every step independently guarded.
      // Links and the 30 requirements/3 test cases are QUERIED FRESH by
      // this run's own marker/touched ids rather than trusted off
      // happy-path variables -- the same lesson the spec above already
      // applies to its own link documents (WP-F13 final fix round, Finding
      // 3): a throw partway through this setup (e.g. filler requirement 14
      // of 28) would leave several of these `let`s still `undefined` while
      // the entities up to that point already exist in the database.
      try {
        if (api) {
          const touchedIds = [reqPassId, reqFailId, casePassAId, casePassBId, caseFailId, defectId].filter(
            (v): v is string => Boolean(v)
          );
          const foundLinkIds = new Set<string>();
          for (const id of touchedIds) {
            const [sourced, destined] = await Promise.all([
              api.get('/linkIssue', { params: { sourceId: id } }),
              api.get('/linkIssue', { params: { destinationId: id } }),
            ]);
            [...(sourced.data?.data || []), ...(destined.data?.data || [])].forEach((d: { _id: string }) =>
              foundLinkIds.add(d._id)
            );
          }
          for (const id of foundLinkIds) {
            await api.delete(`/linkIssue/${id}`).catch(() => {});
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('traceability-matrix.spec.ts density cleanup: deleting link documents failed', err);
      }
      try {
        if (api && executionId) await deleteExecution(api, executionId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('traceability-matrix.spec.ts density cleanup: deleting the execution failed', err);
      }
      try {
        if (api && planId) await deleteTestPlan(api, planId);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('traceability-matrix.spec.ts density cleanup: deleting the test plan failed', err);
      }
      try {
        if (api) {
          const found = await api.get('/defects/wildcardsearch', { params: { search: String(marker) } });
          for (const doc of (found.data?.data || []) as Array<{ _id: string }>) {
            await deleteDefect(api, doc._id);
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('traceability-matrix.spec.ts density cleanup: deleting the defect failed', err);
      }
      try {
        if (api) {
          const found = await api.get('/requirement/wildcardsearch', { params: { search: String(marker) } });
          for (const doc of (found.data?.data || []) as Array<{ _id: string }>) {
            await deleteRequirement(api, doc._id);
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('traceability-matrix.spec.ts density cleanup: deleting requirements failed', err);
      }
      try {
        if (api) {
          const found = await api.get('/testrepo/wildcardsearch', { params: { search: String(marker) } });
          for (const doc of (found.data?.data || []) as Array<{ _id: string }>) {
            await deleteTestCase(api, doc._id);
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('traceability-matrix.spec.ts density cleanup: deleting test cases failed', err);
      }
      try {
        if (context) await context.close();
      } finally {
        if (persona) await persona.cleanup();
      }
    }
  });
});
