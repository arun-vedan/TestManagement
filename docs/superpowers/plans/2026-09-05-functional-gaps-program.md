# Functional gap remediation — program plan

> **For agentic workers:** this is a PROGRAM document, not an executable plan.
> It owns the work-package register, the sequence, and the orchestration
> protocol. Each work package gets its own executable plan at
> `docs/superpowers/plans/YYYY-MM-DD-wp-<id>-<slug>.md`, written by the
> orchestrator immediately before that package is dispatched, using
> `superpowers:writing-plans`. Executors read their WP plan, not this file —
> except for **Global Constraints** and **Escalation triggers**, which bind
> every package.

**Goal:** close the functional gaps identified in the 2026-09-05 enterprise
evaluation — the things a tester or test manager cannot do today — in an order
that keeps the product shippable at every step.

**Scope:** functionality only. Security, deployment, CI, compliance process and
localisation gaps from the same evaluation are deliberately **out of scope
here** and tracked separately; see "Explicitly not in this program".

**Source of findings:** the functional gap analysis of 2026-09-05, verified
against source at `98b0a77`. Entries below carry the evidence that was actually
checked, in the style of `PRODUCT_GAP_REGISTER.md`.

---

## Global Constraints

These bind every work package in this program. An executor's own requirements
implicitly include this section.

- **No new runtime dependency** without orchestrator approval. This repo has a
  standing bias against adding a library for a job that a small amount of
  hand-rolled code does (precedent: Wave C-2 shipped CSV export
  dependency-free). Propose, do not install.
- **Every new route** mounts the full chain in this order:
  `keycloak.protect()` → `requireProjectScope()` → `authorize('<action>')`.
  Reads use `'read'`, writes `'write'`, deletes `'delete'`.
- **Literal path segments register BEFORE `/:id`.** Express matches in
  registration order and `/:id` swallows any single-segment literal. This has
  already bitten this repo twice (`/bulk`, `/wildcardsearch`) — both route
  files carry a comment saying so.
- **Never trust `projectId` from a request body.** It comes from
  `req.projectScope.projectId`, stamped server-side.
- **Cross-project resolution returns 404, not 403** — a 403 confirms the id
  exists in another project. This is the precedent set when the `fieldsService`
  tenant hole was closed in Wave A-1.
- **Frontend permission checks are decoration.** `frontend/src/permissions.ts`
  says so in its own header. The server is the boundary; a UI gate is for
  hiding controls, never for enforcement.
- **A backend capability is not delivered until a UI surfaces it.** This
  program exists largely because that rule was not applied — versioning,
  results ingestion and search backends all shipped without readers.
- **Verify against the running stack, not against the code you just wrote.**
  `scripts/run-api-tests.sh` against the live compose stack; browser
  verification for anything a user sees.
- **Append to `docs/superpowers/PRODUCT_GAP_REGISTER.md`** at the end of every
  package: what was resolved, what was newly found, what was checked and found
  fine. Do not delete entries.

---

## The register

Sizes: **XS** under a day · **S** days · **M** one to two weeks · **L** multiple
weeks. Sizes are engineering effort for one executor, not calendar time.

### Wave F1 — unblock the daily loop

Small, independent, high daily value. All four can run in parallel: no two own
the same file (see the conflict map).

| WP | Gap closed | Why now | Size |
|---|---|---|---|
| **F01** | Search does not exist for test plans or test runs | Search covers 3 of 6 modules. `entitySearchConfigs.ts` documents the absence honestly rather than faking it; the fix is two backend routes following a pattern that already exists three times. Smallest high-value item in the program. | S |
| **F02** | Version history shows *when* something changed, never *what* it contained | **CORRECTED 2026-09-05.** The original entry claimed there was no reader. That was wrong: `Components/governance/LifecycleStatus.tsx` already renders a History button and dialog listing `Version N` + timestamp, already mounted in both detail views, backed by helpers that already exist in `apiCalls.tsx`. The real gap is narrower and is the auditable half — on TC-1 the summary changed at v2 and the step count dropped 3 → 1 at v4, none of which a user can see. Extend the existing dialog in place; do not build a second one. | S |
| **F03** | ~~Bulk operations exist for 2 of 6 modules~~ **DONE 2026-09-06** — five of six now | `bulkUpdate`/`bulkDelete` exist on test cases and defects only, and defects have no bulk status change. Requirements, plans and runs have none. The controller pattern to copy is `testRepoService/controllers/testrepo.js:362-520`. | M |
| **F04** | ~~Legacy defects render a raw numeric status~~ **DONE 2026-09-06** | Bug-1/2/3 hold codes (1/2/8) that never mapped to a status name, so the chip shows "2" and the control is disabled. A data migration with a written decision on what the codes meant — not a UI fix. | XS |

