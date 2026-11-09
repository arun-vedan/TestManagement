// WP-063 / WP-063b — Journey 2 (priority, WP-051): generate test cases from
// a requirement with AI, review the drafts, and accept one.
//
// STATUS: REAL, EXECUTED PASS against the live stack, with the real
// aiService (AI_PROVIDER=mock in this environment — deterministic, no vendor
// key, but a genuine HTTP round trip through Kong to the service, not a
// browser-side stub).
//
// WP-063 wrote this from source reading only; the Kong CORS gap
// (docs/e2e-playwright-cors-blocker.md, now fixed) stopped it at the guard,
// so its selectors were never executed. The reported failure — "Generate
// test cases (AI)" not found — was real: the spec selected
// `.tree-node` first()'s `button[aria-pressed]`, which is the top-level
// FOLDER row ("test"), not a requirement. The old Pages/requirements.tsx +
// Components/Tabs/TabContent.tsx rendered that button only for an open,
// saved requirement tab, so clicking a folder could never produce it. Rows
// were addressed by accessible name from then on, and the spec brings its
// own requirement (support/fixtures.ts) instead of depending on whatever
// happens to sit first in the seeded tree.
//
// WP-075 — Requirements' project-scoped page is retired in favour of the
// workbench (Pages/requirements.tsx deleted; RequirementDetail.tsx +
// EntityTree.tsx take over). Updated for the new UI: the URL this journey
// lands on is now .../workbench/requirements, tree rows are react-
// accessible-treeview `treeitem`s (WP-073) rather than the old
// `.tree-node`'s `<button>`, and the requirement's detail content —
// heading, AI buttons — is rendered by RequirementDetail.tsx rather than
// TabContent.tsx. Verified live against the new component; see the inline
// comments at each changed step below for what was checked and why.
//
// Accepting a candidate CREATES real data — a draft test case plus two link
// documents (api/aiApi.ts#acceptCandidate) — so all of it, and the fixture
// requirement, is removed in afterAll.
import { test, expect } from '@playwright/test';
import { AxiosInstance } from 'axios';
import { assertApiReachable } from '../support/requireApi';
import { serviceApi } from '../support/api';
import {
  RequirementFixture,
  cleanupRequirementFixture,
  createRequirementFixture,
  findAcceptedTestCaseIds,
} from '../support/fixtures';

let api: AxiosInstance;
let fixture: RequirementFixture;
let aiUnavailableReason: string | null = null;

test.beforeAll(async () => {
  api = await serviceApi();

  // WP-166 — AI is off for the closed beta, enforced at DEPLOYMENT level, and
  // afd8482 hides every AI entry point while it is. So the control this
  // journey clicks does not exist and the journey is unreachable, not broken.
  //
  // Asked of GET /api/v1/ai/availability rather than inferred from a missing
  // button: a button that is absent because AI is off and a button that is
  // absent because someone deleted it look identical to a selector, and only
  // one of those should pass quietly. The endpoint answers 200 with a verdict
  // in every state, which is what makes it usable here.
  const probe = await api.get('/ai/availability', { validateStatus: () => true });
  if (probe.status !== 200) {
    aiUnavailableReason = `GET /ai/availability returned HTTP ${probe.status}`;
  } else if (!probe.data?.data?.available) {
    aiUnavailableReason = `${probe.data.data.reason}: ${probe.data.data.message}`;
  }
  if (aiUnavailableReason) {
    // eslint-disable-next-line no-console
    console.warn(
      `\n[ai-generation] SKIPPED — ${aiUnavailableReason}` +
        '\n[ai-generation] Nothing below was verified. Set AI_GLOBALLY_ENABLED=true in' +
        '\n[ai-generation] backend/.env, recreate aiservice, and enable AI on project 1.\n'
    );
    return;
  }

  fixture = await createRequirementFixture(api, 'ai');
});

test.afterAll(async () => {
  // No fixture is created when the journey is skipped, so there is nothing to
  // clean up and cleanup would throw on an undefined fixture.
  if (aiUnavailableReason) return;
  await cleanupRequirementFixture(api, fixture);
});

