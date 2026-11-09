// WP-063 / WP-063b — Journey 1 (priority, "the strongest existing flow"):
// execute a test and record a result.
//
// STATUS: REAL, EXECUTED PASS against the live stack. WP-063 wrote this from
// source reading only — the Kong CORS gap stopped it at the guard before any
// of it ran, so its selectors were unverified. That gap is fixed
// (docs/e2e-playwright-cors-blocker.md), the spec has now actually been run,
// and the parts that were wrong have been corrected:
//
//   - It selected tree rows with `.tree-node ... button[aria-pressed]`. Both
//     the page's run tree AND the per-run test-case tree inside an open tab
//     use that same `.tree-node` class (Components/folderStructure/
//     CustomNode.tsx and Components/folderList/CustomNode.tsx), so
//     `.tree-node` first() matched the OUTER tree both times and the "select
//     a test case" step just re-clicked the run. Rows are now addressed by
//     their real accessible names instead.
//   - It ran against "the first run in the tree", which is Run-1. Run-1 has
//     ZERO test cases attached (verified live), so the Play/Save controls —
//     which TestExecutionContent.tsx renders only inside
//     `{teTCDetails[0] && ...}`, i.e. after a test case is selected — never
//     existed to be found. That was the actual reported failure. The spec
//     now creates its own single-test-case run and deletes it afterwards
//     (see support/fixtures.ts for why not the seeded runs).
//
// Steps follow docs/accessibility-keyboard-pass.md's hand-verified
// walkthrough of this flow (steps 3-16), which a WP-046 human pass already
// scripted keyboard-only; this drives the same flow with mouse-equivalent
// Playwright actions.
import { test, expect } from '@playwright/test';
import { AxiosInstance } from 'axios';
import { assertApiReachable } from '../support/requireApi';
import { serviceApi } from '../support/api';
import {
  TestExecutionFixture,
  createTestExecutionFixture,
  deleteTestExecutionFixture,
  readExecutionTestCase,
} from '../support/fixtures';

let api: AxiosInstance;
let fixture: TestExecutionFixture;

test.beforeAll(async () => {
  api = await serviceApi();
  fixture = await createTestExecutionFixture(api, 'exec');
});

test.afterAll(async () => {
  await deleteTestExecutionFixture(api, fixture);
});

