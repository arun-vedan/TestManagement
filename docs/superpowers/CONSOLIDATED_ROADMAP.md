# Consolidated roadmap — planned scope + what the build surfaced

Sub-project 1 is complete (all 12 acceptance criteria pass). This merges the
**three unspecced sub-projects from the original plan** with the **gaps the
work surfaced** (`PRODUCT_GAP_REGISTER.md`), into one sequence.

**Ordering principles**, in priority order:
1. **Live security exposure first** — it is not a feature, and it is cheap.
2. **Cheap fixes that unblock everyone** before expensive ones.
3. **Daily tester workflow** before administration and redesign.
4. **Dependencies respected**: a sub-project runs after whatever unblocks it.
5. **Subjective redesign last**, when the functional surface has stopped moving.

---

## Wave A — safety and cheap unblocks

Small, mostly mechanical, disproportionate value.

| # | Item | Why first | Size |
|---|---|---|---|
| A-1 | **C1: `fieldsService` tenant isolation** | A live hole: any authenticated user can read, rewrite or delete another project's field definitions, which rewrites other teams' forms. `savedView.js` in the same service already has the correct chain to copy. **Verified safe to scope**: the model has `projectId` and all live docs carry one, so adding scope will not blank existing forms. | S — backend, needs tests + a scope check in the controller |
| A-2 | **A4: deep links do not boot the app** | `"homepage": "."` emits a relative `<script src>`, so no project-scoped URL survives a cold load — in dev *or* production. Nothing is shareable, which undercuts WP-044's whole purpose. One config line, but verify the deployment assumption behind it. | S |
| A-3 | **Test debt: D1, D2, D6** | Make the creation E2E permanent (creation is core now and only a temporary spec covers it); add jest guards for the two WP-074c bugs; label `DynamicAutocomplete`'s combobox. | S |

## Wave B — the daily tester workflow

The gaps a tester hits on day one. **A6 is the single highest-value item in
this document.**

| # | Item | Why | Size |
|---|---|---|---|
| B-1 | **A6: raise/link a defect from a failing test run** | Fail a step → there is no path to a defect. Breaks the core QA loop and the traceability story the product otherwise supports. **Never existed**, so no migration could have caught it. | M |
| B-2 | **A2: search** | The source panel's search mode is a literal placeholder. A repository of any size is unusable without it. Backend wildcard search already exists (`/testrepo/wildcardsearch`). | M |
| B-3 | **A1: single-entity delete** | Bulk delete exists for two modules; there is no per-entity delete anywhere. A mistyped case cannot be removed. | S |
| B-4 | **B1: clone/duplicate** | Cheap once create + delete exist; authoring by duplication is a core habit. | S |

## Wave C — getting data in and out

| # | Item | Why | Size |
|---|---|---|---|
| C-1 | **A3: CSV import UI** | **The backend already exists** — `importExport.js` has `previewImport`/`commitImport` with an all-or-nothing commit and a dry-run preview. This is a UI job. | M |
| C-2 | **A3: export, and XLSX** | No export endpoint exists at all, and import is CSV-only while the owner asked for "csv or excel". Both are real additions. | M |

## Wave D — the planned sub-projects

| # | Item | Why in this order | Size |
|---|---|---|---|
| D-1 | **Sub-project 3 — Admin Fields configuration** | Its stated prerequisite (the `fieldsService` hole) is already closed by A-1, so it starts unblocked. Field definitions drive every detail form and can currently only be changed in the database. | M |
| D-2 | **Sub-project 4 — Release as module 6 + release lens** | **DONE** — see "Where the roadmap stands" below. The finding immediately after this table describes the state as of 2026-09-05, before this item was picked up; it is kept for its own record of why the naive plan wasn't a straight port. | done |
| D-3 | **Sub-project 2 — detail-view redesign** | Deliberately last: it is the most subjective and the most expensive, and it should land once the functional surface has stopped moving. Absorbs **B5** (the list view squeezed into a ~300px panel). | L |

## Not scheduled — needs an owner decision

- **B2 — bulk operations for requirements/plans/runs**: needs new backend
  endpoints; only test cases and defects have them.
- **B6 — legacy numeric defect statuses** (Bug-1/2/3 render as "2"): a data
  migration, not a UI fix.
- **D4 — seeded data drift**: TC-2 sits in folder `test44`. Restoring it needs
  a backend write that was blocked by the permission classifier.
- **D7 — refetch-on-focus vs in-progress inline edits**: a plausible
  interaction, unobserved. Worth a deliberate test before it is found live.

---

## Why not some other order

- **Search before defect-from-run?** Search is felt more often, but A6 breaks a
  workflow outright rather than making one slow, and it is the traceability
  story the product sells. A6 first.
- **Sub-project 2 earlier?** It is a redesign of screens the other waves are
  still changing. Doing it first would mean doing it twice.
- **Import before search/delete?** Import matters at onboarding; search and
  delete matter every day thereafter.


---

## Finding (2026-09-05): sub-project 4's release lens has no data model

Checked before starting D-2, not assumed. **No entity carries a `releaseId`.**
`grep -i release` across every model outside `releaseService` returns nothing
on test cases, requirements or defects.

What a Release actually links to:
- `Release.linkedTestPlanIds` → TestPlan Mongo `_id` strings, explicitly
  "reference-only, no FK/populate"
- `environmentId` on TestPlan and TestExecution

So "scope the workbench to a release" cannot filter Test Cases, Requirements or
Defects today. It would have to be derived transitively — release → linked
plans → those plans' test cases → executions of those plans → defects linked to
those cases — a **multi-hop join across four services with no aggregation
endpoint**. That is a backend design decision with a real cost, not frontend
work, and it is the actual product value of sub-project 4.

The other half — **Releases as workbench module 6** — is doable frontend-only,
but it is a port of `Pages/releases.tsx` (645 lines, working today and reachable
from the drawer) into the workbench. It buys consistency and finishes the
navigation split; it buys **no new capability**.

**Recommendation**: do not spend the port until the lens question is answered,
because the answer may change what module 6 needs to show. Both are recorded
rather than half-built.

## Where the roadmap stands

| Wave | Status |
|---|---|
| A-1 security · A-2 deep links · A-3 test debt | **done** |
| B-1 defect-from-run · B-2 search · B-3 delete · B-4 clone | **done** |
| C-1 CSV import UI · C-2 CSV export | **done** |
| C-2 XLSX | **needs a decision** — no spreadsheet library is present, and this repo has a documented bias against adding one for exactly this job |
| D-1 Fields admin | **done** |
| D-2 Releases | **done** — WP-F15/F18 (2026-09-19) gave module 6 a list/detail and a lens deriving membership from the generic link graph + `linkedTestPlanIds`, explicit-only at first (that package's own R4). WP-F15b (2026-09-23) reversed that R4: attaching a test plan now derives its own test cases and their requirements as release members too, so covering a release no longer means hand-linking every case and requirement a plan already contains. See `PRODUCT_GAP_REGISTER.md`'s 2026-09-19 and 2026-09-23 entries for the full ruling history. |
| D-3 Detail-view redesign | **needs direction** — the largest and most subjective item; deliberately last |
