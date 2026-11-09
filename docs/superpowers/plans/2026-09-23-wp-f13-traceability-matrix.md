# WP-F13 — Traceability matrix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One view that answers, per requirement: which test cases cover it, whether they have been run, whether they passed, and which defects are attached — with a CSV export, and a summary that reconciles with the rows rather than contradicting them.

**Architecture:** One backend computation feeding both the matrix rows and the summary, so they cannot disagree. Read-time traversal over the existing link graph and execution records — no new entity, no link rows written. The execution dimension is read from `TestExecution.TestCases[].TestStatus` **regardless of a run's `source`**, so automated results appear without a shape change when they arrive.

**Tech Stack:** Node 18 / Express / Mongoose 5.13.23, React 18 / TypeScript / MUI v5 / react-query, Jest + supertest, Playwright.

**Spec:** `docs/superpowers/plans/2026-09-05-functional-gaps-program.md` row F13, as amended by the 2026-09-23 register entry deferring F11, plus the owner's decisions recorded in that conversation: four deterministic segments first, CSV export in v1, adequacy explicitly deferred to F22.

> **Correction (final fix round, 2026-09-24):** this plan originally deferred test adequacy to **F19**. F19 was already taken by an unrelated, unplanned gap in `functional-gaps-program.md` (the workbench-nav fix), a collision discovered during WP-F13's final fix round. Every "F19" reference in this plan is now **F22**, the identifier the adequacy gap was renumbered to.

## Global Constraints

- **No new runtime dependencies. No new entity. No link rows written.**
- Routes keep `keycloak.protect(), requireProjectScope(), authorize('read')`; `projectId` always from `req.projectScope`.
- **Containers have NO bind mount**; the compose file is `backend/docker-compose.yml`, **not** the repo root. Rebuild after every source change — and re-run any host-side suite *after* the rebuild, never before. A host-side run against a stale container proves nothing; that exact mistake produced an inaccurate report in WP-F15b.
- Mongo ONLY via `docker exec mongodb mongosh ...`. NEVER a host-side client — a stray `mongod` squats on `127.0.0.1:27017`. Find database names by listing them; never guess.
- **Keycloak data is in POSTGRES**, not Mongo — persona sweeps go through the Admin API.
- Do not mutate seeded data. Report counts before and after; clean up every fixture on every path.
- Tests non-vacuous: name the single-line break for each, perform the probes, and **verify each probe's edit landed before trusting the run**.
- Frontend commands from `/Users/arunganesha/srckubetest/frontend`, never `frontend/src`. **CRACO**, not plain react-scripts. Isolation runs only.
- No line-number cites in comments. No comment asserting a file exists or does not exist.

## Verified premises

1. **`coverage.js` reports 0% for every project, always — and it is wrong.** It defines "tested" as a link with `linkType: 'tests'` and `srcModule: 2`. Live census: **23 of 23 link rows are `relates-to`; zero are `tests`.** The cached project-1 payload reads `tested: 0, untested: 5` while `Req-1→TC-1`, `Req-2→TC-2` and `newReq51→TC-1` all plainly exist. The workbench link affordances (`ReleaseDetail`, `DefectDetail`, `TestRunDetail`) hardcode `relates-to`, so the primary UI cannot produce a link that would count.
2. **Live module-pair census** (`srcModule → destinationModule` : rows): `1→1`:4, `5→1`:3, `2→5`:3, `2→1`:3, `1→2`:3, `5→2`:3, `1→5`:2, `6→2`:1, `2→6`:1. Note **defects link to BOTH requirements and test cases** — an earlier register claim that they reach a release only via requirements was wrong.
3. **Bidirectionality is a client-side double write**, not a backend `$or`. Most links are mirrored pairs; at least one is one-way. Any traversal must query both directions itself.
4. **`linkIssueService` keys on HUMAN ids** (`TC-1`, `Req-1`, `Bug-1`) and carries no project scoping of its own. Scoping comes from intersecting against the project-scoped entity lists.
5. **Execution status vocabulary is `Pass` | `Fail` | `No Run`** (`adapters/normalize.js`), stored per case per run at `TestExecution.TestCases[].TestStatus`. 14 executions live.
6. **`requirement.parentId` exists and is in use** — 4 of 5 project-1 requirements have a parent. F13 does **not** use it; F22 will.
7. **`ReportCache` has a `reportType` enum and a unique `(projectId, reportType)` index.** A new type must be added to the enum **and** to `postRefresh`'s `reportTypes` list, or it will never refresh.
8. **CSV encoding already exists client-side**: `frontend/src/Components/Export/csvEncode.ts`'s `buildCsv`, hand-rolled, no dependency. `MAX_EXPORT_ROWS` is 5000. There is **no** backend export endpoint anywhere and adding one is out of scope.
9. **`frontend/src/Pages/reports.tsx`** composes persona sections (e.g. `TestManagerSection`) from `useReportState` hooks.

## Rulings