test('record a Pass result against a test execution step', async ({ page }) => {
  // NOT page.goto('/projects/1/testexecution') directly: frontend/package.json's
  // "homepage": "." makes CRA emit a RELATIVE <script src="main.bundle.js">,
  // which resolves wrong for any cold/hard load two segments deep
  // (resolves to /projects/1/main.bundle.js -> webpack-dev-server's SPA
  // fallback serves index.html for that -> browser tries to parse HTML as
  // JS -> blank page). Confirmed directly (see
  // docs/e2e-playwright-feasibility.md's "the one thing that IS a genuine
  // constraint" section). Landing on "/" first (a shallow path, where the
  // relative script resolves correctly) and reaching this page via real
  // in-app navigation avoids it, and is also just how a real user gets here
  // post-login.
  await page.goto('/');
  await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 15000 });
  // WP-078 Part A: MainDrawer's "Test Execution" entry (the path this spec
  // used to click through) is gone -- removed along with the other five
  // drawer entries that duplicated a workbench rail entry under a
  // mismatched label (owner-approved decision, EXECUTION_LOG.md). The
  // dashboard's own "My work" section (TesterSection.tsx) is visible to
  // every role including this suite's 'contributor' persona and always
  // renders its "View assigned tests" drill-down link (DrilldownLink.tsx),
  // which points at /projects/1/testexecution -- still redirected into the
  // workbench by App.tsx's WorkbenchModuleRedirect, landing here at
  // /projects/1/workbench/testruns exactly as the old drawer click did
  // (plus an `assignedTo` query param the workbench doesn't read -- see
  // dashboardLinks.ts's own WP-076 GAP comment -- so it lands on the same
  // unfiltered tree either way).
  await page.getByRole('link', { name: 'View assigned tests →' }).click();
  await page.waitForURL(/\/projects\/1\/workbench\/testruns/, { timeout: 15000 });

  await assertApiReachable(page);

  // 1. Open this spec's own run. WP-073's accessible tree (EntityTree.tsx,
  // wrapping react-accessible-treeview) replaced the old
  // Components/folderStructure/CustomNode.tsx row markup this comment used
  // to describe -- every row is now a real `role="treeitem"`, not a
  // `role="button"`. Addressed by its real accessible name (the library
  // sets the treeitem's accessible name from the node's own text) rather
  // than by position, so it cannot silently pick up someone else's row.
  const runRow = page.getByRole('treeitem', { name: fixture.testExecutionId, exact: true });
  await expect(runRow).toBeVisible({ timeout: 15000 });
  await runRow.click();

  // 2. Inside the newly-opened tab, select the run's test case in ITS list
  // (TestRunDetail.tsx's own "Test Cases" panel -- a plain MUI
  // <List>/<ListItemButton>, not a tree at all any more; the old
  // Components/folderList/CustomNode.tsx tree this comment used to describe
  // is gone from this screen along with Pages/testExecution.tsx). Verified
  // (per this WP's instructions) rather than assumed: ListItemButton's
  // underlying MUI ButtonBase renders as a plain <div>, and
  // @mui/material/ButtonBase sets role="button" on any non-<button>,
  // non-link root -- so this row genuinely still has role="button". What
  // DID need to change: `exact: true` broke, because this row's accessible
  // name is no longer just the bare id -- it also contains its StatusChip's
  // label text (e.g. "TC-... No Run"), sibling content inside the same
  // ListItemButton, same as any other MUI ButtonBase accessible-name
  // computation. A substring regex against the id is still unambiguous
  // (nothing else on this screen renders this fixture's generated id).
  const caseRow = page.getByRole('button', { name: new RegExp(fixture.testCaseId) });
  await expect(caseRow).toBeVisible({ timeout: 15000 });
  await caseRow.click();

  // The test case's details pane is what carries the Play/Save controls.
  await expect(
    page.getByRole('heading', { name: new RegExp(`^${fixture.testCaseId} : `) })
  ).toBeVisible({ timeout: 15000 });

  // 3. Enter edit mode via the Run button.
  //
  // WP-046's gap here (icon-only <Button>s with no accessible name, forcing
  // this suite onto MUI's auto-generated icon data-testid instead of a real
  // role-based selector) is fixed in the workbench component: TestRunDetail.tsx
  // gives both controls real accessible names, now from their own visible
  // labels ("Run" and "Save") rather than an aria-label, so this addresses
  // them the normal way. exact: true because Playwright matches `name` as a
  // substring by default and "Run" would otherwise also hit the workbench's
  // "Test Runs" rail entry.
  const playButton = page.getByRole('button', { name: 'Run', exact: true });
  const saveButton = page.getByRole('button', { name: 'Save' });
  await expect(playButton).toBeEnabled({ timeout: 10000 });
  await expect(saveButton).toBeDisabled();
  await playButton.click();

  // 4. Record "Pass" for both of the fixture's steps. The status control is
  // a real labelled Select (Components/Tabs/TableRows.tsx:79-88,
  // inputProps={{'aria-label': `Status for step ${n}`}}) and only exists in
  // edit mode, so its presence is itself the proof that Play worked.
  for (const step of [1, 2]) {
    const status = page.getByLabel(`Status for step ${step}`);
    await expect(status).toBeVisible();
    await status.click();
    await page.getByRole('option', { name: 'Pass', exact: true }).click();
    await expect(status).toHaveText('Pass');
  }

  // 5. Save.
  await expect(saveButton).toBeEnabled();
  await saveButton.click();

  // 6. Edit mode exits (Play re-enabled, Save disabled again) -- the same
  // signal docs/accessibility-keyboard-pass.md step 16 asks a human to
  // confirm. handleSave() only reaches setEdit(false) after
  // updateTestSteps() resolved, so this also means the PUT succeeded.
  await expect(playButton).toBeEnabled({ timeout: 15000 });
  await expect(saveButton).toBeDisabled();

  // The read-only view now shows the recorded results, and the run's roll-up
  // counter moved from "No Run" to "Pass" -- i.e. the app re-read the saved
  // state rather than just leaving optimistic UI on screen.
  await expect(page.getByText('Pass', { exact: true }).first()).toBeVisible();

  // 7. The assertion that makes this an end-to-end test rather than a DOM
  // test: read the run back out of the API and confirm the result was really
  // PERSISTED with the right shape -- both steps Pass, and the test case
  // rolled up to Pass by the backend's own logic.
  const saved = await readExecutionTestCase(api, fixture);
  expect(saved.TestSteps.map((s: any) => s.status)).toEqual(['Pass', 'Pass']);
  expect(saved.TestStatus).toBe('Pass');
});
