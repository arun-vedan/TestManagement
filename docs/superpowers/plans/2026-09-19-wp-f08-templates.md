# WP-F08 — Test case templates

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save a test case (or requirement, plan, defect) as a named template, and start new work from it — so the team's house shape for a regression case stops being copied by hand from whichever old case someone remembers.

**Architecture:** A template is **a stored draft prefill**. The workbench already has the entire mechanism: `useCloneEntity` flattens a source record into a prefill, mints a draft id, calls `setDraftPrefill`, and opens a tab. "Create from template" is that exact path with a saved prefill instead of a live record. New collection, no new create flow, no change to any detail component's draft handling.

**Tech Stack:** Node 18 / Express / **Mongoose 5.13.23**, React 18 / TypeScript / MUI v5 / react-query, Jest + supertest, Playwright.

**Spec:** `docs/superpowers/plans/2026-09-05-functional-gaps-program.md` row F08 — "Depends on F06. Cheap once shared steps and the create-from-draft path both exist — a template is a named draft."

## Global Constraints

- **No new runtime dependencies.**
- Every protected route: `keycloak.protect(), requireProjectScope(), authorize(<action>)` in that order — reads `'read'`, writes `'write'`, deletes `'delete'`. `releaseService` shipped nine routes with no `authorize()` and a viewer could delete releases; that was fixed on 2026-09-19 and must not be repeated here.
- `projectId` always from `req.projectScope`, never the body. Every query filtered by it.
- **Containers have NO bind mount.** The compose file is `backend/docker-compose.yml`, **not** the repo root. Rebuild after every source change or you are testing stale code.
- Mongo ONLY via `docker exec mongodb mongosh ...`. NEVER a host-side client — a stray native `mongod` squats on `127.0.0.1:27017`. **Find database names by listing them; do not guess** — a guessed name returns 0 for everything and reads like a clean answer.
- Do not mutate or delete seeded data. Report counts before and after; clean up every fixture on every path.
- Tests non-vacuous: name the single-line break for each, and perform the probes rather than asserting them.
- Frontend commands from `/Users/arunganesha/srckubetest/frontend`, never `frontend/src`. Isolation runs only.
- No line-number cites in comments. No comment asserting a file exists or does not exist — six stale-claim incidents in this programme.

## Verified premises

1. **No test case template exists.** Confirmed across `backend/` and `frontend/src`.
2. **BUT "template" ALREADY MEANS SOMETHING ELSE HERE, and this is the trap.** `frontend/src/model/TemplateModel.tsx` defines `{TemplateName, templateId, gitURL}` — a **project** template for scaffolding a new project from a git URL, rendered by `Components/Core/TemplateList.tsx` in the create-project wizard. `Pages/templates.tsx` and `Context/TemplateContext.tsx` exist and are **orphaned** (nothing imports them; only `TemplateList` is used, by `createNewProject.tsx`). Do not reuse, extend or rename any of it, and do not let a reader confuse the two.
3. **The draft-prefill mechanism exists and is proven.** `workbenchStore` has `draftPrefill: Record<EntityId, DraftPrefill>`, `setDraftPrefill`, and `makeDraftEntityId()`.
4. **`useCloneEntity` is the working analogue.** It flattens a record, mints a draft id, sets the prefill, opens a tab. A template does the same with a stored prefill. F07a also proved this path carries `datasetId` correctly after a fix.
5. **`DRAFT_CAPABLE_MODULES = {1, 2, 3, 5}`** — test cases, requirements, test plans, defects. Module 4 (runs) has no draft flow; module 6 (releases) is created from its own page.
6. **`testRepoService` already hosts `SharedStep` and `Dataset`** — it is becoming this product's authoring-assets service, which is why R2 puts templates there.

## Rulings

- **R1 — a template is a stored prefill, not a new entity type.** It holds the same flattened shape `useCloneEntity` builds. Creating from one reuses that exact path. *Cost if wrong:* a template cannot hold anything a draft cannot; if templates later need their own lifecycle (versioning, approval), that is a different feature.
- **R2 — module-generic, stored in `testRepoService`.** The mechanism already serves four modules; restricting to test cases would cost more code than it saves. `testRepoService` hosting a requirement template is a deliberate compromise — it is already the authoring-assets home (premise 6), and a new service for one collection is not worth it. *Cost if wrong:* a later move, which is a rename and a route change.
- **R3 — call it `CaseTemplate`, never `Template`.** Premise 2 is a live naming collision: `Template` already means a project scaffold in this codebase. Anything named `Template` will be misread. *Cost if wrong:* none.
- **R4 — saving a template captures the record as it is now, and never updates.** A template is a starting point, not a live link. Editing the case it came from does not change the template, and editing the template does not touch cases made from it. *Cost if wrong:* users wanting propagation want shared steps (F06), which already exist and do exactly that.
- **R5 — deleting a template is allowed with no usage guard.** Unlike a shared step or dataset, nothing references a template after creation (R4), so there is nothing to break. *Cost if wrong:* none; the absence of a guard here is a consequence of R4, not an oversight.

---

### Task 1: `CaseTemplate` model, CRUD, and RBAC