### Wave F2 — authoring economics

The compounding costs. **F06 changes the test case model, so it must land
before any importer is written against that model** (F14) — that ordering is
the single most important dependency in this program.

| WP | Gap closed | Why in this order | Size |
|---|---|---|---|
| **F05** | No tags or labels on anything | Cheapest of the four and independent of the model change. Custom fields exist but are not a filter/group dimension. Unlocks saved-view filtering that F03's bulk selection immediately benefits from. | M |
| **F06** | ~~No reusable/shared steps~~ **DONE 2026-09-08** | `TestStepSchema` is embedded per test case, so shared login steps are retyped everywhere and a change to them is a bulk edit. Highest authoring value in the program, and it reshapes `testrepo.js`'s model — everything downstream of that model waits for it. A step sequence is now authored once (`SharedStep` collection), referenced from a test case as `{sharedStepId, sharedStepTitle}`, and edited in one place — proven end to end by `frontend/e2e/specs/shared-steps.spec.ts`: one edit to a shared step updates every referencing test case, and a reload never flattens the reference into copies. Expansion into flat `{testStep, Expected}` rows stays explicit and opt-in (`?expand=steps`) — see `PRODUCT_GAP_REGISTER.md`'s 2026-09-08 entry for why implicit expansion was rejected. | L |
| **F07a** | ~~No parameterised / data-driven cases (authoring)~~ **DONE 2026-09-13** | Depends on F06: a dataset binds to steps, and steps must be addressable before they can take parameters. Delivers the AUTHORING half only: one test case with `{{placeholders}}` and a bound `Dataset` (its own collection, mirroring `SharedStep`) replaces five near-identical copies, and an author can preview any data row without ever altering what is stored (`?substitute=<rowIndex>`, opt-in, never persisted — see `PRODUCT_GAP_REGISTER.md`'s 2026-09-13 entry). Proven end to end by `frontend/e2e/specs/parameterised-cases.spec.ts`. ~~A test run still shows one row per test case, not one per data row — this is NOT "data-driven testing done".~~ **CORRECTED 2026-09-15.** That sentence was accurate on 2026-09-13 and, despite F07b's "DONE" below, stayed accurate straight through 2026-09-14: F07b's own enrichment trigger turned out to be unreachable by any user-facing path (`createTestExecution`'s stub always persisted a real, truthy `TestSteps: []` — Mongoose's own default for an array-typed path — so the guard that fires enrichment, written for "absent means un-enriched", could never see it as absent). A real "Create Execution" click, clicked open, still produced exactly one row per test case, parameterised or not, until this was fixed 2026-09-15 (one-line model default, `default: undefined`, in `backend/testPlanExecutionService/models/TestExecution.js`) — see `PRODUCT_GAP_REGISTER.md`'s 2026-09-15 entry. A run now genuinely produces one row per bound data row, addressed independently, with no assistance needed to trigger it. | L |
| **F07b** | ~~No per-iteration execution results~~ **DONE 2026-09-14 — F07 now COMPLETE** | The other half of F07, split out because it reshaped records of runs that already happened rather than the authoring model F07a touched. A case within a run is now addressed by `TestCaseId` **plus** `iterationIndex` (six backend sites + the frontend's list key/selection + defect-raising — the exact premise F07a's plan had verified would have to change). Enrichment expands a bound case into one row per data row at first open, snapshotting each row's substituted text; `planProgress`/`passRateTrend` count iterations individually (this changes what those dashboards' totals mean for a heavily parameterised project — disclosed in the product, `TestManagerSection.tsx`); `workload` deliberately still counts executions. Proven end to end by `frontend/e2e/specs/per-iteration-results.spec.ts`: two independently-addressable result rows from one 2-row dataset-bound case, each holding its own status after a genuine reload (server truth, not the DOM), a defect raised from the failing row that names its data values, and reporting counting 2 executed / 1 passed against that run's own plan. See `PRODUCT_GAP_REGISTER.md`'s 2026-09-14 entry for the rulings, the review catches, and the non-vacuity transcript. **Final review found this package's own enrichment trigger unreachable by any user-facing path (a real "Create Execution" click never satisfied it — see F07a's row above); fixed 2026-09-15, see `PRODUCT_GAP_REGISTER.md`'s 2026-09-15 entry.** | L |
| **F08** | ~~No test case templates~~ **DONE 2026-09-20 — Wave F2 now COMPLETE** | Depends on F06. Cheap once shared steps and the create-from-draft path both exist: a `CaseTemplate` is a named, stored draft prefill (`testRepoService`, module-generic across 1/2/3/5), and "start from template" replays `useCloneEntity`'s own draft-open mechanism (`buildEntityPrefill`/`openDraftFromPrefill`, extracted so clone and template can never drift on it) with a stored prefill instead of a live fetch. Saving one captures the source record's fields at that moment and **never updates again in either direction** — the deliberate opposite of F06's `SharedStep`, which is a live reference. Proven end to end by `frontend/e2e/specs/case-templates.spec.ts`: author a case with steps, save it as a template, start a second case from it and confirm the fields/steps carried over, edit the ORIGINAL case, then reopen the template and confirm it still shows the pre-edit text — checked against both the DOM and a live read of the stored document. See `PRODUCT_GAP_REGISTER.md`'s 2026-09-20 entry for R1–R5, the `Template` naming collision with the unrelated project-scaffold feature (`model/TemplateModel.tsx`), and the non-vacuity transcript. | S |