test('generate AI test-case candidates for a requirement and accept one', async ({ page }) => {
  test.skip(aiUnavailableReason !== null, `AI unavailable — ${aiUnavailableReason}`);
  // NOT page.goto('/projects/1/requirements') directly -- see
  // test-execution.spec.ts's comment on the same line for why (CRA's
  // "homepage": "." emits a relative script src that resolves wrong on a
  // cold load two segments deep; reaching the page via real in-app
  // navigation from "/" avoids it, and matches how a real user gets here
  // post-login anyway).
  await page.goto('/');
  await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 15000 });
  // WP-078 Part A — MainDrawer's "Requirements" entry (the path this spec
  // used to click through) is removed along with the other five drawer
  // entries that duplicated a workbench rail entry under a mismatched
  // label (owner-approved decision, EXECUTION_LOG.md). The dashboard's own
  // "View requirements" drill-down (TestManagerSection.tsx) is gated to
  // manager/admin, and this suite's persona is deliberately 'contributor'
  // (e2e/support/api.ts), so that link isn't a usable replacement here.
  // Instead: enter the workbench through the one dashboard link every role
  // sees (TesterSection's "View assigned tests", always rendered -- see
  // test-execution.spec.ts's matching comment), then switch modules via
  // the workbench's own rail (ModuleRail.tsx), which is unaffected by the
  // drawer teardown and still labels this module "Requirements"
  // (MODULE_LABELS[2], modules.ts).
  await page.getByRole('link', { name: 'View assigned tests →' }).click();
  await page.waitForURL(/\/projects\/1\/workbench\/testruns/, { timeout: 15000 });
  await page.getByRole('button', { name: 'Requirements' }).click();
  await page.waitForURL(/\/projects\/1\/workbench\/requirements/, { timeout: 15000 });

  await assertApiReachable(page);

  // 1. Open this spec's own requirement. It is created at the tree root
  // (parentId 0) precisely so it needs no folder expansion to be reachable
  // — see support/fixtures.ts. Tree rows are react-accessible-treeview
  // `treeitem`s (EntityTreeNode.tsx, WP-073), not the old folderStructure
  // tree's `<button>` rows -- Hooks/queries/useTreeChildren.ts's module-2
  // branch sets each row's accessible name straight from `reqId` with no
  // status chip alongside it, so `exact: true` still isolates this one row.
  const reqRow = page.getByRole('treeitem', { name: fixture.reqId, exact: true });
  await expect(reqRow).toBeVisible({ timeout: 15000 });
  await reqRow.click();

  // 2. Wait for the requirement's own content to actually be on screen.
  //
  // This is a real readiness gate, not padding. It originally guarded a
  // GENUINE PRODUCT RACE this spec found against the pre-cutover UI —
  // reported in EXECUTION_LOG.md's WP-063b entry rather than quietly
  // worked around: TabContent.tsx:592 gated the "Generate test cases (AI)"
  // button on state that didn't depend on the requirement having loaded,
  // while the drawer it opened needed `fieldValues['_id']`, populated only
  // after three sequential requests -- generating in that window POSTed
  // with no requirementId and 400'd.
  //
  // WP-075's workbench cutover retired that page, but the equivalent race
  // is possible in the new one too, so RequirementDetail.tsx (this
  // journey's real target now) carries its own explicit guard: the whole
  // component returns a <CircularProgress> until both its field-definition
  // and entity queries settle (so the button cannot even be *mounted*
  // mid-fetch), and the button is additionally `disabled={!entityLoaded}`
  // (`entityLoaded = Boolean(values._id)`) as defense in depth --
  // RequirementDetail.tsx's own header comment above that guard documents
  // the same WP-063b race by name. This heading (DetailHeader.tsx, driven
  // by the same entity query as the button's guard) is the readiness
  // signal for both: if the requirement never loads, this assertion fails
  // here rather than sliding into a confusing downstream error.
  await expect(
    page.getByRole('heading', { name: new RegExp(`^${fixture.reqId} : `) })
  ).toBeVisible({ timeout: 15000 });

  // 3. Open the AI generation drawer. This button exists only when
  // canPerform('write') holds — true for the 'contributor' role this
  // suite's persona really has, so its presence is itself a live check
  // that RBAC resolved correctly in the browser. `toBeEnabled` is a real
  // (auto-retrying) wait on the `entityLoaded` guard above, not a fixed
  // sleep -- by the time the heading assertion above passes, the same
  // entity query has already settled, so this should already be true, but
  // asserting it explicitly keeps the click honest without a bare
  // waitForTimeout.
  const generateButton = page.getByRole('button', { name: 'Generate test cases (AI)' });
  await expect(generateButton).toBeEnabled({ timeout: 15000 });
  await generateButton.click();

  const drawer = page.getByRole('presentation').filter({ hasText: 'Generate test cases with AI' });
  await expect(drawer.getByRole('heading', { name: 'Generate test cases with AI' })).toBeVisible();
  await expect(drawer.getByText('Drafts are advisory only')).toBeVisible();

  // 4. Ask for exactly one candidate (AiTestCaseDrawer.tsx defaults to 3) —
  // fewer real documents created, and it makes the assertions below exact
  // rather than "at least one".
  await drawer.getByLabel('Number of candidates').click();
  await page.getByRole('option', { name: '1 candidate', exact: true }).click();

  await drawer.getByRole('button', { name: 'Generate', exact: true }).click();

  // The candidate text comes from the real aiService response, not from
  // anything this page could invent -- backend/aiService/providers/
  // mockProvider.js's deterministic "mock-generated candidate N".
  const summaryField = drawer.getByRole('textbox', { name: 'Summary' });
  await expect(summaryField).toHaveCount(1, { timeout: 20000 });
  await expect(summaryField).toHaveValue('mock-generated candidate 1');

  // 5. Accept the (default-checked) candidate.
  const acceptButton = drawer.getByRole('button', { name: 'Accept selected' });
  await expect(acceptButton).toBeEnabled();
  await acceptButton.click();

  // 6. AiTestCaseDrawer.tsx's success Alert and the accepted card's
  // "Added as draft" Chip. Both only appear after acceptCandidate() really
  // reached testRepoService AND both linkIssue writes came back 2xx (a
  // failed link triggers its compensating rollback and an error Alert
  // instead), so this is not just "the button was clickable".
  await expect(drawer.getByText('1 test case created as draft.')).toBeVisible({ timeout: 20000 });
  await expect(drawer.getByText('Added as draft')).toBeVisible();

  // 7. Server-side confirmation, independent of anything the page says: a
  // real 'tests' link now exists from this requirement to a real test case,
  // and that test case is a draft marked as AI-generated. This is the
  // assertion that would catch the drawer reporting success over a write
  // that did not actually land.
  const linkedTestCaseIds = await findAcceptedTestCaseIds(api, fixture);
  expect(linkedTestCaseIds).toHaveLength(1);

  const created = await api.get('/testrepo', { params: { TestCaseId: linkedTestCaseIds[0] } });
  const testCase = created.data?.data?.[0];
  expect(testCase, `No test case found for ${linkedTestCaseIds[0]}`).toBeTruthy();
  expect(testCase.TestCaseSummary).toBe('mock-generated candidate 1');
  expect(testCase.status).toBe('draft');
  expect(testCase.generatedBy).toBe('ai');
});
