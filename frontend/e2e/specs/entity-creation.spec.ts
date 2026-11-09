// D1 (docs/superpowers/PRODUCT_GAP_REGISTER.md) -- permanent E2E coverage
// for the creation journey. Promoted from the temporary WP-079 screenshot
// harness `_create-shot.spec.ts`: creation is core product behaviour now
// (before WP-079 the workbench could not create a test case, requirement or
// defect at all -- every migration WP through WP-078 explicitly excluded the
// not-yet-saved draft path; see TestCaseDetail.tsx's own header comment), so
// it deserves durable regression coverage rather than scratch work whose
// deletion was left to whoever reviewed the screenshots.
//
// Real field shapes for the two dynamic-field forms (module 2 / module 5)
// were verified live via the mongodb MCP tool against srckube-fields.fields
// before writing these -- not guessed:
//   - module 2 (Requirement): requirementDescription (Editor, "Description"),
//     requirementSummary (TextArea, "Summary" -- excluded from FieldGrid,
//     rendered by RequirementDetail's own dedicated Summary box),
//     RequirementStatus (Text, "Status"), requirementType (Text, "Type"),
//     AcceptanceCriteria (Editor, "Acceptance Criteria"). Only
//     requirementSummary/requirementDescription are actually `required` on
//     the Mongoose schema (backend/requirementService/models/requirement.js)
//     -- the rest are dynamicFields (unvalidated Mixed), so filling just
//     those two is a genuinely valid create, not a lucky pass.
//   - module 5 (Defect): summary (TextArea, "Summary"), description
//     (Editor), Status (IssueDropDown), assignedTo (UserDropDown), Priority/
//     Severity (DropDown), testSeverity (DropDown, isDefault: false). The
//     defects Mongoose schema (backend/defectService/models/defects.js) has
//     no `required` fields at all besides projectId (server-stamped) and
//     the auto-generated defectId ("Bug-<n>", that model's own pre-save
//     hook) -- confirmed here rather than assumed, since the id prefix
//     ("Bug-", not "DEF-") only shows up by actually reading that hook.
//
// Navigation note: identical constraint to every other spec in this suite --
// package.json's "homepage": "." makes CRA/webpack-dev-server emit a
// RELATIVE <script src="main.bundle.js">, so a cold page.goto() of any deep
// URL never boots the app. Land on '/' first, let keycloak-js finish its
// redirect dance and the SPA mount, THEN hop to the workbench route via the
// SPA's own client-side router (history.pushState + a manually dispatched
// 'popstate', reproducing what a same-origin link click does).
//
// Cleanup note: the shared logged-in persona (e2e/auth/global-setup.ts) is
// deliberately 'contributor' (e2e/auth/persona.ts), which has no 'delete'
// in the RBAC matrix (backend/shared/service-core/permissions.js). The
// three creation journeys below still clean up through the more-privileged
// SERVICE identity (e2e/support/api.ts's serviceApi()/fixtures.ts), through
// the same public REST API the browser itself talks to -- never Mongo
// directly. Every record this spec creates is deleted, and the deletion is
// confirmed by re-query (not just a 2xx on the DELETE call) -- this
// programme has already had to purge ~800 leaked fixture documents once.
//
// Wave B-3/B-4 (PRODUCT_GAP_REGISTER.md A1/B1) -- module 1 now HAS real
// Delete/Clone UI (the tree row's "Actions for ..." menu), and the whole
// point of the last journey below is to click it for real, not just prove
// it's hidden. 'contributor' genuinely cannot ('delete' is a separate RBAC
// action from 'write' -- see permissions.ts's matrix), so that journey logs
// in as its OWN throwaway 'manager' persona (e2e/support/login.ts) on a
// fresh browser context, rather than inflating the shared persona's role
// (the same reasoning e2e/support/api.ts's header comment already gives for
// keeping the shared persona at 'contributor').
import { test, expect } from '@playwright/test';
import { assertApiReachable } from '../support/requireApi';
import { serviceApi } from '../support/api';
import { createTestExecutionFixture, deleteTestExecutionFixture, TestExecutionFixture } from '../support/fixtures';
import { createE2EPersona } from '../auth/persona';
import { loginAsPersona } from '../support/login';
// ed3f06d moved these out of the panel header into the "New" menu.
import { createDraft, chooseMoreAction } from '../support/sourcePanelMenus';

const BASE_URL = 'http://localhost:3000';

