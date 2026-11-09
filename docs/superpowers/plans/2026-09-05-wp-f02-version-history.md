# WP-F02 — Show what a version contained, not just when it changed

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** make the existing version-history dialog show the content of each superseded version, so a change is readable rather than merely dated.

**Architecture:** extend `Components/governance/LifecycleStatus.tsx`'s existing History dialog **in place**. No new API module, no new component, no second History affordance.

**Tech Stack:** React 18 + TypeScript, MUI, Jest + Testing Library, Playwright.

**Spec:** `docs/superpowers/plans/2026-09-05-functional-gaps-program.md` — work package F02.

---

## Read this first: the original plan for this package was wrong

The first version of this plan claimed version history had no reader and specified a new API module, a new hook, a new section component and a new History tab. **That premise was false.** Its Task 1 was implemented correctly against its brief, then reverted (`e4a12af`) when a task reviewer found that:

- `api/apiCalls.tsx:172-186` already exports `getTestCaseVersions` and `getRequirementVersions`.
- `Components/governance/LifecycleStatus.tsx:110-141` already renders a **History** button and a dialog listing `Version N` + timestamp.
- That component is already mounted in **both** `TestCaseDetail` and `RequirementDetail`.

Building a parallel module would have duplicated two functions under names that already exist. Do not recreate any of it. **You are editing one file's dialog.**

## The real gap, verified against live data

The dialog dates a change without showing what it contained. On the seeded `TC-1` (project 1):

| version | `TestCaseSummary` | `TestSteps` length |
|---|---|---|
| v1 | `test req2` | 3 |
| v2 | `test req2 (verification touch)` | 3 |
| v3 | `test req2` | 3 |
| v4 | `test req2` | **1** |

A test case silently lost two of its three steps, and nothing in the UI can show that. This is the audit-relevant half of the evaluation's E4 finding.

## Global Constraints

- **No new runtime dependency.**
- **No new API module and no new component.** Everything happens inside `LifecycleStatus.tsx`.
- **This is a CRA/CRACO app. `npx jest` does not work.** Use `CI=true npx craco test <path> --watchAll=false`.
- **The frontend suite is not green and cannot be.** 35 of 78 suites fail *to run* on a pre-existing `keycloak-js` ESM parse error. The bar is **0 tests failing and the failed-suite count still 35**.
- **Verify against the running stack**, not against the code you just wrote.
- **Append to `docs/superpowers/PRODUCT_GAP_REGISTER.md`** at the end.

## Do NOT show `updatedBy`

Snapshots carry `updatedBy`, and it is tempting — "who changed this" is the obvious companion to "what changed". It holds a **raw Keycloak subject UUID** (`c16a3041-919f-482f-a027-0b18060aa536`), not a name. Verified against live data.

This is the second field to hit this trap; `assignedTo` hit it in WP-F01, where it was dropped from both search and display for the same reason. Nothing in this product resolves a user id to a display name. Rendering a UUID would be a regression in readability, not a feature. It is recorded against WP-F09.

## Do NOT build a diff

Showing *what differed* between two versions is the natural next step and is deliberately out of scope: it needs a decision about which of a snapshot's ~15 keys are comparable, and `TestSteps`/`dynamicFields` are structured values with no display today. Listing each version's own content is enough for a reader to see the v4 step drop themselves. The diff is recorded as follow-up.

---

### Task 1: Show each version's content in the history dialog

**Files:**
- Modify: `frontend/src/Components/governance/LifecycleStatus.tsx` — the `versions` state type (line ~59) and the dialog body (lines ~114-141)
- Test: `frontend/src/Components/governance/__tests__/LifecycleStatus.history.test.tsx` (create; the directory has no tests yet)

**Interfaces:**
- Consumes: `getTestCaseVersions` / `getRequirementVersions` from `api/apiCalls.tsx` — already imported in this file at lines 18-23. Do not re-import or re-implement them.
- Produces: no new exports. A local `interface EntityVersion` replaces the `any[]` state type.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/Components/governance/__tests__/LifecycleStatus.history.test.tsx`. Mock `../../../api/apiCalls` — that module transitively imports `api/axios`, which imports `src/keycloak.js`, and an unmocked import puts this suite into the 35 that fail to run.

```tsx
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { getTestCaseVersions } from '../../../api/apiCalls';
import { LifecycleStatus } from '../LifecycleStatus';