### Wave F3 — execution truth

Makes the execution record honest enough for the reporting in F13 to mean
something.

| WP | Gap closed | Why in this order | Size |
|---|---|---|---|
| **F09** | A test run has no name, one assignee for the whole run, and no baseline | **Verified: `TestExecution` has no title field of any kind** — only `TestExecutionId`, `assignedTo` and a case array. This is why F01 can only give runs a weak search. Adds a run title, moves assignment down to the per-case level, and freezes the run's case set at start so a plan edited mid-run cannot change what is being executed. Gates the rest of this wave. | M |
| **F10** | No re-run of failed tests only | Depends on F09's per-case state. A partial retest currently means a whole new run. | M |
| **F11** *(deferred 2026-09-23 — owner plans a dedicated automation module covering automation design, which largely dissolves the binding problem; design kept in the register for the interop case)* | Ingested CI results never reach reporting | Results arrive tagged with the runner's test name (`TAG:<classname>.<name>`, set in `adapters/normalize.js`) and are never bound to a repository case, so coverage and trend reports cannot see them. Publishing a CI recipe before this would make things worse, not better. | M |
| **F12** | One environment per plan; no configuration matrix | Depends on F09. "Run this plan on Chrome, Firefox and iOS" currently means cloning the plan three times. `Environment` already exists as a first-class model with CRUD in `releaseService`. | L |

### Wave F4 — answers, and getting data in and out

