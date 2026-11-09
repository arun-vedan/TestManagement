# WP-F24 — Configurable release fields, and a Settings panel that only offers what works

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A release's fields can be configured per project like a test case's. And Settings stops offering field configuration for two modules that silently ignore it.

**Architecture:** `fieldsService` is already generic over `moduleId` — no backend change. `ReleaseDetail` reads `getFields(6)` and **merges configured fields on top of its built-in set**, so a project with no seeded definitions still renders a complete form. The Settings panel's module list shrinks to the modules whose detail forms actually consume it.

**Tech Stack:** React 18 / TypeScript / MUI v5 / react-query; Node/Express/Mongoose 5.13.23 (read-only here); Jest, Playwright.

**Spec:** the owner's report — *"the fields in the plans, runs and releases are not in the settings module"* — plus their scope decision: **releases only; stop offering plans and runs.** The orphaned module-4 field document is to be left in place and reported, not deleted.

## Global Constraints

- **No new runtime dependencies. No backend changes, with ONE amendment.** `fieldsService` already keys on `moduleId` and needs nothing — that part holds.

  **Amended during Task 1.** I reasoned the prohibition from "`fieldsService` is generic" and never checked whether the *release entity* can store a configured field's value. It cannot. `backend/releaseService/models/Release.js` has **no `dynamicFields` bucket**, and the schema is strict, so Mongoose silently drops an undeclared path without error. Every module that genuinely supports configurable fields has exactly one such bucket — `testrepo.js`, `requirement.js`, `defects.js` — and `Release.js` has none. Shipping Task 1 without this would render a configured field whose value vanishes on save: the same "looks like it works, does nothing" defect this package exists to remove, merely relocated from Settings to the form. **Adding `dynamicFields` to `Release.js`, and whatever the write path needs to carry it, is permitted.** Nothing else in the backend is.

  Note `TestPlan.js` also has no `dynamicFields`, which is consistent with plans not supporting configurable fields — the decision this package already made for other reasons.
- **No data migration and no seeding.** 621 of 622 projects have zero field definitions; a design that depends on seeded documents is wrong. See R1.
- **Do not delete the orphaned module-4 `'Step Status'` document** (created 2024-08-13). Owner's decision: leave it, report it.
- Frontend commands from `/Users/arunganesha/srckubetest/frontend`, never `frontend/src`. **CRACO**, not plain react-scripts. Isolation runs (`--testPathPattern`), `--runInBand`.
- Finish with `npx tsc --noEmit` and eslint clean on every file touched.
- Tests non-vacuous: name the single-line break for each, perform the probes, and **verify each probe's edit landed before trusting the run**.
- **Before retiring or renaming any `data-testid`, grep the WHOLE repo — `src/**` and `e2e/**` — for consumers.** WP-F23 shipped a red suite and six vacuous assertions by scanning one subtree. This is now a required step, not advice.
- No comment asserting an invariant the code does not have. This programme has five recorded stale-claim incidents; one of them is the very comment Task 2 has to correct.

## Verified premises

1. **The Settings panel offers modules 1-5** (`MODULES_WITH_FIELDS: ModuleId[] = [1, 2, 3, 4, 5]` in `frontend/src/Components/settings/FieldsPanel.tsx`), and its own comment claims those five are "the only modules any detail component actually reads field definitions for … grep across workbench/detail/modules confirms FieldGrid/getFields is wired into exactly these five". **That claim is false for modules 3 and 4.**
2. **Module 3 (test plans) never reads field definitions.** `TestPlanDetail.tsx` mentions `getFields(3)` only in comments and hand-rolls its own controls, saying so. **Zero** module-3 field documents exist.
3. **Module 4 (test runs) never reads its own field definitions.** `TestRunDetail.tsx` states it has no FieldGrid; its only `getFields` call is `getFields(1)`, for the nested test-case rows inside a run. **One** module-4 document exists — `'Step Status'`, a DropDown created **2024-08-13** — which nothing has ever rendered. It is the live proof that configuring these modules does nothing.
4. **Module 6 (releases) is not offered and not wired.** `ReleaseDetail.tsx` declares a hardcoded `RELEASE_FIELDS` (`name`, `status`, `notes`) with `targetDate` handled separately by its own date control, and comments that fabricating a `getFields(6)` call would be dishonest against a collection nothing populated.
5. **`fieldsService` is generic over `moduleId`** — `field.js` declares `moduleId: Number, required`, with no enum and no per-module branching. Module 6 needs no backend change.
6. **There is no default-field bootstrap anywhere.** Only project 1 has field documents (20 of them; 10 `isDefault: true`, 2 `false`, 8 with the flag absent). The other 621 projects have none, for any module.
7. **`FieldGrid` has no date field type** — which is why `targetDate` is hand-rolled in `ReleaseDetail` and why `TestPlanDetail` hand-rolls its own date controls.

## Rulings

- **R1 — built-in release fields stay built in; configured fields are added on top.** `getFields(6)` supplements `RELEASE_FIELDS`, never replaces it. Premise 6 is the reason: a design that reads definitions from the database would render an empty Details form in 621 of 622 projects, and "seed them all" is a migration this package refuses. A built-in must not be deletable through Settings either — removing `name` or `status` from a release would break the entity, not customise it. *Cost if wrong:* a project cannot rename or hide a built-in field, only add to it. That is the safe direction.
- **R2 — a configured field that collides with a built-in must not silently shadow it.** Decide the collision rule explicitly (built-in wins, or the configured one overrides its label only) and make it visible in the panel, because a user who adds a `status` field and sees nothing change will conclude Settings is broken — the exact complaint that opened this package. *Cost if wrong:* an unexplained no-op, which is the failure mode this whole package exists to remove.
- **R3 — the panel must not offer what the product ignores.** Modules 3 and 4 come out of `MODULES_WITH_FIELDS`. A control that saves successfully and changes nothing is worse than an absent one, because the user blames themselves. And **the false comment gets corrected in the same change** — leaving it would be the sixth stale-claim incident here.
- **R4 — say why, in the UI, not only in a code comment.** Removing two modules from a dropdown leaves a user wondering where they went. One plain sentence in the panel is enough: plans and runs carry purpose-built forms rather than configurable attributes. *Cost if wrong:* a line of copy to change later.
- **R5 — `targetDate` stays hand-rolled.** `FieldGrid` has no date type (premise 7). Do not invent one here; that is a `FieldGrid` change with five other consumers and no mandate in this package.