jest.mock('../../../api/apiCalls', () => ({
    getTestCaseVersions: jest.fn(),
    getRequirementVersions: jest.fn(),
    updateTestCaseStatus: jest.fn(),
    updateRequirementStatus: jest.fn(),
}));

const mockGetVersions = getTestCaseVersions as jest.Mock;

function renderLifecycle() {
    return render(
        <LifecycleStatus
            entityId="mongo-1"
            entityIdLabel="TC-1"
            status="approved"
            entityType="testcase"
            onStatusChanged={jest.fn()}
            onError={jest.fn()}
        />,
    );
}

beforeEach(() => {
    jest.clearAllMocks();
});

// WP-F02 -- the dialog already listed "Version N" + a timestamp. What it
// never showed was what the version CONTAINED, which is the half an
// auditor needs: on the seeded TC-1 the step count drops from 3 to 1 at
// v4 and nothing in the UI could show it.
it('shows a version\'s summary and step count once it is expanded', async () => {
    mockGetVersions.mockResolvedValue([
        { _id: 'b', version: 4, createdAt: '2026-03-04T10:00:00.000Z', snapshot: { TestCaseSummary: 'test req2', status: 'approved', TestSteps: [{ testStep: 'only one' }] } },
        { _id: 'a', version: 1, createdAt: '2026-03-01T10:00:00.000Z', snapshot: { TestCaseSummary: 'test req2', status: 'approved', TestSteps: [{ testStep: 'a' }, { testStep: 'b' }, { testStep: 'c' }] } },
    ]);
    renderLifecycle();
    fireEvent.click(screen.getByRole('button', { name: /history/i }));

    const v4 = await screen.findByRole('button', { name: /Version 4/ });
    // Content is behind the expander, exactly as the version rows were before.
    expect(screen.queryByText('3 steps')).not.toBeInTheDocument();

    fireEvent.click(v4);
    expect(await screen.findByText('1 step')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Version 1/ }));
    expect(await screen.findByText('3 steps')).toBeInTheDocument();
});

it('never renders the raw updatedBy UUID', async () => {
    // updatedBy is a Keycloak subject id, not a name -- the same trap
    // assignedTo hit in WP-F01. Showing it would be a readability
    // regression, not a feature.
    mockGetVersions.mockResolvedValue([
        { _id: 'a', version: 2, createdAt: '2026-03-01T10:00:00.000Z', snapshot: { TestCaseSummary: 'shown', updatedBy: 'c16a3041-919f-482f-a027-0b18060aa536' } },
    ]);
    renderLifecycle();
    fireEvent.click(screen.getByRole('button', { name: /history/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Version 2/ }));

    expect(await screen.findByText('shown')).toBeInTheDocument();
    expect(screen.queryByText(/c16a3041/)).not.toBeInTheDocument();
});

it('never renders Mongo plumbing from the snapshot', async () => {
    mockGetVersions.mockResolvedValue([
        { _id: 'a', version: 2, createdAt: '2026-03-01T10:00:00.000Z', snapshot: { TestCaseSummary: 'shown', __v: 7, parentId: 42, _id: 'inner-id', dynamicFields: { x: 1 } } },
    ]);
    renderLifecycle();
    fireEvent.click(screen.getByRole('button', { name: /history/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Version 2/ }));

    expect(await screen.findByText('shown')).toBeInTheDocument();
    expect(screen.queryByText('inner-id')).not.toBeInTheDocument();
    expect(screen.queryByText('42')).not.toBeInTheDocument();
});

it('still shows the empty state when there is no history', async () => {
    mockGetVersions.mockResolvedValue([]);
    renderLifecycle();
    fireEvent.click(screen.getByRole('button', { name: /history/i }));
    expect(await screen.findByText(/no prior versions/i)).toBeInTheDocument();
});

it('works for a requirement, using its own summary field', async () => {
    const { getRequirementVersions } = jest.requireMock('../../../api/apiCalls');
    (getRequirementVersions as jest.Mock).mockResolvedValue([
        { _id: 'r', version: 3, createdAt: '2026-03-01T10:00:00.000Z', snapshot: { requirementSummary: 'the requirement text' } },
    ]);
    render(
        <LifecycleStatus entityId="mongo-2" entityIdLabel="Req-5" status="approved" entityType="requirement" onStatusChanged={jest.fn()} onError={jest.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /history/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Version 3/ }));
    expect(await screen.findByText('the requirement text')).toBeInTheDocument();
});
```

If the History button's accessible name is not matched by `/history/i`, read the component and use its real name — do not add a test id.

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd frontend && CI=true npx craco test src/Components/governance/__tests__/LifecycleStatus.history.test.tsx --watchAll=false`

