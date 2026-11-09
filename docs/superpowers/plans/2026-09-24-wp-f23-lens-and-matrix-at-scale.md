# WP-F23 — The Lens and the matrix at scale

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A release with 300 test cases, and a project with 200 requirements, stay readable — and the two or three items that need attention are on the first screen rather than somewhere in the scroll.

**Architecture:** Replace flat `.map()` lists with the DataGrid this codebase already uses next door. Summary stays visible; detail collapses by default; default sort surfaces problems first. **Rendering only — no endpoint changes**; the payload split is a documented follow-up.

**Tech Stack:** React 18 / TypeScript / MUI v5 / `@mui/x-data-grid` ^6.19.10 (already a dependency) / react-query.

**Spec:** the owner's report — *"in the lens the way test cases, requirements etc are arranged it is fine when we have one or two but when you have a large release with 100s of testcases it is not going to look good"* — extended to the traceability matrix, which has the same defect in a worse form.

## Global Constraints

- **No new runtime dependencies.** `@mui/x-data-grid` ^6.19.10 is already in `frontend/package.json`.
- **No backend changes in this package.** Not the lens endpoint, not the traceability service. If a payload problem is found, record it; do not fix it here.
- Frontend commands from `/Users/arunganesha/srckubetest/frontend`, never `frontend/src`. **CRACO**, not plain react-scripts. Isolation runs (`--testPathPattern`), `--runInBand`.
- Finish with `npx tsc --noEmit` and eslint clean on every file touched.
- Tests non-vacuous: name the single-line break for each, perform the probes, and **verify each probe's edit landed before trusting the run**.
- A React test asserting items on a **fresh mount** can pass against a broken implementation — React renders all children on first mount. Say so where it applies and design around it.
- No line-number cites in comments. No comment asserting a file exists or does not exist, and no comment stating an invariant the code does not have — three separate incidents in the last two packages.

## Verified premises