- **R1 — "tested" means any requirement↔test-case link, either direction, any `linkType`.** Gating on `linkType: 'tests'` makes the figure wrong by construction (premise 1). `'tests'` may be surfaced as a stronger signal, but it cannot be the gate. *Cost if wrong:* a shipped number changes — project 1 goes from 0% to 60% linkage. That is a visible change toward the truth, and the register entry must say so plainly.
- **R2 — four mutually exclusive, exhaustive segments, not one percentage.** A single percentage hides which of the four you are in; each segment is separately actionable, and the four must sum to the total. **Amended during Task 1** after live data showed a `TestStatus` of `InProgress` — outside the `Pass`/`Fail`/`No Run` vocabulary `normalize.js` documents, which is the *CI ingestion* vocabulary, not the whole set the human execution path writes. Evaluate in this precedence over a requirement's linked cases:
  1. no linked cases → **no tests linked**
  2. **any** linked case has a `Fail` → **executed, failing**
  3. **every** linked case has a `Pass` → **executed, all passing**
  4. otherwise → **tests linked, not fully verified**

  The load-bearing part is (3): "all passing" must mean *all*, not "at least one ran and none failed". The original rule classified a requirement with one `Pass` and one `No Run` as all-passing, and `InProgress` as passing too. **An unrecognised status must never be read optimistically as success** — more unknown values will appear, so the rule is safe by default rather than enumerating what has been seen. *Cost if wrong:* a requirement reads as less verified than it is, which is visible and fixable; the reverse is neither.
- **R3 — the matrix and the summary are computed by ONE function.** Not two that agree today. A matrix that contradicts a tile on the same dashboard is worse than either problem alone, and reconciliation-by-convention decays. *Cost if wrong:* one function is harder to cache in two shapes; take that cost.
- **R4 — the test-count column is an indicator, never a score.** Render it as a count. No percentage, no grade, no colour scale implying a threshold. Adequacy is explicitly NOT measured here (F22) and this column must not be mistaken for it.
- **R5 — the automation seam is "do nothing special".** Read `TestExecution.TestCases[].TestStatus` regardless of the run's `source`. Do **not** add a `source` filter that a later work package must remove, and do **not** add an empty "automated" column that renders a lie until F11 lands. When automated results are bound, they become rows in the same execution records and appear with no shape change. Say this in a comment so a later author does not "add CI support" by special-casing it.
- **R6 — every figure keeps its denominator.** Standing rule in this service. A requirement with no linked cases reads as "no tests linked", never as 0% passing.
- **R7 — do not traverse case↔case (`1↔1`) edges.** Four exist live. A test case related to another test case is not a requirement being covered; following that edge would inflate coverage through an unrelated relationship.

---

### Task 1: The coverage definition, corrected, with four segments

**Files:** modify `backend/reportingService/services/coverage.js`; tests in that service.

Fix R1's defect and add R2's segmentation. `computeCoverage` must classify every requirement in the project into exactly one of the four segments, and return both the segment counts and the linkage headline, with denominators (R6).

Follow both link directions (premise 3) and reject `1↔1` edges (R7). Scope by intersecting against the project-scoped requirement and test-case lists (premise 4).

The execution dimension: a linked case counts as *executed* if it appears in any `TestExecution.TestCases[]` with a `TestStatus` other than `No Run`; *failing* if any such entry is `Fail`. Read every execution regardless of `source` (R5).