**Files:** create `backend/testRepoService/models/CaseTemplate.js`, `controllers/caseTemplate.js`, `routes/caseTemplate.js`; modify `server.js`; modify `srckube-kong/kong.yml` (**a git submodule** — commit inside it, then the pointer); test `__tests__/caseTemplate.test.js`.

**Produces:** `CaseTemplate` = `{ id, CaseTemplateId ("CT-<n>"), projectId, moduleId, name, description, prefill: Mixed, createdBy, updatedBy, timestamps }`. Routes `GET/POST /api/v1/casetemplate`, `GET/PUT/DELETE /api/v1/casetemplate/:id`.

Model it on `SharedStep` — same sequence hook, same tenant rules, same router shape — **minus** the usage query and delete guard (R5). `prefill` is `Mixed` deliberately: it holds whatever `useCloneEntity`'s flatten produces for that module, and constraining it would couple this collection to five detail components' field lists.

- [ ] **Step 1: Write the failing tests** — create stamps `CT-<n>` and the caller's `projectId`; a body-supplied `projectId` is ignored; another project's template is invisible; `moduleId` outside `{1,2,3,5}` is rejected 400; create with no name is 400; delete succeeds with no guard. Plus RBAC: viewer read-only, contributor cannot delete.
- [ ] **Step 2: Run to verify failure.** — [ ] **Step 3: Model.** — [ ] **Step 4: Controller.** — [ ] **Step 5: Router + mount + Kong route**, proving routing with an unauthenticated `curl` expecting **401**, not 404.
- [ ] **Step 6: Rebuild the container; run the suite.**
- [ ] **Step 7: Prove non-vacuity** — drop the `projectId` filter → the cross-project test fails; drop the `moduleId` validator → that test fails.
- [ ] **Step 8: Commit.**

---

### Task 2: Save as template, and start from template

**Files:** create `frontend/src/api/caseTemplateApi.ts`, `frontend/src/Components/templates/CaseTemplatePicker.tsx`, `.../SaveAsTemplateDialog.tsx`; modify the detail components for modules 1/2/3/5 and `SourcePanel.tsx`; tests + a11y suites beside each.

Use `axiosPrivate` with the full `/api/v1/casetemplate` path — **there is no `serviceApi()` helper in `frontend/src`** (that is Playwright-only, and a plan of mine wrongly claimed otherwise once).

**Starting from a template must reuse `useCloneEntity`'s path**, not a parallel one: mint a draft id, `setDraftPrefill(draftId, template.prefill)`, `openTab`. If that requires extracting a shared helper from `useCloneEntity`, do that rather than duplicating it — two copies of this logic will drift, and the clone path has already needed one correction (`datasetId` was silently dropped).

- [ ] **Step 1: Write the failing tests** — "Save as template" captures the current record's fields; starting from a template opens a draft prefilled with them; the draft is a real draft (unsaved, shows Create); a viewer sees neither control; **a template made from a parameterised case carries its `datasetId`** (the exact field the clone path silently dropped until F07a fixed it — assert it here too).
- [ ] **Step 2: Run to verify failure.** — [ ] **Step 3: Implement.** — [ ] **Step 4: a11y suites, each with a NON-VACUITY GUARD** asserting the interactive controls are genuinely mounted. An axe pass over an unopened dialog means nothing; this project shipped exactly that once and it passed a review first.
- [ ] **Step 5: Run isolation suites, eslint, `tsc --noEmit`.** — [ ] **Step 6: Commit.**

---

### Task 3: Browser journey, and close F08

**Files:** create `frontend/e2e/specs/case-templates.spec.ts`; update `PRODUCT_GAP_REGISTER.md` and the roadmap.

Follow `release-wiring.spec.ts` for structure, including its setup shape (persona, context and API client created **inside** the `try`). Cleanup needs delete rights; the shared `contributor` persona has `write: true, delete: false`.

Journey: author a test case with steps → save it as a template → start a new case from that template → assert the new case carries the template's fields and steps → edit the original case → **reopen the template and confirm it did NOT change** (R4) → clean up.

- [ ] **Step 1: Write it.** — [ ] **Step 2: Prove non-vacuity** by making "start from template" ignore the stored prefill; the journey must fail. Restore; report both. — [ ] **Step 3: Run it.** — [ ] **Step 4: Sweep** for leaked templates, cases and Keycloak users (Keycloak is on POSTGRES — Admin API, not mongosh); report counts. — [ ] **Step 5: Register entry** recording R1-R5, the `Template` naming collision, and anything a review caught that the tests missed. — [ ] **Step 6: Commit.**

---

## Self-review

**Spec coverage.** F08's row says a template is a named draft and that it is cheap once shared steps and the create-from-draft path exist. Both do. Task 1 stores the draft, Task 2 saves and restores it, Task 3 proves it end to end.

**The risk I am most wary of.** R4 says a template never updates. That is the right default, but it is the opposite of F06's shared steps, where one edit propagates everywhere. Both behaviours now exist in the same product, and a user will reasonably expect one when they get the other. The register entry must state the distinction plainly: **a shared step is a live reference; a template is a starting point.**

**Type consistency.** `CaseTemplateId` (`CT-n`, human) and the Mongo `_id` are different things — releases proved that confusion is real. `prefill` is `Mixed` by design (R1) and must be round-trip tested, because a strict schema silently dropping a field is exactly how WP-F06 lost `sharedStepTitle` through five reviewed tasks.
