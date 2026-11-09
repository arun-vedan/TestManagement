# WP-F18b — Move releases fully into the workbench

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One answer to "where are releases". Everything about a release lives in the workbench; environments move to Settings where project configuration belongs; the nav drawer's Releases entry goes away.

**Why now:** F15/F18 put releases in the workbench but deliberately left `Pages/releases.tsx` in place (ruling R2 — two entry points beat a port done twice). The owner then hit the consequence: the same concept in two places, with **quality gates split down the middle** — edited on the nav page, status shown in the workbench.

**Architecture:** No new entities and no backend changes. Every capability being moved already exists server-side; this is relocation plus tests.

**Tech Stack:** React 18 / TypeScript / MUI v5 / react-query; Jest + supertest; Playwright.

## Global Constraints

- **No new runtime dependencies. No backend changes** — if a task seems to need one, stop and report; it would mean a premise below is false.
- Every control gated with `usePermissions()`: create/edit need `can('write')`, delete needs `can('delete')`. A contributor has write but **not** delete. `releaseService` shipped nine routes with no role check and a viewer could delete a release (fixed 2026-09-19, proven by watching an unguarded DELETE destroy a seeded record) — the UI must not re-open that by offering controls the backend will refuse.
- **Sequence matters and is not negotiable.** Each capability must work in its new home *before* the old one is removed. The nav entry goes last. At no point may the owner be left unable to reach gates or environments.
- Tests non-vacuous: name the single-line break for each and perform the probes rather than asserting them. **Verify each probe's edit actually landed before trusting the run** — three probes in this programme silently applied nothing (wrong anchor string) and reported a passing suite that proved nothing.
- a11y suites for new dialogs, each with a **non-vacuity guard** asserting the interactive controls are genuinely mounted. An axe pass over an unopened dialog means nothing; this project shipped exactly that once and it passed a review first.
- Frontend commands from `/Users/arunganesha/srckubetest/frontend`, never `frontend/src`. Isolation runs only — a full jsdom run times out.
- No line-number cites in comments. No comment asserting a file exists or does not exist — six stale-claim incidents here, every one a sentence true when written.

## Verified premises