async function clientSideNavigate(page: import('@playwright/test').Page, url: string) {
  await page.evaluate((target) => {
    window.history.pushState({}, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, url);
}

test.describe('entity creation (D1 -- promoted from WP-079 Part A/B)', () => {
  test.setTimeout(90000);

  test('create a real test case end to end via the new draft flow, then delete it', async ({ page }) => {
    await page.goto('/');
    await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 15000 });

    await clientSideNavigate(page, '/projects/1/workbench/testcases');
    await page.waitForURL(/\/projects\/1\/workbench\/testcases/, { timeout: 15000 });

    await assertApiReachable(page);

    const tree = page.getByRole('tree');
    await tree.waitFor({ state: 'visible', timeout: 30000 });

    // 1. Open a draft -- SourcePanel's "New Test Case" control (gated on
    // usePermissions().can('write'); 'contributor' has it).
    await createDraft(page, 'New Test Case');

    // The draft form: DetailHeader shows "New Test Case" (no id/summary
    // yet -- there is no server record), TestCaseDetail's dedicated
    // Summary box, and FieldGrid rendering the live, DB-driven field
    // definitions (getFields(1)) all empty.
    await expect(page.getByRole('heading', { name: 'New Test Case' })).toBeVisible({ timeout: 15000 });

    const marker = `E2E create ${Date.now()}`;
    await page.getByLabel('Summary').fill(marker);

    // Description -- fieldType 'Editor' (ReactQuill), a contenteditable
    // div, not a plain input/textarea.
    const descriptionEditor = page.locator('.ql-editor');
    await descriptionEditor.click();
    await page.keyboard.type('Created by the entity-creation e2e spec.');

    // Priority -- fieldType 'DropDown' (MUI Select, role=combobox).
    await page.getByRole('combobox', { name: 'Priority' }).click();
    await page.getByRole('option', { name: 'High' }).click();

    // Scenario -- fieldType 'Text'.
    await page.getByLabel('Scenario').fill('E2E scenario');

    // 2. Create. A successful save replaces the draft tab with a real
    // TestCaseId (store's replaceTab) -- the header goes from
    // "New Test Case" to "TC-<n> : <summary>".
    await page.getByRole('button', { name: /^create$/i }).click();

    const summaryPattern = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const heading = page.getByRole('heading', { name: new RegExp(`^TC-\\d+ : ${summaryPattern}`) });
    await expect(heading).toBeVisible({ timeout: 20000 });
    const headingText = (await heading.textContent()) || '';
    const match = headingText.match(/^(TC-\d+)/);
    const testCaseId = match?.[1];
    expect(testCaseId, `Could not parse a TestCaseId out of heading text "${headingText}"`).toBeTruthy();

    // The tree's root-children query was invalidated on Create -- the new
    // row should be visible with no manual refresh.
    const treeRow = page.getByRole('treeitem', { name: testCaseId!, exact: true });
    await expect(treeRow).toBeVisible({ timeout: 15000 });

    // 3. Cleanup -- see this file's header comment for why the service
    // identity, not the logged-in persona, does this.
    const api = await serviceApi();
    const found = await api.get('/testrepo', { params: { TestCaseId: testCaseId } });
    const docs = (found.data?.data || []) as Array<{ _id: string }>;
    expect(docs.length, `Expected to find the created ${testCaseId} via GET /testrepo`).toBeGreaterThan(0);
    for (const doc of docs) {
      await api.delete(`/testrepo/${doc._id}`);
    }
    const verify = await api.get('/testrepo', { params: { TestCaseId: testCaseId } });
    expect(verify.data?.data || [], 'Test case should be gone after cleanup').toHaveLength(0);
  });

  // Module 2 (Requirements). Same shape as the test-case journey above: open
  // a draft via SourcePanel's "New Requirement" control, fill the two
  // schema-required fields (see this file's header comment), Create for
  // real, then delete the created requirement through the service identity
  // and verify it is actually gone.
  test('create a real requirement end to end via the new draft flow, then delete it', async ({ page }) => {
    await page.goto('/');
    await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 15000 });

    await clientSideNavigate(page, '/projects/1/workbench/requirements');
    await page.waitForURL(/\/projects\/1\/workbench\/requirements/, { timeout: 15000 });

    await assertApiReachable(page);

    const tree = page.getByRole('tree');
    await tree.waitFor({ state: 'visible', timeout: 30000 });

    await createDraft(page, 'New Requirement');

    await expect(page.getByRole('heading', { name: 'New Requirement' })).toBeVisible({ timeout: 15000 });

    const marker = `E2E requirement ${Date.now()}`;
    await page.getByLabel('Summary').fill(marker);

    // Description -- fieldType 'Editor' (ReactQuill). It is the FIRST of
    // two editors on this form (AcceptanceCriteria is the other, sorted
    // after it by field `id` -- see this file's header comment), so
    // `.first()` is load-bearing, not decoration.
    const descriptionEditor = page.locator('.ql-editor').first();
    await descriptionEditor.click();
    await page.keyboard.type('Created by the entity-creation e2e spec.');

    // EditorField (FieldGrid.tsx) only commits into the draft buffer
    // `onBlur` -- typing alone updates its own local `draft` state but not
    // RequirementDetail's `draftValues`, so an immediate click on Create
    // right after typing would post an empty requirementDescription (the
    // Mongoose schema's own `required` message, "Please add a Display
    // name", is the actual proof this raced -- caught by this spec's first
    // live run, not assumed). Clicking back into the Summary field forces
    // that blur first.
    await page.getByLabel('Summary').click();

    await page.getByRole('button', { name: /^create$/i }).click();

    const summaryPattern = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const heading = page.getByRole('heading', { name: new RegExp(`^Req-\\d+ : ${summaryPattern}`) });
    await expect(heading).toBeVisible({ timeout: 20000 });
    const headingText = (await heading.textContent()) || '';
    const match = headingText.match(/^(Req-\d+)/);
    const reqId = match?.[1];
    expect(reqId, `Could not parse a reqId out of heading text "${headingText}"`).toBeTruthy();

    const treeRow = page.getByRole('treeitem', { name: reqId!, exact: true });
    await expect(treeRow).toBeVisible({ timeout: 15000 });

    const api = await serviceApi();
    const found = await api.get('/requirement', { params: { reqId } });
    const docs = (found.data?.data || []) as Array<{ _id: string }>;
    expect(docs.length, `Expected to find the created ${reqId} via GET /requirement`).toBeGreaterThan(0);
    for (const doc of docs) {
      await api.delete(`/requirement/${doc._id}`);
    }
    const verify = await api.get('/requirement', { params: { reqId } });
    expect(verify.data?.data || [], 'Requirement should be gone after cleanup').toHaveLength(0);
  });

  // Module 5 (Defects). The defect id prefix is "Bug-", not "DEF-" --
  // verified by reading the model's own pre-save hook (see this file's
  // header comment), not assumed from the module name.
  test('create a real defect end to end via the new draft flow, then delete it', async ({ page }) => {
    await page.goto('/');
    await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 15000 });

    await clientSideNavigate(page, '/projects/1/workbench/defects');
    await page.waitForURL(/\/projects\/1\/workbench\/defects/, { timeout: 15000 });

    await assertApiReachable(page);

    const tree = page.getByRole('tree');
    await tree.waitFor({ state: 'visible', timeout: 30000 });

    await createDraft(page, 'New Defect');

    await expect(page.getByRole('heading', { name: 'New Defect' })).toBeVisible({ timeout: 15000 });

    // Status is NOT offered before the record exists -- the disabled
    // placeholder FieldGrid's IssueDropDownField renders instead of the
    // real DefectStatus workflow control (WP-077's `mongoId` gate). The
    // placeholder is a disabled TextField carrying `aria-label="Status"`
    // (FieldGrid.tsx's IssueDropDownField), not display text, so it is
    // located as a textbox and its value asserted.
    await expect(page.getByRole('textbox', { name: 'Status' })).toHaveValue('Save the defect to set its status');
    await expect(page.getByRole('button', { name: /change status/i })).toHaveCount(0);

    const marker = `E2E defect ${Date.now()}`;
    // isMandatory adds a trailing "*" to the label's accessible name
    // (FormLabel `required`), same convention as DefectDetail.test.tsx.
    await page.getByLabel('Summary', { exact: false }).fill(marker);

    // Description -- the only Editor field on this form (Status/assignedTo
    // are excluded from a draft; Priority/Severity/testSeverity are plain
    // DropDowns) -- unlike the requirement form above, no `.first()`
    // disambiguation is needed here.
    const descriptionEditor = page.locator('.ql-editor');
    await descriptionEditor.click();
    await page.keyboard.type('Created by the entity-creation e2e spec.');

    await page.getByRole('combobox', { name: 'Priority' }).click();
    await page.getByRole('option', { name: 'High' }).click();

    await page.getByRole('button', { name: /^create$/i }).click();

    const summaryPattern = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const heading = page.getByRole('heading', { name: new RegExp(`^Bug-\\d+ : ${summaryPattern}`) });
    await expect(heading).toBeVisible({ timeout: 20000 });
    const headingText = (await heading.textContent()) || '';
    const match = headingText.match(/^(Bug-\d+)/);
    const defectId = match?.[1];
    expect(defectId, `Could not parse a defectId out of heading text "${headingText}"`).toBeTruthy();

    const treeRow = page.getByRole('treeitem', { name: defectId!, exact: true });
    await expect(treeRow).toBeVisible({ timeout: 15000 });

    const api = await serviceApi();
    const found = await api.get('/defects', { params: { defectId } });
    const docs = (found.data?.data || []) as Array<{ _id: string }>;
    expect(docs.length, `Expected to find the created ${defectId} via GET /defects`).toBeGreaterThan(0);
    for (const doc of docs) {
      await api.delete(`/defects/${doc._id}`);
    }
    const verify = await api.get('/defects', { params: { defectId } });
    expect(verify.data?.data || [], 'Defect should be gone after cleanup').toHaveLength(0);
  });

  // A6 (docs/superpowers/PRODUCT_GAP_REGISTER.md's highest-value open gap)
  // -- "You cannot raise or link a defect from a failing test run." Before
  // this WP, TestRunDetail had no defect action and no links section at
  // all: a tester marking a step Failed had to leave the run, create a
  // defect by hand elsewhere, and nothing recorded why it existed. This
  // journey drives the real fix end to end: record a real Fail against a
  // fixture run's step (same fixture/mechanics as
  // test-execution.spec.ts's Journey 1), raise a defect from that failing
  // test case through the new "Raise defect" action (a module-5 draft
  // pre-filled with the run/test-case/step context), complete it for real,
  // then verify via the API -- not just the DOM -- that BOTH the defect AND
  // the bidirectional link (TestRunDetail.tsx's DefectLinksSection <->
  // TC-1 <-> the new Bug-N, module 1 <-> module 5, linkType 'relates-to')
  // actually exist. Every record this test creates (the run fixture, the
  // defect, both link documents) is deleted, each confirmed gone by
  // re-query -- see this file's header comment for why that discipline is
  // non-negotiable in this suite.
  test('raise a defect from a failing test run and confirm the defect + link both exist, then delete both', async ({ page }) => {
    const api = await serviceApi();
    let fixture: TestExecutionFixture | undefined;
    try {
      fixture = await createTestExecutionFixture(api, 'raise-defect');

      await page.goto('/');
      await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 15000 });

      await clientSideNavigate(page, '/projects/1/workbench/testruns');
      await page.waitForURL(/\/projects\/1\/workbench\/testruns/, { timeout: 15000 });

      await assertApiReachable(page);

      const tree = page.getByRole('tree');
      await tree.waitFor({ state: 'visible', timeout: 30000 });

      // 1. Open the fixture run, select its test case -- identical to
      // test-execution.spec.ts's Journey 1 (see that file's comments for
      // why rows are addressed by accessible name/regex rather than
      // position).
      const runRow = page.getByRole('treeitem', { name: fixture.testExecutionId, exact: true });
      await expect(runRow).toBeVisible({ timeout: 15000 });
      await runRow.click();

      const caseRow = page.getByRole('button', { name: new RegExp(fixture.testCaseId) });
      await expect(caseRow).toBeVisible({ timeout: 15000 });
      await caseRow.click();

      await expect(
        page.getByRole('heading', { name: new RegExp(`^${fixture.testCaseId} : `) })
      ).toBeVisible({ timeout: 15000 });

      // 2. Record a real Fail against the first step, so this is genuinely
      // "raise a defect from a FAILING test run" rather than an arbitrary
      // one.
      const playButton = page.getByRole('button', { name: 'Run', exact: true });
      const saveButton = page.getByRole('button', { name: 'Save' });
      await expect(playButton).toBeEnabled({ timeout: 10000 });
      await playButton.click();

      const step1Status = page.getByLabel('Status for step 1');
      await expect(step1Status).toBeVisible();
      await step1Status.click();
      await page.getByRole('option', { name: 'Fail', exact: true }).click();

      await expect(saveButton).toBeEnabled();
      await saveButton.click();
      await expect(playButton).toBeEnabled({ timeout: 15000 });

      // 3. "Raise defect" (TestRunDetail.tsx's DefectLinksSection) opens a
      // module-5 draft, pre-filled with the real test case/run/step
      // context -- no invented placeholder text.
      const raiseDefectButton = page.getByRole('button', { name: /^raise defect$/i });
      await expect(raiseDefectButton).toBeVisible({ timeout: 15000 });
      await raiseDefectButton.click();

      await expect(page.getByRole('heading', { name: 'New Defect' })).toBeVisible({ timeout: 15000 });

      const summaryInput = page.getByLabel('Summary', { exact: false });
      await expect(summaryInput).toHaveValue(new RegExp(fixture.testCaseId));
      await expect(summaryInput).toHaveValue(new RegExp(fixture.testExecutionId));

      const descriptionEditor = page.locator('.ql-editor');
      await expect(descriptionEditor).toContainText('Fixture step one');
      await expect(descriptionEditor).toContainText('Fail');

      // 4. Create for real.
      await page.getByRole('button', { name: /^create$/i }).click();

      const heading = page.getByRole('heading', { name: /^Bug-\d+ : / });
      await expect(heading).toBeVisible({ timeout: 20000 });
      const headingText = (await heading.textContent()) || '';
      const match = headingText.match(/^(Bug-\d+)/);
      const defectId = match?.[1];
      expect(defectId, `Could not parse a defectId out of heading text "${headingText}"`).toBeTruthy();

      // 5. The assertion that makes this end-to-end rather than a DOM
      // test: read BOTH the defect and the bidirectional link back out of
      // the API and confirm they were really PERSISTED with the right
      // shape.
      const foundDefect = await api.get('/defects', { params: { defectId } });
      const defectDocs = (foundDefect.data?.data || []) as Array<{ _id: string }>;
      expect(defectDocs.length, `Expected to find the created ${defectId} via GET /defects`).toBeGreaterThan(0);

      const forwardLinks = await api.get('/linkIssue', {
        params: { sourceId: fixture.testCaseId, destinationId: defectId },
      });
      const forwardDocs = (forwardLinks.data?.data || []) as Array<{
        _id: string;
        srcModule: number;
        destinationModule: number;
        linkType: string;
      }>;
      expect(forwardDocs.length, 'Expected a TestCase -> Defect link').toBeGreaterThan(0);
      expect(forwardDocs[0].srcModule).toBe(1);
      expect(forwardDocs[0].destinationModule).toBe(5);
      expect(forwardDocs[0].linkType).toBe('relates-to');

      const reverseLinks = await api.get('/linkIssue', {
        params: { sourceId: defectId, destinationId: fixture.testCaseId },
      });
      const reverseDocs = (reverseLinks.data?.data || []) as Array<{
        _id: string;
        srcModule: number;
        destinationModule: number;
        linkType: string;
      }>;
      expect(reverseDocs.length, 'Expected the reverse Defect -> TestCase link').toBeGreaterThan(0);
      expect(reverseDocs[0].srcModule).toBe(5);
      expect(reverseDocs[0].destinationModule).toBe(1);
      expect(reverseDocs[0].linkType).toBe('relates-to');

      // 6. Cleanup -- delete both link documents and the defect (the run
      // fixture is deleted in `finally` below), each confirmed gone by
      // re-query.
      for (const doc of [...forwardDocs, ...reverseDocs]) {
        await api.delete(`/linkIssue/${doc._id}`);
      }
      for (const doc of defectDocs) {
        await api.delete(`/defects/${doc._id}`);
      }

      const verifyForward = await api.get('/linkIssue', {
        params: { sourceId: fixture.testCaseId, destinationId: defectId },
      });
      expect(verifyForward.data?.data || [], 'Forward link should be gone after cleanup').toHaveLength(0);
      const verifyReverse = await api.get('/linkIssue', {
        params: { sourceId: defectId, destinationId: fixture.testCaseId },
      });
      expect(verifyReverse.data?.data || [], 'Reverse link should be gone after cleanup').toHaveLength(0);
      const verifyDefect = await api.get('/defects', { params: { defectId } });
      expect(verifyDefect.data?.data || [], 'Defect should be gone after cleanup').toHaveLength(0);
    } finally {
      await deleteTestExecutionFixture(api, fixture);
    }
  });

  // Wave B-3 (delete an entity) / B-4 (clone an entity) --
  // PRODUCT_GAP_REGISTER.md A1/B1. Before this WP there was no way to
  // delete a single test case and no way to clone one; both live on the
  // tree row's "Actions for <name>" menu (EntityTreeNode.tsx). This is the
  // real proof for both, in one journey: create a test case, clone it
  // (proving the clone is a genuinely SEPARATE record, its own id, not a
  // reference to the original), then delete BOTH through the actual UI
  // (confirmation dialog and all) and confirm via API re-query that
  // neither remains. It cleans up after itself by construction -- nothing
  // is left behind to purge, and TC-2/folder `test44`'s known drift is
  // never touched.
  //
  // Needs its own 'manager' persona (not the shared 'contributor' one --
  // see this file's header comment) because 'delete' is a separate RBAC
  // action from 'write' (permissions.ts): a manager persona has both.
  test('create a test case, clone it, then delete both through the UI', async ({ browser }) => {
    const persona = await createE2EPersona('delete-clone', 'manager');
    // `@playwright/test`'s `browser` fixture wraps `newContext()` to inherit
    // this project's `use:` options (including `storageState`) unless
    // overridden -- without this, the "fresh" context below would actually
    // start already logged in as the SHARED 'contributor' persona
    // (playwright.config.ts's STORAGE_STATE_PATH), defeating the entire
    // point of logging in as a separate 'manager' persona here.
    const context = await browser.newContext({ storageState: undefined });
    try {
      const page = await context.newPage();
      await loginAsPersona(page, BASE_URL, persona);

      await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 15000 });
      await clientSideNavigate(page, '/projects/1/workbench/testcases');
      await page.waitForURL(/\/projects\/1\/workbench\/testcases/, { timeout: 15000 });

      await assertApiReachable(page);

      const tree = page.getByRole('tree');
      await tree.waitFor({ state: 'visible', timeout: 30000 });

      // 1. Create a real test case (same flow as the first journey above).
      await createDraft(page, 'New Test Case');
      await expect(page.getByRole('heading', { name: 'New Test Case' })).toBeVisible({ timeout: 15000 });

      const marker = `E2E clone-delete ${Date.now()}`;
      await page.getByLabel('Summary').fill(marker);

      // Description/Priority are mandatory on this form (real, DB-driven
      // field defs -- same required fields the first journey above fills).
      const descriptionEditor = page.locator('.ql-editor');
      await descriptionEditor.click();
      await page.keyboard.type('Created by the delete/clone e2e journey.');
      await page.getByRole('combobox', { name: 'Priority' }).click();
      await page.getByRole('option', { name: 'High' }).click();

      await page.getByRole('button', { name: /^create$/i }).click();

      const summaryPattern = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const originalHeading = page.getByRole('heading', { name: new RegExp(`^TC-\\d+ : ${summaryPattern}`) });
      await expect(originalHeading).toBeVisible({ timeout: 20000 });
      const originalHeadingText = (await originalHeading.textContent()) || '';
      const originalId = originalHeadingText.match(/^(TC-\d+)/)?.[1];
      expect(originalId, `Could not parse a TestCaseId out of heading text "${originalHeadingText}"`).toBeTruthy();

      const originalRow = page.getByRole('treeitem', { name: originalId!, exact: true });
      await expect(originalRow).toBeVisible({ timeout: 15000 });

      // 2. Clone it via the tree row's Actions menu.
      const actionsButton = page.getByRole('button', { name: new RegExp(`Actions for ${originalId}`, 'i') });
      await actionsButton.click();
      await page.getByRole('menuitem', { name: /^clone$/i }).click();

      // The clone opens as a pre-filled DRAFT (still "New Test Case" --
      // there is no server record yet), with the Summary field showing
      // "Copy of <original summary>" so the user can see and edit it
      // before saving -- exactly the dispatch's B-4 requirement.
      await expect(page.getByRole('heading', { name: 'New Test Case' })).toBeVisible({ timeout: 15000 });
      const cloneSummaryInput = page.getByLabel('Summary');
      await expect(cloneSummaryInput).toHaveValue(`Copy of ${marker}`);

      // 3. Save the clone through the normal create path -- a genuinely
      // new record, not a reference to the original.
      await page.getByRole('button', { name: /^create$/i }).click();
      const cloneHeading = page.getByRole('heading', {
        name: new RegExp(`^TC-\\d+ : Copy of ${summaryPattern}`),
      });
      await expect(cloneHeading).toBeVisible({ timeout: 20000 });
      const cloneHeadingText = (await cloneHeading.textContent()) || '';
      const cloneId = cloneHeadingText.match(/^(TC-\d+)/)?.[1];
      expect(cloneId, `Could not parse a TestCaseId out of heading text "${cloneHeadingText}"`).toBeTruthy();
      expect(cloneId).not.toBe(originalId);

      const cloneRow = page.getByRole('treeitem', { name: cloneId!, exact: true });
      await expect(cloneRow).toBeVisible({ timeout: 15000 });

      // 4. Prove via the API that the clone is a genuinely SEPARATE
      // record: both ids exist, with distinct Mongo _ids.
      const api = await serviceApi();
      const originalDocsBefore = (await api.get('/testrepo', { params: { TestCaseId: originalId } })).data
        ?.data as Array<{ _id: string }>;
      const cloneDocsBefore = (await api.get('/testrepo', { params: { TestCaseId: cloneId } })).data?.data as Array<{
        _id: string;
      }>;
      expect(originalDocsBefore.length, `Expected to find the original ${originalId} via GET /testrepo`).toBeGreaterThan(0);
      expect(cloneDocsBefore.length, `Expected to find the clone ${cloneId} via GET /testrepo`).toBeGreaterThan(0);
      expect(cloneDocsBefore[0]._id).not.toBe(originalDocsBefore[0]._id);

      // 5. Delete BOTH through the real UI -- confirmation dialog and all.
      for (const id of [originalId!, cloneId!]) {
        const row = page.getByRole('treeitem', { name: id, exact: true });
        await expect(row).toBeVisible({ timeout: 15000 });
        await page.getByRole('button', { name: new RegExp(`Actions for ${id}`, 'i') }).click();
        await page.getByRole('menuitem', { name: /^delete$/i }).click();

        const dialog = page.getByRole('dialog');
        await expect(dialog).toBeVisible({ timeout: 10000 });
        await expect(dialog.getByText(new RegExp(`Delete ${id}`))).toBeVisible();
        await dialog.getByRole('button', { name: /^delete$/i }).click();

        await expect(dialog).not.toBeVisible({ timeout: 15000 });
        await expect(row).not.toBeVisible({ timeout: 15000 });
      }

      // 6. Confirm via the API -- not just the DOM -- that neither record
      // remains.
      const verifyOriginal = await api.get('/testrepo', { params: { TestCaseId: originalId } });
      expect(verifyOriginal.data?.data || [], `${originalId} should be gone after UI delete`).toHaveLength(0);
      const verifyClone = await api.get('/testrepo', { params: { TestCaseId: cloneId } });
      expect(verifyClone.data?.data || [], `${cloneId} should be gone after UI delete`).toHaveLength(0);
    } finally {
      await context.close();
      await persona.cleanup();
    }
  });

  // Wave C-1 (Register A3) -- CSV import for test cases. The backend
  // (WP-045, backend/testRepoService/controllers/importExport.js) has
  // existed since before this WP with no UI ever wired to it; this drives
  // the real UI (SourcePanel's new "Import CSV" action, module 1 only) end
  // to end against the real preview/commit endpoints, in both directions:
  //   - a clean 2-row file: Preview shows it clean, Commit creates exactly
  //     those two rows, confirmed by GET /testrepo (not just the DOM), then
  //     both are deleted and re-queried to confirm they're actually gone.
  //   - a file with one deliberately invalid row: Preview's real,
  //     server-computed report marks it invalid (proving the actual
  //     buildImportReport() validation ran, not a client-side guess), and
  //     GET /testrepo confirms NOTHING for that file's marker was ever
  //     created -- the all-or-nothing guarantee.
  //
  // This exercises the guarantee via Preview correctly leaving Commit
  // disabled on a dirty file (CsvImportDialog.tsx's own canCommit gate) --
  // the real product behaviour a user actually encounters -- rather than
  // forcing a raw commit call on an invalid file, which no reachable UI
  // path allows. The distinct case of commit itself answering 422 AFTER a
  // preview it followed came back clean (the server re-validates and never
  // trusts a client-reported clean preview -- e.g. the file changed, or a
  // concurrent edit) is a race between two requests that cannot be staged
  // deterministically against a real server in this suite; it is proven
  // instead by Components/Import/__tests__/CsvImportDialog.test.tsx's own
  // "shows the server-returned report ... on a 422 from commit after a
  // clean preview" test, with the backend's real 422 response shape (read
  // directly from importExport.js) mocked in.
  test('import test cases from a CSV end to end, then a deliberately invalid file imports nothing', async ({ page }) => {
    await page.goto('/');
    await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 15000 });

    await clientSideNavigate(page, '/projects/1/workbench/testcases');
    await page.waitForURL(/\/projects\/1\/workbench\/testcases/, { timeout: 15000 });

    await assertApiReachable(page);

    const tree = page.getByRole('tree');
    await tree.waitFor({ state: 'visible', timeout: 30000 });

    const api = await serviceApi();
    const marker = `E2E import ${Date.now()}`;

    // --- 1. A clean 2-row file: Preview clean, Commit creates both rows ---
    await chooseMoreAction(page, 'Import CSV');

    const dialog = page.getByRole('dialog', { name: /import test cases from csv/i });
    await expect(dialog).toBeVisible({ timeout: 10000 });

    const cleanCsv = [
      'Summary,Description',
      `${marker} row 1,Created by the entity-creation e2e spec (CSV import).`,
      `${marker} row 2,Created by the entity-creation e2e spec (CSV import).`,
      '',
    ].join('\n');

    await dialog.getByLabel(/choose csv file/i).setInputFiles({
      name: 'e2e-import-clean.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(cleanCsv),
    });

    // Map columns: the file's real detected headers ("Summary",
    // "Description") onto the two REQUIRED_FIELDS
    // (backend/testRepoService/controllers/importExport.js's own
    // ALLOWED_FIELDS/REQUIRED_FIELDS).
    await dialog.getByRole('combobox', { name: /map "summary" to/i }).click();
    await page.getByRole('option', { name: /^summary \(required\)$/i }).click();
    await dialog.getByRole('combobox', { name: /map "description" to/i }).click();
    await page.getByRole('option', { name: /^description \(required\)$/i }).click();

    await dialog.getByRole('button', { name: /^preview$/i }).click();
    await expect(dialog.getByText(/2 of 2 row\(s\) valid/i)).toBeVisible({ timeout: 15000 });
    await expect(dialog.getByText(/preview is clean/i)).toBeVisible();

    const commitButton = dialog.getByRole('button', { name: /^commit import$/i });
    await expect(commitButton).toBeEnabled();
    await commitButton.click();

    await expect(dialog.getByText(/imported 2 test case/i)).toBeVisible({ timeout: 20000 });
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 10000 });

    // Confirm via the API -- not just the dialog's own success message --
    // that exactly those two test cases now exist.
    const row1 = await api.get('/testrepo', { params: { TestCaseSummary: `${marker} row 1` } });
    const row2 = await api.get('/testrepo', { params: { TestCaseSummary: `${marker} row 2` } });
    const row1Docs = (row1.data?.data || []) as Array<{ _id: string; TestCaseId: string }>;
    const row2Docs = (row2.data?.data || []) as Array<{ _id: string; TestCaseId: string }>;
    expect(row1Docs.length, `Expected to find "${marker} row 1" via GET /testrepo`).toBe(1);
    expect(row2Docs.length, `Expected to find "${marker} row 2" via GET /testrepo`).toBe(1);

    // The imported row's tree entry is visible with no manual refresh --
    // CsvImportToolbar.tsx's onImported invalidates the module-1 tree
    // query on success.
    const importedRow = page.getByRole('treeitem', { name: row1Docs[0].TestCaseId, exact: true });
    await expect(importedRow).toBeVisible({ timeout: 15000 });

    // Cleanup -- every record this spec creates is deleted (see this
    // file's header comment) -- before starting the rejection scenario
    // below, so a failure partway through that second scenario can never
    // leave the success scenario's own rows behind uncleaned.
    await api.delete(`/testrepo/${row1Docs[0]._id}`);
    await api.delete(`/testrepo/${row2Docs[0]._id}`);
    const verifyRow1 = await api.get('/testrepo', { params: { TestCaseSummary: `${marker} row 1` } });
    const verifyRow2 = await api.get('/testrepo', { params: { TestCaseSummary: `${marker} row 2` } });
    expect(verifyRow1.data?.data || [], `"${marker} row 1" should be gone after cleanup`).toHaveLength(0);
    expect(verifyRow2.data?.data || [], `"${marker} row 2" should be gone after cleanup`).toHaveLength(0);

    // --- 2. A deliberately invalid file: Preview marks it invalid, Commit
    //        stays disabled, and NOTHING is ever created for this marker
    //        (the all-or-nothing guarantee) ---
    const badMarker = `E2E import bad ${Date.now()}`;
    await chooseMoreAction(page, 'Import CSV');
    const dialog2 = page.getByRole('dialog', { name: /import test cases from csv/i });
    await expect(dialog2).toBeVisible({ timeout: 10000 });

    // Row 2's Description is deliberately left empty -- REQUIRED_FIELDS
    // (importExport.js) rejects it server-side with "TestCaseDescription
    // is required", the real validation error, not a client-side guess.
    const invalidCsv = [
      'Summary,Description',
      `${badMarker} row 1,Created by the entity-creation e2e spec (CSV import).`,
      `${badMarker} row 2,`,
      '',
    ].join('\n');

    await dialog2.getByLabel(/choose csv file/i).setInputFiles({
      name: 'e2e-import-invalid.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(invalidCsv),
    });

    await dialog2.getByRole('combobox', { name: /map "summary" to/i }).click();
    await page.getByRole('option', { name: /^summary \(required\)$/i }).click();
    await dialog2.getByRole('combobox', { name: /map "description" to/i }).click();
    await page.getByRole('option', { name: /^description \(required\)$/i }).click();

    await dialog2.getByRole('button', { name: /^preview$/i }).click();
    await expect(dialog2.getByText(/1 of 2 row\(s\) are invalid/i)).toBeVisible({ timeout: 15000 });
    await expect(dialog2.getByText(/TestCaseDescription is required/)).toBeVisible();

    // Commit is unreachable from here -- the product's own all-or-nothing
    // gate (CsvImportDialog.tsx's canCommit) never enables it against a
    // dirty preview, so there is no click that could import a partial
    // batch.
    await expect(dialog2.getByRole('button', { name: /^commit import$/i })).toBeDisabled();

    await dialog2.getByRole('button', { name: 'Close' }).click();
    await expect(dialog2).not.toBeVisible({ timeout: 10000 });

    // Confirm via the API that this marker created NOTHING at all --
    // neither the row that would have been valid on its own, nor anything
    // else.
    const badRow1 = await api.get('/testrepo', { params: { TestCaseSummary: `${badMarker} row 1` } });
    const badRow2 = await api.get('/testrepo', { params: { TestCaseSummary: `${badMarker} row 2` } });
    expect(badRow1.data?.data || [], `"${badMarker} row 1" must not have been created (all-or-nothing)`).toHaveLength(0);
    expect(badRow2.data?.data || [], `"${badMarker} row 2" must not have been created (all-or-nothing)`).toHaveLength(0);
  });
});
