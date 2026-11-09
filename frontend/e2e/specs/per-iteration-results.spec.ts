// WP-F07b Task 5 (final) -- the browser journey that closes the package,
// and the proof that the whole chain (Task 1's addressing, Task 2's
// enrichment, Task 3's counting, Task 4's rendering) actually delivers
// F07b's promise: a run of a PARAMETERISED case produces ONE RESULT ROW
// PER DATA ROW, each independently addressable, instead of collapsing to
// a single ambiguous row.
//
// The journey (brief's own order): create a 2-row dataset -> author a
// parameterised case bound to it -> add the case to a plan and start a
// run from it -> assert the run shows TWO rows for that ONE case -> fail
// iteration 1, pass iteration 0 -> assert each holds its OWN status after
// a genuine reload (read back from the SERVER, not just the DOM) -> raise
// a defect from iteration 1 and assert it names the data values (R5) ->
// assert reporting counts 2 executed / 1 passed against THIS fixture's
// own plan, not global totals (R3) -> clean up.
//
// Setup (dataset/case/plan/run) goes through the same REST API the
// browser itself talks to, not the UI -- parameterised-cases.spec.ts
// (WP-F07a Task 5) already proves the dataset+case authoring UI works,
// and TestPlanDetail's own "Create Execution" button posts exactly this
// shape (TestCases: [{TestCaseId, TestCaseSummary, TestStatus, id}],
// no TestSteps -- see controllers/testexecution.js's own
// getExecutionTestCaseDetails: a stub row with no TestSteps is what
// triggers enrichment the first time a tester opens it in a run, the
// exact mechanism this test depends on). What is DISTINCTIVE to this
// package -- addressing two iterations of one case independently in the
// run view, and raising a defect that names which data row failed -- is
// exercised entirely through the real browser below.
//
// Persona: needs 'manager' (write to record results and raise a defect,
// delete to clean up in the SAME session) -- same reasoning as
// parameterised-cases.spec.ts and shared-steps.spec.ts, so this does NOT
// reuse the suite's shared 'contributor' persona (write:true,
// delete:false).
//
// Cleanup ordering (has bitten this programme repeatedly, per this
// task's brief): the TEST CASE (which carries the datasetId reference)
// must be deleted BEFORE the DATASET, or the dataset's delete guard
// (controllers/dataset.js's deleteDataset) refuses with 409 and leaks the
// dataset on every run. Persona/context/api client are all created
// INSIDE the try below (matching parameterised-cases.spec.ts's own fixed
// setup shape) so a throw before any of them exist can never leak
// anything, and every cleanup step is independently guarded (its own
// try/catch, logged rather than thrown) so a failure in one can never
// skip persona.cleanup() at the end.
import { test, expect, BrowserContext } from '@playwright/test';
import { AxiosInstance } from 'axios';
import { execSync } from 'child_process';
import { assertApiReachable } from '../support/requireApi';
import { serviceApi } from '../support/api';
import { createE2EPersona } from '../auth/persona';
import { loginAsPersona } from '../support/login';