Expected: FAIL. The dialog currently renders a flat `<ListItem>` per version with no expander, so `getByRole('button', { name: /Version 4/ })` finds nothing.

- [ ] **Step 3: Type the versions state**

Replace `const [versions, setVersions] = useState<any[]>([]);` (line ~59) with a typed state, and add the interface above the component:

```typescript
// WP-F02 -- the shape both getTestCaseVersions and getRequirementVersions
// already return. Declared locally rather than in a new api module: the
// two fetchers live in api/apiCalls.tsx and already have this one caller,
// and an earlier attempt at this package created a parallel typed module
// exporting the same two names, which was reverted (e4a12af).
//
// `snapshot` is the WHOLE prior document, Mongo bookkeeping included, so
// it stays index-signature typed and is read through an allow-list below.
interface EntityVersion {
    _id: string;
    /** The version the entity held BEFORE the edit this snapshot records. */
    version: number;
    createdAt: string;
    snapshot: Record<string, unknown>;
}
```

```typescript
    const [versions, setVersions] = useState<EntityVersion[]>([]);
```

- [ ] **Step 4: Render each version's content behind an expander**

Add to the MUI import list: `Accordion`, `AccordionSummary`, `AccordionDetails`, `Typography`, `Stack`. Add `import ExpandMoreIcon from '@mui/icons-material/ExpandMore';`.

Add above the component, beside `EntityVersion`:

```typescript
// The snapshot is a whole document, so this renders an allow-list rather
// than iterating its keys. `__v`, `_id`, `parentId` and `id` are plumbing;
// `dynamicFields` has no display; `updatedBy` is a raw Keycloak subject
// UUID rather than a name (the same trap assignedTo hit in WP-F01), so
// showing it would be a readability regression. TestSteps is summarised as
// a count -- that alone makes a dropped-steps edit visible, which is the
// concrete case this package exists for.
const SNAPSHOT_FIELDS: { key: string; label: string }[] = [
    { key: 'TestCaseSummary', label: 'Summary' },
    { key: 'requirementSummary', label: 'Summary' },
    { key: 'TestCaseDescription', label: 'Description' },
    { key: 'description', label: 'Description' },
    { key: 'acceptanceCriteria', label: 'Acceptance criteria' },
    { key: 'status', label: 'Status' },
];

function snapshotRows(snapshot: Record<string, unknown>): { label: string; value: string }[] {
    const rows = SNAPSHOT_FIELDS
        .map((f) => ({ label: f.label, value: snapshot[f.key] }))
        .filter((r) => typeof r.value === 'string' && r.value.trim() !== '')
        .map((r) => ({ label: r.label, value: r.value as string }));

    const steps = snapshot.TestSteps;
    if (Array.isArray(steps)) {
        rows.push({ label: 'Steps', value: `${steps.length} step${steps.length === 1 ? '' : 's'}` });
    }
    return rows;
}
```

Then replace the `<List dense>…</List>` block (lines ~126-137) with:

```tsx
                        <Box>
                            {versions.map((v) => {
                                const rows = snapshotRows(v.snapshot);
                                return (
                                    <Accordion key={v._id} disableGutters>
                                        <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                                            <Typography variant="subtitle2" sx={{ mr: 2 }}>{`Version ${v.version}`}</Typography>
                                            <Typography variant="body2" color="text.secondary">
                                                {new Date(v.createdAt).toLocaleString()}
                                            </Typography>
                                        </AccordionSummary>
                                        <AccordionDetails>
                                            {rows.length === 0 ? (
                                                <Typography variant="body2" color="text.secondary">
                                                    This version recorded no displayable fields.
                                                </Typography>
                                            ) : (
                                                <Stack spacing={1}>
                                                    {rows.map((r) => (
                                                        <Box key={r.label}>
                                                            <Typography variant="caption" color="text.secondary">{r.label}</Typography>
                                                            <Typography variant="body2">{r.value}</Typography>
                                                        </Box>
                                                    ))}
                                                </Stack>
                                            )}
                                        </AccordionDetails>
                                    </Accordion>
                                );
                            })}
                        </Box>
```

Remove `List`, `ListItem` and `ListItemText` from the MUI import if nothing else in the file uses them — check first; do not leave an unused import, `eslint` must still exit 0.

- [ ] **Step 5: Run the test and watch it pass**