| WP | Gap closed | Why in this order | Size |
|---|---|---|---|
| **F13** | ~~No traceability matrix~~ **DONE 2026-09-24** | Was gated on F11. F11 is deferred (2026-09-23, pending a dedicated automation module — see the register), so the gate was satisfied differently: the matrix is built over the link-and-derivation graph it can honestly claim, with the automated-execution dimension absent rather than zero (R5 — read `TestExecution.TestCases[].TestStatus` regardless of `source`; no filter added that F11 would have to remove). **Found and fixed a number that was wrong on the way in**: requirement coverage (`reportingService/services/coverage.js`) had read **0% for every project, always** — it gated "tested" on `linkType:'tests'`, a value the product's own link affordances have never once written (all 23 live link rows are `relates-to`). Corrected to "any requirement↔case link, any `linkType`, either direction" (R1); project 1 now reads 2 of 5 requirements linked (40%) — a shipped number changing, announced in the register rather than discovered. Replaced the single percentage with four mutually exclusive, exhaustive segments computed by ONE function (`classifyRequirementSegment`, R3) that both the coverage tile and the new per-requirement matrix (`services/traceability.js`, `Pages/dashboard/sections/TraceabilityMatrixSection.tsx` on `Pages/reports.tsx`) import, so the two can never quietly disagree. A `testCount` column is a plain, unscored thinness indicator (R4) — adequacy is explicitly out of scope, tracked as **F22** below (renumbered from F19 in the final fix round — see the numbering note below the table: F19 was already taken by an unrelated, unplanned gap, making "the named follow-up is F19" ambiguous between two rows). CSV export reuses the existing dependency-free `csvEncode.ts`/`exportApi.ts`; no backend export endpoint was added. Proven end to end by `frontend/e2e/specs/traceability-matrix.spec.ts`: link two test cases to a requirement, run one to Pass and leave the other unrun, and see the row read "Tests linked, not fully verified" (never "all passing") — the exact case an amended ruling (R2) exists to get right, since one Pass and one never-run case is not "all passing". See `PRODUCT_GAP_REGISTER.md`'s 2026-09-24 entry for R1–R7, the corrected 60%→40% premise, and the non-vacuity transcript (probe: reintroduce the `linkType:'tests'` gate, rebuild `reportingservice`, confirm the requirement reads untested; restore, rebuild, confirm it passes). | M |
| **F14** | Import/export is CSV, test cases only; no cross-project copy | Depends on **F06** (do not write importers against a model about to change) and F05. Adds requirements and defects both directions, whole-project export, incumbent-tool importers, copy/move of an asset between projects, and the CSV byte-order mark that closes the open "csv or excel" decision. | M |
| **F15** | ~~No release lens~~ **DONE 2026-09-19** | The blocked sub-project 4 decision. Recommendation stands: **do not add `releaseId` to five services** — derive it in `reportingService`, which already performs this class of join for `/release-readiness`. Verified: no entity outside `releaseService` carries a release reference. **Shipped stronger than the recommendation**: releases needed no schema change ANYWHERE, not just no `releaseId` field — `linkIssueService`'s `srcModule`/`destinationModule` were already untyped `Number`s with no enum, so module 6 joined the existing link graph at zero schema cost. `GET /reports/release-lens?releaseId=<id>` (`backend/reportingService/services/releaseLens.js`) reports, for one release: linked requirements/test cases/defects (resolved, not raw link rows — an endpoint pointing at a deleted entity is silently excluded), linked test plans (`Release.linkedTestPlanIds`, a separate, pre-existing mechanism the lens does not conflate with the link graph), and execution results reached through those plans. Every count ships with its denominator (R5) — a release with nothing linked reads "0 of 0, nothing linked yet", never a bare zero. `computeReleaseReadiness` remains project-scoped by design, not an oversight — see `PRODUCT_GAP_REGISTER.md`'s 2026-09-19 entry for why. | M |
| **F22** *(new, 2026-09-23; renumbered from F19 in the final fix round — F19 was already taken by the unplanned workbench-nav gap below, and the collision made "the named follow-up is F19" ambiguous)* | No measure of test **adequacy** | F13's segments measure presence and outcome: one shallow passing test reads the same as twelve thorough ones. Three routes, in build order — child-requirement rollup (deterministic; `parentId` already exists and is already in use), defect leakage (empirical; defect→req and defect→case links plus execution timestamps already held), AI assessment (judgement, labelled as such, never inside the coverage number). Full design in the register, 2026-09-23. | L |
| **F16** | Notifications: 3 event types, in-app only; reports cannot leave the tool | `Notification.type` is an enum of exactly `execution-completed`, `defect-assigned`, `status-review`. No email, no watch/subscribe, no rules. Once an email channel exists, scheduled report delivery and report export (the Monday-morning report a manager gets without opening the tool) ride on it — so both live here rather than in F13. | M |
| **F17** | Modules and Folders administration unbuilt | Two reserved Settings tabs that say so honestly in `ReservedTab.tsx`. Follows the pattern `FieldsPanel.tsx` established in Wave D-1. | M |
| **F18** | ~~Releases live outside the workbench~~ **DONE 2026-09-19** | Depended on **F15**: what module 6 needed to show depended on the lens answer. Releases are now a real workbench module 6 — list (`entityListConfigs.tsx`'s `releaseConfig`) and detail (`ReleaseDetail.tsx`), reachable and openable (a real gap found and closed mid-package: module 6 has neither a tree nor a search config, so the list view's id column needed its own click-to-open wiring — `entityListConfigs.tsx`'s `ReleaseIdCell`), can be linked to the defects/requirements/test cases it covers via the same `LinksSection` every other module mounts, and shows the F15 lens on its own "Lens" tab. `Pages/releases.tsx` stayed as the release CRUD/quality-gate entry point at the time (ruling R2 — two entry points is cheaper than a port done twice); this package did not migrate it. **Follow-up, WP-F18b, DONE 2026-09-20**: the owner hit that deliberate gap directly ("the release is wired in the main app drawer and not the workbench") — quality gates were split down the middle, edited on the nav page, status shown in the workbench. WP-F18b moved environments to Settings, gate editing beside gate status in `ReleaseDetail.tsx`, and create/delete into the workbench, then deleted `Pages/releases.tsx` and its nav-drawer entry — releases now have exactly one home. No backend change was needed anywhere in that package either; every capability already existed server-side, including the environment update/delete routes an earlier premise wrongly claimed were missing. See `PRODUCT_GAP_REGISTER.md`'s 2026-09-20 entry for the two deliberate behaviour changes (environments gained edit/delete; delete moved from a list row to the detail header) and the non-vacuity transcript. Proven end to end by `frontend/e2e/specs/release-wiring.spec.ts`: create a release → link a defect and a requirement to it → link a test plan → open the release and see the lens count them → confirm the link is visible from the defect's own detail → clean up. See `PRODUCT_GAP_REGISTER.md`'s 2026-09-19 entry for the rulings (R1-R5), the corrected orchestrator premise, and the non-vacuity transcript. | S |

### Unplanned — found by the owner using the tool

| WP | Gap closed | Why | Size |
|---|---|---|---|
| **F19** | The workbench had no navigation entry, and the nav itself was unreadable | Reported by the owner, not found by any review. WP-078's split gave the drawer the job of answering "which area am I in" and never added an area entry for the workbench — the one place all test work happens. It was reachable only from a dashboard drill-down, a legacy redirect, or a typed URL, and the module rail that navigates it renders *inside* it. The drawer also opened collapsed to a 41px strip of unlabelled icons. **DONE** — commit `6f423ed`; adds one area entry (not the five per-module entries WP-078 deliberately removed), opens the drawer by default, and widens the rail 96px → 148px. | S |

| **F20** | Every AI panel rendered on the nav drawer's dark teal surface | Reported by the owner: the "Generate test cases (AI)" overlay was hard to read. Root cause was not the overlay — the theme set `MuiDrawer.styleOverrides.paper` to `#244855` with white text **globally**, for the nav drawer's benefit. Four AI panels (`AiTestCaseDrawer`, `AiDuplicateCheckDrawer`, `AiDuplicateAuditPanel`, `AiLintPanel`) are also `<Drawer>`s and set only a width, so all four inherited a dark surface while rendering TextFields, Alerts and dividers MUI styles for a light one. **DONE** — the navy moved onto the nav drawer itself. | XS |

| **F23** | The release Lens tab (and the traceability matrix, F13, in a worse form) became unreadable walls at scale | Reported by the owner: *"in the lens the way test cases, requirements etc are arranged it is fine when we have one or two but when you have a large release with 100s of testcases it is not going to look good."* Both replaced flat `.map()`/nested-table rendering with `@mui/x-data-grid` (already a dependency), client-side paged at 25/50/100, with a default sort that surfaces failing/unresolved/derived items first instead of a plain id order. The Lens gained real per-test-case execution status (a small, permitted additive field on an otherwise-unchanged, uncached payload) so R2's "failing first" sort could apply to test cases at all — the exact entity the owner reported. **DONE 2026-09-25.** Proven end to end by two new browser specs (`frontend/e2e/specs/release-lens-density.spec.ts`, and a density test added to `traceability-matrix.spec.ts`): a 30-item set renders as one page with the total stated, a failing item lands on the first screen with zero interaction, the grid's own container — not the page body — holds the horizontal overflow, and the CSV exported from a paged matrix still contains every row with full nested detail. Along the way, found and repaired two existing specs whose own per-row testids the DataGrid migration had retired without anyone checking for consumers — six of the resulting broken assertions were `toHaveCount(0)` checks that had gone silently, vacuously green rather than red. See `PRODUCT_GAP_REGISTER.md`'s 2026-09-25 entry for R1–R6, the R3 amendment, the vacuous-assertion post-mortem, a fourth instance of this programme's "a rule expressed twice drifts" pattern, and the deliberate follow-up (the lens stays uncached and recomputes on every tab open — paging the render does not touch that). | S |

**Note on numbering:** F19 sits outside the F01–F18 sequence deliberately. It was
not planned; it came from the owner using the product, which is the same source
that produced the most valuable entries in `PRODUCT_GAP_REGISTER.md`. Renumbering
the planned packages to make room would have broken every reference in the
dependency graph and the conflict map.

**Correction (final fix round, 2026-09-24):** the test-adequacy gap this note's own
table once labelled **F19** (added 2026-09-23, planned, in Wave F4 above) was a
second, unrelated row carrying the same identifier as this unplanned one — a
collision, not a coincidence: this note's own F19 already existed when the planned
row was added. That made "the named follow-up is F19" (`coverage.js`, the register)
ambiguous between two different gaps. The planned row is renumbered to **F22** (the
next free identifier after F19–F21) throughout this doc and `PRODUCT_GAP_REGISTER.md`;
this row keeps F19, for the same non-renumbering reason given above.

---

## Dependency graph

```
F01 ─┐
F02 ─┼─ (independent, parallel)
F03 ─┤
F04 ─┘

F05 ─────────────────────────────┐
F06 ──┬──> F07a ──> F07b         │
      ├──> F08                   │
      └────────────────> F14 <───┘
F09 ──┬──> F10
      └──> F12
F11 ──────> F13
F15 ──────> F18
F16, F17  (independent)
```

**The two edges that matter:** `F06 → F14` (never write an importer against a
model that is about to change) and `F11 → F13` (never build a coverage report
on results that are not bound to cases).

---

## File-ownership conflict map

Two work packages may run in parallel **only if their owned-file sets are
disjoint.** The orchestrator checks this before dispatching anything
concurrently. Files listed are the ones a package is expected to modify; an
executor that needs to touch a file owned by another in-flight package
escalates rather than editing it.

| WP | Owns |
|---|---|
| F01 | `backend/testPlanExecutionService/{routes,controllers}/{testplan,testexecution}.js` · `frontend/src/workbench/search/entitySearchConfigs.ts` · `frontend/src/api/apiCalls.tsx` (append-only) |
| F02 | `frontend/src/workbench/detail/` (new `VersionHistorySection.tsx` + `DetailTabs.tsx`) · `frontend/src/api/versionApi.ts` (new) |
| F03 | `backend/{requirementService,testPlanExecutionService}/controllers/*` (bulk exports only) · `frontend/src/api/bulkApi.ts` · `frontend/src/workbench/list/` |
| F04 | `backend/defectService/scripts/` (new migration) — no application code |
| F05 | shared model touch across 5 services — **runs alone**, no parallel package |
| F06 | `backend/testRepoService/models/` — **runs alone** |
| F09 | `backend/testPlanExecutionService/models/TestExecution.js` — **conflicts with F01**, must follow it |
| F11 | `backend/testPlanExecutionService/adapters/`, `controllers/ingest.js` |

`frontend/src/api/apiCalls.tsx` is a shared append-only file: packages may add
exported helpers to the end, never reorder or edit existing ones. Two packages
appending to it concurrently is acceptable; the orchestrator resolves the merge.

---

## Orchestration protocol

**Opus orchestrates. Sonnet executes. One work package per executor, fresh
context each time.**

### Why the split is drawn here

This repository has a documented, recurring failure mode, recorded in
`PRODUCT_GAP_REGISTER.md`: a work package reports "X deliberately not ported,
out of scope", which is reasonable in isolation, and nobody asks *where X lives
after this change*. Lifecycle status, drag-and-drop, entity creation and
write-permission gating were each lost that way and recovered later.

An executor with fresh context cannot catch that — it has no memory of what X
was. **The orchestrator holds the only context in which that question is
askable**, so asking it is a fixed part of accepting every package, not a
judgement call.

### What the orchestrator owns

- The register above, and the order things run in.
- Writing each WP's executable plan before dispatch, using
  `superpowers:writing-plans`. An executor never writes its own plan.
- Every decision that crosses a service boundary, changes a shared model, or
  touches a security boundary.
- The parallel-dispatch decision, gated on the conflict map.
- Acceptance. Nothing merges on an executor's own assertion that it works.

### What the executor owns

- Its package, to the brief, in TDD order: failing test → run it and watch it
  fail → minimal implementation → run it and watch it pass → commit.
- Following existing patterns in the file it is editing. This codebase carries
  unusually dense explanatory comments; **read the comment before changing the
  line it explains** — several of them record a bug that was already fixed once.
- Reporting honestly. A package that delivered three of four items and says so
  is worth more than one that claims four.

### The brief the orchestrator hands over

Every dispatch carries exactly these fields. A brief missing any of them is not
ready to dispatch.

1. **WP id and one-sentence goal.**
2. **The gap, with its evidence** — the file and line that proves the gap is
   real, copied from the register.
3. **Files to create, and files to modify with line ranges.**
4. **The pattern to copy** — a concrete existing file and line range doing the
   same thing. Nearly every package in this program has one.
5. **Interfaces produced** — exact exported names, parameters and return
   shapes that a later package will consume.
6. **Out of scope**, named explicitly, *and where each excluded thing lives
   instead*. Never a bare "out of scope".
7. **Definition of done** (below).
8. **Escalation triggers** (below).

### Definition of done

A package is done when all of these are true, with evidence in the report:

- [ ] Every step's test was watched failing before it was made to pass.
- [ ] The service's own suite passes against the **live stack**
      (`scripts/run-api-tests.sh`), with output recorded.
- [ ] `cd frontend && CI=true npm test` passes, and `npx eslint 'src/**/*.{ts,tsx}'` exits 0.
- [ ] Anything a user sees was verified **in a real browser**, not only in jsdom.
- [ ] `PRODUCT_GAP_REGISTER.md` has a dated entry: resolved / newly found /
      checked-and-fine.
- [ ] The report names anything deliberately not done, and where it now lives.

### Escalation triggers — stop and return to the orchestrator

An executor **must not decide** any of the following alone:

- A shared model or a cross-service contract needs to change.
- A new Kong route or gateway configuration change is needed.
- A new runtime dependency looks necessary.
- An assumption in the brief turns out to be false — **this is a success, not a
  failure.** The `craco`/`publicPath` finding in Wave A-2 and the release-lens
  finding that blocked sub-project 4 both came from an executor stopping here.
- Anything touching authentication, authorisation or project scoping.
- The package cannot be finished without also fixing something outside it.

### Review gate

Two stages, in order:

1. **Executor self-verification.** Runs the commands, pastes the output. An
   assertion without output is not verification.
2. **Orchestrator review.** Reads the diff, re-runs the suite, and asks the
   fixed acceptance question: *what did this change stop doing, and where does
   that capability live now?* Then browser-checks anything user-visible.

Failing review returns the package to a **fresh** executor with the review
findings appended to the brief — not to the same context, which will defend its
earlier choices.

---

## Explicitly not in this program

Real gaps from the same evaluation, excluded because they are not functional:
external tracker integration, deployment and provisioning, the CI gate,
approvals/baselines/signatures, granular roles, and internationalisation. They
are sequenced in the evaluation's own Waves E–H and should not be folded into
these packages opportunistically.

Functional gaps deliberately deferred, with the reason:

- **Milestones / sprints / iterations** — overlaps with what Releases become
  after F15. Decide after the lens exists, not before.
- **Estimation and time tracking** — no demand recorded from the owner; large
  surface for speculative value.
- **Exploratory / session-based testing** — a genuinely different execution
  model, not an extension of this one. Its own sub-project when wanted.
- **Cross-project portfolio reporting** — matters at a scale this product has
  not been load-tested at. Measure first.
- **Run scheduling** — depends on F12's configuration matrix to be meaningful.
- **Richer search: full text over steps and descriptions, filters, saved
  searches, cross-module search** — F01 delivers *parity* across the six
  modules, which is the gap that blocks daily work. Going beyond a regex over
  id and title wants a real text index and a query model, and is worth doing
  once rather than incrementally. Its own package when the six modules all
  search at all.

---

## Where this program stands

| Wave | Status |
|---|---|
| F1 — F01 search · F02 version history · F03 bulk parity · F04 status migration | **COMPLETE** (2026-09-06) |
| F2 — F05 tags · F06 shared steps · F07a/F07b parameterisation · F08 templates | F06 **DONE** (2026-09-08); F07a **DONE** (2026-09-13, authoring half); F07b **DONE** (2026-09-14) — **F07 complete**; F08 **DONE** (2026-09-20) — **Wave F2 COMPLETE** |
| F3 — F09 run identity · F10 partial re-run · F11 result binding · F12 config matrix | not planned |
| F4 — F13 RTM · F14 portability · F15 release lens · F16 notifications · F17 admin · F18 module 6 | F15 **DONE** (2026-09-19); F18 **DONE** (2026-09-19); F13 **DONE** (2026-09-24); F14/F16/F17 not planned |

The executable plan for F01 is at
`docs/superpowers/plans/2026-09-05-wp-f01-search-parity.md`.
