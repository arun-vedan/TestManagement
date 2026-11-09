// WP-F05d -- the browser proof for tags.
//
// WHAT THIS IS FOR, precisely. WP-F05e's review round added real jsdom
// coverage of the tag column and click-to-filter (EntityList.test.tsx, via
// a test-only `disableVirtualization` theme override), so the click itself
// is no longer proven only here. What jsdom cannot prove is the part that
// crosses the wire: jsdom mocks the page fetcher, so nothing there shows
// that a tag typed into the editor actually reaches Mongo, survives a
// reload, or that `?tags=` really narrows server-returned rows.
//
// That is this spec's job, and it is the only place it is done.
//
// Fixture discipline: this creates its own requirement and removes it in a
// finally block, so a failed assertion cannot leave drift behind. The gap
// register already carries one seeded-drift entry and one about the
// tenant-isolation suites leaking a fixture per run; this adds to neither.
// Nothing seeded is tagged, modified or deleted.
//
// Permissions: the shared persona is a `contributor` (write: true,
// delete: false). Tagging needs only write, so no elevated persona is
// required -- the requirement is created and removed through the API, not
// through a UI delete.
import { test, expect } from '@playwright/test';
import { AxiosInstance } from 'axios';
import { assertApiReachable } from '../support/requireApi';
import { serviceApi } from '../support/api';
import { RequirementFixture, cleanupRequirementFixture, createRequirementFixture } from '../support/fixtures';

let api: AxiosInstance;

test.beforeAll(async () => {
  api = await serviceApi();
});

test('a tag added in the editor persists to the backend and filters the list', async ({ page }) => {
  test.setTimeout(120000);
  const tag = `wpf05-${Date.now()}`;
  let fixture: RequirementFixture | null = null;

  try {
    fixture = await createRequirementFixture(api, 'tags');

    await page.goto('/');
    await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 20000 });
    await assertApiReachable(page);
    await page.getByRole('link', { name: 'Workbench' }).click();
    await page.waitForURL(/\/projects\/1\/workbench\/testcases/, { timeout: 20000 });

    await page.getByTestId('workbench-module-rail').getByRole('button', { name: 'Requirements' }).click();
    await page.waitForURL(/workbench\/requirements/, { timeout: 20000 });
    await page.waitForTimeout(2000);

    // Open this spec's own requirement and tag it.
    await page.getByRole('treeitem', { name: fixture.reqId, exact: true }).click();
    await expect(page.getByRole('heading', { name: new RegExp(`^${fixture.reqId} : `) })).toBeVisible({ timeout: 20000 });

    const input = page.getByRole('textbox', { name: /add a tag/i });
    await expect(input).toBeVisible({ timeout: 15000 });
    await input.fill(tag);
    await input.press('Enter');
    await expect(page.getByText(tag, { exact: true })).toBeVisible({ timeout: 15000 });

    // THE POINT: prove it reached the backend, not just React state.
    await expect
      .poll(async () => {
        // serviceApi's baseURL already carries /api/v1 and the project
        // header -- see e2e/support/api.ts and how fixtures.ts calls it.
        const resp = await api.get('/requirement', { params: { tags: tag } });
        return (resp.data?.data ?? []).map((r: { reqId: string }) => r.reqId);
      }, { timeout: 20000 })
      .toContain(fixture.reqId);

    // And that it survives a reload -- i.e. it was persisted, not cached.
    await page.reload();
    await expect(page.getByText(tag, { exact: true })).toBeVisible({ timeout: 25000 });

    // Now the list: switch to List view and filter by the tag. jsdom proves
    // the click wiring; this proves the filtered query really comes back
    // narrowed from the server.
    await page.getByRole('button', { name: 'List view' }).click();
    await page.waitForTimeout(2500);

    const chip = page.getByRole('button', { name: tag }).first();
    await expect(chip).toBeVisible({ timeout: 20000 });
    await chip.click();

    await expect(page.getByText(/filtered by tag/i)).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: /clear tag filter/i })).toBeVisible();

    // The grid must now show this requirement and not the untagged ones.
    await expect(page.getByText(fixture.reqId).first()).toBeVisible({ timeout: 20000 });
    await expect(page.getByText('Req-3', { exact: true })).toHaveCount(0);
  } finally {
    if (fixture) await cleanupRequirementFixture(api, fixture);
  }
});