---

### Task 1: Releases read configurable fields

**Files:** modify `frontend/src/workbench/detail/modules/ReleaseDetail.tsx`; tests and a11y in `frontend/src/workbench/detail/__tests__/`.

Add a `getFields(6)` query and merge its result over `RELEASE_FIELDS` per R1 — built-ins always present, configured fields appended. Apply R2's collision rule. `targetDate` keeps its own control (R5).

A release in a project with no module-6 definitions must render exactly what it renders today. That is the regression to guard hardest, because it is the state 621 projects are in.

- [ ] **Step 1: Write the failing tests** — with no configured fields the form renders the three built-ins unchanged (this is the 621-project case); a configured Text field appears in addition to the built-ins; a configured field whose `fieldName` collides with a built-in resolves per R2 and does not vanish silently; a configured field with `isDisplayed: false` is not rendered; the query failing does not blank the form — built-ins still render; editing and saving a configured field's value persists through the same path as a built-in.
- [ ] **Step 2: Run to verify failure.** — [ ] **Step 3: Implement.** — [ ] **Step 4: a11y suite with a mount guard.**
- [ ] **Step 5: Prove non-vacuity** — make the merge replace instead of supplement → the no-configured-fields test fails; drop the `isDisplayed` filter → that test fails.
- [ ] **Step 6: `tsc --noEmit`, eslint, isolation suites. Commit.**

---

### Task 2: Settings offers only what works

**Files:** modify `frontend/src/Components/settings/FieldsPanel.tsx`; its tests and a11y.

`MODULES_WITH_FIELDS` becomes `[1, 2, 5, 6]` — modules 3 and 4 out (R3), module 6 in (Task 1 made it real). **Correct the false comment** (premise 1) to state what is actually true, and add R4's one-sentence explanation in the UI.

Verify what the panel does when a module has zero definitions — module 6 will be in that state for every project — and make sure it reads as "none configured yet", not as an error or a blank.

- [ ] **Step 1: Write the failing tests** — the module selector offers exactly Test Cases, Requirements, Defects, Releases; it does **not** offer Test Plans or Test Runs; selecting Releases lists module-6 definitions; a module with zero definitions reads as "none configured yet"; creating a field against Releases posts `moduleId: 6`.
- [ ] **Step 2: Run to verify failure.** — [ ] **Step 3: Implement.** — [ ] **Step 4: a11y suite.**
- [ ] **Step 5: Prove non-vacuity** — put module 3 back in the list → the "does not offer" test fails.
- [ ] **Step 6: Grep the whole repo for any consumer of the removed options** — `src/**` and `e2e/**`, per the Global Constraint. Report every hit. — [ ] **Step 7: `tsc --noEmit`, eslint, isolation suites. Commit.**

---

### Task 3: Browser proof, and close it

**Files:** create or extend an e2e spec; update `PRODUCT_GAP_REGISTER.md` and the programme doc.

Journey: open Settings → Fields → select **Releases** → add a field → open a release → **see that field on its Details tab beside the built-ins** → confirm Test Plans and Test Runs are not offered in the selector → clean up the field.

Follow `release-wiring.spec.ts` for structure but **not its setup shape** — it creates its persona outside the `try` while its own header claims otherwise (recorded during WP-F13, still unfixed). Create yours inside. Cleanup runs through `serviceApi()`'s service identity, not the persona. Query for what exists in the `finally` rather than trusting arrays populated on the happy path.

- [ ] **Step 1: Write it.** — [ ] **Step 2: Prove non-vacuity** by making the merge replace instead of supplement; the journey must fail. Restore; report both. — [ ] **Step 3: Run it.** — [ ] **Step 4: Sweep** every fixture, the created field document, and Keycloak personas; report counts before and after. — [ ] **Step 5: Register entry** recording R1-R5 and, plainly: that the panel offered two modules whose forms ignored it, with the orphaned `'Step Status'` document from 2024-08-13 as the evidence; that the panel's own comment asserted the opposite (the sixth stale-claim incident); and **as a separate recorded gap, premise 6** — there is no default-field bootstrap, so 621 of 622 projects have no field definitions for any module, which likely means an empty Details form for test cases, requirements and defects outside project 1. That is not fixed here and needs its own package. — [ ] **Step 6: Commit.**

---

## Self-review

**Spec coverage.** The owner reported three modules missing from Settings and chose "releases only, stop offering the other two". Task 1 makes releases real, Task 2 makes the panel honest, Task 3 proves it and records what was found.

**The risk I am most wary of.** R1's merge direction. Reading definitions from the database is the symmetrical design and it is wrong here — premise 6 means it would empty the form in 621 projects. A later reader will see releases behaving differently from test cases and be tempted to "fix" the asymmetry. The comment must say that releases are the *correct* behaviour and the other five modules are the ones with the latent gap.

**The thing I am deliberately not fixing.** Premise 6 itself. It is larger than this package, affects modules 1/2/5 more than 6, and the owner has not scoped it. Recorded, not absorbed.