- [ ] **Step 1: Write the failing tests** — a requirement linked to a case via a `relates-to` link counts as tested (this is premise 1's bug, and the test that would have caught it); a requirement linked only through a reverse-direction row still counts; a requirement linked to another *test case* via `1↔1` does **not** count; the four segments are mutually exclusive and sum to the total; a requirement whose linked case has run entries all `No Run` lands in "not executed", not "passing"; a requirement with one passing and one failing case lands in "failing"; a project with zero requirements reports zeros **and says so**, not 100%.
- [ ] **Step 2: Run to verify failure.** — [ ] **Step 3: Implement.** — [ ] **Step 4: Rebuild the container, then run the service suite.**
- [ ] **Step 5: Prove non-vacuity** — restore the `linkType: 'tests'` filter → the `relates-to` test fails; drop the reverse-direction check → that test fails; allow `1↔1` edges → the R7 test fails.
- [ ] **Step 6: Check every consumer of the `coverage` payload** before changing its shape — the dashboard reads it, and `handVerifiedFigures.test.js` asserts live figures. Update what must change; do not weaken an assertion to accommodate a new key.
- [ ] **Step 7: Commit.**

---

### Task 2: The matrix rows

**Files:** create `backend/reportingService/services/traceability.js`; modify `models/ReportCache.js`, `controllers/reports.js`, `routes/reports.js`; tests.

One row per requirement: its id and summary, its linked test cases (each with its latest execution status), its linked defects (premise 2 — **both** the `5↔2` requirement edge and the `5↔1` edge through its cases), its test count (R4), and its segment (R2).

**R3 is the point of this task:** the segment on each row and the summary counts from Task 1 must come from **one** computation. Export the classification from `coverage.js` and use it here, or move it somewhere both import — either is fine, two copies is not.

Add `traceability` to the `ReportCache` enum, wire `getTraceability` through `getOrCompute`, mount the route with the same guards as every sibling, and add it to `postRefresh`'s list (premise 7 — omitting that is a silent staleness bug).

- [ ] **Step 1: Write the failing tests** — a requirement with 2 linked cases, one passed and one never run, produces one row with both cases, their distinct statuses, testCount 2, and the "failing"/"not executed" segment as R2 defines it; defects reach a row through both edges and are not double-counted when both exist; a link to a deleted case does not produce a row entry; a requirement in another project is absent; the row segments and the Task 1 summary counts agree for the same fixture **in the same test** (this is R3's guard — write it as one assertion over both outputs).
- [ ] **Step 2: Run to verify failure.** — [ ] **Step 3: Implement.** — [ ] **Step 4: Rebuild, then run the suite.**
- [ ] **Step 5: Prove non-vacuity** — make the row classifier disagree with the summary classifier → the R3 guard fails; drop the `5↔1` defect edge → that test fails; omit `traceability` from `postRefresh` → assert that omission is caught, or say plainly why it cannot be and what covers it instead.
- [ ] **Step 6: Commit.**

---

### Task 3: The matrix on screen, with CSV export

**Files:** modify `frontend/src/api/reportApi.ts`, `frontend/src/Pages/reports.tsx` (+ the persona section that hosts it); create the matrix component and its tests.

Render the rows as a table: requirement, test count, cases with per-case status, defects, segment. Wide content scrolls in its own container. Above it, the four segments as a summary that reads as four facts, not one score.

CSV export via `buildCsv` from `Components/Export/csvEncode.ts` (premise 8) — client-side, no new dependency, no backend endpoint. Respect `MAX_EXPORT_ROWS` and say so when truncating rather than silently cutting.

R4: the test-count column is a count. No percentage, no grade, no threshold colouring.

- [ ] **Step 1: Write the failing tests** — the four segments render as four labelled facts with their denominator; a requirement with no linked cases renders as "no tests linked", not as 0% passing (R6); per-case status renders per case, not aggregated away; the export produces a row per requirement with the same counts the table shows; a project with no requirements renders an honest empty state.
- [ ] **Step 2: Run to verify failure.** — [ ] **Step 3: Implement.** — [ ] **Step 4: a11y suite with a non-vacuity guard** asserting the table genuinely mounts.
- [ ] **Step 5: Prove non-vacuity** — render the segment counts from a hardcoded object instead of the payload → the segment tests fail; drop the per-case status → that test fails.
- [ ] **Step 6: Run isolation suites, eslint, `tsc --noEmit`. Commit.**

---

### Task 4: Browser journey, and close it

**Files:** create `frontend/e2e/specs/traceability-matrix.spec.ts`; update `PRODUCT_GAP_REGISTER.md` and the programme doc.

Journey: create a requirement and two test cases → link both to the requirement → run one of them to a pass, leave the other unrun → open the matrix → **see one row, 2 cases, one passed and one not run, test count 2, segment "not fully executed"** → export CSV and assert the downloaded content matches the row → clean up.

Follow `release-wiring.spec.ts` for structure, including its setup shape (persona, context and API client created **inside** the `try`). Note the download assertion needs Playwright's download handling, not a DOM check.

- [ ] **Step 1: Write it.** — [ ] **Step 2: Prove non-vacuity** by restoring the `linkType: 'tests'` filter in `coverage.js` and rebuilding; the journey must fail because the requirement reports untested. Restore, rebuild, report both. — [ ] **Step 3: Run it.** — [ ] **Step 4: Sweep** requirements, cases, executions, links and Keycloak users; report counts. — [ ] **Step 5: Register entry** recording R1-R7 and, plainly, that **a shipped number changes**: requirement coverage was 0% for every project and was wrong; project 1 moves to 60% linkage. State the cause (the `linkType: 'tests'` gate against a UI that only writes `relates-to`) so nobody re-introduces it. Note that F22 (adequacy) is the named follow-up and that this matrix deliberately does not measure it. — [ ] **Step 6: Commit.**

---

## Self-review

**Spec coverage.** The owner asked for the numbers available from manual execution now, with automation later and adequacy documented separately. Task 1 fixes the number that was wrong, Task 2 produces the rows, Task 3 puts both on screen with export, Task 4 proves it and records the change. Adequacy is out of scope by decision, documented as F22.

**The risk I am most wary of.** R3. Two computations that agree on the day they ship will drift, and the failure is silent — a tile and a table on the same page quietly disagreeing is exactly the kind of thing users notice before we do. The single-function constraint is worth the caching awkwardness it causes.

**The second risk.** R1 changes a number people may already have screenshotted. It is a change toward the truth, but it must be announced in the register rather than discovered.

**Type consistency.** `linkIssueService` ids (`sourceId`/`destinationId`), `TestExecution.TestCases[].TestCaseId`, `TestPlan.TestCases[].TestCaseId` and `requirement.reqId` are all **human** ids in one key space. `requirement.parentId` and `requirement.id` are Numbers and must not leak into a link query.
