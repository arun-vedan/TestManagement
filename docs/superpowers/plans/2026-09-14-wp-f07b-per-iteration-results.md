# WP-F07b — Per-iteration execution results

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A run of a parameterised test case produces **one result row per data row** — "ran 5 roles, 4 passed, 1 failed" — instead of collapsing to a single ambiguous row.

**Why this is its own package:** it changes how a test run *addresses* a case, and test runs are records of things that already happened. F07a deliberately left it out so the authoring model could land without that risk.

**Architecture:** `ExecutionTestCaseSchema` gains `iterationIndex` (and the dataset values that produced it). A case is addressed by `TestCaseId` **plus** `iterationIndex` everywhere — six backend sites, the frontend's list key and selection, and defect raising. Enrichment expands a bound case into N rows at run time, snapshotting substituted text per row. Existing documents have no `iterationIndex`; absent is treated as `0` and backfilled, which is safe because **no existing run has two rows sharing a `TestCaseId`** (verified).

**Tech Stack:** Node 18 / Express / **Mongoose 5.13.23** (`^5.7.1` in package.json — verified at runtime; 5.x and 7.x differ on update-validator semantics, which produced F07a's only Critical). React 18 / TypeScript / MUI v5 / react-query. Jest + supertest, Playwright.

**Spec:** `docs/superpowers/plans/2026-09-05-functional-gaps-program.md` (F07b row), `docs/superpowers/PRODUCT_GAP_REGISTER.md`.

## Global Constraints

- **No new runtime dependencies.**
- Routes keep `keycloak.protect(), requireProjectScope(), authorize(<action>)` in that order.
- `projectId` always from `req.projectScope`, never the body. Every query filtered by it.
- **`ExecutionTestCaseSchema` and `ExecutionTestStepSchema` are STRICT.** An undeclared field is silently stripped on save — this is how F06 lost `sharedStepTitle` through five reviewed tasks. Declare every new field, and test that it survives a round trip.
- **Containers have NO bind mount.** A host edit does nothing until the image is rebuilt and restarted. Rebuild after every source change or you are testing stale code. Say in your report that you did.
- Tests non-vacuous: name the single-line break for each, and perform the probes the tasks ask for.
- No test may mutate or delete seeded data. Clean up on every path. **Delete order: test cases before the datasets/shared steps they reference.**
- Mongo ONLY via `docker exec mongodb mongosh`. NEVER a host `mongosh`, NEVER the MCP mongodb tools. **The execution database is `srckube-testexecution`** — not `srckube-testplanexecution`, which does not exist and silently returns 0 for every query. That mistake was made while writing this plan and nearly became a premise.
- **Keycloak's data is in POSTGRES**, not Mongo. A user sweep uses the Admin API. Deleting `user_entity` rows directly fails on a foreign key from `user_role_mapping`, and forcing past it leaves the realm inconsistent.
- No line-number cites in comments — several have gone stale here. Cite symbols.
- No comment asserting a file exists or does not exist.
- Frontend commands from `/Users/arunganesha/srckubetest/frontend`, never `frontend/src`. The jsdom suite is unmeasurable under load and a full run times out: isolation runs only.

## Verified premises

Checked against the code and the live database before this plan was written.

1. **Six backend sites address a case within an execution by `TestCaseId` alone** — all in `testPlanExecutionService/controllers/testexecution.js`: three Mongo queries on `'TestCases.TestCaseId'` and three `execution.TestCases.find((tc) => tc.TestCaseId === tcid)`. `.find()` returns the first match, so N iterations would all answer to the same name and every status update would land on iteration 0.
2. **No positional `$` updates into `TestCases`** anywhere in the service — grepped. Every write is fetch-modify-save through the schema, which makes an additive field safe.
3. **The frontend addresses a case the same way**: `key={tc.TestCaseId}`, `selected={tc.TestCaseId === selectedTcId}`, and defect raising uses `selectedTc.TestCaseId` (`TestRunDetail.tsx`).
4. **CI ingestion also binds results by `TestCaseId`** — `adapters/normalize.js` builds the `TestCases[]` id a result is stored under. Iterations must not silently break CI binding; decide and state what a CI result without an iteration means (see R4).
5. **`reportingService` reads `TestCases` in three services, but only TWO of them count rows.** Corrected by an independent plan audit after this plan first claimed all three counted per entry — the sixth premise of mine in this programme to be wrong, and the first caught *before* anyone built on it.
   - `planProgress.js` and `passRateTrend.js` DO count one row per entry (`bucket.total += 1` per case). Iterations will multiply their totals.
   - `workload.js` does **not** count rows at all. It uses `TestCases` only inside `isCompletedExecution`, as `cases.every(tc => pass|fail)`, to decide whether a whole *execution* is finished; it counts executions per assignee. Iterations change its meaning subtly but defensibly — a run becomes "completed" only when every iteration has reached a terminal state — and that is arguably more correct, not less.
   The three services therefore have **different** behaviours, and Task 3 must establish each one's separately rather than treating them as a set.
6. **Live data, measured in `srckube-testexecution`: 14 executions, 14 case rows, max 3 per run, and ZERO runs with two rows sharing a `TestCaseId`.** The uniqueness assumption holds in real data today, so an additive `iterationIndex` defaulting to 0 is a clean, reversible migration.
7. **Runtime Mongoose is 5.13.23.**

## Rulings

- **R1 — `iterationIndex` is additive; absent means 0.** Existing rows are backfilled to 0, and reads treat a missing value as 0 so a partially-migrated database behaves correctly. *Cost if wrong:* none identified; premise 6 shows no collisions to resolve.
- **R2 — a run snapshots substituted text per iteration.** Each row stores the resolved step text for its data row, exactly as execution already snapshots steps today. This is what keeps a finished run honest when the dataset is later edited. *Cost if wrong:* editing a dataset would retroactively rewrite history.
- **R3 — reporting counts iterations INDIVIDUALLY, in the two services that count rows at all.** A data row that failed is a failure; five roles tested is five results. This applies to `planProgress` and `passRateTrend`; `workload` counts executions, not rows, and is left alone (see premise 5). **This changes the meaning of existing dashboards**: a project that parameterises heavily will see its totals rise relative to before, without anything having got worse. That is a real reporting change and must be stated in the register and surfaced in the UI where the numbers appear, not discovered by a manager wondering why the count moved. *Cost if wrong:* the alternative (collapse iterations to one weighted result per case) keeps old numbers comparable but hides which data rows fail, defeating the feature.
- **R4 — a CI result with no iteration binds to iteration 0.** CI runners do not know about datasets. Binding to 0 keeps existing ingestion working unchanged; a runner that wants per-iteration results can supply one later. *Cost if wrong:* CI results on a parameterised case under-report; stated plainly rather than silently.
- **R5 — defects raised from a run carry the iteration and its data values.** "TC-9 failed" is not actionable when only the `viewer` row failed. *Cost if wrong:* triage loses the one fact that makes a data-driven failure reproducible.

---

### Task 1: Iteration identity on the execution model, and the six addressing sites

**Files:** modify `backend/testPlanExecutionService/models/TestExecution.js`, `controllers/testexecution.js`; create `backend/testPlanExecutionService/scripts/backfill-iteration-index.js`; test `__tests__/iterationAddressing.test.js`.

**Produces:** `ExecutionTestCaseSchema.iterationIndex: { type: Number, default: 0 }` and `iterationValues: { type: Map, of: String }` (the data row that produced this iteration, for display and defect context). All six sites address by `TestCaseId` + `iterationIndex`.

- [ ] **Step 1: Write the failing tests.** Two rows with the same `TestCaseId` and different `iterationIndex` are independently addressable: updating iteration 1's status leaves iteration 0 untouched (this is the test the whole package exists for — it fails today because `.find()` returns the first match). A request with no iteration resolves to 0. A legitimate `iterationIndex: 0` is NOT swallowed by a falsy check — that is the classic bug in this exact change. Existing single-row documents keep working unchanged.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Declare the fields.** Both schemas are strict; an undeclared field is silently dropped. Add a round-trip test proving `iterationIndex` and `iterationValues` survive a save-and-read.
- [ ] **Step 4: Change the six sites.** Three Mongo queries gain the iteration in the match; three `.find()` calls compare both. Keep a single helper so the six cannot drift apart.
- [ ] **Step 5: Backfill script.** Stamp `iterationIndex: 0` on every existing case row. Follow this repo's existing backfill conventions, and note that **every backfill script here documents host invocation while the only correct path is `docker exec`** — do not repeat that. Report before/after counts against `srckube-testexecution`.
- [ ] **Step 6: Rebuild the container, run the suite.**
- [ ] **Step 7: Prove non-vacuity.** Revert one `.find()` to compare `TestCaseId` only → the independent-addressing test must fail. Change `?? 0` to `|| 0` on a falsy path → the iteration-0 test must fail. Restore each.
- [ ] **Step 8: Commit.**

---

### Task 2: Enrichment expands a bound case into N iterations

**Files:** modify `controllers/testexecution.js` (the enrichment path); test `__tests__/iterationEnrichment.test.js`.

- [ ] **Step 1: Write the failing tests.** Opening a case bound to a 3-row dataset creates 3 rows, `iterationIndex` 0/1/2, each carrying that row's substituted step text and its `iterationValues`. A case with NO dataset creates exactly one row, `iterationIndex 0` — unchanged behaviour, and the regression guard for every existing run. Editing the dataset afterwards does NOT change the stored rows (R2). A dataset with zero rows behaves like an unbound case rather than creating nothing.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Fetch the case with `?expand=steps&substitute=<i>` per iteration — F07a's parameters, unchanged. Note `substitute` requires a canonical non-negative integer and rejects an empty value with 400.
- [ ] **Step 4: Rebuild, run all three service suites** (`testPlanExecutionService`, `testRepoService`, `aiService` — the last with `--runInBand`; its parallel run is recorded as unmeasurable).
- [ ] **Step 5: Prove non-vacuity.** Make enrichment ignore `datasetId` → the 3-row test fails. Make it expand unbound cases → the one-row regression guard fails.
- [ ] **Step 6: Commit.**

---

### Task 3: Reporting counts iterations, and says so

**Files:** modify `backend/reportingService/services/{planProgress,workload,passRateTrend}.js`; frontend surface where these numbers render; tests beside each.

**This task implements R3 and its disclosure.** The plan originally said "each service already counts one row per entry, so the code change may be nil". That was WRONG and an audit caught it: the three services behave differently (premise 5). Establish each one's actual behaviour first, and expect a different answer per file:
- `planProgress.js` / `passRateTrend.js` count per row — they will likely need no change, but prove it with a test rather than assuming.
- `workload.js` counts EXECUTIONS via `isCompletedExecution`'s `cases.every(...)`. Do not "fix" it to count rows: a tester's workload is runs assigned, not data rows. Decide deliberately whether "completed" should require every iteration to be terminal (the current behaviour, which seems right) and write a test pinning whichever you choose.
**Do not manufacture a change in any file that turns out to be correct already** — but equally, do not assume all three are correct because two of them are.

- [ ] **Step 1: Write tests** proving a 3-iteration case with 2 passes reports 3 executed / 2 passed in `planProgress` and `passRateTrend`. For `workload`, write a different test: that a run with 3 iterations counts as ONE assigned execution, and is "completed" only once all three are terminal.
- [ ] **Step 2: Run; implement only what actually fails.**
- [ ] **Step 3: Disclose the change in the product.** Where these figures render, a parameterised run's totals now count data rows. Add a short, plain note at the point the numbers appear — not a release note, which is read by the wrong people. One line, non-apologetic, saying counts include one result per data row.
- [ ] **Step 4: Commit.**

---

### Task 4: The run view addresses iterations

**Files:** modify `frontend/src/workbench/detail/modules/TestRunDetail.tsx`; tests beside it.

- [ ] **Step 1: Write the failing tests.** Three iterations of one case render as three distinct rows (React key collision is the failure mode — assert three list items, not one). Selecting iteration 2 shows iteration 2's steps and status. Raising a defect from iteration 2 carries the iteration and its data values into the summary/description (R5). A run with no parameterised cases renders exactly as before.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.** Key and selection become `TestCaseId` + `iterationIndex`. Label each row with its data values, not a bare index — "TC-9 · role=admin" is usable; "TC-9 (2)" is not.
- [ ] **Step 4: Run isolation suites, eslint, `tsc --noEmit`.**
- [ ] **Step 5: Prove non-vacuity.** Revert the key to `TestCaseId` alone → the three-rows test must fail.
- [ ] **Step 6: Commit.**

---

### Task 5: Browser journey, and close F07b

**Files:** create `frontend/e2e/specs/per-iteration-results.spec.ts`; update `PRODUCT_GAP_REGISTER.md` and the programme roadmap.

Follow `parameterised-cases.spec.ts` for structure — including its fixed setup shape, where the persona, context and API client are created **inside** the `try` so nothing escapes cleanup. The shared `contributor` persona has `write: true, delete: false`; cleanup needs delete rights.

The journey: create a 2-row dataset → author a parameterised case → add it to a plan and start a run → assert the run shows **two** rows for that one case → fail iteration 1, pass iteration 0 → assert each holds its own status after a reload → raise a defect from iteration 1 and assert it names the data values → assert reporting counts 2 executed, 1 passed → clean up.

- [ ] **Step 1: Write it.** — [ ] **Step 2: Prove non-vacuity** by reverting the frontend key to `TestCaseId` alone; the journey must fail. Restore and report both. — [ ] **Step 3: Run it.** — [ ] **Step 4: Sweep** `srckube-testexecution`, `srckube-testrepo` and Keycloak (Admin API) for leaks; report counts. — [ ] **Step 5: Register entry** recording R1-R5 and their evidence, **that R3 changes the meaning of existing dashboards**, what reviews caught that the tests missed, and that F07 is now complete. — [ ] **Step 6: Commit.**

---

## Self-review

**Spec coverage.** F07b's row asks for one result row per data row and names the addressing change as the blocker. Task 1 makes rows addressable, Task 2 creates them, Task 3 makes them count, Task 4 makes them usable, Task 5 proves the chain. F07a's caveat alert should be removed by Task 4 or 5 — whichever lands the UI that makes it false; state which.

**The risk I am most wary of.** Premise 6 says no existing run has duplicate `TestCaseId`s, so the migration is clean *in this database*. A production database could differ. The backfill must therefore be idempotent and must report, not assume, what it found — and Task 1 Step 5 asks for before/after counts for exactly that reason.

**Type consistency.** `iterationIndex` is a `Number` everywhere, defaulting to 0, and "absent" and "0" are the same thing by R1. `iterationValues` is a Map of column name to string value, matching `Dataset.columns` / `Dataset.rows` which are `[String]` and `[[String]]`.