1. **The workbench already owns**: the release list (`entityListConfigs.tsx`'s `releaseConfig`), `ReleaseDetail` (fields, **gate status** via `getGateStatus`, linked test plans with add/remove, `LinksSection`, the F15 lens).
2. **The nav page still exclusively owns**: release **create/delete**, **gate editing**, and **environments**.
3. **Gate editing is not a separate feature.** `Pages/releases.tsx` edits gates by calling `updateRelease(id, { qualityGates: gateDraft })` — `qualityGates` is a field on `Release`, not its own entity. Moving it means adding an editor to `ReleaseDetail` that calls the same function.
4. **Environment CRUD is COMPLETE server-side** — `routes/environments.js` mounts `get`, `getOne`, `post`, `put` and `delete`, each with the correct `authorize()` gate. The gap is client-side only: `frontend/src/api/releaseApi.ts` exposes just `getEnvironments` and `createEnvironment`. (An earlier read of mine said the backend lacked update/delete; checking the routes disproved it.)
5. **Settings tabs today**: `members`, `apikeys`, `audit`, `fields`, `modules`, `folders`. `modules` and `folders` are `ReservedTab` stubs belonging to **WP-F17** — do not take either slot. Environments is a new tab.
6. **`MainDrawer.tsx` already documents Releases as "the one exception KEPT here"** because the workbench rail also lists it. That comment becomes false the moment Task 4 lands, and must be removed with it.

## Rulings

- **R1 — environments go to Settings, not the workbench.** An environment is project-scoped configuration of the same shape as Fields, not a test asset. It only ever lived on the releases page because releases were the first thing that needed it. *Cost if wrong:* a tab move.
- **R2 — gate editing joins gate status in `ReleaseDetail`.** A gate is a policy *on a release*; splitting it from the thing it governs is the specific confusion the owner reported. *Cost if wrong:* none identified.
- **R3 — complete the environment client while moving it.** The backend already supports update and delete (premise 4). A Settings tab where a typo can be added and never corrected is not worth shipping. *Cost if wrong:* two extra client functions and their tests.
- **R4 — `Pages/releases.tsx` is deleted, not left orphaned.** This codebase already carries orphaned `Pages/templates.tsx` and `Context/TemplateContext.tsx` that nothing imports and that actively mislead — one of them cost a work package a false premise. Do not add a third. *Cost if wrong:* it is in git history.
- **R5 — the nav entry is removed only after Tasks 1-3 are proven.** *Cost if wrong:* the owner loses access to gates or environments mid-migration, which is the one outcome this sequence exists to prevent.

---

### Task 1: Environments move to Settings

**Files:** create `frontend/src/Pages/settings/EnvironmentsTab.tsx` and `frontend/src/Components/settings/EnvironmentsPanel.tsx`; modify `frontend/src/Pages/settings/index.tsx`; extend `frontend/src/api/releaseApi.ts` with `updateEnvironment` and `deleteEnvironment`; tests + a11y suite.

Follow `FieldsPanel.tsx` — it is the proven Settings-panel analogue (and note its own suites were dead until 2026-09-15; its *pattern* is sound, its history is a caution).

- [ ] **Step 1: Write the failing tests** — the tab lists environments; create/edit need `can('write')`; delete needs `can('delete')` and a contributor sees none; deleting asks for confirmation naming the environment.
- [ ] **Step 2: Run to verify failure.** — [ ] **Step 3: Add the two API client functions** (backend routes already exist — premise 4). — [ ] **Step 4: Build the panel and register the tab.** — [ ] **Step 5: a11y suite with a non-vacuity guard.**
- [ ] **Step 6: Prove non-vacuity** — remove the `can('delete')` gate; the contributor test must fail.
- [ ] **Step 7: Commit. Do NOT yet remove environments from `Pages/releases.tsx`** — both exist until Task 4.

---

### Task 2: Gate editing moves to `ReleaseDetail`

**Files:** modify `frontend/src/workbench/detail/modules/ReleaseDetail.tsx`; tests.

`ReleaseDetail` already renders gate **status**. Add the editor beside it, calling `updateRelease(id, { qualityGates })` exactly as the nav page does (premise 3). Gate types are `minPassRate` and `maxOpenDefects`.

- [ ] **Step 1: Write the failing tests** — a release's gates render editable; saving calls `updateRelease` with the edited `qualityGates`; status refreshes after a save; a viewer sees status but no editor; **a release with no gates configured says so plainly** rather than showing an empty editor that implies gates exist.
- [ ] **Step 2: Run to verify failure.** — [ ] **Step 3: Implement.** — [ ] **Step 4: Run isolation suites, eslint, `tsc --noEmit`.**
- [ ] **Step 5: Prove non-vacuity** — make the save send an empty array; the save test must fail.
- [ ] **Step 6: Commit. The nav page keeps its gate editor until Task 4.**

---

### Task 3: Create and delete a release from the workbench

**Files:** modify `frontend/src/workbench/SourcePanel.tsx` (or wherever module 6's "New …" belongs), `ReleaseDetail.tsx`, `frontend/src/workbench/modules.ts` if module 6 needs a create affordance; tests.

Module 6 is deliberately **excluded** from `DRAFT_CAPABLE_MODULES` because a release has no blank-draft flow — it is created from a dialog, not a draft tab. **Decide deliberately**: either give module 6 a create dialog (matching how the nav page does it today), or add it to the draft flow. State your reasoning; do not pattern-match the other five modules without checking that a release's required fields suit a draft.

- [ ] **Step 1: Write the failing tests** — creating a release from the workbench calls `createRelease` and opens it; delete is gated on `can('delete')` and confirms first, naming the release; a viewer sees neither.
- [ ] **Step 2: Run to verify failure.** — [ ] **Step 3: Implement.** — [ ] **Step 4: Prove non-vacuity** on the delete gate. — [ ] **Step 5: Commit.**

---

### Task 4: Remove the old entry points, and close it

**Files:** delete `frontend/src/Pages/releases.tsx`; modify `frontend/src/App.tsx` (its route) and `frontend/src/Components/NavBar/MainDrawer.tsx` (the nav entry **and** the now-false comment from premise 6); create `frontend/e2e/specs/release-migration.spec.ts`; update `PRODUCT_GAP_REGISTER.md` and the roadmap.

**Before deleting anything**, verify every capability works in its new home. List them and check them off explicitly in your report: create, delete, gate edit, gate status, environments create/edit/delete, link test plans, links, lens.

Journey: create a release in the workbench → edit its gates → see gate status → link a defect → create an environment in Settings → delete it → delete the release → clean up. Follow `release-wiring.spec.ts`'s structure including its setup shape (persona, context and API client created **inside** the `try`).

- [ ] **Step 1: Verify and report the capability checklist.** — [ ] **Step 2: Write the journey.** — [ ] **Step 3: Remove the page, the route, the nav entry and the stale comment.** — [ ] **Step 4: Prove non-vacuity** by breaking one moved capability; the journey must fail. — [ ] **Step 5: Run it; sweep for leaked releases, environments and Keycloak users (Keycloak is on POSTGRES — Admin API, not mongosh).** — [ ] **Step 6: Register entry + roadmap.** — [ ] **Step 7: Commit.**

---

## Self-review

**Spec coverage.** F18's row says releases should live in the workbench and that it depended on F15's lens answer. F15/F18 delivered the lens and the views; this closes the half deliberately deferred — and the owner's report ("the release is wired in the main app drawer and not the workbench") is the acceptance test.

**The risk I am most wary of.** Task 4 deletes the surface the owner has actually been using. If any capability is missed, they lose it with no fallback, and the nav page will be gone. That is why the capability checklist is Step 1 of Task 4 rather than a closing formality, and why Tasks 1-3 each explicitly leave the old page intact.

**Type consistency.** `ReleaseDetail`'s `entityId` is the release's Mongo `_id`, while `linkIssueService` keys on the human `releaseId` (`REL-n`) — releases are the one module where those differ, and Task 3 of F15/F18 had to handle it. Any new code touching links must use the human id.