const BASE_URL = 'http://localhost:3000';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// WP-F07b Task 2's own test suite (iterationEnrichment.test.js) found and
// documented this, live, before this task ever ran: createTestExecution's
// stub row always defaults `TestSteps` to `[]` -- a real, truthy array,
// Mongoose's own default for an array-typed path even when the field is
// never sent -- so the enrichment branch in getExecutionTestCaseDetails
// (`if (!TestCases[0].TestSteps)`, controllers/testexecution.js) never
// fires through the create API alone, for ANY execution, parameterised or
// not. A genuinely un-enriched record has the field ABSENT, not present-
// but-empty. Reproduced here exactly the way that suite does: a direct,
// docker-exec-only Mongo unset on the freshly created stub (this task's
// own constraint: NEVER a host mongosh -- a stray native mongod squats on
// 127.0.0.1:27017 and a host client would silently talk to the wrong
// database) -- so this journey exercises the same enrichment code path a
// tester's first click on a freshly created run's case actually depends
// on, live, rather than a shape this test invented that the real
// createTestExecution flow never produces. This is a real, pre-existing
// gap independent of F07b (it affects every execution's first-open
// enrichment, not just parameterised ones) -- recorded in this task's own
// report, not silently worked around without comment.
// WP-101 -- the Mongo root credentials come from the environment, not from
// source. This file is tracked, and the password used to be written here in
// full. A Playwright spec cannot reach backend/shared/test-utils (different
// package), so it reads the same variables backend/.env defines; run the e2e
// suite with those exported, or via a runner that sources backend/.env.
const MONGO_USER = process.env.MONGO_ROOT_USER || process.env.MONGO_BACKUP_USER;
const MONGO_PASSWORD = process.env.MONGO_ROOT_PASSWORD || process.env.MONGO_BACKUP_PASSWORD;
if (!MONGO_USER || !MONGO_PASSWORD) {
  // Thrown rather than defaulted: a missing credential otherwise surfaces as
  // an authentication error that reads like a broken database.
  throw new Error(
    'per-iteration-results.spec.ts needs MONGO_ROOT_USER and MONGO_ROOT_PASSWORD in the ' +
      'environment (they live in backend/.env; see backend/.env.example).'
  );
}
const MONGO_URI =
  `mongodb://${MONGO_USER}:${encodeURIComponent(MONGO_PASSWORD)}@localhost:27017/srckube-testexecution?authSource=admin`;
function unsetStubTestSteps(exeid: string): void {
  const script = `db.testexecutions.updateOne({TestExecutionId:"${exeid}"},{$unset:{"TestCases.0.TestSteps":""}})`;
  execSync(`docker exec mongodb mongosh "${MONGO_URI}" --quiet --eval '${script.replace(/'/g, "'\\''")}'`, {
    stdio: 'pipe',
  });
}