Run: `cd frontend && CI=true npx craco test src/Components/governance/__tests__/LifecycleStatus.history.test.tsx --watchAll=false`

Expected: PASS, 5 tests.

- [ ] **Step 6: Run the neighbouring suites, the full suite and the linter**

Run: `cd frontend && CI=true npx craco test src/workbench/detail --watchAll=false`
Expected: PASS — `LifecycleStatusSection.test.tsx`, `TestCaseDetail.test.tsx` and `DefectDetail.test.tsx` all touch this component's surroundings.

Run: `cd frontend && CI=true npx craco test --watchAll=false`
Expected: 0 tests failing, failed-suite count still 35.

Run: `cd frontend && npx eslint 'src/**/*.{ts,tsx}'`
Expected: exit 0.

- [ ] **Step 7: Prove it in a real browser**

Create `frontend/e2e/specs/version-history.spec.ts`, mirroring `e2e/specs/search.spec.ts`'s preamble (read it first). `TC-1` in project 1 has four superseded versions, with the step count dropping at v4.

```typescript
import { test, expect } from '@playwright/test';
import { assertApiReachable } from '../support/requireApi';

// WP-F02 -- the dialog already listed versions and dates. This asserts the
// thing that was missing: a reader can see what a version CONTAINED.
test('a test case version history shows what each version contained', async ({ page }) => {
  test.setTimeout(90000);

  await page.goto('/');
  await page.waitForURL(/\/projects\/1\/dashboard/, { timeout: 20000 });
  await assertApiReachable(page);
  await page.getByRole('link', { name: 'Workbench' }).click();
  await page.waitForURL(/\/projects\/1\/workbench\/testcases/, { timeout: 20000 });

  await page.getByRole('button', { name: 'Search view' }).click();
  await page.getByRole('searchbox', { name: /search test cases/i }).fill('TC-1');
  const hit = page.getByRole('button', { name: /^TC-1(?!\d)/ });
  await expect(hit.first()).toBeVisible({ timeout: 20000 });
  await hit.first().click();

  await page.getByRole('button', { name: /history/i }).click();
  const firstVersion = page.getByRole('button', { name: /Version \d/ }).first();
  await expect(firstVersion).toBeVisible({ timeout: 20000 });

  await firstVersion.click();
  // The real assertion: a step count is on screen, which is what makes a
  // dropped-steps edit visible at all.
  await expect(page.getByText(/\d+ steps?$/).first()).toBeVisible({ timeout: 20000 });
});
```

Run: `cd frontend && npx playwright test e2e/specs/version-history.spec.ts --reporter=list`, then the whole suite and confirm it is one more than before.

Correct selectors against the real DOM if they do not match; do not add test ids to source.

- [ ] **Step 8: Update the gap register**

Append a dated `### 2026-09-05 — after WP-F02` section recording: what was resolved (each version's content is now readable; the TC-1 step drop is visible); that **no diff view** was built and why; that **`updatedBy` was deliberately not shown** because it is a raw Keycloak UUID, the second field to hit that trap after `assignedTo`, tracked with WP-F09; and, under **Checked and FINE**, that this package added no API module and no second History affordance — the existing dialog was extended in place.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/Components/governance/LifecycleStatus.tsx \
        frontend/src/Components/governance/__tests__/LifecycleStatus.history.test.tsx \
        frontend/e2e/specs/version-history.spec.ts \
        docs/superpowers/PRODUCT_GAP_REGISTER.md
git commit -m "WP-F02: show what each version contained, not just when it changed"
```

## Definition of done

- [ ] Every test watched **failing** before it was made to pass.
- [ ] `CI=true npx craco test --watchAll=false`: 0 tests failing, failed-suite count still 35.
- [ ] `npx eslint 'src/**/*.{ts,tsx}'` exits 0.
- [ ] `npx playwright test --reporter=list` passes, one more test than before.
- [ ] `PRODUCT_GAP_REGISTER.md` carries the dated entry.
- [ ] No new API module, no new component, no second History button anywhere.

## Out of scope, and where each excluded thing lives instead

- **Field-by-field diff between versions** — recorded in the register as this package's follow-up.
- **Showing who changed a version** — blocked on user-id → display-name resolution; tracked with WP-F09.
- **Restore/revert a version** — append-only models, no endpoint, needs a backend decision.
- **History for plans, runs or defects** — no version model exists for them.
- **Any backend change.** Both routes exist and are already tested.
