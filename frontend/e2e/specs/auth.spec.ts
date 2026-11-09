// WP-063 / WP-063b — REAL, EXECUTED, WATCHED PASS.
//
// This proves the hardest part of the harness end to end: a real disposable
// Keycloak user (e2e/auth/persona.ts), created via the Admin API and granted
// real 'contributor' membership on project 1, driven through Keycloak's
// ACTUAL hosted login form (src/index.tsx's `keycloak.init({ onLoad:
// 'login-required' })` redirect — not a stub, not a mock) by
// e2e/auth/global-setup.ts, landing back in the app authenticated.
//
// WP-063b — WHAT CHANGED AND WHY. As originally written, this spec's final
// assertion required the text "Unable to determine your role on this project
// right now." to be VISIBLE. That banner is Pages/dashboard/index.tsx's
// `roleError` branch: it was showing only because Kong had no `cors` plugin,
// so usePermissions' getProjects() call was killed at preflight and the role
// could never resolve. In other words the spec pinned a broken state as if
// it were the expected one — the same anti-pattern WP-012's tests fell into
// when they asserted a 403 regression as correct. Kong's CORS gap is now
// fixed (docs/e2e-playwright-cors-blocker.md), the banner is correctly gone,
// and this spec now asserts the HEALTHY authenticated state instead: the
// role resolves, real project data loads, and the error branch is absent.
import { test, expect } from '@playwright/test';

test('a real Keycloak login lands on the project-scoped dashboard shell', async ({ page }) => {
  await page.goto('/');
  // LegacyRedirect (App.tsx) sends "/" to /projects/<DEFAULT_PROJECT_ID>/dashboard.
  await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 15000 });

  // THE DRAWER STARTS COLLAPSED, and this spec was stale about it.
  //
  // History, because it has flipped twice and the comment here was left
  // asserting the wrong half:
  //   f498f94  WP-F19  made `open` default to TRUE, fixing the owner's
  //                    report that "the nav bar is very small to understand"
  //                    -- the nav opened as a 41px strip of unlabelled icons.
  //   1befece  "UI: collapse the nav drawer by default"  put it BACK to
  //                    React.useState(false), deliberately.
  //
  // That commit updated the jest tests (MainDrawer.test.tsx,
  // appRouting.test.tsx) but not this Playwright spec, so this file kept
  // claiming `open` "now defaults to true" and kept asserting labels were
  // visible with no interaction. They are present but HIDDEN while
  // collapsed, so the assertion failed on `Received: hidden` with the
  // locator resolving to a real MuiListItemText span -- a stale test, not a
  // product regression and not a login failure.
  //
  // So expand it first, as the pre-WP-F19 version of this spec did. The
  // control is only rendered while collapsed
  // (`display: open ? 'none' : 'flex'`), which is why clicking it is correct
  // now and would have hung under the WP-F19 default.
  //
  // Asserting the labels after expanding, rather than asserting the icon
  // rail, keeps what this spec is actually for: proving the real nav mounted
  // from real route config post-login. It deliberately does NOT assert which
  // default is right -- that is 1befece's decision to own, not this spec's.
  await page.getByTestId('drawer-expand').click();

  // Real nav, rendered from real route config (App.tsx / MainDrawer.tsx) --
  // proves the SPA mounted post-login, not just that the URL changed.
  //
  // WP-078 Part A — this used to assert "Test Execution"/"Requirements"/
  // "Test Repository" (three of the six drawer entries the owner-approved
  // navigation split removed: they duplicated a workbench rail entry under
  // a mismatched label -- EXECUTION_LOG.md's "RECORDED DECISION (owner):
  // navigation split between drawer and rail"). Asserting the RETAINED set
  // instead proves the same thing (the real nav mounted) without pinning
  // labels this WP deliberately deleted.
  await expect(page.getByText('Home', { exact: true })).toBeVisible();
  await expect(page.getByText('Workbench', { exact: true })).toBeVisible();
  await expect(page.getByText('Projects', { exact: true })).toBeVisible();
  await expect(page.getByText('Reports', { exact: true })).toBeVisible();
  await expect(page.getByText('Settings', { exact: true })).toBeVisible();

  // The switcher's label is not static chrome: ProjectSwitcher.tsx fills it
  // from a real GET /api/v1/projects response, so "Default Project" here is
  // proof that an authenticated, project-scoped API call left the browser,
  // passed Kong's JWT gate, and came back — the exact thing the CORS gap
  // used to make impossible.
  await expect(page.getByRole('combobox', { name: 'Switch project' })).toHaveText('Default Project');

  // The dashboard's role-gated content. Pages/dashboard/index.tsx renders
  // "My work" (TesterSection) only on the `role` branch — reaching it means
  // usePermissions resolved this persona's REAL membership role on project 1
  // ('contributor', granted by e2e/auth/persona.ts).
  await expect(page.getByRole('heading', { name: 'My work' })).toBeVisible();

  // ...and the failure branch that used to be asserted as "correct" is now
  // asserted to be ABSENT. Kept as an explicit negative rather than deleted:
  // this text reappearing is the precise, named symptom of the Kong CORS
  // plugin regressing, and this line is what would catch it.
  await expect(
    page.getByText('Unable to determine your role on this project right now.')
  ).toHaveCount(0);
});
