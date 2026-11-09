# WP-F07a — Parameterised test cases (authoring half)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One test case with `{{placeholders}}` and a bound dataset replaces five near-identical copies, and an author can preview any data row without ever altering what is stored.

**Scope, stated plainly:** this is the AUTHORING half only. After it lands, a test run still shows **one row per test case**, not one per data row. Per-iteration pass/fail is WP-F07b, planned separately because it reshapes records of runs that already happened. "F07a done" must not be read as "data-driven testing done" — see the owner-facing note at the end.

**Architecture:** A `Dataset` collection in `testRepoService`, shaped like `SharedStep` (same service, same tenant scoping, same delete-guard contract). A test case binds one dataset via `datasetId`. Step text carries `{{name}}` placeholders. Substitution is a **separate** opt-in read parameter, never folded into `?expand=steps`, never persisted, and never shown in an editable field.

**Tech Stack:** Node 18 / Express / **Mongoose 5.13.23** (`^5.7.1` in `package.json`; verified at runtime inside the container, *not* Mongoose 7 as an earlier draft of this plan wrongly stated — 5.x and 7.x differ precisely on update-validator semantics, which is exactly where this package's first Critical was found), React 18 / TypeScript / MUI v5 / react-query, Jest + supertest, Playwright. CRA via CRACO.

**Spec:** `docs/superpowers/plans/2026-09-05-functional-gaps-program.md` (F07 row), `docs/superpowers/PRODUCT_GAP_REGISTER.md`.

## Global Constraints

- **No new runtime dependencies.** Placeholder substitution is a regex over strings; do not add a template engine.
- Every new protected route is mounted `keycloak.protect(), requireProjectScope(), authorize(<action>)` in that order — reads `'read'`, writes `'write'`, deletes `'delete'`. Copy `backend/testRepoService/routes/sharedStep.js`. Deviating is a tenant-isolation or RBAC hole.
- `projectId` is **always** stamped server-side from `req.projectScope.projectId` and **always** deleted from an incoming update body.
- Every query against `Dataset` is filtered by `projectId`.
- **`backend/testRepoService`'s container has NO bind mount.** A host edit does nothing until the image is rebuilt and restarted. If you edit backend source, rebuild — and say so in your report.
- Tests must be non-vacuous. For every test, name the single-line production change that makes it fail, and state it in your report. Perform the probes the tasks ask for; do not assert them.
- No test may mutate or delete seeded data. Fixtures cleaned up on **every** path including throws. **Delete order: test cases before the datasets they reference** — the reverse trips the delete guard and leaks a document every run. This bit WP-F06 three times.
- All Mongo inspection goes through `docker exec mongodb mongosh`. NEVER a host `mongosh`, NEVER the MCP mongodb tools — both hit a stale look-alike DB on `127.0.0.1:27017`. Confirmed four times in this project.
- Frontend commands run from `/Users/arunganesha/srckubetest/frontend`, never `frontend/src`.
- The jsdom suite is **not reliably measurable under load** (0-13 failures per run, different sets). Trust only isolation runs and before/after comparisons. A full-suite run times out — do not attempt one.
- **No line-number cites in comments.** Four have gone stale in this project, one within the same day. Cite the symbol.
- **No comment asserting a file exists or does not exist.** That has gone wrong here twice, in opposite directions.

## Verified premises

Checked against the code and the live database before this plan was written. An implementer who finds one false must stop and report.

1. **No parameterisation concept exists.** A grep for `dataset|data-driven|parameteris|iteration` across all `.js`/`.ts`/`.tsx` outside `node_modules` returns only unrelated hits (`req.params`, `useParams`, "parameterised component").
2. **`{{ }}` does not collide with real content.** Live query across **167 test cases and 0 shared steps**: zero step texts contain `{{`. The syntax is free.
3. **Exactly two consumers pass `?expand=steps`** — execution enrichment (`testPlanExecutionService/controllers/testexecution.js`) and `aiService/controllers/ai.js`. **Neither may ever receive substituted text.** An execution that snapshotted row 0's values would silently record the wrong thing as history; an AI exemplar of substituted text teaches the model the wrong pattern. This is the whole reason substitution is a separate parameter (R2).
4. **`expandSteps(docs, projectId)` returns flat rows and is the natural place to hook a second pass**, but it must remain callable without substitution.
5. **The delete-guard + usage-query pattern is proven.** `SharedStep`'s model, controller, router and tests are the template to copy; they passed independent review.
6. **A run addresses a case by `TestCaseId` alone** — 6 backend sites plus the frontend's list key and defect-raising. This is what blocks per-iteration results and is why F07b exists. **F07a must not touch any of it.**

## Rulings

- **R1 — `Dataset` is its own collection, not a field on the test case.** A dataset is reusable across cases (the same user matrix drives many logins) and needs its own usage query. Mirrors `SharedStep`. *Cost if wrong:* an embedded dataset would have been simpler for one-off cases; those can still bind a dataset used once.
- **R2 — substitution is a SEPARATE opt-in parameter, never folded into `?expand=steps`.** Premise 3 is the reason: both existing expand consumers must keep seeing authored text. *Cost if wrong:* one extra parameter at one call site.
- **R3 — substitution is NEVER persisted, and never appears in an editable field.** The editor shows the authored text as editable and the substituted text as a read-only preview beside it. This is WP-F06's read-modify-write flattening trap wearing a new costume: if a substituted value ever reaches a PUT, the placeholder is destroyed and the case silently stops being parameterised. *Cost if wrong:* none — this is the safe direction.
- **R4 — expansion happens BEFORE substitution.** A shared step's text may itself contain placeholders, and they must resolve against the binding case's dataset. *Cost if wrong:* shared steps could not be parameterised, which is most of their value in a login preamble.
- **R5 — an unresolved placeholder is left visible as `{{name}}`, never blanked.** A blank reads as authored-empty and hides the error; a visible placeholder describes its own problem. *Cost if wrong:* a preview looks untidy when a column is missing, which is the point.
- **R6 — F07a leaves execution behaviour byte-identical.** No file under `testPlanExecutionService` is touched. A reviewer should verify this with `git diff --stat`.

---

### Task 1: `Dataset` model, CRUD, usage, and delete guard

**Files:**
- Create: `backend/testRepoService/models/Dataset.js`
- Create: `backend/testRepoService/controllers/dataset.js`
- Create: `backend/testRepoService/routes/dataset.js`
- Modify: `backend/testRepoService/server.js` (mount beside the `sharedstep` router)
- Modify: `srckube-kong/kong.yml` (**a git submodule** — commit there, then the pointer)
- Test: `backend/testRepoService/__tests__/dataset.test.js`

**Interfaces produced:**
- `Dataset`: `{ id: Number, DatasetId: String ("DS-<n>"), projectId: Number, title: String, description: String, columns: [String], rows: [[String]], createdBy, updatedBy, timestamps }`.
- `GET/POST /api/v1/dataset`, `GET/PUT/DELETE /api/v1/dataset/:id`, `GET /api/v1/dataset/:id/usage`.
- Usage: `{ success: true, data: { count, testCases: [{TestCaseId, TestCaseSummary}] } }`. Delete refusal: **409** with the same `data` payload.

**This task is a deliberate near-copy of `SharedStep`.** Read `models/SharedStep.js`, `controllers/sharedStep.js`, `routes/sharedStep.js` and `__tests__/sharedStep.test.js` first and follow them closely — the pattern passed independent review and diverging from it without reason is a finding. Copy the structure; do **not** copy comments that describe shared steps.

- [ ] **Step 1: Write the failing tests**

Mirror `sharedStep.test.js`'s harness (black-box axios against the running container). Cover: create stamps `DS-<n>` and the caller's `projectId`; a body-supplied `projectId` is ignored; another project's dataset is invisible (404 on `/:id`, absent from list); create with no title is 400; **`rows` whose length does not match `columns` is rejected** (400) — an unchecked ragged dataset produces silently-wrong substitution later; usage reports referencing test cases; delete of an in-use dataset is **409** with the usage payload; delete of an unreferenced one succeeds; usage counts only within the caller's project. Plus RBAC: viewer read-only, contributor no delete.

- [ ] **Step 2: Run to verify failure** — `cd /Users/arunganesha/srckubetest/backend/testRepoService && npx jest __tests__/dataset.test.js`. Expected: 404s throughout.

- [ ] **Step 3: Write the model**, following `SharedStep.js`. Same `pre("save")` atomic-counter hook via `getNextSequence(this.constructor.db, 'dataset')`, guarded on `isNew`. Add a schema-level validator rejecting any row whose length differs from `columns.length`.

- [ ] **Step 4: Write the controller**, following `sharedStep.js`. `findUsage` queries `{ projectId, datasetId }` on test cases and is the single source of truth for both the usage route and the delete guard. Log a refused delete (as `sharedStep.js` does) — it is invisible in the audit trail because nothing was deleted.

- [ ] **Step 5: Router + mount**, following `routes/sharedStep.js`, with `/:id/usage` registered **before** `/:id`.

- [ ] **Step 6: Gateway route.** `srckube-kong` is a **git submodule** — commit inside it, then commit the moved pointer in the parent. Add a `datasetRoute` under the existing `testRepoService` service, copying `sharedStepRoute` field for field (including the `jwt` plugin), path `/api/v1/dataset`. Every route in that file has exactly one path; follow it. Then prove routing:
```bash
docker compose restart kong && sleep 5
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8000/api/v1/dataset
```
Expected **401** (routed), not 404. Record the actual code.

- [ ] **Step 7: Run to verify pass** — full `testRepoService` suite.

- [ ] **Step 8: Prove non-vacuity.** Remove `projectId` from `findUsage` → the cross-project test fails. Change the 409 to 200 → the delete-guard test fails. Remove the ragged-row validator → that test fails. Restore each.

- [ ] **Step 9: Commit.**

---

### Task 2: Bind a dataset, and find the placeholders

**Files:**
- Modify: `backend/testRepoService/models/testrepo.js` (add `datasetId` to `TestRepoSchema`)
- Create: `backend/testRepoService/utils/placeholders.js`
- Modify: `backend/testRepoService/controllers/testrepo.js` (binding validation)
- Test: `backend/testRepoService/__tests__/placeholders.test.js`

**Interfaces produced:**
- `TestRepoSchema.datasetId: { type: ObjectId, ref: 'Dataset' }`.
- `extractPlaceholders(steps) -> string[]` — unique `{{name}}` names, in first-appearance order, from both `testStep` and `Expected`.
- `GET /api/v1/testrepo/:id/parameters` → `{ success: true, data: { placeholders: [...], columns: [...], missing: [...], unused: [...] } }`. `missing` = placeholders with no column (the error case); `unused` = columns no placeholder references (a warning, not an error).

- [ ] **Step 1: Write the failing tests.** `extractPlaceholders` finds names in `testStep` and `Expected`; de-duplicates preserving order; tolerates whitespace (`{{ role }}` ≡ `{{role}}`); ignores a lone `{` or an unclosed `{{`; returns `[]` for no placeholders. The `/parameters` route reports `missing` and `unused` correctly, **including placeholders that live inside an expanded shared step** (R4) — that case is the one most likely to be missed.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Write `utils/placeholders.js`.** A single regex, `/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g`. No template engine. Export `extractPlaceholders` and the regex (Task 3 reuses it, and two divergent regexes would be a real bug).

- [ ] **Step 4: Add `datasetId` and the `/parameters` route.** The route expands shared steps first (R4), then extracts. Binding validation: a `datasetId` that does not exist, or belongs to another project, is rejected 400 — never silently stored, because a dangling binding would make every preview empty with no explanation.

- [ ] **Step 5: Run to verify pass** (full suite; backend container rebuilt).

- [ ] **Step 6: Prove non-vacuity.** Make the regex non-global → the de-dup/multi test fails. Skip expansion in `/parameters` → the shared-step placeholder test fails. Drop the cross-project binding check → that test fails.

- [ ] **Step 7: Commit.**

---

### Task 3: Substitution, opt-in and never persisted

**Files:**
- Modify: `backend/testRepoService/utils/expandSteps.js` **or** create `backend/testRepoService/utils/substituteSteps.js` — implementer's call, stated in the report
- Modify: `backend/testRepoService/controllers/testrepo.js` (`getTestCase`, `getTestCases`)
- Test: `backend/testRepoService/__tests__/substituteSteps.test.js`

**Interfaces produced:** `?substitute=<rowIndex>` on both read routes. Requires the case to have a `datasetId`; applied **after** expansion (R4). Response rows gain `substituted: true` and keep the authored text under `authoredTestStep` / `authoredExpected` so a client can show both without a second request.

- [ ] **Step 1: Write the failing tests.** A read with no `substitute` returns authored text with placeholders intact — **the regression guard for R3**. `?substitute=0` substitutes row 0. `?substitute=1` substitutes row 1. An out-of-range index is 400, not a silent empty substitution. A case with no `datasetId` and `?substitute=0` is 400. **An unmatched placeholder is left as `{{name}}`** (R5). Placeholders inside an expanded shared step substitute correctly (R4). And explicitly: **`?expand=steps` alone never substitutes** (R2, premise 3) — this protects executions and AI.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement**, reusing Task 2's exported regex. Substitution is a pure string pass over already-expanded rows. It must not mutate stored documents — the read path already deep-clones before expanding; keep that.

- [ ] **Step 4: Run to verify pass** (full suite; rebuild the container).

- [ ] **Step 5: Prove non-vacuity — three probes, all required.** Make substitution unconditional (ignore the `substitute` param) → **both** the authored-text guard and the `expand`-alone guard must fail. Blank an unmatched placeholder instead of leaving it → the R5 test fails. Substitute before expanding → the shared-step test fails.

- [ ] **Step 6: Prove R6 — no execution change.** `git diff --stat <task-1-base> HEAD -- backend/testPlanExecutionService` must be **empty**. Paste the output in the report.

- [ ] **Step 7: Commit.**

---

### Task 4: Frontend — manage datasets, bind one, preview a row

**Files:**
- Create: `frontend/src/api/datasetApi.ts`
- Create: `frontend/src/Components/datasets/DatasetManagerDialog.tsx`
- Create: `frontend/src/Components/datasets/DatasetBindControl.tsx`
- Modify: `frontend/src/workbench/detail/modules/TestCaseDetail.tsx`
- Modify: `frontend/src/Components/Tabs/TableRows.tsx` (preview column)
- Tests beside each, plus a11y suites for the dialog

**Follow the proven pattern:** read `frontend/src/api/sharedStepApi.ts` and `frontend/src/Components/sharedSteps/SharedStepManagerDialog.tsx` first. Use `axiosPrivate` with the full `/api/v1/dataset` path — **there is no `serviceApi()` helper in `frontend/src`**; that is a Playwright-only helper, and a previous plan of mine wrongly claimed otherwise. `axiosPrivate` adds `X-Project-Id` automatically.

**R3 is the whole task.** The authored text stays the editable field. The substituted text renders as a **read-only preview**, visually distinct, and must never be written back. The test that matters: with a preview row selected, edit an unrelated step and assert the PUT payload contains the **authored** text with `{{placeholders}}` intact.

- [ ] **Step 1: Write the failing tests.** Preview off by default. Selecting a row shows substituted text as read-only. **Editing any step while a preview is active PUTs authored text, never substituted** (the R3 guard). A `missing` placeholder is surfaced to the author, not swallowed. Delete returns 409 → the dialog renders `data.testCases` (same contract as shared steps). Permission gating: bind/create/edit need `can('write')`, delete needs `can('delete')`; a contributor has write but **not** delete.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Build**, following `SharedStepManagerDialog.tsx`'s react-query conventions. Note `FieldsPanel.test.tsx` is **not** a usable pattern — both its suites execute zero tests (see the register); `sharedSteps` tests are the working template.

- [ ] **Step 4: a11y suites** for the dialog, **each with a non-vacuity guard** asserting the interactive controls are genuinely mounted. An axe pass over an unopened dialog means nothing — WP-F05 shipped exactly that. If a guard fails for an unrelated reason, fix the cause; do not weaken the assertion.

- [ ] **Step 5: Run isolation suites, eslint, `tsc --noEmit`.**

- [ ] **Step 6: Commit.**

---

### Task 5: Browser journey, and close F07a

**Files:**
- Create: `frontend/e2e/specs/parameterised-cases.spec.ts`
- Modify: `docs/superpowers/PRODUCT_GAP_REGISTER.md`
- Modify: `docs/superpowers/plans/2026-09-05-functional-gaps-program.md` (F07a done; F07b listed as the remaining half)

Follow `frontend/e2e/specs/shared-steps.spec.ts` for structure and cleanup. The shared `contributor` persona has `write: true, delete: false` — cleanup needs delete rights. **Delete test cases before datasets.** Guard the cleanup path so no failure can skip `persona.cleanup()` — a leak of exactly that kind was found in the F06 spec.

The journey: create a dataset (2 columns, 2 rows) → author a case with `{{placeholders}}` → bind it → select preview row 0, assert substituted text → select row 1, assert it changes → **edit an unrelated step while previewing, reload, and assert the placeholders are still `{{name}}` in storage** (the R3 proof, and the single most valuable assertion here) → attempt to delete the bound dataset, assert the 409 names the case → cleanup.

- [ ] **Step 1: Write it.** — [ ] **Step 2: Prove non-vacuity** by making the preview write substituted text into the editable field; the journey must fail. Restore. Report both. — [ ] **Step 3: Run it.** — [ ] **Step 4: Sweep for leaked datasets, test cases and Keycloak users; report counts.** — [ ] **Step 5: Register entry**, recording R1-R6 and their evidence, and — plainly — anything a review caught that the tests missed. Do not invent a confession; if reviews caught nothing, say so. **State explicitly that F07a delivers parameterised authoring and NOT per-iteration execution results, and that a run still shows one row per case.** — [ ] **Step 6: Commit.**

---

## Self-review

**Spec coverage.** F07's row asks for parameterised/data-driven cases, noting the dependency on F06 ("a dataset binds to steps, and steps must be addressable"). F06 made steps addressable; Task 2 binds a dataset; Task 3 resolves values; Task 4 lets an author see them. The half this plan does **not** cover — per-iteration results — is stated in the goal, in R6, and again in the register entry, because the risk in this package is that "F07 done" is read as more than it is.

**Type consistency.** `DatasetId` (capital D, the `DS-n` human id) and `datasetId` (the ObjectId reference on a test case) are deliberately different, exactly as `SharedStepId`/`sharedStepId` are — and F06 proved that pairing is survivable but needs stating. The reference is an `ObjectId` in Mongo and a `string` on the wire.

**Inherited lessons applied.** Opt-in rather than implicit (R2), never-persist-the-derived-form (R3), order-of-operations made explicit (R4), visible-failure over silent-blank (R5), and an explicit no-touch boundary with a mechanical check (R6). Four of the five come directly from defects this programme has already paid for.

**Known risk.** Task 3 modifies the read path that F06's executions depend on. The `expand`-alone guard test in Task 3 Step 1 and the `git diff --stat` check in Step 6 exist specifically to catch a regression there, because a silent change to what executions snapshot would not surface until someone read a stored run.