1. **`@mui/x-data-grid` ^6.19.10 is already a dependency** and is used across the app: `EntityList.tsx`, `entityListConfigs.tsx`, `TestPlanDetail.tsx`, `linkissue.tsx`, `ViewSwitcher.tsx`.
2. **`TestPlanDetail.tsx` — the tab directly beside the Lens — already renders four DataGrids** over exactly this shape (a plan's member test cases). It is the precedent to follow, not a pattern to invent.
3. **`EntityList.tsx` does server-side paging** with `paginationModel`, `pageSizeOptions={[25, 50, 100]}` and `rowCount`. Its shape is the reference for grid wiring; this package uses **client-side** paging because both payloads already arrive whole.
4. **`ReleaseDetail.tsx` does NOT currently import DataGrid** — it only mentions it in a comment. The import is new to that file.
5. **`LensGroup` is a heading plus its children**, nothing more — no collapse, no count, no overflow handling.
6. **`TraceabilityMatrixSection.tsx` renders a table of tables**: `rows.map(...)` with no pagination, and inside each row `row.testCases.map(...)` and `row.defects.map(...)`. 200 requirements averaging four cases each renders ~800 nested items in one pass.
7. **The release lens is NOT cached** — `controllers/reports.js` routes `getReleaseLens` around `getOrCompute` deliberately. Traceability **is** cached. So the lens recomputes and ships everything on every tab open.
8. **CSV export is client-side**, built by `buildCsv` in `Components/Export/csvEncode.ts` from the full row array, with `MAX_EXPORT_ROWS` 5000 in `api/exportApi.ts`.
9. **F15b's R2 is still binding:** derived release members and explicitly-linked ones must stay visibly distinct. The current Lens does this with a "Derived" chip and a `via` caption per row.

## Rulings

- **R1 — summary always visible, detail collapsed by default.** Counts and breakdowns never hide behind a disclosure. The wall is the detail, not the numbers. *Cost if wrong:* one extra click for a release with three items.
- **R2 — default sort surfaces problems first.** This is the ruling that makes the change useful rather than merely shorter. Failing before not-run before passing; unresolved defects before closed. A grid sorted by id scatters twelve failures across twelve pages and answers nothing. **Sorting is not decoration here — it is the feature.**
- **R3 — client-side paging; no endpoint changes, with ONE amendment.** Both payloads already arrive whole, so paging the render costs nothing and risks nothing. The lens's uncached full-payload-per-read (premise 7) is a real concern at scale and stays **out of scope**: record it, do not fix it.

  **Amended during Task 1.** The lens payload carries **no per-test-case execution status**, so R2 — the package's central ruling — cannot be satisfied for test cases, which is the exact entity the owner reported. R3 existed to stop scope creep into endpoint splitting and caching, not to block the small additive field R2 depends on. The lens already fetches every execution and already reads `TestStatus` per case; it aggregates into counts and discards the detail. `coverage.js` already exports `resolveExecutionSets`, which produces a latest-status-per-case map, in the same service. **Adding per-case latest status to the lens's linked and derived test-case arrays is permitted.** Endpoint splitting, caching and pagination remain forbidden. *Cost if wrong:* a slightly larger lens payload, on a read that already ships every member.

  **Scope that status to the release's OWN executions** (the ones belonging to its attached plans), not project-wide. A pass recorded against an unrelated plan must not make this release read green — the same "which release actually found this" honesty WP-F15b's R3 was built on.
- **R4 — CSV export must contain EVERY row, not the visible page.** DataGrid's own export exports what is displayed. An audit export that silently contains 25 of 300 rows is worse than no export at all, because nobody checks. Keep exporting from the full array, and add a test that pins it. **This is the most likely thing to break silently in this package.**
- **R5 — F15b's derived/asserted distinction must survive the move into a grid** (premise 9). A chip in a table cell, a column, a filter — the mechanism can change; the distinction cannot disappear.
- **R6 — no empty state may read as a clean bill of health.** Standing rule. "No test cases linked" and "0 failing" are different claims.

---

### Task 1: The release Lens at scale

**Files:** modify `frontend/src/workbench/detail/modules/ReleaseDetail.tsx` (`ReleaseLensPanel`, `LensGroup`); tests and a11y in `frontend/src/workbench/detail/__tests__/`.

Give `LensGroup` a collapse, with its count in the heading, collapsed by default (R1). Inside, render requirements, test cases and defects as DataGrids following `TestPlanDetail.tsx`'s usage (premise 2), with client-side paging at 25/50/100, sorting and a quick filter.

Default sort per R2: test cases by execution state with failing first; defects by status with unresolved first; requirements by whether they are derived or asserted, then id.

R5: the derived/asserted distinction moves into the grid — a column or a cell chip, your choice, but a reader must still see at a glance which members someone asserted and which the system inferred, and from what.

- [ ] **Step 1: Write the failing tests** — a group with 60 items renders one page, not 60 rows, and states the total; the group is collapsed on first render and its count is visible while collapsed; expanding reveals the grid; a failing test case sorts above a passing one **without the user touching the sort**; a derived member is still distinguishable from an asserted one (R5); a group with zero items reads as an honest empty state, not "0 failing" (R6).
- [ ] **Step 2: Run to verify failure.** — [ ] **Step 3: Implement.** — [ ] **Step 4: a11y suite** — a collapsed disclosure and a grid both have real a11y requirements; assert the controls genuinely mount.
- [ ] **Step 5: Prove non-vacuity** — remove the default sort model → the failing-first test fails; render all rows without paging → the paging test fails; drop the derived chip → the R5 test fails.
- [ ] **Step 6: `tsc --noEmit`, eslint, isolation suites. Commit.**

---

### Task 2: The traceability matrix at scale

**Files:** modify `frontend/src/Pages/dashboard/sections/TraceabilityMatrixSection.tsx`; tests and a11y alongside.

Replace the `TableContainer` + `rows.map` + nested maps (premise 6) with a DataGrid: one row per requirement, paged client-side at 25/50/100, sortable, filterable.

The nested lists are the harder half. A requirement's test cases and defects cannot each be a nested table inside a cell at this scale. Render a compact summary in the cell — counts plus the worst status, e.g. *"4 cases · 1 failing"* — and put the detail behind a per-row expansion or a detail panel. Decide which, and say why in the report.

Default sort per R2: `executedFailing` first, then `notFullyVerified`, then `noTestsLinked`, then `executedPassing`. A reader opening the matrix should land on what is broken, then what is unverified, then what is untested — passing rows last, because they need nothing.

**R4 is the trap in this task.** The CSV export currently builds from the full `rows` array. Keep it that way. Do not switch to DataGrid's built-in export, and do not let the export read the paged/filtered view.

- [ ] **Step 1: Write the failing tests** — 60 requirements render one page and the total is stated; a failing row sorts above a passing one by default; the per-cell summary states counts and the worst status rather than listing every case; the detail affordance reveals the full case and defect lists; **the CSV contains all 60 rows while the grid shows 25** (R4 — write this one first, it is the one that matters); the `testCount` column is still a plain count with no score or threshold colouring (F13's R4); an empty project reads honestly (R6).
- [ ] **Step 2: Run to verify failure.** — [ ] **Step 3: Implement.** — [ ] **Step 4: a11y suite with a mount guard.**
- [ ] **Step 5: Prove non-vacuity** — point the export at the paged rows → the all-rows export test fails; remove the default sort → the failing-first test fails; restore both and confirm byte-identical.
- [ ] **Step 6: `tsc --noEmit`, eslint, isolation suites. Commit.**

---

### Task 3: Browser proof, and close it

**Files:** modify or extend `frontend/e2e/specs/traceability-matrix.spec.ts`; create a lens density spec or extend `release-derived-membership.spec.ts`; update `PRODUCT_GAP_REGISTER.md` and the programme doc.

Prove in a real browser what jsdom cannot: that a large set renders as a page rather than a wall, that the grid scrolls inside its own container with the page body not scrolling sideways, and that the CSV downloaded from a paged grid contains **every** row.

Use enough fixtures to cross a page boundary — 30 is enough to prove paging at a 25 page size without making the spec slow. Follow `release-wiring.spec.ts` for structure, **but note that spec creates its persona outside the `try`, which its own header wrongly claims otherwise** (recorded during WP-F13). Create yours inside.

- [ ] **Step 1: Write it.** — [ ] **Step 2: Prove non-vacuity** — remove paging and confirm the page-boundary assertion fails. — [ ] **Step 3: Run it.** — [ ] **Step 4: Sweep** every fixture and Keycloak persona; report counts before and after. — [ ] **Step 5: Register entry** recording R1-R6, and **record as an explicit follow-up** the lens's uncached full payload per read (premise 7) — what it costs at 300 cases, and that R3 deliberately left it. — [ ] **Step 6: Commit.**

---

## Self-review

**Spec coverage.** The owner reported the Lens. The matrix has the same defect in a worse form and shipped hours earlier, so it is in scope — leaving it would mean fixing the reported symptom and knowingly leaving its twin.

**The risk I am most wary of.** R4. Paginating a table and exporting a table are two code paths that look the same from the outside, and the failure is silent: an audit CSV with 25 of 300 rows looks exactly like an audit CSV. The test for it is specified first in Task 2 for that reason.

**The second risk.** R2 being implemented as "a sortable column" rather than "sorted correctly on arrival". Sortable is table stakes; landing on the failures is the actual deliverable.

**What this does not fix.** The lens recomputes and ships every linked and derived member on every tab open (premise 7). Paging the render does not touch that. It is recorded as a follow-up rather than silently absorbed.