test.describe('per-iteration execution results (WP-F07b Task 5 -- the chain, end to end)', () => {
  test.setTimeout(240000);

  test('two data rows, two independent statuses, a defect that names the failing row, and reporting that counts both', async ({
    browser,
  }) => {
    const persona = await createE2EPersona('f07b', 'manager');
    // Declared here, created inside the try -- see this file's header
    // comment.
    let context: BrowserContext | undefined;
    let api: AxiosInstance | undefined;

    const marker = Date.now();
    const datasetTitle = `e2e-f07b-dataset-${marker}`;
    const tcSummary = `E2E F07b iterations ${marker}`;

    let datasetMongoId: string | undefined;
    let testCaseMongoId: string | undefined;
    let testCaseId: string | undefined;
    let planMongoId: string | undefined;
    let planId: string | undefined;
    let executionMongoId: string | undefined;
    let executionId: string | undefined;
    let defectMongoId: string | undefined;
    let defectId: string | undefined;

    // The two data rows this whole journey is built to keep separate.
    const columns = ['role', 'env'];
    const rows = [
      ['admin', 'prod'],
      ['viewer', 'staging'],
    ];
    const stepText = 'Log in as {{role}}';
    const expectedText = 'Dashboard shown for {{role}} in {{env}}';
    const substituted = [
      { testStep: 'Log in as admin', expected: 'Dashboard shown for admin in prod' },
      { testStep: 'Log in as viewer', expected: 'Dashboard shown for viewer in staging' },
    ];

    try {
      // ---------------------------------------------------------------
      // Setup: a 2-row dataset, a case bound to it, a plan holding that
      // case, and a run started from the plan -- via the same REST API
      // the browser itself uses (see header comment for why not the UI
      // here).
      // ---------------------------------------------------------------
      api = await serviceApi();

      const dsResp = await api.post('/dataset', {
        title: datasetTitle,
        description: 'WP-F07b Task 5 e2e fixture -- two login roles.',
        columns,
        rows,
      });
      datasetMongoId = dsResp.data?.data?._id;
      expect(datasetMongoId, 'POST /dataset should return a Mongo _id').toBeTruthy();

      const tcResp = await api.post('/testrepo', {
        TestCaseSummary: tcSummary,
        TestCaseDescription: JSON.stringify({ ops: [{ insert: 'WP-F07b Task 5 e2e fixture\n' }] }),
        TestSteps: [{ testStep: stepText, Expected: expectedText }],
        datasetId: datasetMongoId,
        parentId: 0,
      });
      testCaseMongoId = tcResp.data?.data?._id;
      testCaseId = tcResp.data?.data?.TestCaseId;
      expect(testCaseId, 'POST /testrepo should return a TestCaseId').toBeTruthy();

      const planResp = await api.post('/testplan', {
        TestCases: [{ TestCaseId: testCaseId, TestCaseSummary: tcSummary, TestStatus: 'No Run', id: 1 }],
        parentId: 0,
      });
      planMongoId = planResp.data?.data?._id;
      planId = planResp.data?.data?.TestPlanId;
      expect(planId, 'POST /testplan should return a TestPlanId').toBeTruthy();

      // Deliberately no TestSteps on this stub -- see header comment.
      // This is exactly the shape TestPlanDetail.tsx's "Create Execution"
      // button posts for a real user's plan-to-run flow.
      const execResp = await api.post('/testexecution', {
        TestCases: [{ TestCaseId: testCaseId, TestCaseSummary: tcSummary, TestStatus: 'No Run', id: 1 }],
        TestPlanId: planMongoId,
      });
      executionMongoId = execResp.data?.data?._id;
      executionId = execResp.data?.data?.TestExecutionId;
      expect(executionId, 'POST /testexecution should return a TestExecutionId').toBeTruthy();
      unsetStubTestSteps(executionId!);

      // ---------------------------------------------------------------
      // Browser: open the run, watch enrichment turn the one stub row
      // into two, record a result against each independently, prove
      // persistence survives a genuine reload, raise a defect that names
      // the failing row's data, and confirm reporting counts both rows.
      // ---------------------------------------------------------------
      context = await browser.newContext({ storageState: undefined });
      const page = await context.newPage();
      await loginAsPersona(page, BASE_URL, persona);
      await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 15000 });

      await page.evaluate((target) => {
        window.history.pushState({}, '', target);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, '/projects/1/workbench/testruns');
      await page.waitForURL(/\/projects\/1\/workbench\/testruns/, { timeout: 15000 });
      await assertApiReachable(page);

      const tree = page.getByRole('tree');
      await tree.waitFor({ state: 'visible', timeout: 30000 });

      const runRow = page.getByRole('treeitem', { name: executionId!, exact: true });
      await expect(runRow).toBeVisible({ timeout: 15000 });
      await runRow.click();

      await expect(page.getByRole('heading', { name: executionId!, exact: true })).toBeVisible({ timeout: 15000 });
      await page.waitForURL(new RegExp(`/workbench/testruns/${escapeRegex(executionId!)}$`), { timeout: 15000 });

      // Before enrichment: exactly ONE row, labelled by the bare
      // TestCaseId (no iterationValues yet) -- the regression guard this
      // whole feature must never break for a run that is still on its
      // stub row.
      const stubRow = page.getByRole('button', { name: new RegExp(`^${escapeRegex(testCaseId!)}`) });
      await expect(stubRow).toBeVisible({ timeout: 15000 });
      await stubRow.click();

      // Selecting it triggers enrichment server-side (Task 2): the
      // detail pane resolves to iteration 0 (admin/prod)'s substituted
      // text, fetched fresh from testRepoService.
      await expect(
        page.getByRole('heading', { name: new RegExp(`^${escapeRegex(testCaseId!)} : `) })
      ).toBeVisible({ timeout: 20000 });
      await expect(page.getByText(substituted[0].testStep, { exact: true })).toBeVisible({ timeout: 15000 });

      // --- Pass iteration 0 (admin/prod) ---
      const playButton = page.getByRole('button', { name: 'Run', exact: true });
      const saveButton = page.getByRole('button', { name: 'Save' });
      await expect(playButton).toBeEnabled({ timeout: 10000 });
      await playButton.click();
      const status1 = page.getByLabel('Status for step 1');
      await expect(status1).toBeVisible();
      await status1.click();
      await page.getByRole('option', { name: 'Pass', exact: true }).click();
      await expect(saveButton).toBeEnabled();
      await saveButton.click();
      await expect(playButton).toBeEnabled({ timeout: 15000 });
      await expect(saveButton).toBeDisabled();

      // --- THE ASSERTION THAT MATTERS MOST: saving iteration 0's result
      // invalidates the run's own list, which now re-reads TWO rows for
      // this ONE TestCaseId -- one per data row, labelled by the data
      // that produced it (Task 4's iterationLabel), not by a bare index.
      // Nothing else in this package proves the user-visible payoff end
      // to end. ---
      const adminRowName = new RegExp(`^${escapeRegex(testCaseId!)} · role=admin, env=prod`);
      const viewerRowName = new RegExp(`^${escapeRegex(testCaseId!)} · role=viewer, env=staging`);
      const adminRow = page.getByRole('button', { name: adminRowName });
      const viewerRow = page.getByRole('button', { name: viewerRowName });
      await expect(adminRow).toBeVisible({ timeout: 15000 });
      await expect(viewerRow).toBeVisible({ timeout: 15000 });
      // Exactly two rows for this TestCaseId -- not one (the pre-F07b
      // bug), not three or more (a stray duplicate write).
      await expect(page.getByRole('button', { name: new RegExp(`^${escapeRegex(testCaseId!)}( ·|$)`) })).toHaveCount(2);

      // --- Fail iteration 1 (viewer/staging) ---
      await viewerRow.click();
      await expect(page.getByText(substituted[1].testStep, { exact: true })).toBeVisible({ timeout: 15000 });
      // Non-vacuity anchor: clicking a row must move MUI's own `selected`
      // highlight to exactly that row. `isSelected` (TestRunDetail.tsx) is
      // computed from the SAME `iterationRowKey` helper as the list `key`
      // prop -- deliberately, "so the two cannot drift apart" (that
      // file's own comment). This is what actually makes this journey
      // catch this task's required non-vacuity probe (reverting the key
      // to a bare TestCaseId): under that revert, `rowKey` (bare) can
      // never equal `iterationRowKey(selectedTcId, selectedIterationIndex)`
      // (always suffixed "::N"), so NEITHER row is ever shown selected,
      // no matter which one was clicked -- verified live before writing
      // this assertion. A React key COLLISION alone, with no reorder, is
      // otherwise invisible to Playwright (it queries rendered DOM, never
      // React's own reconciliation identity) -- this is the one place in
      // the journey that is actually sensitive to it.
      await expect(viewerRow).toHaveClass(/Mui-selected/);
      await expect(adminRow).not.toHaveClass(/Mui-selected/);
      await expect(playButton).toBeEnabled({ timeout: 10000 });
      await playButton.click();
      const status1Again = page.getByLabel('Status for step 1');
      await expect(status1Again).toBeVisible();
      await status1Again.click();
      await page.getByRole('option', { name: 'Fail', exact: true }).click();
      await expect(saveButton).toBeEnabled();
      await saveButton.click();
      await expect(playButton).toBeEnabled({ timeout: 15000 });
      await expect(saveButton).toBeDisabled();

      // --- THE ASSERTION THAT IS THE WHOLE FEATURE: each iteration
      // holds its OWN status after a genuine reload -- a fresh mount,
      // not a re-render, and read back from the SERVER via the same
      // getexecutiontc route the browser itself uses, not just the DOM.
      // If both rows shared a status the backend addressing collapsed
      // and iterations are cosmetic. ---
      await page.reload();
      await expect(page.getByRole('heading', { name: executionId!, exact: true })).toBeVisible({ timeout: 20000 });

      await expect(adminRow).toBeVisible({ timeout: 15000 });
      await adminRow.click();
      await expect(page.getByText(substituted[0].testStep, { exact: true })).toBeVisible({ timeout: 15000 });
      await expect(page.getByLabel('Status for step 1')).not.toBeVisible(); // not in edit mode
      await expect(page.getByText('Pass', { exact: true }).first()).toBeVisible();
      await expect(adminRow).toHaveClass(/Mui-selected/);
      await expect(viewerRow).not.toHaveClass(/Mui-selected/);

      await expect(viewerRow).toBeVisible({ timeout: 15000 });
      await viewerRow.click();
      await expect(page.getByText(substituted[1].testStep, { exact: true })).toBeVisible({ timeout: 15000 });
      await expect(page.getByText('Fail', { exact: true }).first()).toBeVisible();
      await expect(viewerRow).toHaveClass(/Mui-selected/);
      await expect(adminRow).not.toHaveClass(/Mui-selected/);

      // Server truth, independent of the DOM: read both iterations back
      // via the exact route TestRunDetail.tsx itself calls
      // (getTeTestCaseDetails -> GET /testexecution/getexecutiontc).
      const readIteration = async (iterationIndex: number) => {
        const resp = await api!.get('/testexecution/getexecutiontc', {
          params: { tcid: testCaseId, exeid: executionId, iterationIndex },
        });
        return resp.data?.data?.[0]?.TestCases?.[0];
      };
      const serverIteration0 = await readIteration(0);
      const serverIteration1 = await readIteration(1);
      expect(serverIteration0?.TestStatus, 'iteration 0 (admin/prod) should be Pass on the server').toBe('Pass');
      expect(serverIteration1?.TestStatus, 'iteration 1 (viewer/staging) should be Fail on the server').toBe('Fail');
      expect(serverIteration0?.iterationValues).toEqual({ role: 'admin', env: 'prod' });
      expect(serverIteration1?.iterationValues).toEqual({ role: 'viewer', env: 'staging' });
      // Belt and braces on the addressing itself: two DIFFERENT documents
      // (different iterationIndex), not the same row read twice.
      expect(serverIteration0?.iterationIndex ?? 0).toBe(0);
      expect(serverIteration1?.iterationIndex).toBe(1);

      // --- Raise a defect from the FAILING iteration (viewer/staging;
      // still selected from the reload block above) and assert it names
      // the data values (R5): "TC-9 failed" is not actionable when only
      // the viewer row failed. ---
      const raiseDefectButton = page.getByRole('button', { name: 'Raise defect' });
      await expect(raiseDefectButton).toBeVisible({ timeout: 15000 });
      await raiseDefectButton.click();

      await expect(page.getByRole('heading', { name: 'New Defect' })).toBeVisible({ timeout: 15000 });
      const summaryField = page.getByLabel('Summary');
      await expect(summaryField).toHaveValue(new RegExp(`${escapeRegex(testCaseId!)} failed in run ${escapeRegex(executionId!)}`));
      await expect(summaryField).toHaveValue(/iteration 1: role=viewer, env=staging/);
      const descriptionEditor = page.locator('.ql-editor');
      await expect(descriptionEditor).toContainText('role=viewer, env=staging');
      await expect(descriptionEditor).toContainText('iteration 1');
      await expect(descriptionEditor).not.toContainText('role=admin');

      await page.getByRole('button', { name: /^create$/i }).click();
      const defectHeading = page.getByRole('heading', { name: /^Bug-\d+ : /, exact: false });
      await expect(defectHeading).toBeVisible({ timeout: 20000 });
      const defectHeadingText = (await defectHeading.textContent()) || '';
      defectId = defectHeadingText.match(/^(Bug-\d+)/)?.[1];
      expect(defectId, `Could not parse a defectId out of heading text "${defectHeadingText}"`).toBeTruthy();

      // Server truth for R5: the PERSISTED defect names the failing
      // row's data, not just the draft form a moment ago.
      const defectLookup = await api.get('/defects', { params: { defectId } });
      const defectDocs = (defectLookup.data?.data || []) as Array<{ _id: string; summary?: string; description?: string }>;
      expect(defectDocs.length, `Expected to find the created ${defectId} via GET /defects`).toBe(1);
      defectMongoId = defectDocs[0]._id;
      expect(defectDocs[0].summary).toContain('role=viewer, env=staging');
      expect(defectDocs[0].description ?? '').toContain('role=viewer, env=staging');

      // --- Reporting counts iterations individually (R3): THIS
      // fixture's own plan shows 2 executed / 1 passed -- not a global
      // total, which every other spec and every seeded execution would
      // contaminate. ---
      await api.post('/reports/refresh');
      const progressResp = await api.get('/reports/plan-progress');
      const progressData = progressResp.data?.data as { categories: string[]; series: Array<{ id: string; data: number[] }> };
      const planIdx = progressData.categories.indexOf(planId!);
      expect(planIdx, `Expected plan ${planId} to appear in plan-progress categories`).toBeGreaterThanOrEqual(0);
      const executedSeries = progressData.series.find((s) => s.id === 'executed');
      const passedSeries = progressData.series.find((s) => s.id === 'passed');
      expect(executedSeries?.data[planIdx], 'this plan should show 2 executed (one per data row)').toBe(2);
      expect(passedSeries?.data[planIdx], 'this plan should show 1 passed (only the admin row)').toBe(1);
    } finally {
      // Cleanup ordering: defect+links, then the run, then the plan,
      // then the TEST CASE (before the dataset it references -- the
      // reverse trips the dataset's delete guard and leaks it on every
      // run), then the dataset. Every step is independently guarded so a
      // failure in one can never skip a later one, persona.cleanup()
      // included -- see this file's header comment.
      try {
        if (api && defectMongoId) {
          const links = await api.get('/linkIssue', { params: { sourceId: defectId } }).catch(() => undefined);
          for (const link of (links?.data?.data || []) as Array<{ _id: string }>) {
            await api.delete(`/linkIssue/${link._id}`).catch(() => {});
          }
          if (testCaseId) {
            const reverseLinks = await api.get('/linkIssue', { params: { sourceId: testCaseId } }).catch(() => undefined);
            for (const link of (reverseLinks?.data?.data || []) as Array<{ _id: string; destinationId: string }>) {
              if (link.destinationId === defectId) {
                await api.delete(`/linkIssue/${link._id}`).catch(() => {});
              }
            }
          }
          await api.delete(`/defects/${defectMongoId}`).catch(() => {});
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('per-iteration-results.spec.ts cleanup: deleting the defect/links failed', err);
      }
      try {
        if (api && executionMongoId) {
          await api.delete(`/testexecution/${executionMongoId}`).catch(() => {});
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('per-iteration-results.spec.ts cleanup: deleting the test execution failed', err);
      }
      try {
        if (api && planMongoId) {
          await api.delete(`/testplan/${planMongoId}`).catch(() => {});
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('per-iteration-results.spec.ts cleanup: deleting the test plan failed', err);
      }
      try {
        if (api && testCaseMongoId) {
          await api.delete(`/testrepo/${testCaseMongoId}`).catch(() => {});
          if (testCaseId) {
            try {
              const verifyTc = await api.get('/testrepo', { params: { TestCaseId: testCaseId } });
              expect(verifyTc.data?.data || [], `${testCaseId} should be gone after cleanup`).toHaveLength(0);
            } catch (verifyErr) {
              // eslint-disable-next-line no-console
              console.error(`per-iteration-results.spec.ts cleanup: verify-gone check for ${testCaseId} failed`, verifyErr);
            }
          }
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('per-iteration-results.spec.ts cleanup: deleting the test case failed', err);
      }
      try {
        if (api && datasetMongoId) {
          await api.delete(`/dataset/${datasetMongoId}`).catch(() => {});
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('per-iteration-results.spec.ts cleanup: deleting the dataset failed', err);
      }
      try {
        if (context) await context.close();
      } finally {
        await persona.cleanup();
      }
    }
  });
});
