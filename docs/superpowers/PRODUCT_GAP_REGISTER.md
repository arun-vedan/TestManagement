# Product gap register — srckube test management

**Purpose**: a standing evaluation of the product *as a test engineer would
use it*, updated at the end of every WP so gaps are tracked rather than
rediscovered. Migration WPs keep surfacing capabilities that quietly stopped
being reachable; this file exists so that stops being luck.

**Method**: every entry is verified against the running code or the live
stack, not inferred. Where something was checked and found to be FINE, it is
recorded too — so nobody re-investigates it.

Last updated: 2026-09-22, after the dropdown-height defect fix (theme `defaultProps` + `MainDrawer` AppBar height).

---

## A. Blocks day-to-day test work

| # | Gap | Evidence | Status |
|---|---|---|---|
| A1 | ~~No way to delete a single test case, requirement or defect.~~ | `EntityTreeNode.tsx`'s "Actions for &lt;name&gt;" menu -> Delete, confirmation dialog naming the entity, gated on `can('delete')` (not `can('write')`) | **RESOLVED** (Wave B-3) — per-entity delete for all five modules (test case/requirement/test plan/run/defect), each resolved to its real DELETE `.../:id` endpoint (which takes the Mongo `_id`, not the business key — a real bug caught only by browser verification, since every delete route is `findOneAndDelete({_id:...})`); verified live end to end via `e2e/specs/entity-creation.spec.ts` |
| A2 | **No search.** The source panel's `search` mode is a literal placeholder ("Search coming soon") and is deliberately excluded from the mode toggle. A repository of any real size is unusable without it — finding a case by id, title or text is the single most common action a tester performs. | `SourcePanel.tsx:25-26,33` | **OPEN** |
| A3 | **No import/export UI — but the CSV import BACKEND already exists.** `backend/testRepoService/controllers/importExport.js` implements `previewImport` + `commitImport` (all-or-nothing, dry-run preview with per-row source line numbers), mounted at `POST /testrepo/import/preview` and `/import/commit` behind `authorize('write')`. Only the frontend is missing, so this is a UI job, not a feature build. **Two real gaps remain**: it is **CSV only** (the owner asked for "csv or excel" — XLSX needs either frontend parsing or backend support), and there is **no export endpoint at all**. | `importExport.js:1-33`, `routes/testrepo.js:43-44`; no export route exists | **OPEN — owner requested; smaller than first assessed** |
| A4 | **Cannot share a link to anything.** Cold-loading any deep URL never boots the app: `"homepage": "."` makes CRA emit a relative `<script src>`, so `/projects/1/workbench/...` fetches `index.html` instead of the bundle. Pasting a test case or defect link to a colleague does not work — in dev *or* production. Undermines WP-044, which re-platformed every route onto project-scoped URLs precisely to make them bookmarkable. | `build/index.html` carries the same relative src; reproduced in Chromium | **OPEN — needs its own WP** |
| A5 | ~~The workbench is a dead end.~~ | | **RESOLVED** in `bf07bee` — wrapped in `MainLayout`, `100vh`/`10vh` conflict fixed, verified by measuring in the browser |
| A6 | **You cannot raise or link a defect from a failing test run.** A tester marks a step Failed and there is no path to a defect: `TestRunDetail` has no defect action and no links section at all. This breaks the core QA loop (fail → raise → track) and the traceability story the product otherwise supports (requirements ↔ tests via `LinkIssues`). **Checked: the deleted legacy `TestExecutionContent` had no such path either — this is a MISSING FEATURE, never a regression.** | `grep` for `postDefect`/`LinkIssues`/`defect` in `TestRunDetail.tsx` and in the pre-deletion `TestExecutionContent.tsx` returns nothing | **OPEN — highest-value product gap** |

## B. Weakens the workflow

| # | Gap | Evidence | Status |
|---|---|---|---|
| B1 | ~~No copy/clone of a test case.~~ | `EntityTreeNode.tsx`'s Actions menu -> Clone, opens a pre-filled `new:` draft (`useCloneEntity.ts`) through the module's normal create path, gated on `can('write')` | **RESOLVED** (Wave B-4) — clone for the 4 modules with a real create flow (test case/requirement/test plan/defect, `DRAFT_CAPABLE_MODULES`); module 4 (test runs, created from a plan) and module 6 (no detail component) deliberately not offered; verified live via `e2e/specs/entity-creation.spec.ts` (clone proven a genuinely separate record via distinct Mongo `_id`) |
| B2 | ~~Bulk operations only exist for test cases and defects, and defects have no bulk status change. Requirements, plans and runs have no bulk anything.~~ | `api/bulkApi.ts` now covers 5 of 6 modules (test cases, defects, requirements, test plans, test runs) — see the 2026-09-06 entry below for the per-module action asymmetry (the data model's, not a shortcut) and what's still deliberately excluded | **RESOLVED** (WP-F03) — verified live via `e2e/specs/bulk-operations.spec.ts` |
| B3 | ~~Releases are inert.~~ ~~Releases live in two places (nav drawer + workbench).~~ | `EntityDetail` now has a module-6 branch (`ReleaseDetail.tsx`) with real list + detail, linkable via the same `LinksSection` every other module mounts, and its own "Lens" tab (`GET /reports/release-lens`) reporting what is IN a release with every count's denominator (R5). WP-F18b then moved the remaining nav-page-only capabilities (create/delete, gate editing, environments) into that same detail view and Settings, and deleted `Pages/releases.tsx` and its drawer entry — one home, not two. | **RESOLVED** (WP-F15/F18, then WP-F18b) — verified live via `e2e/specs/release-wiring.spec.ts` and `e2e/specs/release-migration.spec.ts`; see the 2026-09-19 and 2026-09-20 entries below for the rulings and the non-vacuity transcripts |
| B4 | **No Fields administration UI.** Field definitions drive every detail form, and they can only be changed in the database. | sub-project 3, not yet specced | **OPEN — sub-project 3** |
| B5 | **List view is squeezed into the ~300px source panel** — a four-column grid truncates ids and dates. Pagination and saved views work; the layout does not. | `list-requirements.png` | **OPEN — owner design call** |
| B6 | ~~Legacy defect statuses render as raw numbers.~~ Bug-1/2/3 held numeric codes (1/2/8). **Corrected premise**: they did not "never map to an `istatus` name" — they mapped exactly, via `srckube-issuestatus.staus` (8=Closed, 1=New, 2=Open), the whole time. The gap was that nothing in the app read that mapping. | `backend/defectService/scripts/backfill-defect-status-names.js`'s header comment, cross-checked against `srckube-issuestatus.staus` directly | **RESOLVED** (WP-F04) — see the 2026-09-06 entry below for the two-part fix and its scale |

## C. Security

| # | Gap | Evidence | Status |
|---|---|---|---|
| C1 | **Tenant isolation hole in `fieldsService`.** `routes/field.js` mounts only `keycloak.protect()` — no `requireProjectScope()`, no `authorize()` — while `routes/savedView.js` in the same service has both. `updateField`/`deleteField` resolve by Mongo `_id` with no project check, so **any authenticated user in any project can read, rewrite or delete another project's field definitions**, which rewrites other teams' forms. Same class WP-021 closed elsewhere. | recorded in `AGENT_EXECUTION_PLAN.md`; still unfixed | **OPEN — must land with or before the Fields UI** |

## D. Test/quality debt in what we have shipped

| # | Item | Status |
|---|---|---|
| D1 | Creation is now core but is only covered by a **temporary** `_create-shot.spec.ts`. It needs a permanent E2E journey. | **OPEN** |
| D2 | Two of the three bugs found in WP-074c (Quill `source === 'user'`, `key={entityId}`) are guarded only by code comments and browser checks — no jest regression test. | **OPEN** |
| D3 | `npx eslint 'src/**/*.{ts,tsx}'` exits 1 on **31 pre-existing errors** in 6 AI-wave test files. The repo-wide lint gate cannot pass until someone owns them. | **OPEN** |
| D4 | Seeded data drift: **TC-2 sits in folder `test44` instead of at root**, left by a temporary drag-and-drop spec whose restore step failed. Restoring it needs a backend write that was blocked by the permission classifier. | **OPEN — needs owner** |
| D5 | `refetchOnWindowFocus`/`refetchOnReconnect` are still `false`; the flip was deferred from WP-071 until the legacy mutable trees are deleted. | **assigned to WP-078** |

## E. Checked and FINE — do not re-investigate

- **Dynamic fields**: every detail view loads its definitions from `fieldsService` via `getFields(<module>)`; nothing is hardcoded. Verified live: modules 1/2/5 have 7/5/7 field docs, module 3 has **0** (so no field form is correct), module 4 has 1 (the step-status dropdown).
- **Link types**: WP-011 shipped a real picker; `linkType` is sent and displayed, not defaulted silently.
- **Coverage**: `useCoverage` drives the Untested badge from the real endpoints.
- **Lifecycle status**: restored to the workbench in WP-074e after the cutover dropped it.
- **Drag-and-drop**: wired in WP-077b with a keyboard "Move to…" alternative; verified by a real drag in Chromium.
- **Execution step rollup**: ported verbatim; `test-execution.spec.ts` records a real Pass end to end.
- **Dashboard drill-down**: restored in the workbench and pre-emptively kept working for Defects.
- **Create Execution from a plan** (module 4): verified working; no second path added.

---

## How this file is maintained

Append a dated section at the end of each WP: what was evaluated, what moved
to FINE, what is newly OPEN. Do not delete entries — mark them resolved with
the commit that did it, so the history of what was nearly lost stays visible.

### 2026-09-04 — after WP-079a/b (creation flow)
- **Resolved**: creation of test cases, requirements, test plans and defects
  (was a show-stopper: four modules had been cut over with no create path).
- **Newly found and fixed**: draft data loss — values typed into a field and
  followed straight by Create were dropped, because the kit's controls only
  commit on blur.
- **Newly recorded**: A1 (no single delete) and A2 (no search) — both surfaced
  by evaluating the tool as a tester rather than as a migration.

### 2026-09-04 — after WP-077 (Defects cutover, all five modules migrated)

**Resolved this WP**
- **RBAC on detail views** (was newly discovered here, and it was serious).
  The legacy page gated its Edit affordance on `can('write')`; per-field
  inline edit removed that button and nothing replaced it, so from WP-074
  onward **a read-only user saw a fully editable form** whose writes the
  backend then rejected. Not a data hole — `authorize('write')` is mounted on
  every write route — but a misleading experience and a regression from the
  model WP-022 established. `FieldGrid` now takes `readOnly`, including for
  the two controls that write on selection (defect status, assignedTo), and
  the plan/run action buttons are gated directly. Guarded by `rbac.test.tsx`.
- Defects migrated; **all five modules now live in the workbench**.

**Newly recorded**
- **D6 — `DynamicAutocomplete` renders an unlabelled combobox**, which fails
  axe. Found while porting the defect a11y suite. It is a shared legacy
  component; the porting WP excluded the field from its fixture rather than
  fix it, so the gap is real and now untested. **OPEN.**
- **A3 corrected** (above): the CSV import backend already exists. This
  materially shrinks the import work — and reveals that **export does not
  exist at all**, which matters for sharing results with people who have no
  login.

**Evaluation note.** Three of the last four WPs each surfaced a capability
that had quietly stopped being reachable — lifecycle status, drag-and-drop,
creation, and now write-permission gating. The common shape: a migration WP
reports "X deliberately not ported, out of scope", which is reasonable in
isolation, and nobody asks *where X lives after the old page is deleted*.
**That question is now part of accepting any migration WP**, and it is why
this register exists.

### 2026-09-04 — after WP-078 (sub-project 1 complete)

**Resolved**
- **A5** — the workbench has the app chrome and is no longer a dead end.
- Navigation duplication: six module entries left the drawer per the owner's
  decision, taking a three-way vocabulary mismatch with them.
- `refetchOnWindowFocus`/`refetchOnReconnect` are back on, deferred since
  WP-071.

**Newly found — the most valuable gap in this register**
- **A6: no defect can be raised or linked from a failing test run.** Found by
  asking what a tester actually does after marking a step Failed. The answer
  today is: nothing — they leave the run, go to Defects, create one by hand,
  and no link records why it exists. **It has never existed**, which is why no
  migration WP could have caught it; only using the tool as a tester does.

**Newly recorded risks**
- **D7 — refetch-on-focus vs in-progress inline edits.** The field controls
  hold a per-field draft and reset it via `useEffect(..., [value])`. Now that
  a window-focus refetch is enabled, a value changed by someone else while a
  user is mid-edit will silently replace what they typed. Not observed, not
  proven — a plausible interaction of two changes made for good reasons
  separately. Worth a deliberate test before it is found in the wild.
- **D8 — a frozen dead chain blocks the rest of the teardown.**
  `editor` → `objectRepo` → `folderStructure` has no route and no importer,
  but deleting it was out of WP-078's scope. It still holds **five of the six
  remaining contexts, both dead dependencies, and all three remaining
  hardcoded hexes** — so spec §11's hex criterion cannot pass until it goes.
  Small, self-contained follow-up.

**Evaluation note.** With the migration finished, the useful question changes
from "what did we drop?" to "what has this tool never had?". A6 came out of
that shift, and it is worth more than anything the migration itself surfaced.

### 2026-09-04 — after Wave A (A-1 security, A-2 deep links, A-3 test debt)

**Resolved**
- **C1 — `fieldsService` tenant isolation.** Proven exploitable first: a field
  created under project 999999 could be read, updated and deleted while scoped
  to project 1, all returning 200. Now mirrors `savedView.js`'s chain, with
  controllers matching on `{_id, projectId}` and returning 404 (not 403) so
  they cannot be used to probe whether an id exists in another project. No
  data migration was needed — every live field doc already carried `projectId`.
  **This was sub-project 3's stated prerequisite, so SP3 is now unblocked.**
- **A4 — deep links.** The register blamed `"homepage": "."`; that was wrong.
  The real cause was `craco.config.js` replacing webpack's `output` wholesale
  and dropping `publicPath`, so the emitted `<script src>` was relative. Found
  only because setting `homepage` did **not** change the build output — a fix
  that would otherwise have been declared done and still broken. Verified in a
  real browser: a cold deep link now boots.
- **D1, D2, D6** — creation has a permanent E2E journey; the two WP-074 bugs
  have jest guards proven non-vacuous; `DynamicAutocomplete` is labelled and
  `assignedTo` is back in the defect a11y fixture.

**Worth recording about the E2E suite.** The six screenshot harnesses were
consolidated into one `module-smoke.spec.ts`. Reviewing them showed something
uncomfortable: **they asserted almost nothing** — typically just that the page
had a title. All three bugs they are credited with catching were actually found
by a human reading the screenshots they produced. The replacement asserts the
detail view does not hit a `RegionErrorBoundary`, which makes that bug class
fail on its own. Screenshots remain valuable for *finding* problems; they were
never a regression test.

**Still open, unchanged**: A1 (no single delete), A2 (no search), A3 (import
UI, no export, CSV-only), A6 (no defect from a failing run — still the
highest-value gap), B1–B6, D4 (TC-2 drift, needs a permission), D7 (refetch vs
in-progress inline edit).

### 2026-09-05 — after WP-F01 (search parity for plans and runs)

**Resolved**
- Search now covers five of six modules. `testPlanExecutionService` gained a
  `wildcardsearch` route on both of its models, each registered ahead of
  `/:id` and scoped by `requireProjectScope()` + `authorize('read')`.
  Module 6 (releases) still has none and still says so.

**Newly recorded**
- **A test run has no name.** `TestExecution`'s only top-level strings are
  `TestExecutionId`, `assignedTo`, `source` and `ciRunUrl` — verified by
  enumerating the schema, not grepped. `assignedTo` holds a raw Keycloak
  subject UUID rather than a name (confirmed against live data), so it is
  not searchable text either: nobody types a UUID. A run is therefore
  findable by its business id and nothing else, and its search result line
  is deliberately empty rather than showing an identifier a reader cannot
  use. This is the product gap behind a deliberately narrow feature.
  **OPEN — WP-F09.**
- **The three pre-existing wildcardsearch routes pass `req.query.search`
  into `$regex` unescaped**, so a search for `.` matches every document,
  and their frontend helpers do not URL-encode, so `&` and `#` are
  truncated in transit. The two routes added here do both correctly, which
  makes the behaviour inconsistent across modules until the older three are
  brought into line. **OPEN — deliberately not fixed here: it changes
  behaviour on three shipped features.**
- **45% of the frontend test suite does not execute.** Measured while
  verifying this package: `CI=true npx craco test --watchAll=false` reports
  **35 of 78 suites failing to run** on a pre-existing `keycloak-js` ESM
  parse error (`SyntaxError: Unexpected token 'export'`), reached via
  `src/keycloak.js` <- `src/api/axios.tsx`. 365 tests pass and **zero tests
  fail** — every failure is suite-level. This predates WP-F01 (the suite
  totalled 77 files before this package added one). It went unnoticed
  because CI runs only `npm run build` for the frontend. **OPEN — this is
  hard evidence for the evaluation's E3 finding.**
- **`npx jest` does not work in this repo's frontend.** It is a CRA/CRACO
  app; the working invocation is `npx craco test <path> --watchAll=false`.
  Recorded because two plan documents specified the wrong command.

**Checked and FINE**
- Kong needs no change: its `testPlanRoute` and `executionRoute` match on
  the path prefixes `/api/v1/testplan` and `/api/v1/testexecution` with
  `strip_path: false`, so both new sub-paths route without a gateway edit.

### 2026-09-05 — correction to a claim this register helped propagate

**Corrected: version history DOES have a reader.** Both the enterprise evaluation
and this program's F02 entry stated that `TestCaseVersion`/`RequirementVersion`
are written and served but never surfaced. That is false.
`Components/governance/LifecycleStatus.tsx:110-141` renders a "History" button
and a dialog listing `Version N` + timestamp, backed by `getTestCaseVersions` /
`getRequirementVersions` in `api/apiCalls.tsx:172-186`, and it is already mounted
in both `TestCaseDetail` and `RequirementDetail`.

The error came from grepping for consumers, seeing `LifecycleStatus.tsx` in the
result, and then summarising it as "nothing consumes either" without re-reading
it. A planned package was written on that premise and its first task was
reverted (`e4a12af`) after a task reviewer caught the duplication — it would have
shipped a second History dialog exporting two functions under names that already
existed.

**The real gap, which stands:** the dialog shows *when* a version was superseded,
never *what it contained*. Verified on live data — TC-1's summary changed at v2
and its step count dropped from 3 to 1 at v4, and none of that is visible.
**OPEN — F02, re-scoped to extend the existing dialog in place.**

**Newly recorded — the same UUID trap on a second field.** Snapshot `updatedBy`
holds a raw Keycloak subject UUID, exactly like `assignedTo` did in WP-F01. Two
fields now demonstrate the same underlying gap: **nothing in this product
resolves a user id to a display name.** Any feature wanting to show "who did
this" is blocked on it. **OPEN — belongs with WP-F09.**

### 2026-09-05 — after WP-F02

**Resolved: each version's content is now readable.** The History dialog in
`Components/governance/LifecycleStatus.tsx` was extended in place — each
`Version N` row is now an expander (`Accordion`) that, once opened, renders
that version's own `TestCaseSummary`/`requirementSummary`, description,
acceptance criteria, status, and a `TestSteps` count read through a small
allow-list (`SNAPSHOT_FIELDS` + `snapshotRows`). On the seeded `TC-1` this
makes the v3→v4 step drop (3 steps → 1 step) visible for the first time,
verified both in a Jest suite and against the real dialog in a browser
(`e2e/specs/version-history.spec.ts`).

**No diff view was built.** The task brief scoped this out deliberately: a
diff needs a decision about which snapshot keys are even comparable, and
`TestSteps`/`dynamicFields` are structured values with no display today.
Listing each version's own content — including the step count — is enough
for a reader to spot a drop like TC-1's themselves. A field-by-field diff
between versions is recorded here as this package's follow-up.

**`updatedBy` was deliberately not shown.** It is a raw Keycloak subject
UUID, not a name — the second field to hit this trap after `assignedTo`
(WP-F01). Displaying it would be a readability regression, not a feature.
Tracked with WP-F09 (user id → display name resolution) alongside
`assignedTo`.

**Checked and FINE**
- This package added no API module and no second History affordance. Both
  `getTestCaseVersions` and `getRequirementVersions` (`api/apiCalls.tsx:172-186`)
  were reused as-is; the existing dialog and its single History button were
  extended in place, not duplicated.

### 2026-09-05 — a latent defect in shipped bulk-delete rollback

**Found while implementing WP-F03, in code that already ships.**
`testRepoService/controllers/testrepo.js:470-487` (WP-043) restores a
partially-deleted batch with `new TestCase(doc.toObject()).save()`. That
re-runs the model's `pre('save')` hook, which guards on `this.isNew` —
true for a reconstructed document even with `_id` populated — so it calls
`getNextSequence()` and **overwrites `id` and `TestCaseId` with a fresh
value**.

The rollback would therefore restore each document's content under a *new
business id*, orphaning every `linkIssue` pointing at the old `TestCaseId`
and every audit row recording it. `defectService`'s bulk delete should be
checked for the same shape.

Unreachable in normal operation — it needs a Mongo failure *after* every id
has already been validated — which is why it has never been observed. But
if it ever fires it corrupts rather than restores, which is worse than the
partial delete it exists to undo.

WP-F03's new bulk deletes deliberately diverge: they restore with
`Model.collection.insertOne(doc.toObject())`, which bypasses model
middleware, because a rollback reinstates an exact prior state rather than
creating a document. **OPEN — the shipped `testRepoService` (and probably
`defectService`) rollback needs the same fix, in its own package.**

### 2026-09-06 — after WP-F03

**Resolved: bulk operations now cover five of six modules**, up from two.
Requirements and test plans/runs (`requirementService`,
`testPlanExecutionService`) got real bulk endpoints (Tasks 1/2), the
frontend's list configs and API client were wired to them (Task 3), and the
whole thing was driven in a real browser end to end — a genuine bulk
status change and a genuine bulk delete against records created for the
purpose, never against seeded data (Task 4, `e2e/specs/
bulk-operations.spec.ts`).

**The action set differs per module because the data model differs, not
because coverage is unfinished** — spelling this out so nobody "completes"
it later:

| Module | Bulk actions | Why not more |
|---|---|---|
| 1 Test Cases | Assign, Change status, Delete | full set — has both fields |
| 2 Requirements | Change status, Delete | no `assignedTo` field exists |
| 3 Test Plans | Delete only | neither `status` nor `assignedTo` exists |
| 4 Test Runs | Assign, Delete | no lifecycle `status` field exists |
| 5 Defects | Assign, Delete | no bulk status — see below |
| 6 Releases | none | list config exists (WP-F15/F18); no bulk endpoint exists for releases in either `releaseApi.ts` or `bulkApi.ts` |

**Newly recorded — defect bulk status was deliberately excluded.**
`defectService`'s status transition validates against `istatusservice`
over HTTP and **fails closed with a 503** if that service is unreachable.
Bulk status change is all-or-nothing across N items, which for defects
means N cross-service calls against a fail-closed dependency before a
single item commits — a materially different risk profile from the other
three modules' local, in-process enum checks (`LIFECYCLE_STATUSES`). This
was judged out of this WP's scope rather than silently skipped. **OPEN,
its own package.**

**Newly recorded — a contributor cannot bulk-act on test plans at all.**
Delete is TestPlan's *only* bulk action (no `status`, no `assignedTo` to
drive anything else from), and the shared e2e persona's role
(`contributor`) has `write: true, delete: false` — so `buildBulkActions`
returns an empty array, `checkboxSelection` never turns on, and no bulk UI
ever appears for this persona on this module. **Correct behaviour**, worth
recording before someone reports it as a bug. The same gating also means a
contributor can never reach bulk *delete* on **any** module — this WP's
own task brief initially assumed the contributor could reach requirements'
bulk delete directly; live verification (`permissions.ts`'s matrix,
mirrored in `buildBulkActions`) showed that path doesn't exist for that
persona anywhere, so `bulk-operations.spec.ts`'s delete coverage logs in as
its own throwaway `manager` persona instead — the same precedent
`entity-creation.spec.ts`'s clone/delete journey already set (Wave B-3/B-4)
rather than inflating the shared persona's role.

**Checked and FINE**
- `EntityList.tsx` needed no change at all for this WP.
`checkboxSelection={bulkActions.length > 0}` already turns selection on by
itself once a module's config offers any bulk action, and `BulkActionBar`
already renders nothing when the actions array is empty — both paths
pre-existed and just started being exercised by three more modules.

### 2026-09-06 — three findings WP-F03 surfaced in shipped code but did not fix

Each was found while implementing bulk parity, each is outside that package,
and each is recorded rather than half-fixed.

- **`testRepoService`'s bulk status change notifies nobody.** `updateTestCaseStatus`
  publishes `EVENT_STREAMS.STATUS_CHANGED`, and `notificationService` turns a
  transition into `'review'` into a manager notification. Its **bulk** path
  publishes nothing, so moving ten test cases into review one at a time notifies
  managers ten times and doing it in one action notifies nobody. WP-F03 fixed this
  for requirements; the test-case hole is untouched. **OPEN.**
- **The PATCH rollback loops swallow less carefully than the delete loops.** In
  `requirementService` and `testPlanExecutionService`, the compensating revert on
  the update path `await`s each restore with no `.catch(() => {})` — so the first
  failed revert aborts the rest — and returns the raw driver error rather than the
  descriptive "rolled back" 500 the delete paths and the canonical return. The
  caller cannot tell a rollback happened. Inherited from the canonical. **OPEN.**
- **`validateBulkIds` now exists in five places.** Cross-service duplication matches
  this repo's convention (services share only through `service-core`), but
  `testPlanExecutionService` carries **two copies in one service**, the second
  renamed `validateBulkExecIds`/`BULK_MAX_ITEMS_EXEC` to avoid a collision that two
  CommonJS modules cannot have. Raising the 500 cap now means editing two files and
  remembering both spellings. **OPEN — a `service-core` helper is the durable home.**

### 2026-09-06 — every backfill script in this repo can silently target the wrong database

**Found while running WP-F04's migration; it very nearly produced a green
no-op on real data.**

This machine has **two MongoDB servers on port 27017**: a native `mongod`
bound to `127.0.0.1:27017`, and the `mongodb` container published on
`*:27017`. A process running **on the host** that connects to
`127.0.0.1:27017` reaches the **native** server, not the container. The
native one carries a stale look-alike copy of `srckube-defects`, with
Bug-1/2/3 fixtures close enough to the real ones that WP-F04's
"abort unless exactly three documents match" guard would have **passed by
coincidence** — migrating the wrong database, leaving the real data
untouched, and reporting success.

Every backfill script in this repo documents host invocation
(`node scripts/<name>.js`) and reads `MONGO_URI` from `config/config.env`,
which points at `127.0.0.1`:
`requirementService/scripts/backfill-approved-status.js`,
`testRepoService/scripts/backfill-approved-status.js`,
`shared/scripts/backfillProjectId.js`,
`userService/scripts/backfillOrgProject.js`,
`linkIssueService/scripts/backfill-link-type.js`.

**Any of them, run as documented from the host on this machine, silently
operates on the wrong data.** `scripts/mongo-backup.sh` and
`mongo-restore.sh` already avoid this by running inside the container;
WP-F04's migration was run the same way and verified against the container
throughout.

This also means any past backfill whose result was confirmed only by the
script's own output, rather than by reading the container back, is worth
re-checking.

**OPEN** — the scripts should either run in-container by default or assert
which server they reached before writing. Its own package.

### 2026-09-06 — after WP-F04

**B6, corrected and RESOLVED.** B6's original premise was wrong: it claimed
Bug-1/2/3's numeric codes "never mapped to an `istatus` name." They mapped
exactly — the mapping was in `srckube-issuestatus.staus` the entire time,
and always had been:

| code | name |
|---|---|
| 8 | Closed |
| 1 | New |
| 2 | Open |

(Bug-1 held `8` as the string `'8'`; Bug-2/3 held `1`/`2` as JS numbers —
both shapes are real.) The gap was never a missing mapping; it was that
nothing in the app read it. That is now fixed in two parts:

- **The data** (Task 1, `ed33028`): a one-time backfill wrote the resolved
  name onto the three affected documents. Scale, stated plainly: **3 of
  116** defect documents in `srckube-defects`, all in project 1 — the only
  real (non-fixture) defects that exist; the other 113 documents, spread
  across other tenant-isolated projects, already stored names and were
  never touched.
- **The resolver** (this task): `Components/governance/DefectStatus.tsx`'s
  status lookup matched on `istatus` name only
  (`s.istatus.toLowerCase() === (status || '').toLowerCase()`), so a
  numeric id matched nothing — the chip fell back to the raw code and the
  status-change control disabled (`unrecognizedStatus`). Its sibling,
  `dashboardDrilldown/DefectFilterPanel.tsx`'s `resolveStatusName`, already
  solved this exact ambiguity by trying the id first and the name second —
  its own comment calls it "the same real-data ambiguity" defectSummary.js
  resolves server-side. `DefectStatus.tsx` now mirrors that shape (id via
  `String(s.id) === String(status)`, then name), and the resolved entry's
  `istatus` — not the raw `status` prop — is what the chip renders, so a
  legacy id resolves to a real name and the control re-enables. Proven by
  four new jsdom tests in `DefectStatus.test.tsx`; Task 1 already migrated
  the only three legacy records that existed, so no record remains live to
  exercise this path in the browser (verified anyway, live, in
  `docs/e2e-playwright-run-procedure.md`'s stack: Bug-3 now shows "Open"
  with an enabled control — that confirms Task 1's migration, not this
  resolver fix).

**Checked and FINE**
- The `ID_TO_NAME` map in `backfill-defect-status-names.js` is not
  invented — its header comment states, and this task re-confirmed, that
  it is `srckube-issuestatus.staus` copied verbatim (8=Closed, 1=New,
  2=Open, plus the five other ids Bug-1/2/3 didn't use). The script aborts
  with `process.exit(1)` and writes nothing if it ever finds a numeric
  `Status` outside that map, rather than guessing.
- The `staus` collection-name typo and `Deffered`'s stored spelling are
  both pre-existing, both out of this task's scope, and both deliberately
  left alone — the first because renaming a live collection is its own
  migration, the second because "correcting" it would break every
  comparison against the stored value.

### 2026-09-06 — the tenant-isolation suites leak a fixture on every run

**Found while implementing WP-F05; pre-existing and outside its scope.**

`tenantIsolation.test.js` in `testRepoService`, `requirementService` and
`defectService` creates a "WP-021 foreign" fixture in a second project and
cleans it up in an **unchecked** `afterAll` — so a failed or skipped cleanup
is silent. The result compounds: **116 orphaned foreign documents per
collection**, and the count rises by one per collection on every full-suite
run. `testPlanExecutionService` is unaffected.

Measured directly: `srckube-defects.defects` held **116** documents when
WP-F04 examined it and **119** a few hours later, after this session's
verification runs — the leak is live, not historical.

Two consequences worth knowing:
- It is why the defects collection looks like 113 fixtures around 3 real
  records. Anyone reading collection counts to reason about real data will
  be misled.
- Every CI or local full-suite run makes it worse.

**OPEN** — the fix is to assert the cleanup succeeded rather than firing it
and hoping, plus a one-time sweep of the existing orphans. Its own package.

### 2026-09-06 — the jsdom suite is not reliably measurable on this machine

Found while verifying WP-F21. The frontend suite's headline number drifts
run to run: across six full runs in one hour it reported 0, 2, 4, 8, 12 and
13 failing tests, with a **different set each time**, and every implicated
suite passes when run in isolation.

The pattern is load, not logic. This machine sustains a load average of
17-20 with the 26-container stack up, and the slowest suites — the four
`Dashboard` axe checks, plus `TestPlanDetail` and `TestRunDetail` — are the
ones that fail first. Stopping the dev server did not clear it.

Measured deliberately, same machine, minutes apart:

| State | Failing tests | Failing suites |
|---|---|---|
| Without WP-F21's changes | 8 | 38 |
| With WP-F21's changes | 4 | 37 |

So the changes under test made it *better*, and the residual failures are
environmental. But that comparison is the only reason anyone could tell —
**a real regression of one or two tests would be invisible in this noise.**

Consequences worth acting on:
- "The suite is green" cannot currently be asserted from a single run on a
  loaded machine. Isolation runs and before/after comparisons are the only
  trustworthy signals.
- Combined with the 34 suites that never execute at all (`keycloak-js` ESM),
  the frontend's effective safety net is much thinner than 424 passing
  tests suggests.

**OPEN** — the axe suites need either a longer timeout, serialisation, or to
be split out of the default run. Its own package.

### 2026-09-06 — after WP-F05 (tags)

**Resolved**
- **Tags on all five modules**, editable from every detail view, with a tags
  column in the list and click-a-tag-to-filter. `tags: [String]` is
  normalised in a model setter — trimmed, lowercased, de-duplicated — so
  every write path gets it, including bulk and CSV import. Whitespace and
  `null` are rejected with distinct, accurate 400s rather than silently
  rewritten.

**The design decision, recorded because it was an owner call**
- First-class `tags: [String]` rather than a new `'Tags'` custom-field type.
  The custom-field route was genuinely available — `fieldsService` has a
  `fieldType` enum and `FieldGrid` renders per type — but its values would
  land in `dynamicFields.<adminChosenName>`, and it was verified at the time
  that **nothing in the codebase filters on `dynamicFields` and it is not
  indexed anywhere**. Building tag filtering on that would have been
  unproven ground under a name that varies per project.

**Checked and FINE**
- Filtering needed **no backend query code at all**. `advancedResults`
  copies `?tags=` straight into the Mongo filter and a scalar matches any
  element of an array, so the field and its index were the whole job.
- The field is additive: proven against a real pre-existing document
  (`TC-1` has no stored `tags` key and reads back `[]` from the schema
  default). No migration was written or needed.

**Newly recorded**
- **Saved views still cannot capture a filter.** `EntityList` applies a
  selected view's `queryParams` but hands `getCurrentViewState` a hardcoded
  `queryParams: {}`, so a filter can be applied from a view and never saved
  into one. The local tag filter does not fix this. **OPEN.**
- **Tag suggestions come from the loaded list page**, not a project-wide
  vocabulary, because no such endpoint exists and this package declined to
  add one for a thin suggestion list. **OPEN if it proves insufficient.**
- **A Critical defect shipped in Task 3 and was caught only by review.** The
  tag chip's click ran through the grid's `onCellClick` and suppressed
  nothing, so `checkboxSelection` being on — true for anyone with write or
  delete — meant **clicking a tag to filter also armed that row for bulk
  delete**. No test caught it; it was invisible from the diff and required
  reading MUI's row-selection wiring. Fixed by moving the handler onto the
  `Chip` itself with `stopPropagation()`, which also made the chip a real
  `ButtonBase` and closed a keyboard-accessibility gap in the same move.
  Recorded as a caught-before-release defect, not a silent fix, because the
  package's own tests would have shipped it.
- **Two test suites were passing while exercising nothing.** The a11y suite
  had no `tags` in its fixture and rendered without the virtualization
  override, so the interactive chip was never mounted; and an earlier claim
  that the click "cannot be asserted in jsdom at all" was wrong —
  `disableVirtualization` is a first-party prop that mounts every column and
  was simply never tried. Both are now real coverage, each with a guard that
  fails if the markup stops being exercised.

### 2026-09-07 — operational findings surfaced during WP-F06

Three infrastructure facts found while building shared steps. None is caused by
WP-F06; all three would mislead someone later, so they are recorded here rather
than in a work package's own notes.

**1. `srckube-kong` is a git submodule, and it is 16 commits ahead of its remote.**
`.gitmodules` points `srckube-kong` at `git@gitlab.com:srckube-test/srckube-kong.git`.
Gateway config therefore lives in a **separate repository**, and the parent repo only
records a pointer. `git log origin/main..HEAD` in that submodule shows **16 unpushed
commits**, the oldest being `TD-21` and including `WP-061` (healthz routes), `WP-062`
(docs/openapi routes) and `WP-063` (the global CORS plugin) — all of them predating
this session. Consequence: a fresh clone of this project gets a Kong config missing
every route added since TD-21. The local stack works; a rebuilt-from-scratch one would
not. Nothing here pushes to that remote — it is a shared repository and 15 of those
commits belong to other work — but the divergence needs an owner's decision.

**2. `shared/service-core` is bundled per-service at image build time.** Each service
image contains its own copy, so a fix to shared middleware is live only in services
rebuilt afterwards. WP-F06 Task 2 changed `advancedResults`' `removeFields` and rebuilt
only `testreposervice`; the source is correct for all 17 routes that mount it, but 17 other
running containers still hold the old copy. Harmless in this instance (no other service
accepts `?expand=`, verified by grep) and stated plainly rather than left implied,
because the general case is not harmless: a security fix to shared middleware would be
silently absent from every service not rebuilt in the same change.

**3. The MCP `mongodb` tools hit the stale look-alike database.** Independently
confirmed by a Task 1 implementer: the `preconfigured` connection reported 0 documents
where `docker exec mongodb` found 13. Same root cause as the host-`mongosh` hazard
already recorded — a second mongod on `127.0.0.1:27017` — but the MCP tools were not
previously known to be affected, and they present as authoritative. **Every Mongo
inspection in this project must go through `docker exec mongodb mongosh`.** Three
independent confirmations to date.

### 2026-09-08 — `aiService`'s suite is not measurable in parallel

Found during WP-F06 Task 3 and **confirmed pre-existing by two independent methods**,
not accepted on assertion: a reviewer built a `git worktree` at the pre-task commit
(`8864e4e`), ran the suite there against the same live containers, and reproduced the
same class of failures; it also confirmed via `git diff 8864e4e cd982dc --stat` that
every flaky test file and all of `shared/service-core` are byte-identical across the
task's diff.

`cd backend/aiService && npx jest` fails **2-5 unrelated tests per run, a different set
each time** — 403-vs-400 project-scope races, coverage-count mismatches, a timeout. The
cause is shared "Default Project" contention between test files running on parallel
workers. `npx jest --runInBand` is **175/175 clean**.

This is the second suite in this project that cannot give a stable answer — the jsdom
frontend suite (0-13 failures per run, different sets) is already recorded above. The
cost is the same in both cases and it is not the failing tests themselves: **a suite
that varies run to run cannot tell you whether your change broke something**, so every
regression question has to be answered by isolation runs and before/after comparisons
instead. That is slow, and it is easy to misread a flaky failure as a real one (this
project has done exactly that at least once).

The fix is per-file project isolation rather than a shared "Default Project" fixture, or
`--runInBand` in the service's own test script if the isolation work is not worth it.
Until one of those lands, **`--runInBand` is the only trustworthy way to run this
suite**, and any report of aiService failures from a parallel run should be re-run in
band before it is believed.

### 2026-09-08 — Wave D-1's Fields panel has two test suites that execute zero tests

Found during WP-F06 Task 5, when an implementer was told to follow
`FieldsPanel.test.tsx` as the pattern for a new admin CRUD surface and reported that
the pattern file itself does not run. Verified independently, three ways.

**Both** `frontend/src/Components/settings/__tests__/FieldsPanel.test.tsx` and
`FieldsPanel.a11y.test.tsx` fail with `SyntaxError: Unexpected token 'export'` and
report **`Tests: 0 total`**. They are not failing tests — they are suites that never
execute a single assertion. The cause is an ESM-only dependency reached through
`FieldsPanel.tsx`'s `usePermissions` import chain, which Jest's default
`transformIgnorePatterns` does not transform; sibling suites elsewhere avoid it only
because they happen to mock `usePermissions`.

**This is not new and was not caused by WP-F06.** Confirmed by checking out the commit
before this work package began (`c53d8da~1`) in a throwaway worktree and reproducing the
identical failure. `git log` shows the files have not been touched since the Wave D-1
commit that introduced them (`d67e521`) — so the Fields configuration UI has shipped
from day one with both of its test suites running nothing at all, while appearing in the
tree to have unit *and* accessibility coverage.

**Why it went unnoticed is the part worth learning from.** This project's jsdom suite is
already recorded above as unmeasurable — 0 to 13 failures per run, different sets each
time. In a suite that is expected to be noisy, a deterministically broken suite is
indistinguishable from one more flake. The unmeasurable-suite problem is not just slow
and annoying; it actively hides real, permanent breakage. That is the second-order cost,
and it has now been paid once.

Not fixed here: it is outside WP-F06's scope and belongs to whoever owns Wave D-1's
coverage claim. The likely fix is a `transformIgnorePatterns` entry in the CRACO jest
config, or mocking `usePermissions` in both suites as sibling tests already do. **Until
then, no coverage claim for the Fields panel should be believed.**

**Not established:** whether other suites are silently in the same state. A full census
timed out and was not completed, so this entry claims only what was proven — these two.
Someone should run `npx craco test --watchAll=false 2>&1 | grep "Test suite failed to
run"` to completion and record the answer.

### 2026-09-08 — after WP-F06 (shared/reusable test steps, package closed)

**Resolved**
- **A step sequence can now be authored once and referenced from many test
  cases.** A new `SharedStep` collection in `testRepoService` (same service,
  same DB, same `projectId` tenant scoping as test cases). A test case's
  `TestSteps` row gains one optional field, `sharedStepId` — when set, the
  row is a *reference*, not a step in its own right; the Steps tab renders
  it as a "Shared" chip plus the shared step's title (`TableRows.tsx`), and
  editing/deleting the referenced step happens once, in a manager dialog,
  not per test case. Full CRUD (`/api/v1/sharedstep`), an insert picker, and
  a manager dialog all ship, gated on the same `read`/`write`/`delete` RBAC
  actions as every other route.
- **Proven end to end, not just per-layer**, by
  `frontend/e2e/specs/shared-steps.spec.ts`: a real browser creates a shared
  step through the manager, inserts it into a real test case, reloads (the
  reference survives as a reference — not two flattened copies), edits the
  shared step's first row through the manager, and confirms — via a live
  `GET .../testrepo?...&expand=steps` read, the only place a reference is
  ever resolved back into text — that the edit is visible everywhere the
  step is referenced. It also drives a genuine delete refusal (409, naming
  the blocking test case) through the real UI. Non-vacuity was checked by
  hand: the picker's insert handler was neutered to append a plain row
  instead of a reference, the journey failed at the very next assertion
  (no "Shared" chip, no title), and it passed again once reverted.

**The design decision, recorded because it was an owner call (R2)**
- **Storage stays canonical; expansion into flat `{testStep, Expected}` rows
  is explicit and opt-in**, via `?expand=steps` on testRepoService's two
  read routes, never automatic. The tempting alternative — expand on every
  read, so all ~18 existing consumers of `TestSteps` work unchanged — is a
  trap: the Steps tab editor would then read flattened rows, the author
  would edit one unrelated field, the editor would `PUT` back exactly what
  it read, and every reference in that test case would silently become a
  dead copy — with no error, no warning, and no way for anyone to notice
  until the next attempt to edit the *shared* step did nothing. Opt-in
  expansion means the only three call sites that need flat text (execution
  enrichment, AI, and — checked, not assumed — CSV export, which turned out
  to need no change at all) ask for it explicitly; the editor never does,
  so a read-modify-write round trip through it can never flatten a
  reference. `shared-steps.spec.ts`'s step-3 assertion (exactly one plain
  `testStep` textarea after a reload, not three) is the regression guard
  for this decision specifically.

**Checked and FINE (R1, R3, R5)**
- **R1 — a new collection, not a 7th workbench module.** `ModuleId` stays
  `1|2|3|4|5|6`; a shared step is never assigned, executed, or
  defect-linked, so it gets no tree/list/detail/tab-strip machinery of its
  own. `SharedStepManagerDialog`/`SharedStepPicker` are imported nowhere
  except `TestCaseDetail.tsx` — confirmed by grep, not assumed — so "create
  a shared step" necessarily starts from inside a test case's Steps tab,
  which is R3 (UI home is the Steps tab, not Settings) working as designed,
  not an accidental limitation.
- **R5 — no new versioning for shared steps.** Execution history stays
  honest with zero new code because `testexecution.js`'s enrichment already
  snapshots `TestSteps` onto the run document the first time a case is
  opened in a run (fetched via the *list* route, which is why expansion had
  to work there and not only on `/:id` — Task 2's premise 3). A completed
  run's steps are frozen at that moment; editing the shared step afterward
  cannot rewrite it, by construction, not by a rule someone has to
  remember. `shared-steps.spec.ts` proves the other half of the same
  design directly: a *live* test case (not a run) sees the edit
  immediately via `expand=steps`, because nothing there is ever snapshotted.

**Newly recorded**
- **A defect that shipped through five reviewed tasks and was caught only
  by Task 6's live Mongo round trip, not by any review and not by any of
  Tasks 1-5's own tests.** `TestStepSchema` (`testRepoService/models/
  testrepo.js`) is a strict Mongoose schema. Task 1 added `sharedStepId` to
  it deliberately (Ruling P1). Nobody added `sharedStepTitle` — the field
  `TableRows.tsx`'s reference-row branch renders next to the "Shared" chip,
  and that `TestCaseDetail.tsx`'s own header comment claims a reference row
  "carries only these two fields meaningfully" (`sharedStepId` and this
  one). It never did, in the database: strict-mode Mongoose silently
  stripped `sharedStepTitle` on every save. The picker's freshly-inserted
  row showed the title correctly (it was still only in React state,
  pre-save); the first save-and-reload wiped it, leaving a "Shared" chip
  with no title next to it — a real, user-visible defect, invisible to
  every jsdom test in Tasks 4-5 because they mock the API and never send a
  row through the real schema. Caught only because Task 6 inserted a
  shared step through a real browser, saved it, reloaded, and read the
  title back out of actual Mongo. Fixed here: `sharedStepTitle: { type:
  String }` added to `TestStepSchema`, `testreposervice` rebuilt, and the
  full `shared-steps.spec.ts` journey — including the non-vacuity probe —
  reverified green before and after. `testRepoService`'s full Jest suite
  (92/92) and the `sharedSteps`/`AddDeleteTableRows` jsdom suites (30/30)
  were reran clean afterward.

  **Fix round 1 — that schema fix DENORMALIZES the title, and that has a
  cost of its own: nothing fans a rename out.** `sharedStepTitle` on a
  stored `TestSteps` row is a one-time snapshot taken when the reference is
  inserted, not a live pointer — the schema fix above makes it survive a
  save, it does not make it stay in sync. Reviewer-reproduced live: rename
  a shared step through the manager, reload a test case that references
  it, and the OLD title still renders — an unexpanded read returns the
  stale stored value, only an expanded (`?expand=steps`) read returns the
  live one — and it never self-heals: the stale value is simply
  re-persisted on the next unrelated edit to that test case's steps, and
  two different test cases referencing the same shared step can show two
  different labels for it. **Resolution chosen:** keep the schema fix (do
  NOT revert it — reverting brings back the original blank-chip defect,
  which is strictly worse), and make `TestCaseDetail.tsx` resolve the
  DISPLAYED title live instead of trusting the stored one. It now queries
  `listSharedSteps()` on the exact same react-query key
  (`['sharedsteps', projectId]`) `SharedStepPicker`/`SharedStepManagerDialog`
  already use — so a rename made in the manager is reflected with no extra
  fetch — and prefers that live title over the stored `sharedStepTitle`,
  falling back to the stored value only while the list hasn't loaded yet or
  no longer contains the id (e.g. the shared step was since deleted). The
  query is gated on the test case actually having a reference row at all,
  so it costs nothing for the common case. **The stored `sharedStepTitle`
  is a fallback now, not the source of truth — the live library is.** This
  does NOT reintroduce the R2 read-modify-write flattening trap: it is a
  display-only resolution done in the component, never sent back to the
  server, and the editor still never passes `?expand=steps`. Proven
  non-vacuous the same way as the rest of this package: a new
  `TestCaseDetail.test.tsx` test seeds a stale stored title and a
  different live one and asserts the live one renders; making the
  resolver ignore the live list and always keep the stored value was
  confirmed to fail that test before the real fix was restored.
- **A review caught a real coverage gap Task 2's own tests initially
  missed, though never a functional defect, and it is now CLOSED, not
  outstanding.** Cross-project leak protection for `expandSteps()` was at
  first proven only by a mock, never against a live Mongo. The Task 2
  reviewer independently verified the mock was faithful (real `Number`
  types on both sides, and reverting the live `projectId` filter reproduced
  the exact predicted failure — not vacuous), so this was never a shipped
  bug. It correctly recommended extending `sharedStep.test.js`'s existing
  cross-project fixture one HTTP call further, to prove the expander too —
  and that follow-up was written in the same fix round the review itself
  triggered (`6a4fa8a`): `"counts usage only within the caller's project,
  and never expands another project's shared step text into a response"`
  (`backend/testRepoService/__tests__/sharedStep.test.js`) creates
  a real shared step in project A with real step text
  (`'PROJECT A SECRET STEP TEXT'`), a real cross-project reference from a
  project B test case, reads it back live with `?expand=steps` as project
  B, and asserts both that `TestSteps` comes back empty and that
  `PROJECT A SECRET` never appears anywhere in the response. Confirmed
  still passing as part of this task's own `testRepoService` run (92/92).
  An earlier draft of this entry stated this test did not exist — that was
  wrong, caught while writing this section, and corrected before the entry
  was committed rather than left standing.
- **Operationally**, this task needed `docker exec mongodb mongosh` (never
  a host `mongosh`, never the MCP mongodb tools) to sweep for leaked
  fixtures both before and after every run, and needed
  `docker compose build testreposervice` + `up -d` to get the schema fix
  above into the running container — the same not-rebuilt hazard already
  recorded in this file's 2026-09-07 entry, hit again here for real instead
  of only in theory.

### 2026-09-13 — after WP-F07a (parameterised test cases, authoring half — package closed)

**Resolved, and stated plainly what this is NOT.** One test case with
`{{placeholders}}` and a bound `Dataset` (its own collection in
`testRepoService`, mirroring `SharedStep`'s shape and delete-guard
contract) now replaces five near-identical copies. An author writes
`Log in as {{role}}` once, binds a dataset whose `role` column holds
`admin`/`viewer`/…, and previews any row's substituted text
(`GET .../testrepo/:id?substitute=<rowIndex>`) without that text ever
touching what is stored. **This delivers parameterised AUTHORING only —
it is NOT "data-driven testing done".** After this package, a test run
still shows **one row per test case**, exactly as before: nothing under
`testPlanExecutionService` was touched (R6, verified by an empty
`git diff --stat`), a run still addresses a case by `TestCaseId` alone,
and there is no per-iteration pass/fail anywhere. Per-iteration execution
results are **WP-F07b**, a separate, not-yet-started package, precisely
because it reshapes records of runs that already happened rather than the
authoring model this package touched. Anyone reading "F07a done" as more
than the authoring half is reading it wrong; this line exists so that
mistake has somewhere to be corrected.

> **CORRECTED 2026-09-14, after WP-F07b closed F07.** The paragraph above
> ("a test run still shows one row per test case") was accurate on
> 2026-09-13 and is **no longer true**. See the 2026-09-14 entry below: a
> run now produces one result row per bound data row, addressed
> independently. Left in place rather than rewritten, so the historical
> record of what F07a actually shipped (authoring only) stays intact.



**Proven end to end**, not just per layer, by
`frontend/e2e/specs/parameterised-cases.spec.ts`: a real browser creates a
2-column/2-row dataset through the manager dialog, authors a test case
whose first step carries `{{role}}`/`{{env}}` placeholders and whose
second is a plain, unrelated step, binds the dataset, previews row 1
(admin/prod) and asserts the substituted text renders in a read-only
column, previews row 2 (viewer/staging) and asserts the display changes,
then — **with a preview row still active** — edits ONLY the unrelated
step, reloads the page for real, and reads the stored document back
through `GET /testrepo` (the same route the browser used, called fresh
from the Node test harness — server truth, not the browser's cache) to
confirm the placeholder row's `testStep`/`Expected` are still exactly
`Log in as {{role}}` / `Dashboard shown for {{role}} in {{env}}`, with
neither `admin` nor `viewer` anywhere in the stored steps. It also drives
a genuine delete refusal (409, naming the blocking test case) through the
real "Manage datasets…" UI.

**The rulings (R1-R6) and their evidence:**
- **R1 — `Dataset` is its own collection, not a field on the test case.**
  A dataset is reusable across cases and needs its own usage query, same
  reasoning as `SharedStep`. Evidence: `models/Dataset.js`,
  `controllers/dataset.js`'s `findUsage` querying
  `{projectId, datasetId}` across `testcaserepos` independent of any one
  case.
- **R2 — substitution is a separate opt-in parameter, never folded into
  `?expand=steps`.** Both existing `expand=steps` consumers (execution
  enrichment, `aiService`) must keep seeing authored text; a substituted
  execution snapshot would silently record the wrong thing as history, and
  a substituted AI exemplar would teach the wrong pattern. Evidence:
  `controllers/testrepo.js`'s `wantsSubstitute` gate is a distinct
  condition from `expand === 'steps'`, and Task 3's own test suite proves
  `expand=steps` ALONE never substitutes.
- **R3 — substitution is never persisted, and never appears in an
  editable field.** The whole point of this package, per the brief. The
  editor shows authored text as the editable control and substituted text
  as a visually distinct, read-only sibling column
  (`TableRows.tsx`'s `previewRow` prop, wired as a parallel array in
  `AddDeleteTableRows.tsx`, never merged into the row objects
  `handleChange`/`setTcSteps` operate on). Evidence: this task's own
  browser journey (above) and the jsdom guard
  (`TestCaseDetail.parameterised.test.tsx`) both prove it; see "what
  reviews and this task caught" below for how close this one actually
  came to shipping broken.
- **R4 — expansion happens before substitution.** A shared step's own
  text may itself carry `{{placeholders}}`, which must resolve against the
  binding case's dataset. Evidence: `resolveSubstitutionRow`'s callers in
  `controllers/testrepo.js` always run `expandSteps()` first when
  `wantsSubstitute` is true, and Task 3's shared-step-with-placeholder
  test proves substitution reaches text that arrived via expansion, not
  just a case's own rows.
- **R5 — an unresolved placeholder stays visible as `{{name}}`, never
  blanked.** A blank reads as authored-empty and hides the problem; a
  visible placeholder names its own error. Evidence:
  `utils/substituteSteps.js`'s own comment and test: a placeholder with no
  matching dataset column is left untouched in the substituted output, and
  `DatasetBindControl.tsx` separately surfaces it as a `missing` alert in
  the UI rather than only failing silently server-side.
- **R6 — F07a leaves test execution behaviour byte-identical, with one
  dependency the path-scoped check does not itself cover.** What was
  actually verified: `git diff --stat bb251a7..HEAD -- backend/
  testPlanExecutionService` and the same against `backend/aiService` (the
  two `?expand=steps` consumers Premise 3 names) are both **empty** across
  all five tasks — no file under either service's own directory was ever
  touched. That is a narrower claim than "byte-identical execution
  behaviour": Task 3 also changed `backend/shared/service-core/middleware/
  advancedResults.js` (added `'substitute'` to `removeFields`), and that
  file is a **dependency** `testPlanExecutionService` loads too (per this
  file's own 2026-09-07 entry: shared middleware is bundled per-service at
  image build time, so a change to it is live in every service rebuilt
  afterwards, this package's own included). The path-scoped `git diff
  --stat` cannot see a dependency change at all, by construction — it only
  proves no file *under that service's own tree* changed. The reasoning
  that closes the gap is separate from that diff, not a consequence of it:
  `removeFields` only changes behaviour for a request that actually sends
  `?substitute=`, and no route or frontend caller in
  `testPlanExecutionService` (`routes/testexecution.js`, `routes/
  testplan.js` — grepped, not assumed) ever sends or expects that
  parameter. So the change is inert there in practice, but that is a
  reasoned claim about what nothing currently sends, not a mechanical
  guarantee the way the empty diff is for the two services' own code.

**What reviews caught that this package's own tests missed — the real
list, not softened.** Four separate incidents across five tasks, each
caught before it reached the next task rather than after the package
shipped:
- **Task 1 shipped a ragged-row validator that was dead code on the
  update path — in BOTH directions.** The validator that rejects a
  dataset row whose length disagrees with `columns.length` worked on
  create but was silently bypassed on `PUT`, for a Mongoose 5-specific
  reason: the timestamps plugin inserts a `$set` wrapper holding only
  `updatedAt` *before* the model's own `pre('update')` hook runs, while
  the caller's real fields are still top-level on the update document — so
  a naive `update.$set || update` lookup found the wrapper and missed
  everything that mattered. This broke in two directions at once: (a)
  silent corruption — a `PUT` with a shortened `columns` array against an
  unchanged, now-ragged `rows` array returned 200 and left the data
  ragged; (b) a functional regression — valid row edits that should have
  passed were *always* rejected 400, because the same broken lookup also
  fed the wrong data into the length check. The implementer had flagged
  this path as an explicit "Concern" in its own report; review found it
  was worse than flagged — genuinely untested, not merely under-tested.
  Fixed and reverification went past reading the fix: the re-reviewer did
  three separate container rebuilds with a single line reverted each time,
  confirming each half of the fix is independently load-bearing (revert
  the `instanceof` guard and both accept-cases flip back to 400; revert
  the `$set`-lookup fix and all three reject-cases flip back to 200) —
  not just that removing the fix broke *something*, but that it broke the
  *specific* thing each half exists to prevent.
- **Task 2's cross-project isolation test used a never-issued id, and so
  proved nothing about tenant isolation.** The `/parameters` route's
  cross-project guard was tested against an id that had literally never
  been assigned to any document — which 404s whether or not the
  `projectId` filter is even present, since "no document with this id
  exists at all" and "a document exists but not in your project" are
  indistinguishable through that test's own assertion. It read as
  isolation coverage while providing none — the same shape Task 1's
  Critical had, something that *appears* guarded, where the appearance is
  exactly what stops anyone looking twice. Review replaced it with a real,
  existing, other-project document, and both the implementer and the
  re-reviewer independently reproduced the actual leak (delete the
  `projectId` filter, the 404 becomes 200) by rebuilding the container —
  proving the replacement test is load-bearing where the original was not.
- **Task 3 silently substituted row 0 for an empty, hex, or signed
  index**, not just one bad-input case. `Number(rawIndex)` — the obvious
  first implementation — accepts far more than a row index should ever
  mean: `Number('')` is `0`, not `NaN`; `'0x1'` parses as hex `1`; `'+0'`
  and `' 3 '` both coerce to valid-looking integers. The realistic trigger
  is mundane and dangerous: an unset UI dropdown sending
  `?substitute=` with no value would have silently substituted row 0 with
  no error at all — exactly the "silent wrong answer" R5 exists to
  prevent, one layer up from the placeholder-text case R5 actually names.
  Fixed with `CANONICAL_ROW_INDEX` (`/^(0|[1-9][0-9]*)$/`), accepting only
  a bare non-negative decimal integer, verified live against all three
  bad-input shapes plus `abc`/`-1`/`1.5`/`01`/a URL-encoded space, while
  confirming the classic counter-trap was avoided: `substitute=0` (a
  legitimate row 0) still works on both routes, because the gate is
  `substituteParam !== undefined`, never a truthiness check that would
  treat `'0'` as absent.
- **The ORCHESTRATOR's own first R3 guard — on the property it had called
  the most important in the entire package — was vacuous along one
  route, and would have passed with the feature broken.** Written and
  committed as Task 4's PARTIAL state after an implementer was interrupted
  mid-task by a session rate limit, and disclosed at commit time as an
  unverified limitation rather than claimed as tested — which is the only
  reason it was caught rather than shipped. Root cause: `AddDeleteTableRows`
  mirrors its `rows` prop into local state via its own `useEffect`, one
  render behind the read-only preview cell, which reads its `previewRow`
  prop directly and updates immediately. A `waitFor` gated on "the preview
  cell arrived" therefore resolved as soon as the FAST path updated,
  before the SLOWER, potentially-corrupting render had painted — so an
  assertion about the editable field's value, made immediately afterward,
  passed for the wrong reason: not because the value was safe, but because
  the corrupted render had not happened yet. Confirmed non-hypothetical by
  reintroducing corruption a second way (folding the preview into
  `AddDeleteTableRows`' own `rowsData`, not just the commit path) — that
  variant passed against every assertion in the guard as it stood,
  although the corruption plainly reached the screen a moment later. Fixed
  with `flushPendingRenders()`, a real event-loop tick wrapped in `act()`,
  run before any assertion about the editable field is trusted — this task
  (WP-F07a Task 5) independently re-derived the identical failure mode one
  layer down, in the browser rather than jsdom (see the non-vacuity
  transcript in `task-5-report.md`): the very first thing the deliberate
  corruption broke was this same editable-field-shows-substituted-text
  property, one step before the R3-specific assertion the brief asked for
  even got there. Two independent tools found the same defect shape twice.
- **What review did NOT find anything wrong with:** Task 4's core design
  (preview as a parallel array, never merged; correct handling of a
  shared-step reference expanding into N substituted rows and staying
  aligned) and all of Task 2's write-side validation
  (`rejectInvalidDatasetBinding`) were sound on first pass — 2 Minor
  findings total across both, no Criticals, no Importants. Not every task
  in this package needed a fix round; recorded plainly rather than
  padding this list.

**The process fact worth keeping.** `advancedResults` (service-core) folds
every query key it does not recognise straight into the Mongo filter, so
`GET /testrepo?...&substitute=0` would have silently become a filter on a
field named `substitute` — matching zero documents — unless `substitute`
was added to that route's `removeFields` list. **This exact trap was
already documented as a verified premise in WP-F06's own comments**
(the `expand` parameter needed the identical treatment there), and this
package's plan — written before Task 3 was dispatched — **failed to
carry that lesson forward**; nothing in the plan named `removeFields` at
all. It was caught not by review, not by a test, but because the Task 3
implementer read the existing F06 comment in the code it was extending
rather than assuming the new parameter would just work — the comment
doing exactly the job it was written for, and about as strong a case as
this programme has for the standing rule that a comment records a
verified fact, not a stale guess. The gap was fixed before it ever ran
against real data (it shipped with its own regression test, unlike its
`expand` sibling, which shipped without one and was caught only in
retrospect back in WP-F06's own history) — but the near-miss is the
lesson: this is the second time a WP-F06 lesson had to be re-learned by a
later package reading the code rather than the plan remembering it.

**Non-vacuity, this task's own — corrected after final review (fix round
1).** The first probe reported here claimed more than it had shown. It
broke `AddDeleteTableRows.tsx`'s row-sync `useEffect` to fold whichever
preview text was showing into `rowsData` itself — which feeds BOTH the
editable field's displayed value AND the commit payload, since both read
from the same state. That corruption is real, but it is broader than R3:
the journey died at the very first post-preview DOM check (the placeholder
row's editable field showing `"Log in as admin"` instead of `{{role}}`,
with a preview merely active — no edit yet), which is a display-path
defect. **It never reached the edit-while-previewing-then-reload step at
all**, so it did not show that step's own assertions — the single most
valuable ones in this spec — guard anything. A break that fails four steps
early does not demonstrate the later step is load-bearing.

The final reviewer ran the correct, ISOLATED probe instead: corrupt only
the argument `handleChange` passes to `setTcSteps` (the PUT payload), leave
`setRowsData` (the DOM) untouched, and corrupt only rows OTHER than the one
actually being edited — so the display stays correct throughout and only
the commit silently carries substituted text for the untouched placeholder
row. Independently reproduced here: with that isolated corruption in place,
every pre-reload assertion passed (both preview rows displayed correctly,
the editable placeholder field read `{{role}}` throughout, the unrelated
edit and its confirmed server-side write all succeeded) and the journey
failed only at the post-reload DOM corroboration
(`expect(...nth(0)).toHaveValue(step1Text)` reading back `"Log in as
viewer"` instead). With that specific assertion additionally disabled, the
failure moved one step further down, to the fresh post-reload API
read-back (`expect(afterDoc.TestSteps[0].testStep).toBe(step1Text)`),
confirming that assertion — reading storage back through a live request
from the Node harness, not the browser's own state — is independently
load-bearing on its own, not merely redundant with the DOM check beside it.
This is what actually establishes the R3 edit-while-previewing step is
non-vacuous; the original (broader, display-path) probe did not establish
that, and this entry previously overstated it as "a stronger signal" when
it was weaker with respect to the property that step exists to guard. Both
probes were reverted (`git diff --stat` confirmed clean) and the journey
reruns clean. The full transcript of both the original probe and the
corrected isolated one is in
`.superpowers/sdd/2026-09-13-wp-f07a-parameterised-authoring/task-5-report.md`'s
"Fix round 1" section.

**Operationally.** `testreposervice` was already rebuilt and current for
this task (its container's start time postdated the last commit touching
`controllers/dataset.js`, confirmed before relying on it, and cross-checked
live with an authenticated `GET /api/v1/dataset` call). `docker exec
mongodb mongosh` (never a host `mongosh`, never the MCP mongodb tools) was
used to sweep `srckube-testrepo.datasets` and `.testcaserepos` for leaked
fixtures after three separate runs of the spec (two genuine passes plus
the one deliberately broken to prove non-vacuity above) — **zero** leaked
datasets and **zero** leaked test cases matching this task's fixture
markers in all three cases, including the run that failed mid-journey,
confirming the `finally` block's guarded cleanup ran regardless of where
the deliberate corruption made the test fail. Keycloak identities are
**not** stored in Mongo in this stack (a separate Postgres instance backs
Keycloak) — a leaked-user sweep there instead used the same Keycloak Admin
API `e2e/auth/persona.ts`'s own cleanup already calls
(`GET /admin/realms/srckube/users?search=...`), and found zero users
matching this task's `wp063-e2e-parameterised-*` persona prefix after all
three runs.

### 2026-09-14 — after WP-F07b (per-iteration execution results)

> **CORRECTED 2026-09-15, IN PLACE.** This entry claimed F07 was done and the
> feature "proven end to end". It was not. A whole-package review established
> that per-iteration expansion was **unreachable by any user-facing path**:
> `createTestExecution` persisted `TestSteps: []`, the enrichment guard was
> `if (!TestSteps)`, and `![]` is `false`. The proof this entry rested on
> depended on a `docker exec` `$unset` no user can perform. Fixed the next day
> (`default: undefined` on the model path) and independently re-verified
> through Kong with no Mongo assist — see the 2026-09-15 entry below. The
> claims in this entry are true only of the code as it stands AFTER that fix.
> Left in place rather than rewritten, because the mistake is the record: five
> reviewed tasks shipped green and two of them found the evidence without
> asking what it implied.

**F07 is done** *(see the correction above — this was premature when written)*. F07a (2026-09-13, above) delivered parameterised
AUTHORING: one case with `{{placeholders}}` and a bound `Dataset` replaces
five near-identical copies. F07b delivers the other half the entry above
explicitly said was missing: a RUN of such a case now produces **one
result row per bound data row**, each independently addressable, instead
of collapsing to a single ambiguous row. Together these are the whole of
F07 — data-driven testing, authored once and executed per row. The
2026-09-13 entry's "a test run still shows one row per test case" is
corrected in place above rather than rewritten, since it was true when
written.

**Proven end to end** by
`frontend/e2e/specs/per-iteration-results.spec.ts`: a real browser opens a
run built from a 2-row dataset-bound case, watches the stub row expand
into two on first selection (enrichment, Task 2), fails the `viewer/
staging` row and passes the `admin/prod` row independently, reloads the
page for real and confirms — both in the DOM and via a fresh
`GET .../getexecutiontc` call from the Node harness (server truth, not the
browser's cache) — that each iteration still holds its own status and its
own `iterationValues`, raises a defect from the failing row and confirms
both the draft form and the PERSISTED defect name `role=viewer,
env=staging` (R5), and reads `GET /reports/plan-progress` scoped to its
own `TestPlanId` to confirm 2 executed / 1 passed — this fixture's own
figures, not a global total contaminated by the other 14 seeded
executions or any other spec's activity.

**The rulings (R1-R5) and their evidence:**
- **R1 — `iterationIndex` is additive; absent means 0.** Every read
  (`caseIterationQuery`, `caseIterationFilterCond`,
  `matchesCaseIteration` in `controllers/testexecution.js`) uses `?? 0` or
  Mongo's `{$in:[0,null]}`, never a truthiness check — the classic trap
  this exact change invites, since iteration 0 is the ordinary case, not
  an absent one. Evidence: `iterationAddressing.test.js`'s dedicated
  "row genuinely missing iterationIndex in storage still resolves as
  iteration 0" case, and the backfill script
  (`scripts/backfill-iteration-index.js`) stamping all 14 pre-existing
  case rows to `iterationIndex: 0` with a verified-idempotent, reports-
  don't-assume design (see "what reviews caught" below for why that
  design mattered).
- **R2 — a run snapshots substituted text per iteration.** Each row's
  `TestSteps` is fetched once via `?substitute=<i>` and stored at first
  open; editing the dataset afterwards does not touch already-stored
  rows. Evidence: `iterationEnrichment.test.js`'s "editing the dataset
  after enrichment does not change stored rows" case, and this task's own
  journey never re-fetches a row once created.
- **R3 — reporting counts iterations INDIVIDUALLY in the two services
  that count rows at all.** `planProgress.js`/`passRateTrend.js` needed NO
  code change — both already did `bucket.total += 1`/`bucket.executed +=
  1` per `TestCases` entry, so N iterations of one case already count as N
  — Task 3 proved this with a test rather than assuming it, since the
  plan had already been wrong once about this exact file (see premise 5's
  own correction, 1a729d7). `workload.js` counts EXECUTIONS, not rows
  (`cases.every(...)` inside `isCompletedExecution`), and was deliberately
  left alone: a tester's workload is runs assigned, not data rows, and an
  execution is now "completed" only once every iteration is terminal —
  arguably more correct than before, not less.
  **This changes what existing dashboards MEAN, not just what they show.**
  A project that parameterises a case with 5 data rows sees that one
  case's contribution to `planProgress`/`passRateTrend` rise 5x relative
  to before F07b, with nothing having gotten worse — the work genuinely
  is 5 results now, not 1. `workload`'s numbers are unaffected (it never
  counted rows). Disclosed in the product, not just this register: Task 3
  added a plain, non-apologetic note where these figures render
  (`TestManagerSection.tsx`): *"Counts include one result per data row for
  parameterised cases."* A manager who saw a plan's executed-count jump
  needs that sentence in the same place as the number, not buried in a
  release note nobody reads.
- **R4 — a CI result with no iteration binds to iteration 0.** CI runners
  do not know about datasets; `resolveIterationIndex` treats an absent
  query param as 0 exactly like every other caller, so existing CI
  ingestion (`adapters/normalize.js`) is unaffected. A runner that wants
  per-iteration CI results can supply one later — this is stated plainly,
  not silently deferred.
- **R5 — a defect raised from a run carries the iteration and its data
  values.** "TC-9 failed" is not actionable when only the `viewer` row
  failed. Evidence: `TestRunDetail.tsx`'s `handleRaiseDefect` builds
  `iterationSuffix` from `selectedTc.iterationValues` (`?? {}`, never a
  truthiness check on `iterationIndex`, which is 0 for the ordinary case —
  the same R1 trap one layer up) and this task's own journey confirming
  both the draft form AND the persisted `Bug-N` document's `summary`/
  `description` contain `role=viewer, env=staging`, read back from
  `GET /defects` — server truth, not the form a moment before submit.

**What reviews caught that this package's own tests missed — the real
list, not softened:**
- **Task 2 shipped a SILENT LOST UPDATE, reproduced live.** The first
  draft removed the stub row and `splice()`-d in N replacements when
  expanding a bound case. Mongoose's `DocumentArray#splice` marks the
  WHOLE `TestCases` array modified, so `save()` sent the entire array back
  as one `$set` — meaning a concurrent, unrelated write to a DIFFERENT
  case in the same execution (a tester marking case B failed via
  `updateTestStep`, landing between this handler's own read and its save)
  was silently wiped back to its pre-update value, with no error: a plain
  field write never bumps `__v`, so `save()`'s own optimistic-lock check
  never fired to catch it either. Fixed by never replacing the stub (it
  becomes iteration 0 in place via the same targeted `.set()` every other
  write in this file already uses) and appending iterations 1..N-1 via
  `DocumentArray#push` — a genuine `$push` atomic that touches no other
  array element, concurrent or not, confirmed by reading Mongoose's own
  `_registerAtomic` call sites (`push()` vs `splice()` take different
  paths). `controllers/testexecution.js`'s own comment on this fix names
  it "a genuine, PROVEN silent-data-loss hazard, not just a theoretical
  one."
- **Task 1's backfill had a vacuous count that reported work remaining
  when there was none.** The "executions still needing backfill" count
  used the dot path `{'TestCases.iterationIndex': {$exists: false}}`,
  which also matches a document whose `TestCases` array is EMPTY — the
  path trivially doesn't exist there. Measured against real data: 5 of
  the 14 executions have an empty `TestCases` array; the dot-path form
  counted all 5 as "still needs backfilling" when the correct
  `$elemMatch` form counts 0. A migration script whose entire job is to
  report what it found rather than assume had a count that lied in the
  direction of "the migration did not work" — the worst direction for a
  migration report to lie in. Fixed in `c4668f0`.
- **The ORCHESTRATOR's own test instructions were wrong TWICE in this
  package** — this plan, not just an implementer's first draft:
  - Task 1's plan prescribed proving the falsy-zero trap by swapping
    `?? 0` for `|| 0` at the addressing call site. That swap is
    **mathematically inert**: for the exact input the trap is about
    (iteration 0, a falsy value), `0 ?? 0` and `0 || 0` both evaluate to
    0 — the fallback equals the falsy value being tested, so the two
    operators are indistinguishable at that input. The implementer
    verified this live, found it proved nothing, and reconstructed the
    actual falsy-zero trap (gating the check on truthiness instead) to
    probe against — which additionally surfaced a coincidental-pass gap
    in the first draft of the iteration-0 test itself, closed with an
    added order-sensitive case (`335cd37`'s own commit message).
  - Task 4's plan asked for a React-key-collision test ("assert three
    list items, not one"); the first implementation of that test spied on
    `console.error` for React's own "same key" warning TEXT. That test
    would stay green even where it proves nothing about the actual
    failure mode: it is coupled to warning phrasing a future React
    version could silently reword, and — the deeper problem — a
    same-order re-render never exercises the real reconciliation failure
    at all (verified empirically: a click-driven, selection-only
    re-render lets React match children positionally without ever
    consulting the key-based fallback, so the collision is harmless
    there). Fix round 1 (`476e0d8`) added the structural complement: force
    a react-query refetch that returns the SAME three iterations in a
    DIFFERENT order, and assert DOM node identity for one row survives
    the reorder — the one thing `key` actually exists to guarantee, and
    the one thing a warning-text spy cannot prove either way.
- **What review did NOT find anything wrong with:** Task 1's six
  addressing-site helpers (`caseIterationQuery`/`matchesCaseIteration`)
  and Task 4's `iterationLabel`/`iterationRowKey` pairing were sound on
  first pass. Not every task in this package needed a fix round; recorded
  plainly rather than padding this list.

**The durable technical fact worth keeping**, learned twice in this
package (Task 4's own fix round, then confirmed again by this task's own
non-vacuity probe below): **a duplicate React `key` is invisible to a
same-order re-render and only manifests on reorder, or on an assertion
that is itself identity-sensitive** (DOM node identity across a
re-render, or — as this task found — a derived `selected`/highlight state
computed from the same key-producing helper). A test that merely counts
rendered rows, or spies on React's own warning text, can pass while the
underlying collision sits there doing nothing observable until the day
the array reorders or grows past its first stable render.

**Non-vacuity, this task's own.** Required probe: revert
`TestRunDetail.tsx`'s list key from `iterationRowKey(tc.TestCaseId,
tc.iterationIndex)` to bare `tc.TestCaseId` and confirm the journey
fails. The FIRST attempt at this journey (both rows addressed and
labelled correctly by `iterationLabel`, since that function does not
depend on `rowKey` at all) **passed unchanged under the reverted key** —
the exact "invisible to a same-order re-render" fact above, reproduced
live rather than assumed. The journey does add and remove rows (1 -> 2
across the first Save), but React still matches the surviving element
positionally in that transition; nothing in the original journey ever
asked a question whose answer depends on `rowKey`'s IDENTITY rather than
the list's rendered labels. Fixed by adding the one assertion in this
component that actually does depend on it: `isSelected` (`TestRunDetail.
tsx`) is computed by comparing `rowKey` against `iterationRowKey
(selectedTcId, selectedIterationIndex)` — deliberately sharing the same
helper as the list `key`, "so the two cannot drift apart" per that file's
own comment. Under the reverted key, `rowKey` is bare ("TC-N") and can
never equal the suffixed comparison value ("TC-N::0" / "TC-N::1"), so
`isSelected` is always false and no row ever receives MUI's `Mui-selected`
class no matter which one was clicked — verified live with a throwaway
probe before writing the real assertion. With `expect(viewerRow).
toHaveClass(/Mui-selected/)` (and the symmetric "the other row is NOT
selected" check) added after each row click, the full journey now fails
at that exact assertion under the reverted key, and passes cleanly once
restored — confirmed by re-running the full spec green twice more after
restoring. `git diff --stat -- frontend/src/workbench/detail/modules/
TestRunDetail.tsx` confirmed clean (no residual change) before final
commit. Both the vacuous first attempt and the corrected, genuinely
load-bearing probe are transcribed in full in
`.superpowers/sdd/2026-09-14-wp-f07b-per-iteration-results/task-5-report.md`.

**A pre-existing gap this task found, independent of F07b.**
`createTestExecution`'s stub row always persists `TestSteps: []` — a
real, truthy empty array, Mongoose's own default for an array-typed path
even when the field is never sent in the request body — so
`getExecutionTestCaseDetails`'s enrichment branch (`if (!TestCases[0].
TestSteps)`) never fires through the live create-and-click flow alone,
for ANY execution, parameterised or not. Task 2's own test suite
(`iterationEnrichment.test.js`) already found and documented this,
working around it with a direct, docker-exec-only Mongo `$unset` on the
freshly created stub before exercising enrichment — this task's own spec
does the identical thing, for the identical reason, rather than
inventing a shape the real `createTestExecution` API never produces.
Whether a brand-new "Create Execution" click in the live product ever
actually reaches this enrichment path un-assisted (or whether some other
part of the write path already avoids empty-arraying `TestSteps`) was not
re-derived here — flagged for the product owner rather than silently
carried forward a second time without comment.

**Operationally.** `testplanexecutionservice` and `testreposervice` were
already rebuilt and current for this task (containers up 7+ hours,
confirmed the running code matched Tasks 1-4's committed source via
`docker exec ... grep` before relying on it — no rebuild was needed for
Task 5 itself, which touches only the frontend dev server and a
transient, fully-reverted probe edit). `docker exec mongodb mongosh`
(never a host client — a stray native `mongod` squats on
127.0.0.1:27017) was used for the enrichment-trigger workaround above and
for sweeping `srckube-testexecution` before and after every run:
**14 executions before this task's first run, 14 after its last** — the
two extra found mid-session (`Run-2051`/`Run-2052`, artifacts of this
task's OWN debugging against the live stack, not the spec) were
identified, traced to their source, and deleted through the same DELETE
routes the app itself uses before the final count was taken. Swept
`srckube-testrepo` (`testcaserepos`, `datasets` — the correct collection
names; an early sweep query against a guessed `testrepos` collection
silently returned zero and was itself a near-miss, caught by cross-
checking against a dataset-usage 409 that named a document the wrong
collection name couldn't find) and `srckube-testplan`/`srckube-defects`
for this task's own fixture markers: zero leaked test cases, datasets,
plans or defects after cleanup, including after the deliberately-broken
non-vacuity run (its own `finally` block ran the identical guarded
cleanup and left nothing behind). Keycloak (Admin API, never Postgres
directly): zero users matching this task's `wp063-e2e-f07b-*` persona
prefix, and zero remaining `wp063-e2e-*` of any prefix, after the full
session.

### 2026-09-15 — WP-F07b's reachability fix (F07 now genuinely COMPLETE)

**The gap the 2026-09-14 entry flagged rather than resolved is now
resolved.** The final review of WP-F07b (`.superpowers/sdd/
2026-09-14-wp-f07b-per-iteration-results/final-review.md`) proved live,
through the real public API with no Mongo assist anywhere in the flow,
that per-iteration expansion was **unreachable by any user-facing path**:
`createTestExecution`'s stub always persisted a real, truthy `TestSteps:
[]` — Mongoose's own default for an array-typed path, materialised even
when the field is never sent — so `getExecutionTestCaseDetails`'s
enrichment guard (`if (!TestCases[0].TestSteps)`, `![]` is `false`) could
never fire for any execution the API produces. A real "Create Execution"
click, opened, returned a bare stub — one row, no steps — for every case,
parameterised or not. The bug predated F07b (broken by the `[Mixed]` ->
schema normalisation on 2026-08-28); F07b inherited it, two of its own
tasks found and worked around it, and the package closed without
determining the consequence.

**Fix: one line, model-side.**
`backend/testPlanExecutionService/models/TestExecution.js` —
`TestSteps: { type: [ExecutionTestStepSchema], default: undefined }`.
This restores the pre-`[Mixed]` semantics the guard was actually written
against: a new document's `TestSteps`, when never sent, is now genuinely
absent (not `[]`), so `!TestSteps` is `true` and enrichment fires on first
open, exactly once. CI ingest is unaffected — `adapters/normalize.js`
sets `TestSteps` explicitly on every row it builds, so a CI result keeps
its own array and is never re-enriched.

**The obvious alternative was rejected, on the record.** Loosening the
guard to `|| TestSteps.length === 0` (controller-side,
`controllers/testexecution.js`) was considered and rejected: the
expansion path's `execution.TestCases.push(...rowsToAppend)` has no check
for iteration rows that already exist, so a case whose real test case
genuinely has zero steps would re-enrich — and re-push duplicate
iteration rows — on every single open. The model-side default keeps
"populated `[]`" and "genuinely absent" distinguishable, which is the
only way the once-only guard stays correct. This was finding #2 of the
final review and is why the fix is in the model, not the controller.

**Verified end to end, API-only, through Kong** (`http://localhost:8000/
api/v1`), the exact payload shape `TestPlanDetail.tsx`'s "Create
Execution" button posts (`TestCases: [{TestCaseId, TestCaseSummary,
TestStatus:'No Run', id}]`, `TestPlanId`, no `TestSteps`):
- A 2-row dataset-bound case expands into 2 rows on first open —
  `iterationIndex` 0/1, each with its own substituted step text and its
  own `iterationValues`, `iterationIndex=2` correctly 404s (no third
  row), and re-opening iteration 0 a second time does not add a third —
  confirmed via the full execution document (`TestCases.length` stays 2).
- An unbound (non-parameterised) case in the SAME execution still
  produces exactly ONE row, unsubstituted — the regression guard for
  every pre-F07b run, unaffected by the fix.
- The document persisted immediately after `POST /testexecution`, read
  directly from Mongo before any `getexecutiontc` call, has no
  `TestSteps` key at all on either case row (not `[]`) — the fix's whole
  mechanism, observed directly.
- All fixtures (1 dataset, 2 test cases, 1 test plan, 1 execution)
  created and deleted through the app's own DELETE routes; zero left
  behind (swept `srckube-testrepo.datasets`/`testcaserepos`,
  `srckube-testexecution.testplans`/`testexecutions` for this session's
  markers after cleanup).

**Regression test added** (not just the manual check above):
`backend/testPlanExecutionService/__tests__/iterationEnrichment.test.js`,
new describe block "enrichment fires with NO Mongo assist — the
reachability fix itself" — creates an execution through the API exactly
as above, with no `unsetTestSteps()` call (the very workaround every
other test in that file needs), and asserts the N-row expansion and the
unbound-case single-row guard. Proven in both directions, live: reverted
to the pre-fix schema and rebuilt, this test fails exactly as expected
(`iterationValues` undefined, `TestSteps` stays `[]`, no iteration 1);
restored and rebuilt, it passes. The rest of that file's existing tests
(which do call `unsetTestSteps()`) still pass unchanged — the `$unset` is
now a no-op against an already-absent field, not a required trigger.

**One pre-existing test broke as a direct, correct consequence of making
the guard live**, fixed here:
`backend/testPlanExecutionService/__tests__/iterationAddressing.test.js`'s
`createTwoIterationRun()` fixture used a fabricated `TestCaseId`
(`TC-${prefix}`) that was never created in `testRepoService`. Before this
fix, the dead guard made that harmless — a `getexecutiontc` GET against
it just returned the row as-is. With the guard live, that GET now tries
to enrich against a test case that genuinely does not exist and 500s.
Fixed by declaring `TestSteps: []` explicitly on that fixture's two rows
— marking them already-enriched, the same shape a real post-enrichment
row has — since that describe block tests **addressing** (which row a
given `iterationIndex` resolves to), not enrichment, and was never meant
to exercise the enrichment fetch at all. No addressing logic changed.

**Confirmed, live:**
- The 14 seeded executions (`Run-1`..`Run-14`) are byte-identical before
  and after — same count, same `TestCases`/`TestSteps`/`iterationIndex`
  content, same `updatedAt` — across the whole session including every
  test run. `default: undefined` changes what a NEW document gets when
  the field is omitted; it does not touch how an EXISTING stored value
  (`[]`, absent, or populated) reads back. The three legacy `[Mixed]`-era
  rows with `TestSteps` genuinely absent (`Run-5`/TC-1, `Run-9`/TC-2+TC-3,
  `Run-14`/TC-3) still read back with `TestSteps` absent, unchanged.
- Enrichment remains once-only: re-opening an already-enriched case
  (fresh API-created, and the legacy pre-`[Mixed]` rows) never re-fires
  or re-pushes rows.
- `backend/testPlanExecutionService`: full suite, `npx jest --runInBand`
  — **139 passed, 0 failed** (6 suites). `backend/testRepoService`: full
  suite — **155 passed, 0 failed** (11 suites).
- `testplanexecutionservice` was rebuilt and restarted from
  `backend/docker-compose.yml` after every source change (the container
  has no bind mount) — confirmed via `docker exec ... grep` that the
  running `models/TestExecution.js` matched the committed fix before
  relying on it.

**Not touched, per the known-unrelated note:**
`backend/reportingService`'s `handVerifiedFigures.test.js` (3 pre-existing
failures from seeded-data drift, unrelated to this fix, repair pending
with its owner).

**F07 is now genuinely complete**, not just proven-in-principle-behind-a-
dead-guard. `docs/superpowers/plans/2026-09-05-functional-gaps-program.md`'s
F07a and F07b rows are corrected to match this entry.

### 2026-09-15 — two work packages mutated seeded data and left it that way

Found while verifying WP-F07b Task 3, when a full `backend/reportingService` run
showed **3 failed / 45 passed** where the task had only reported its own 8 tests.

The failures were real, stable and nine days old. Three runs including
`--runInBand` gave the identical result, so unlike the jsdom and aiService suites
this one was giving a trustworthy answer that nobody was listening to.

**Two pieces of test residue, three failing tests:**

1. **A leaked requirement fixture.** `"WP-F03 delete fixture"`, created
   2026-09-05, left project 1 holding 6 requirements where `handVerifiedFigures`
   asserts 5. Broke the coverage test.
2. **A defect left mid-transition.** `Bug-2` carried its own confession: a
   `statusHistory` of `New → Open → Deffered`, three seconds apart, same user,
   2026-09-07 — WP-F04's defect-status work driving real seeded data through
   transitions and never restoring it. One change, two broken tests: the status
   breakdown (`"New": 1` became `"Deffered": 1`) and the release-readiness gate
   (open defects 2 → 1).

Both violate the rule every dispatch in this programme carries: **no test may
mutate or delete seeded data.** Repaired by restoring `Bug-2` to `New`, clearing
the test-created `statusHistory`, and deleting the leaked requirement. Suite went
from 45/48 to **48/48**. Both documents were backed up first; the diagnosis came
from the data, not from guessing — `Bug-2`'s own history named the culprit.

**The part worth keeping.** These tests were not flaky and not wrong. They were
*correct and ignored*, for nine days, because nobody ran the full suite and
because this project has taught its contributors to expect red. That is the real
cost of the unmeasurable-suite problem recorded above: it trains people to
discount signal from suites that are perfectly reliable.

Two mitigations, neither implemented here: the fixtures that leaked were created
through the API and could have been removed the same way (the e2e specs now do
exactly that, see the 2026-09-14 entry), and a `handVerifiedFigures`-style test
that asserts absolute seeded counts is a tripwire for exactly this class of
residue — arguably its most valuable property, and the reason to keep it rather
than loosen it when it next fails.

### 2026-09-15 — second instance of the WP-F20 pattern: a nav-drawer style leaking through the theme

Reported by the owner as a UI defect on the screenshot: on
`/projects/1/workbench/testruns/Run-11`, the run's "Test Cases" list rendered as
a cramped dark navy block with white text on an otherwise light page ("the test
case in test plan is not looking good").

**Note first: WP-F20 itself has no entry in this register.** The dispatch for
this fix asserted it did; it does not — `grep -r WP-F20` across the repo's `.md`
files returns nothing. It exists only as code comments in
`frontend/src/Theme/theme.tsx` and `frontend/src/Components/NavBar/MainDrawer.tsx`.
Recording it here now, alongside this second instance, since a pattern with only
one undocumented occurrence isn't yet a pattern anyone can find.

**The pattern, both times**: a style meant for the ONE nav drawer
(`Components/NavBar/MainDrawer.tsx`) gets declared in `Theme/theme.tsx` as a
global `styleOverrides` for the MUI component class the drawer happens to use,
rather than scoped to the drawer itself. Every other consumer of that component
class in the app inherits it whether or not it wants it.

- **WP-F20** (per the code comments, undated/unregistered before now): a global
  `MuiDrawer.styleOverrides.paper` set `backgroundColor: '#244855'` for the nav
  drawer. Four AI panels that are also `<Drawer>`s (`AiTestCaseDrawer`,
  `AiDuplicateCheckDrawer`, `AiDuplicateAuditPanel`, `AiLintPanel`) inherited a
  dark navy surface while rendering light-theme content (TextFields, Alerts,
  dividers) — **4 surfaces affected**. Fixed by moving the navy onto the nav
  drawer's own paper (`MainDrawer.tsx`'s `NAV_PAPER` constant).
- **This WP**: a global `MuiListItemButton.styleOverrides.root` set
  `backgroundColor: '#244855'` / `color: '#fff'` for the nav drawer's own list
  items. It leaked into every OTHER `ListItemButton` in the app — **2 surfaces
  confirmed affected**: the workbench search results list
  (`workbench/search/EntitySearchPanel.tsx`, the reported defect's unreported
  twin) and the run detail's Test Cases list
  (`workbench/detail/modules/TestRunDetail.tsx`, the reported defect itself).
  `Components/Lists/mainList.tsx`'s `ListItemButton` was investigated too — it
  already carries its own `styled()` wrapper with an explicit `background-color:
  #fff`, so it was never affected, and it isn't reachable from any route in
  `App.tsx` today (`WorkList.tsx`/`TemplateList.tsx`/`Pages/templates.tsx` are
  all dead code, dead route). **3 consumers total, 2 broken.**
  
  One extra finding while confirming the fix: removing the global override also
  broke the nav drawer's OWN unselected-item text color. `MainDrawer.tsx`'s
  `ListItemButton` never set its own text color — it was getting `color: #fff`
  for free from the global override, and once that was removed the label text
  fell back to `<a>`'s browser-default link-blue (react-router's `<Link>`
  renders an anchor). This is the exact risk the dispatch asked to confirm
  rather than assume, and confirming it in the browser (not just reading the
  code) is what caught it — reasoning about CSS inheritance from the drawer
  paper's `color: #fff` predicted it would work; it did not, because the
  anchor's own UA default wins over inherited color. Fixed by giving the
  `<Link>` itself an explicit `color: '#fff'`, and giving the `.Mui-selected`
  state its own explicit `color: '#006685'` (matching the shade the removed
  global override used to supply, so the drawer's selected-vs-unselected
  contrast is unchanged from before the fix).

  Also noted: the removed override contained `border: '1'` — not a valid CSS
  border value (no width unit, no style, no color), so it was inert; removing
  it changed nothing visually.

**Other global overrides in `theme.tsx` checked for the same shape** (a
component-wide style that in practice only one consumer wants) — none fixed
here, flagged for the owner:
- `MuiButton.styleOverrides.containedPrimary`, `MuiOutlinedInput`,
  `MuiTableHead`, `MuiTableCell`, `MuiChip` — all added together under WP-016
  specifically to centralize colors used by MANY consumers across the app
  (buttons/inputs/tables/chips generally), not one component's private style.
  Genuinely global-by-design, not a repeat of this mistake.
- `MuiFormLabel.styleOverrides.asterisk` — a single, app-wide "required field"
  red, also intentionally universal.

No other override currently sets a specific component's background/text color
in a way that only one named consumer would want, but the failure mode is easy
to reintroduce (exactly how this happened twice) — worth a second look if a new
single-purpose panel or drawer needs its own distinctive styling in future.

Fixed in `frontend/src/Theme/theme.tsx` (removed the global
`MuiListItemButton` override) and `frontend/src/Components/NavBar/MainDrawer.tsx`
(moved the navy text color local to the drawer). Verified live in the browser
(logged in as a disposable Keycloak persona, the same pattern
`e2e/auth/persona.ts` uses): nav drawer unchanged pixel-for-pixel, Test Cases
list and workbench search results now render as normal light-surface lists.

### 2026-09-15 — creating a folder in the workbench tree failed for every user, since the day before it was reported

Reported by the owner: the "New folder name" control in the workbench tree
did nothing. `folderService`'s logs showed a Mongoose `Folder validation
failed` cast error on every attempt: `Cast to ObjectId failed for value
"<uuid>" ... at path "createdBy"`.

`backend/folderService/models/Folder.js` declared `createdBy`/`updatedBy` as
`mongoose.Schema.Types.ObjectId`. The frontend
(`frontend/src/workbench/SourcePanel.tsx`) sends the signed-in user's
Keycloak `sub` claim — a UUID, 36 characters with dashes, never a 24-hex-char
Mongo ObjectId — so every real create request cast-failed before the
document was ever written. Reproduced live: a POST to `/api/v1/folders`
through Kong with a real Keycloak service-account token (whose `sub` is a
UUID, same shape as a human user's) returned `400` with exactly that cast
error; after the fix the identical request returned `201`.

**Every other service storing this same identity value uses `String`** —
`requirementService/models/requirement.js` and
`testRepoService/models/testrepo.js` both declare `createdBy`/`updatedBy` as
plain `String`. `folderService` was the only outlier. Fixed by matching
that shape exactly.

**When it broke — narrower than "always broken."** `git log` on
`backend/folderService/models/Folder.js` shows only two commits touching it:
the initial commit (which is where the `ObjectId` declaration comes from)
and an unrelated later WP-020c commit (atomic id-counter, did not touch
these fields). So the *model* has been wrong since day one. But the
workbench had no folder-creation UI at all until
`f6e9f7d` (WP-079a, 2026-09-04) — before that, the only place folder
creation happened (`Components/folderStructure.tsx`, since deleted)
hardcoded `createdBy`/`updatedBy` to a literal, `'643402068b556dee6a3e14de'`
— which happens to be a syntactically valid ObjectId, so it cast fine. That
literal is confirmed sitting in the `srckube-folder` database today on all
4 pre-existing folder documents (none of them resolve to a real user in
`srckube-user` — it was always a dummy value, not real attribution). WP-079a
deliberately replaced the hardcoded literal with the real Keycloak `sub` (its
own commit message calls this out as intentionally NOT porting the legacy
bug) — and that is the exact moment the latent model defect became a live
show-stopper. **Net: a defect present since the initial commit, dormant for
the project's entire life because nothing exercised it with a real user id,
and turned live by WP-079a on 2026-09-04 — one day before this report.**

**Existing data — no migration needed.** Queried `srckube-folder.folders`
directly (4 documents, none touched). All 4 carry the same dummy ObjectId
literal in `createdBy`/`updatedBy` described above. Changing the schema type
to `String` is purely additive: Mongoose casts a stored BSON ObjectId to its
hex-string form on read under a `String`-typed path, confirmed live by
`GET`-ing one of the 4 pre-existing documents after the fix — it came back
with `createdBy: "643402068b556dee6a3e14de"` (a string), no cast error, no
data rewritten. No backfill, no migration script.

**Read path checked** (`getFolders`/`getFolder`/`advancedResults(Folder)`):
no other code path — in `folderService` or any other service — imports the
`Folder` model or otherwise assumes `createdBy`/`updatedBy` are ObjectIds.
Nothing else needed a change.

Fixed in `backend/folderService/models/Folder.js` (`ObjectId` → `String` for
both fields, matching `requirementService`/`testRepoService`'s exact shape).
Regression test added at `backend/folderService/__tests__/folder.test.js`
(folderService had no test suite before this) — a black-box HTTP test using
a real Keycloak service-account token for its UUID `sub`, proven red against
the un-rebuilt container (`400`, same cast error as the live report) and
green after rebuilding+restarting the `folderservice` container from the
fixed source. `backend/folderService/package.json` gained `jest`/`axios`
devDependencies (test-only, mirroring `testRepoService`'s existing pattern
exactly — no new runtime dependency).

### 2026-09-17 — the dead-suite census, completed: 32 of 96 frontend suites run zero tests

The 2026-09-15 entry recorded two suites (`FieldsPanel`) that executed zero tests and
noted, honestly, that a full census had never been completed. It has now been completed,
and the answer is worse than the sample suggested.

**32 of 96 frontend test suites — one third — fail to run at all.** Not failing
assertions: `Tests: 0 total`. They appear in the tree as coverage and provide none.

**One cause, for all 32:** `node_modules/keycloak-js/lib/keycloak.js` is ESM-only
(`"type": "module"`, no CJS build) and Jest's default `transformIgnorePatterns` does not
transform `node_modules`. Any suite whose import chain reaches `src/keycloak.js` dies at
parse time, before a single test executes.

The casualties are not peripheral. They include the entire `EntityTree` suite (6 files,
covering drag-and-drop, delete/clone, the move menu and its a11y), `Workbench.test`,
`Workbench.a11y`, `WorkbenchChrome`, `EntityDetail`, `MainDrawer`, `ProjectSwitcher`,
`rbac.test`, all five AI panel suites, both CSV import suites, and the export API tests.
The workbench — this product's primary surface — has essentially no executing
component-level tests.

**Why it survived.** This register already records that the jsdom suite is unmeasurable
under load (0-13 failures per run, different sets each time). That has trained everyone,
human and agent, to treat red as background noise. A suite that never runs looks exactly
like one more flake, and 32 of them hid in plain sight behind that expectation. The same
mechanism let three genuinely-correct `reportingService` tests sit red for nine days.

**The fix is central and small**: add `keycloak-js` to `transformIgnorePatterns` in the
CRACO jest config, so it is transformed rather than skipped. The 2026-09-15 fix chose the
local route instead — mocking the import chain per suite — which was the right call for
two files and is plainly the wrong one for 32.

**Expect noise, and do not silence it.** These suites have never executed, so they have
never been validated. Resurrecting them will surface genuine failures and probably some
vacuous tests. That is the point: a failing test you can see is worth more than a green
one that never ran. Whoever does this must treat each newly-failing test as a finding to
investigate, not as breakage to suppress — and must not reach for `.skip` to get a clean
run.

### 2026-09-17 — links are bidirectional only by client-side double write, and deleting an entity orphans them

Two findings, from WP-F15/F18 Task 3 correcting an orchestrator premise.

**1. Bidirectionality is not a backend property.** The plan claimed `linkIssueService`
matched `{sourceId, destinationId}` or the swapped pair on read, so one record served both
directions. There is no such `$or` anywhere in the service. The swapped-pair match that
produced that claim lives in `deleteLinks`, which removes *both* directions — itself the
evidence that two records exist per logical link. Bidirectionality comes from
`linkissue.tsx` issuing a forward and a reverse `createLink`.

Confirmed in live data: of **11 logical links, 10 are mirrored pairs and 1 is a single
document** — a link visible from one end and invisible from the other.

**Why this matters beyond the correction.** A client-side double write has no atomicity. If
the second call fails, the user sees a link from the side they created it on and nothing
from the other side, with no error. Anything creating links outside that component — a
migration, a fixture, a future service, an API caller — produces a half-link unless it
knows to write both rows. Nothing in the service enforces or documents that.

**2. Deleting an entity does not delete its links.** The single one-way record is
`Bug-1072 → TC-4788`, created 2026-09-14. **Neither entity still exists** — both were
deleted, and the link outlived them. So link rows accumulate as entities are removed, and
a link table gradually fills with references to things that are gone.

Not fixed here: the orphan is left in place deliberately (it is evidence, and removing
user data is the owner's call), and cascade-on-delete is a design decision, not a bug fix.
Both are recorded so the next person does not rediscover them from scratch. If links are
ever used to drive a lens — which WP-F15 Task 4 is about to do — orphaned rows inflate
counts, so the lens should count only links whose endpoints resolve.

### 2026-09-19 — WP-F15/F18 closed: releases stop being an island (B3 RESOLVED, F15/F18 DONE)

A release was an island — it linked OUT to test plans only, and nothing linked back. This
package (Tasks 1-5) gave module 6 a real workbench presence: a list, a detail view, the
ability to link a release to the defects/requirements/test cases it covers via the
existing generic link graph, a backend lens answering "what is in this release", and that
lens on the screen a user actually opens. Proven end to end in a real browser via
`frontend/e2e/specs/release-wiring.spec.ts`.

**R1 — no `releaseId` field on any entity, and no schema change ANYWHERE.** The roadmap's
own F15 entry recommended against adding `releaseId` to five services and deriving
membership in `reportingService` instead. This package went further than that
recommendation and found it was cheaper than the roadmap assumed: `linkIssueService`'s
`srcModule`/`destinationModule` are plain `Number` fields with **no enum, no schema
constraint of any kind** — module 6 could be linked to anything the day this package
started, at zero schema cost. Confirmed against real seeded links in the same shape
(`Bug-1 → TC-1`) before a line of Task 3 was written. The roadmap's recommendation was
"derive it in reportingService instead of adding a field five times"; the actual answer
was "there was never anything to add — the join already existed and needed only a
consumer." *Cost if this is ever wrong*: a link is a weaker statement than a field — "a
defect belongs to exactly one release" cannot be enforced through the link graph. That
constraint, if ever wanted, is later, additive work; nothing here blocks it.

**R2 — releases are a real workbench module now: list + detail, like every other
module.** `entityListConfigs.tsx`'s `releaseConfig` (Task 1) and `ReleaseDetail.tsx`
(Task 2) give module 6 the same list/detail shape modules 1-5 have. `Pages/releases.tsx`
(the pre-existing CRUD + quality-gate page) stays as-is, not migrated — two entry points
is cheaper than a port done twice, and Pages/releases.tsx already owned release
create/quality-gate editing before this package touched anything.

**A real gap found and closed mid-package, not in the original plan: module 6 had no way
to be OPENED.** Task 1's list rendered rows; nothing made a row clickable. Checked why:
module 6 has no tree (releases carry no `parentId` — `Hooks/queries/useTreeChildren.ts`'s
`fetchLeaves` falls through its module switch to `default: return []` for module 6, so
`EntityTree` renders permanently empty for it) and no search config
(`EntitySearchPanel`'s own "not available" branch for module 6). `EntityList.tsx` wires
no click handler on any row, for any module — modules 1-5 never needed one because their
tree already gives a working entry point. For releases, the List view was therefore the
**only** place a release ever appeared in the product, and the only one with no way to
open it. Fixed narrowly: `entityListConfigs.tsx`'s `ReleaseIdCell` gives module 6's id
column its own click-to-open wiring (`openTab`/`setSelection` called directly from a
`renderCell`-mounted component, rather than threading a callback through `EntityList.tsx`
itself, which five other modules' own tree already serves and which this package had no
mandate to touch). Covered by a new jsdom test (`EntityList.test.tsx`, "clicking a release
row's id opens its detail tab in the workbench store") and exercised for real by
`release-wiring.spec.ts`'s own Step 5.

**R3 — the lens is derived in `reportingService`, computed fresh, never cached.**
`GET /api/v1/reports/release-lens?releaseId=<id>` (`releaseLens.js`) is deliberately NOT
routed through `ReportCache` (Task 4): that model's key is `(projectId, reportType)`, one
row per project per report, and a lens is keyed by `(projectId, releaseId)` — a finer
grain the cache was never built to hold. Same "always live" posture as releaseService's
own `getGateStatus`.

**R4 — release membership is explicit, never inferred.** A release contains what someone
linked to it (the generic link graph, for requirements/test cases/defects) plus its own
`linkedTestPlanIds` (a separate, pre-existing field). No date/sprint/status heuristic
invents membership. *Cost if wrong*: someone has to do the linking, and a release with
nothing linked reads as empty rather than quietly wrong (R5, next).

**R5 — every figure ships with its denominator.** The lens's own response carries
`links.rawLinkRowsSeen` / `distinctCounterparts` / `resolvedCount` / `unresolvedCount` /
`ignoredOtherModuleCount` alongside every per-type count, and `ReleaseDetail.tsx`'s Lens
tab renders them as sentences ("3 linked defects, 1 linked plan, 12 executed"), never bare
digits. A release with nothing linked at all (zero requirements/test cases/defects linked
AND zero test plans configured) reads **"Nothing linked yet"** — an explicit `Alert`, not
a computed percentage over an empty set and not an error. This matters because this
programme has shipped a confident number computed over nothing more than once: a vacuous
axe suite that passed while mounting none of the markup it tested (2026-09-08 entry
below), and a reachability backfill whose own report claimed work remaining when there was
none (2026-09-15 entry above). R5 is the standing defense against that same failure shape
recurring here.

**An orchestrator premise was wrong, and corrected mid-package (Task 3, restated here
because it is load-bearing for this whole package's Task 4/5 work).** The plan claimed
`linkIssueService` read links bidirectionally — a backend `{sourceId, destinationId}` OR
the swapped pair. There is no such `$or` anywhere in that service. Bidirectionality is a
**client-side double write**: `linkissue.tsx`'s `linkIssuesHandle` fires a forward
`createLink` then a reverse one. Confirmed against live data: of 11 logical links at the
time, 10 were mirrored pairs and 1 was a single, one-way document. This is why
`releaseLens.js`'s `collectCounterparts` queries `linkIssue` in BOTH directions
(`sourceId=<releaseId>` and `destinationId=<releaseId>`) and collapses on counterpart
identity — reading only one direction would silently miss any link whose forward write
landed but whose reverse write did not. Full detail in the 2026-09-17 entry above.

**Deleting an entity does not delete its links (restated, load-bearing here too).** The
live example is `Bug-1072 → TC-4788` — both entities deleted, the link document still
present, preserved deliberately as evidence and never touched by this package's own e2e
spec or its cleanup. `releaseLens.js` counts only links whose endpoints actually resolve
against their owning service's current data (`links.unresolvedCount` reports how many did
not) — an orphaned or cross-project link is silently excluded from every per-type count,
not counted as a phantom member. Full detail in the 2026-09-17 entry above.

**Readiness stays project-wide — by design, not by omission.** `computeReleaseReadiness`
(`/reports/release-readiness`) takes `(projectId, headers)` and always did; nothing in
this package changed its scope. A release-SCOPED gate verdict already exists, at
`releaseService`'s own `GET /releases/:id/gate-status` — `ReleaseDetail.tsx`'s Quality
Gates tab (Task 2) reads THAT, live, and states plainly when no gates are configured
("No quality gates configured for this release") rather than reporting a vacuous pass.
The two are deliberately not merged: `/release-readiness` answers "is the project ready
to ship, across every release in it" (a portfolio question `reportingService`'s other five
reports already answer at project grain) and `/gate-status` answers "does THIS release
currently pass its OWN configured rules" (a release question `releaseService` already
owned before this package started). Presenting the project-wide figure as if it were a
release's own would have been exactly the R5 failure shape this package exists to avoid.

**Open scope choice, stated plainly rather than left implicit: the lens does not count
module-3 generic links to test plans.** A test plan can be linked to a release two
different ways — `Release.linkedTestPlanIds` (the pre-existing, dedicated mechanism
`linkTestPlan`/`unlinkTestPlan` write) and, in principle, a generic link-graph entry via
`LinksSection` with `srcModule: 6, destinationModule: 3`. `releaseLens.js`'s own header
comment names this choice directly: counting a module-3 link too would let the same test
plan be "in" a release two different ways with two different answers for whether it is a
member. The lens counts only `linkedTestPlanIds`. Nothing in the product currently stops
someone from creating a module-3 generic link to a test plan from a release's Links tab —
`LinksSection`'s own issue-type list includes `TestCase`, not test plans specifically, so
this is unlikely to happen by accident, but it is not blocked, and if it ever does happen
the lens will silently not count it. Left open rather than fixed: closing it either means
blocking module-3 links from module 6 (a `LinksSection` change with no other module
precedent) or having the lens ALSO read the generic graph for test plans and merge/dedupe
against `linkedTestPlanIds` (more surface, for a case that has not been observed).

**Also found, not in the original task list, and left open: `releaseService` and
`Pages/releases.tsx` have no RBAC gate at all.** `releaseService/routes/releases.js`'s own
header comment says an `authorize(action)` layer "is being added concurrently... not
wired in here" — and it still is not; every route is `keycloak.protect()` +
`requireProjectScope()` only. `Pages/releases.tsx` calls no `usePermissions()`/`can()` of
any kind. A `viewer` can create, edit and delete releases today, through either the legacy
page or the API directly. Not fixed here (an RBAC change is exactly the kind of thing this
programme's own Escalation triggers hold out for the orchestrator) — recorded so it is not
rediscovered from scratch.

**Non-vacuity, performed, not merely reasoned about.** `releaseLens.js`'s
`collectCounterparts` was changed to unconditionally `return new Map()` — severing the
link traversal the whole function exists to perform — and `reportingservice` was rebuilt
and restarted from that source (containers here have no bind mount; a source edit alone
tests nothing). `release-wiring.spec.ts` was then run against the broken container and
**genuinely failed**, at exactly the lens assertion and nowhere earlier:

```
Error: expect(locator).toBeVisible() failed
Locator: getByRole('tabpanel').getByText(/1 linked defect/)
Expected: visible
Timeout: 20000ms
Error: element(s) not found
```

Everything before that line in the journey — creating the release/defect/requirement/test
plan, opening the release via the new click-to-open list cell, both link creations, the
test-plan link — still passed, because none of it depends on `collectCounterparts`; only
the lens's own counts do, and only the lens's own assertions failed. The failed run's
`finally` cleanup still ran correctly (try/finally, not gated on the failed assertion) —
confirmed via `mongosh` immediately after: 0 releases, 21 link documents (the seeded
baseline, unchanged), 3/5 defects/requirements in project 1 (seeded baseline, unchanged).
The source was then restored exactly (`diff` against the pre-edit copy showed no
difference) and `reportingservice` rebuilt and restarted again; `release-wiring.spec.ts`
was run twice more and passed both times. Five total runs across this task: 2 clean passes
before the break, 1 genuine failure at the break, 2 clean passes after the restore.

**Sweep, before and after all five runs (mongosh, `docker exec mongodb`, never a host
client):**

| Collection | Before | After |
|---|---|---|
| `srckube-release.releases` | 0 | 0 |
| `srckube-linkissue.linkissues` | 21 | 21 |
| `srckube-defects.defects` (project 1) | 3 | 3 |
| `srckube-requirements.requirements` (project 1) | 5 | 5 |
| `srckube-testplan.testplans` | 8 | 8 |
| `srckube-testexecution.testexecutions` | 14 | 14 |
| `srckube-folder.folders` | 5 | 5 |

No document matching either fixture marker (`E2E relwiring`/`E2E Release Wiring`) was
found in any collection after any run. Keycloak (Admin API, not mongosh — Keycloak is on
Postgres): 0 users matching the `wp063-e2e-release-wiring-*` username prefix, checked
after all five runs. The live orphan `Bug-1072 → TC-4788` was checked present and
untouched throughout. **Folder count note**: `srckube-folder.folders` holds 5 documents,
not the 4 this programme's plans have used as the seeded baseline — checked, and the 5th
(`moduleId: 6, folderName: "test-rel"`, created 2026-09-17) predates this task's own runs
by two days and was not created by anything in this package; it is prior drift from an
earlier task's own manual verification, carried forward unchanged, not a new leak.

### 2026-09-19 — the 32 suites are alive, and the first thing they showed is what they were NOT testing

The `keycloak-js` transform fix landed (`f131dd2`): **64/96 suites executing → 96/96**, 747
tests, 746 passing. Triage of the 32 resurrected suites found exactly **one** broken test
(a case-mismatch selector, `'Choose File'` vs `'Choose file'`), **zero** genuine product
bugs, and **zero** stale tests.

That result is suspiciously clean, so it was probed rather than celebrated — and the probe
is the finding.

**The WP-F21d guard has no coverage.** `EntityTree`'s `handleSelect` guards on
`isSelected`, because the tree library fires `onSelect` for the node being DESELECTED as
well as the one being selected. Without it, opening a second entity re-selects the first
as it deselects, and the app snaps back — reported by the owner as the screen flipping
between two tickets, fixed 2026-09-07.

Deleting that guard and re-running the whole resurrected `EntityTree` suite: **36/36 still
pass.** The fix that closed an owner-reported bug has no regression test, and the suite
that should hold one does not.

**Why it has none is the point.** When the guard shipped on 2026-09-07, this suite was
dead. A dead suite does not merely hide failures — it removes the feedback that would have
prompted writing the test at all. Nobody skipped it; there was simply nothing to be
answerable to. The resurrection restored the ability to notice that, which is worth more
than the 746 green tests.

**Attempts to add the test, and why none is committed.** Three were made and all abandoned
honestly rather than shipped:
1. Driving the real widget (focus → Enter → ArrowDown → Enter) **passes with the guard
   removed** — jsdom's run of that interaction never emits the deselect event, so the test
   looked like coverage and was vacuous.
2. Selecting by click does not select at all in this library; selection is keyboard-driven.
3. Spying on `<TreeView>` to invoke `onSelect` directly reached the branch, but wrapping
   the real component broke the six other suites that drive the genuine widget.

**Left as an open gap, deliberately.** A vacuous test here would be worse than none: it
would read as coverage for a bug that has already reached this owner twice. Closing it
properly needs either a library-level test seam or a Playwright journey, where the real
widget emits real deselect events.

### 2026-09-19 — testRepoService's own suite leaks fixtures, and versions accumulate without bound

Found while verifying WP-F08 Task 1, whose implementer noticed `testcaserepos` and
`testcaseversions` climbing across a full-suite run and correctly established the growth
was **not** from its own tests.

Measured in `srckube-testrepo`: **201 test cases** (167 earlier the same day) and
**2,549 test case versions**. Surviving fixtures carry names like
`"WP-021 foreign test case <timestamp>"` — tenant-isolation fixtures from a work package
that shipped long ago, never cleaned up, still there.

**Two distinct problems.**

1. **Fixture leakage.** Ten sibling test files in this service create test cases and do not
   remove them. Unlike the `sharedsteps`/`datasets`/`casetemplates` collections — which sit
   at 0 before and after every run, because the packages that added them were held to
   cleanup discipline — the older suites predate that expectation.

2. **Unbounded version growth, which is the larger one.** `TestRepoSchema`'s
   `pre('findOneAndUpdate')` hook snapshots the whole document into `testcaseversions` on
   **every** update. 2,549 versions for 201 cases is roughly 12 per case, and nothing ever
   prunes them. Each is a full document copy. This grows with every test run and every real
   edit, forever.

**Why it stayed invisible.** `handVerifiedFigures` asserts absolute counts for requirements
and defects, so drift there fails loudly — that tripwire caught two real incidents in this
programme. Nothing asserts a count for test cases or versions, so this grew unremarked.
A tripwire only guards what it counts.

Neither is fixed here: cleaning ten older suites is its own work package, and version
retention is a product decision (how long should a test case's history be kept?) rather
than a bug fix. Recorded so the next person does not rediscover it — and so that whoever
adds a retention policy knows the growth is real, not theoretical.

### 2026-09-20 — after WP-F08 (test case templates, package closed)

**Resolved**
- **A test case (or requirement, plan, defect) can now be saved as a named template and
  started from later**, closing the row's own gap: teams no longer reproduce their house
  shape for a case by hand from whichever old one someone remembers. A new `CaseTemplate`
  collection in `testRepoService` (`{id, CaseTemplateId ("CT-<n>"), projectId, moduleId,
  name, description, prefill: Mixed, createdBy, updatedBy, timestamps}`), full CRUD at
  `/api/v1/casetemplate`, gated by the standard `keycloak.protect() → requireProjectScope()
  → authorize()` chain (Task 1). "Save as template…" sits under each of the four
  draft-capable modules' `DetailHeader`; "Start from template…" sits beside "New …" in
  `SourcePanel.tsx`'s `CreateActions` (Task 2).
- **R1 — a template is a stored prefill, not a new entity type — held.** It carries the
  exact flattened shape `useCloneEntity` builds for a live record
  (`workbench/entityPrefill.ts`'s `buildEntityPrefill`), and starting from one replays the
  identical draft-open path (`workbench/openDraftFromPrefill.ts`) a clone uses. Verified live
  in `case-templates.spec.ts`: the draft opened from a template shows the "Create" button,
  not a saved record, and no fetch of an existing entity ever fires for it.
- **R2 — module-generic, hosted in `testRepoService` — held.** `moduleId` is validated
  server-side against `{1,2,3,5}` (`CaseTemplate.js`'s schema enum); the mechanism is proven
  end-to-end for module 1 here and unit-proven for 2/3/5 in Task 2's own suites.
- **R5 — delete with no usage guard — held, and confirmed to have nothing to guard.**
  Unlike `SharedStep`/`Dataset` in the same service, `deleteCaseTemplate` deletes
  unconditionally after the tenant-scoped lookup (`controllers/caseTemplate.js`). Correct by
  construction: R4 means nothing is ever created that *references* a template, so there is
  nothing a delete could orphan.
- **Proven end to end, not just per-layer**, by `frontend/e2e/specs/case-templates.spec.ts`:
  a real browser authors a test case with two steps, saves it as a template, starts a second
  case from that template and asserts — via the DOM AND a live `GET /testrepo` read — that
  the new case's summary and steps match the template's capture, THEN edits the original
  case's first step, THEN starts a THIRD draft from the same template and asserts — again
  via the DOM AND a live `GET /casetemplate` read of the stored document — that the reopened
  template still shows the pre-edit text, not the edit just made. Non-vacuity checked by
  hand: `useStartFromTemplate.ts`'s call to `openDraftFromPrefill` was changed to pass `{}`
  instead of `template.prefill`; the journey failed immediately at the first
  carried-fields assertion (`Summary` field empty). Reverted, it passed again. Both runs'
  edit was confirmed to have actually landed by re-reading the file before trusting the
  result — three probes elsewhere in this programme silently applied nothing and reported a
  passing suite that proved nothing.

**R4 — the sentence worth reading twice.** A `CaseTemplate` captures a record as it stood at
save time and never updates again in either direction — editing the source case afterward
does not touch templates already made from it, and editing a template never touches cases
made from it. This is the *exact opposite* of WP-F06's `SharedStep`: a shared step is a
**live reference** — one edit to the shared step propagates to every test case that
references it, immediately, with no snapshot anywhere. A `CaseTemplate` is a **snapshot** —
one save freezes it, and nothing that happens to the source record afterward, or that
happens to a case started from it afterward, is ever visible from the other side. Both
behaviours now exist in this same product, on the same Steps tab, one dialog apart
(`SaveAsTemplateDialog`'s own copy says so: "Later edits to this record or the template stay
independent of one another"). A user coming from shared steps has every reason to expect
propagation from a template too, and will not get it. `case-templates.spec.ts`'s Steps 5–6
are the regression guard for exactly this distinction, checked from both records
independently — the template's stored `prefill.TestSteps` after the edit, AND the original
case's own stored `TestSteps` after the edit, so a broken fix could not hide behind rolling
back the wrong side.

**The naming collision — read this before reusing anything called `Template`.**
`frontend/src/model/TemplateModel.tsx` (`{TemplateName, templateId, gitURL}`, rendered by
`Components/Core/TemplateList.tsx` in the create-project wizard) is a **project scaffold**,
unrelated to test-case templates, and was already live before this package existed.
`Pages/templates.tsx`/`Context/TemplateContext.tsx` are orphaned leftovers of that same
concept — nothing imports them. None of it was touched, extended, or renamed by WP-F08.
Every new symbol in this package is `CaseTemplate` — model, controller, routes, ids
(`CT-<n>`), collection (`casetemplates`), React components (`CaseTemplatePicker`,
`SaveAsTemplateDialog`), hooks (`useStartFromTemplate`) — specifically so grepping for
`Template` does not surface this feature next to the unrelated one and invite a future
reader to merge or reuse either into the other.

**The design decision, recorded because it was a plan-level call (extraction over
duplication)** — Task 2 pulled two pieces out of `useCloneEntity.ts` rather than writing a
parallel implementation for templates: `buildEntityPrefill` (the per-module "flatten a
record into a prefill" logic) and `openDraftFromPrefill` (mint a draft id, record the
prefill, open the tab, in that order). Clone and "start from template" now call the same two
functions; the only difference is a live fetch vs. a stored `CaseTemplate.prefill`. This
was not a style preference — this exact path had **already drifted once**: cloning a
parameterised test case silently dropped `datasetId` from the prefill, found only by
WP-F07a's own whole-package review after five reviewed tasks had shipped without noticing.
A second, independently-written flatten for templates would have been a second place for
that same class of bug to reappear, this time for a different field, found by a different
whole-package review some number of tasks later. `SaveAsTemplateDialog.test.tsx` carries a
`datasetId`-through-a-parameterised-case assertion specifically so this does not repeat a
third time; `case-templates.spec.ts` does not re-prove `datasetId` in the browser (Task 2's
suites already do, and Task 3's fixture is not parameterised) but does re-prove the shared
mechanism itself holds for `TestCaseSummary`/`TestSteps`/`Priority`.

**Checked and FINE (R3)**
- **R3 — call it `CaseTemplate`, never `Template` — held**, per the naming-collision section
  above; confirmed by a fresh grep across the whole package's new files, not assumed from the
  plan's own premise.

**Anything a review caught that this package's own tests missed: nothing new.** Task 3's
browser journey passed on its first attempt once its OWN authoring mistakes were fixed
(clicking "Steps" before filling step text, filling `Priority` while the "Steps" tab —
not "Details" — was active, and omitting the schema-required `TestCaseDescription` field
entirely, unrelated to templates and already true of every module-1 draft since WP-079). None
of those were product bugs; all three were caught by the journey failing loudly with a clear
cause, fixed, and re-verified. The one Mongoose-specific defect in this package (`Number`'s
enum validator silently accepting `{values, message}` and admitting nothing, breaking every
valid create) was self-caught by Task 1's own implementer during coding, fixed before its own
tests were written, and re-verified from a live container round trip — this record exists so
that fix is not "corrected" back to the `String`-style form later, not because a later review
found it. The one disclosed, still-open scope gap is Task 2's own: `deleteCaseTemplate` has
an API route (Task 1) and a client function (`caseTemplateApi.ts`) but **no UI caller
anywhere** — a template, once saved, can currently only be removed by a direct API call, not
through the product. R5 (no usage guard) means adding that control later needs no migration
or backfill; it is a product-scope decision Task 2 disclosed at the time, not a defect this
task found.

**Sweep, before and after `case-templates.spec.ts` (three runs: pass, deliberately-broken
fail, pass again)** — `srckube-testrepo.casetemplates`: 0 → 0. `srckube-testrepo.testcaserepos`:
201 → 201 (this package's own fixtures net to zero every run; the collection's pre-existing
drift from ten older suites, recorded above, is unrelated and was not touched). Keycloak
users matching this suite's `wp063-e2e-*` naming: 0 → 0.

### 2026-09-22 — "dropdown select height" turned out to be two unrelated bugs, both real

Reported by the owner as a UI defect ("the dropdown select height needs to be reduced in
all places.. there are overlaps due to that"), with the project switcher and the reusable
test-steps dialog named as the concrete places they saw it. Both named places already set
`size="small"` where the first-pass diagnosis expected them not to, which forced a second
look — the two things actually wrong there were not the same bug.

**Bug 1 — `Theme/theme.tsx` had no `defaultProps` at all.** Every `Select`/`TextField`/
`FormControl`/`OutlinedInput`/`Autocomplete` in the app rendered at MUI's medium (~56px)
height unless the individual file remembered to pass `size="small"` by hand. A grep found
most files do; a real minority don't, and which is which is pure accident of who wrote that
file. Two confirmed, screenshotted instances of the same component pair rendering at two
different heights side by side:
- **Settings → Fields → "New Field" dialog**: the Type `Select`
  (`Components/settings/FieldsPanel.tsx`, the dialog's `<FormControl fullWidth>` with no
  `size`) rendered visibly taller than the Module `Select` one panel up (same file, `
  <FormControl size="small">`).
- **Reusable test steps → "New shared step" dialog**
  (`Components/sharedSteps/SharedStepManagerDialog.tsx`): the Title and Description
  `TextField`s (no `size`) rendered taller than the per-step Step/Expected `TextField`s
  immediately below them in the same `Stack` (same file, already `multiline size="small"`).

Fixed once, in `Theme/theme.tsx`, with `defaultProps: { size: 'small' }` on
`MuiFormControl`, `MuiTextField`, `MuiSelect`, `MuiOutlinedInput`, and `MuiAutocomplete` —
not by editing the ~50 files that already pass the prop by hand (that stays a no-op for
them). Checked deliberately rather than assumed, against the installed `@mui/material`
source: `TextField` and `Select` each resolve and forward their own `size` explicitly to
the input they render, so `MuiOutlinedInput`'s default alone would not have reached them —
each needed its own `defaultProps` entry. `FormControl`'s `size` only reaches a descendant
that reads it from FormControl context; `OutlinedInput`/`Input`/`FilledInput` do,
`Radio`/`Checkbox`/`Switch` (via `SwitchBase`) do not — confirmed by reading
`SwitchBase.js`, so this default cannot shrink a checkbox group that happens to sit in a
bare `FormControl`. Multiline fields (`minRows`/`rows` — description fields, comment
boxes) were checked, not assumed safe: `size="small"` on `OutlinedInput` only reduces its
own padding (16.5px/14px → 8.5px/14px, from the installed component's own styles); it does
not touch `rows`/`minRows`. Verified live by filling a two-line description into the
now-"small" field and confirming both lines render uncropped.

**Bug 2 — unrelated to Bug 1 — `MainDrawer.tsx`'s `AppBar` was sized in `vh`, its own
content in fixed pixels.** `const APPBAR_HEIGHT = '5vh'` set the AppBar's `height`, while
its `Toolbar` child keeps MUI's own fixed `minHeight: 64px` at this app's breakpoints and
the ProjectSwitcher's `size="small"` `Select` is a fixed ~38px tall regardless of viewport.
5vh only reaches 64px at a 1280px-tall viewport; below that (any laptop screen), the
AppBar's own painted navy background falls short of its Toolbar's actual rendered height,
so the Toolbar's contents — the project switcher, the search/apps icon button, the
notification bell, the user menu — render past the bottom edge of the navy bar and
overlap the page content directly beneath it. This is why the reported control "already
had `size="small"`" and still looked wrong: the control was never the wrong size, its
container was.

Verified live, not inferred from reading the sx: logged in as a disposable Keycloak
persona (`e2e/auth/persona.ts`'s pattern), measured the rendered AppBar/Toolbar/Select
boxes via `getBoundingClientRect`, and cross-checked against actual decoded PNG pixel
colour (not `getComputedStyle`, which reads a box's declared colour whether or not that
box actually paints at the sampled point) at four viewport heights (900/800/720/650px @
1280px wide):

| viewport height | AppBar's own box height (before) | pixel at y=50, x=640/1015 (before) | AppBar box height (after) | pixel at y=50 (after) |
|---|---|---|---|---|
| 900px | 45px | white (255,255,255) | 64px | navy (36,72,85) |
| 800px | 40px | white | 64px | navy |
| 720px | 36px | white | 64px | navy |
| 650px | 32.5px | white, with the Select's own border visibly painted on it at y=44 (33,33,33 on white) | 64px | navy |

Before the fix, at every one of these four heights the navy background stopped short of
y=50 and the page's white background showed through underneath the toolbar's icon
cluster; after, the AppBar's own box is always exactly as tall as its Toolbar
(`APPBAR_HEIGHT` changed to a fixed `'64px'`, one constant still shared with the
fillHeight content-offset calc immediately below it, per the existing comment there), and
the same point is inside the navy band at all four heights.

**Same-shape inconsistency found but NOT fixed here — flagged for the owner**:
`Components/Layout/MainLayout.tsx`'s non-fillHeight branch offsets page content below the
AppBar with a *second*, independent `mt={'3vh'}` (plus a `height={'10vh'}` that a prior WP
already documented as harmless, since the wrapping `Box` defaults to `overflow: visible`).
That `3vh` was never tied to `MainDrawer.tsx`'s `APPBAR_HEIGHT` constant — it is a bare
literal in a different file, so it does not automatically track today's `64px` fix either.
In practice a fixed `p: 3` (24px) padding from `MainDrawer`'s own `main` Box sits between
the two and appears to absorb the gap on every page checked, but the two values were never
actually coupled, which is the same "two constants that happen to agree by luck" shape as
`APPBAR_HEIGHT` itself was before today. Not touched in this change (out of scope for the
reported defect, and every non-workbench page depends on it) — worth a second look if
short-viewport spacing above the fold is ever revisited.

Fixed in `frontend/src/Theme/theme.tsx` (five `defaultProps` entries) and
`frontend/src/Components/NavBar/MainDrawer.tsx` (`APPBAR_HEIGHT` from `'5vh'` to
`'64px'`). Jest suites for every component touched by either change (`MainDrawer`,
`ProjectSwitcher`, `FieldsPanel` + a11y, `SharedStepManagerDialog` + a11y,
`SharedStepPicker` + a11y, `EnvironmentsPanel` + a11y, `TestPlanDetail`, `TestCaseDetail` +
parameterised, `DatasetBindControl` + a11y, `SaveAsTemplateDialog` + a11y, `linkissue`
a11y, `ViewSwitcher`, `AiTestCaseDrawer`, `CsvImportDialog` + a11y, `AddDeleteTableRows` +
a11y, `SourcePanel`, `EntitySearchPanel`) run in isolation, all green — none asserted the
old medium height, so nothing needed updating to match the new default. Two disposable
Keycloak personas used for the browser verification, both deleted via the Admin API
afterward and confirmed gone (`GET .../admin/realms/srckube/users?search=dd-` → `[]`).

### 2026-09-23 — the "label sits on top of the input border" report is real, but is NOT this entry's `defaultProps` change, and is NOT fixed

A follow-up owner report, with a screenshot of `SharedStepPicker.tsx`'s "Search shared
steps" field: the floating label renders on top of the outlined input's top border
instead of in a cut notch — the leading hypothesis going in was that the 2026-09-22
`defaultProps: { size: 'small' }` addition to `MuiOutlinedInput` (this same entry, above)
left `MuiInputLabel` unsized, desynchronising the label from the input, or that
`MuiOutlinedInput`'s new default otherwise interferes with `TextField`'s notch-width
calculation.

**Both hypotheses are wrong, checked against the code before assuming.** Read the
installed `@mui/material` source directly (`OutlinedInput/OutlinedInput.js`,
`OutlinedInput/NotchedOutline.js`, `TextField/TextField.js`): `TextField` always passes
its own `label` prop straight through to `OutlinedInput` as an explicit prop
(`InputMore.label = label`), never through `defaultProps`, so no theme-level
`defaultProps` on any of these five components can suppress or alter it — the
`NotchedOutline`'s `withLabel = label != null && label !== ''` gate is unaffected by
`size`. Confirmed live in a real browser (Chromium via Playwright) that this is exactly
what happens: `legend`'s own `getComputedStyle(...).width` and `.maxWidth` are correct
(`112.156px`, `100%`) and `notched` is `true` in every broken case measured.

**Established this is NOT a regression from `6a1835e`, by checking out
`6a1835e~1`'s `Theme/theme.tsx` (the version with none of this entry's `defaultProps` at
all) into the working tree and reproducing live**: the identical broken render — a solid
border line running straight through the shrunk label, with no visible gap — appears on
`SharedStepPicker`'s "Search shared steps" field with the OLD theme too, and on a second,
unrelated field (`Components/settings/FieldsPanel.tsx`'s "New Field" dialog → "Display
name", which this entry's `defaultProps` change never touched in a way relevant here: it
reproduces at both the old theme's medium size and with `size="small"` added to it
explicitly). Theme restored to its current (`git checkout`) state afterward; nothing in
`theme.tsx` was changed.

**What it actually is: a real DOM/CSS-vs-painted-pixel divergence, most likely a
Chromium/MUI native `<fieldset>/<legend>` border-notch paint bug, not an app defect.**
Decoded the actual screenshot PNG pixels (per this file's own prior "don't trust
`getComputedStyle` alone" lesson, three entries up) rather than stopping at computed
style: the border-top is painted as one continuous line straight through the label
glyphs, with teal border colour visible in the gaps between letters — there is no cut
notch anywhere along that border, despite the legend's own computed box being exactly
right. Nine different attempts to make the notch repaint correctly on
`SharedStepPicker`'s field all failed: removing `autoFocus` and cold-clicking to focus it
manually for the first time ever, blurring and refocusing an already-mounted field,
typing a value while focused, waiting 2.5s untouched, forcing a viewport resize, and
forcing a targeted reflow directly on the `.MuiOutlinedInput-notchedOutline` element
itself (`display:none` → read `offsetHeight` → `display:''`) — broken every time.
Swapping the two fields' label TEXT between components (isolating "is it the string") did
not move the bug either — it stayed with the `SharedStepPicker` component regardless of
which label string it displayed. By contrast, `FieldsPanel`'s "Display name" field showed
the same broken paint on mount but self-corrected after a value was typed into it, in
every variant tried (default medium size, explicit `size="small"`, with or without an
added `sx={{ mb: 2 }}`) — the one procedural difference located between the two dialogs
is that `SharedStepPicker`'s dialog fires a `useQuery` (`stepsQuery`) whose
loading→loaded content swap lands directly below the field within the same paint window
that `autoFocus` shrinks its label, where `FieldsPanel`'s "New Field" dialog has no
concurrent fetch (its fields list is already loaded before the dialog opens) — a
plausible trigger for a paint invalidation race, but not confirmed to the same standard
as the rest of this entry; recorded as the leading lead for whoever picks this up, not as
an established cause.

**`MuiOutlinedInput.styleOverrides` was itself named as a suspect on review — tested
directly, on the field that never self-heals, and exonerated.** The reviewer's point was
fair: the first check above only proved `6a1835e`'s *`defaultProps`* additions weren't the
cause, because the OLD theme (`6a1835e~1`) still carried the pre-existing
`MuiOutlinedInput.styleOverrides.root` block (`borderRadius: '8px'` and the
`&.Mui-focused .MuiOutlinedInput-notchedOutline { borderColor: '#244855' }` rule) — that
block was never varied, so it was never actually tested. Both are individually plausible
for this exact symptom (a root-level `borderRadius` fighting the fieldset's own radius; a
focused-state override on the very element that has to carve the notch), so each was
removed in isolation and reproduced live on `SharedStepPicker`'s field (the one that never
self-heals under any condition, per above), with the resulting border decoded from actual
screenshot pixels each time, not `getComputedStyle`:

| variant | `MuiOutlinedInput.styleOverrides` | painted result | evidence (under `label-notch/`) |
|---|---|---|---|
| (a) current theme | `borderRadius: '8px'` + `Mui-focused` override, both present | broken — solid teal line straight through the label, x≈124 to the right edge, no gap | `notch-a-current-dialog.png`, `notch-a-current-pixelrows.json`, `notch-a-current-meta.json` |
| (b) `borderRadius` removed | `Mui-focused` override only (confirmed applied: computed `border-radius` dropped `8px`→`4px`, MUI's own default) | broken — identical pixel pattern to (a) | `notch-b-noradius-dialog.png`, `notch-b-noradius-pixelrows.json`, `notch-b-noradius-meta.json` |
| (c) `Mui-focused` override removed | `borderRadius: '8px'` only (computed focused border colour unchanged at `rgb(36,72,85)` — this override was always redundant with `palette.primary.main`, which is the same hex, so MUI's own default focused colour painted identically with or without it) | broken — identical pixel pattern to (a) | `notch-c-nofocusrule-dialog.png`, `notch-c-nofocusrule-pixelrows.json`, `notch-c-nofocusrule-meta.json` |
| (d) whole `styleOverrides` block removed | none — only `defaultProps: { size: 'small' }` left on `MuiOutlinedInput` (computed `border-radius` back to MUI default `4px`) | broken — identical pixel pattern to (a) | `notch-d-noneofit-dialog.png`, `notch-d-noneofit-pixelrows.json`, `notch-d-noneofit-meta.json` |

All four variants decode to the same painted result: a continuous teal line from
roughly the end of the label text to the right edge of the field, with border colour
visible in the gaps between letters over the label itself — i.e. no notch is ever cut,
regardless of which parts of `MuiOutlinedInput.styleOverrides` are present. `theme.tsx`
was restored (`git checkout`) to its original content between each variant and after the
last one; a byte-identical backup taken before this round of edits is kept at
`label-notch/theme.tsx.original-backup` for anyone who wants to diff it against the
current file. **This closes the gap the reviewer flagged: the theme's `MuiOutlinedInput`
`styleOverrides` block — both the `borderRadius` and the `Mui-focused` notch-colour rule
— was tested on its own, not merely left un-varied, and is exonerated.**

**Not fixed here.** No lever in `theme.tsx` — this entry's `defaultProps`, either half of
the adjacent `MuiOutlinedInput.styleOverrides` block, or removing all of it at once — was
shown to cause or cure this, so there is nothing left in this app's theme to safely narrow
or revert; doing so on a guess would be exactly the kind of unverified change this
register exists to catch. Filed here as a separate, real, pre-existing UI defect
(present since before this entry's own `defaultProps` change, and independent of it, and
now independent of the rest of `MuiOutlinedInput`'s styling too) for separate follow-up,
rather than folded into this entry's fix. Durable screenshots and decoded pixel data from
both rounds of live checking are kept under
`/private/tmp/claude-501/-Users-arunganesha-srckubetest/d1197281-59da-4a5d-812b-fa721d4e4f0e/scratchpad/label-notch/`
(19 files: 4 dialog screenshots, 4 tight border-region crops, 4 decoded pixel-row dumps,
4 metadata JSON files, one original-theme backup, listed in the table above) — reproduce
via `SharedStepPicker`'s "Insert shared step" dialog or `FieldsPanel`'s "New Field"
dialog, focus the first field, and compare the computed `legend` width/`notched` flag
against the actually painted border. No jsdom regression test was added: jsdom does no
layout, so it cannot observe a painted-pixel divergence at all, and the one DOM fact that
*is* checkable in jsdom — the legend's presence/attributes — reads as correct in both the
broken and the (hypothetically) fixed state, which is precisely the "test that passes
whether or not the bug is present" this programme has been burned by before; an honest
test here would prove nothing. Three disposable Keycloak personas
(`wp063-e2e-notchcheck-*`, `wp063-e2e-notchswap-*`, `wp063-e2e-notchabc-*`) used across
both rounds of live checks, all deleted via the Admin API afterward and confirmed gone
(`GET .../admin/realms/srckube/users?search=notch` → `[]`).

### 2026-09-23 — TestPlan carries the same ObjectId author-field bug folderService had

Found while verifying premises for the release-cascade work, not by looking for it.

`backend/testPlanExecutionService/models/TestPlan.js` declares:

```js
createdBy: { type: mongoose.Schema.Types.ObjectId },
updatedBy: { type: mongoose.Schema.Types.ObjectId },
```

This is the identical shape that broke folder creation on 2026-09-17: Keycloak's `sub`
is a 36-character UUID, a Mongo ObjectId is 24 hex characters, and the cast fails with a
validation error. Every other service in this repo stores that value as a `String`.

**It is currently dormant, for a reason worth knowing:** of 8 test plans, **zero carry a
`createdBy` value at all** — nothing in the create path writes it. So there is no failure
today, and equally **no author attribution on any test plan**. The bug springs the moment
anyone wires up "created by" on a plan, exactly as it did for folders the day a folder
UI first sent a real `sub`.

Not fixed here — it is outside the work package that found it, and the fix is the same
one-line type change plus a regression test. Recorded so the next person to add plan
attribution does not spend an afternoon on a validation error whose cause is already
documented twice.

Worth a sweep: these two services were found by accident. Any model declaring an author
field as `ObjectId` has the same latent defect, and nobody has checked them all.

### 2026-09-23 — WP-F15b closed: attaching a test plan now brings its cases and their requirements with it — and this REVERSES WP-F15's own R4

WP-F15/F18's R4 (2026-09-19 entry above) said **"release membership is explicit, never
inferred"** — a release contains only what someone linked to it, plus its own
`linkedTestPlanIds`. That was the right call at the time: it was cheap, auditable, and
matched every other module's linking story. It also had a cost that was invisible until
someone actually used it: attaching a test plan told a release nothing about the plan's
own contents. Covering a release meant linking every one of its test plan's cases, and
every one of THEIR requirements, by hand — the plan's membership and the release's
membership were two separate facts a human had to keep in sync manually. The owner hit
that cost directly (this WP's own brief opens with it) and asked for the obvious fix:
attaching a plan should bring its details with it. WP-F15b is that fix, and it reverses
R4 outright: a release's test cases and requirements are now **derived** through an
attached plan, not just **linked**. What R4 protected — a release never silently claiming
membership nobody could see the reason for — is now carried by R2 below instead of by
"nothing is ever inferred": derivation is real, but it is never allowed to look like a
link.

**R1 — derive, never write a link row.** The obvious implementation, when a plan is
attached, is to auto-create the same `linkIssue` rows a human would have created by hand.
Rejected on three counts: (a) once written, a human's link and a machine's are
indistinguishable — unlinking becomes ambiguous, does the row come back on the next sync
or not; (b) the link graph has no atomicity (2026-09-17 entry: bidirectionality is a
client-side double write, not a backend `$or`; 10 of 11 logical links are mirrored pairs,
1 is one-way) — auto-writing N rows on every attach multiplies a known fragility instead
of using it once per human action; (c) deleting an entity does not delete its links
(2026-09-17 entry: the live `Bug-1072 -> TC-4788` orphan) — auto-written rows would
accumulate orphans faster than hand-written ones already do. Deriving instead means
detaching a plan removes its members instantly, with nothing to clean up and no orphan
risk at all — proven directly by
`frontend/e2e/specs/release-derived-membership.spec.ts`'s own detach step, which finds
"Nothing linked yet" again immediately, not a residue of stale rows a cleanup pass missed.
*Cost if wrong*: a traversal cost on every lens read, which the lens already pays fresh on
every call (R3 of the 2026-09-19 entry — it was never cached in the first place).

**R2 — derived and asserted must be visibly different, and this is what now carries R4's
old protection.** A derived member is an inference; an explicit link is someone's
deliberate claim. `ReleaseDetail.tsx`'s Lens tab renders them as sibling lists under the
same group, never merged — a derived row carries its own "Derived" chip
(`lens-derived-chip`) and a `via` caption explaining the inference
(`lens-requirement-derived-via` / `lens-testcase-derived-via`), and the group's own title
states both counts and both denominators ("Requirements (0 linked, 1 derived via 1 test
case)"). Collapsing the two would lose the ability to tell a coverage gap (nothing derived
because no plan is attached) from a linking gap (something is attached but nothing on it
resolves) — this is the ruling this package's own plan named as "most likely to be
simplified away by a later change; the one to defend." *Cost if wrong*: a release reads as
having more explicit coverage than anyone actually asserted, which is exactly the kind of
confident-but-wrong number this programme has shipped before (R5 of the 2026-09-19 entry).

**R3 — defects stay explicit-only; the chain stops at requirements.** Tempting to also
derive "defects raised against this release," and the chain technically supports a third
hop (case -> requirement -> defect, since defects link to requirements, not to test
cases, in this data — 2026-09-19 premise). Rejected: a defect linked to a requirement may
be from any release or any year — that link carries no version context at all — so
inheriting it would fill a release with historical bugs it never contained, reported with
total confidence. The honest alternative ("defects raised from an execution of one of this
release's plans") has no data behind it: `defectService`'s own schema carries no
execution/run/plan/case reference of any kind, verified field-by-field. So the third hop
is not implemented in any form, in either direction. Defects enter a release by an
explicit link and nothing else, exactly as R4 (the old one) already required for them.
*Cost if wrong*: a release under-reports its defects, which is visible and fixable — the
alternative, over-reporting with total confidence, is neither.

**R4 (this package's own numbering restarts at R1 above; this line keeps the register's
running convention) — every figure keeps its denominator, derivation included.** Already
the lens's rule before this package (2026-09-19's own R5); derivation makes it more
important, not less, because now there are two kinds of count that must never be
confused: "2 test cases derived via 1 plan" and "2 test cases linked directly" are
different facts about the same release and must read as different sentences, not be
summed into one number.

**R5 — one unfiltered link fetch for the requirement hop, not one per derived case.**
Deriving requirements needs links whose endpoint is a derived case, and
`advancedResults` (the shared list-query helper every WP-021 service uses) has no `$in`
support — so the choice was one call for the whole `linkIssue` collection, filtered
client-side, or one call per derived case. Took the single call: it matches the
"fetch everything, filter client-side" pattern `releaseLens.js` already used for plans,
requirements, cases and defects, and the lens is already uncached and already fetching
all of several other collections in full on every call. *Cost if wrong*: the call grows
with the link collection (23 rows live at the time this was written); revisit if
`linkIssueService` ever gets a real bulk-read endpoint.

**Proven end to end, including the reversal's own argument.**
`frontend/e2e/specs/release-derived-membership.spec.ts` creates a plan with two test
cases (one linked to a requirement), attaches the plan to a release, and reads 2 derived
test cases + 1 derived requirement off the Lens tab having linked none of them by hand —
then detaches the plan and asserts the release reads "Nothing linked yet" again, with
zero derived rows, zero derived chips, and (unchanged throughout) zero explicitly-linked
rows. That detach-and-disappear step is R1's whole argument compressed into one
assertion: nothing was ever written to unwind, so there is nothing left over to find.
Non-vacuity was checked directly, not assumed: the plan-traversal hop in
`releaseLens.js` (`resolvedPlans.forEach` -> `[].forEach`) was broken, the
`reportingservice` container rebuilt from that change (no bind mount — a host-side check
against a stale container would prove nothing, the exact mistake an earlier task in this
package's own report is recorded elsewhere as making), the spec re-run and confirmed
failing on the derived-group assertions specifically, then the file restored
(`git diff --stat` showed no changes — byte-identical) and the container rebuilt again,
with the spec passing a final time on the real code. Fixture counts (project 1: 16 test
cases, 5 requirements, 3 defects, 5 folders, 23 link documents, 14 executions, 8 test
plans, 2 releases) were identical before the pass run, after the deliberate-failure run,
and after the final pass run — the spec's own `finally` cleaned up correctly even on the
run that failed mid-assertion. No Keycloak persona was left behind
(`wp063-e2e-release-derived-membership-*`, checked via the Admin API, zero found).

---

## 2026-09-23 — F11 (CI result binding) deferred by the owner, pending a dedicated automation module

**Status: deferred, not descoped.** The owner has plans for a dedicated automation module
that covers automation *design* inside the tool, not only result ingestion. F11 is parked
until that module's shape is known. This entry exists so the next session does not rediscover
the problem and build the wrong thing.

**Why the deferral is the right call, not merely a delay.** F11's difficulty is entirely in
*binding*: connecting a CI result to a repository test case. The format layer is already
generic — `adapters/junitAdapter.js` covers everything that emits JUnit XML (TestNG, pytest,
Jest, Surefire, Playwright), `adapters/cucumberAdapter.js` covers Cucumber, and the ingest
endpoint accepts pre-normalized JSON as a universal escape hatch, authenticated by API key
(`requireAuth('results:write')`). What does not exist is any hop from a result to a case:
`controllers/ingest.js` never contacts testRepoService, so every result is stored as
`TAG:<classname>.<name>` — a namespaced free-text label referencing nothing. Live data
confirms it: zero `TAG:` rows, zero `source: 'ci'` rows, because the loop was never worth
closing while results arrived orphaned.

**If automation design lives in srckube, the binding problem largely dissolves.** A tool that
authors the automation knows the identity it minted, so the result carries an id the tool
issued rather than one a customer has to be persuaded to embed. That is a structurally better
answer than any matching scheme, and it is why building the binding layer first would have
been premature work aimed at a problem the automation module removes.

**What the binding design was, kept for the interop case.** Even with an automation module,
customers will bring suites srckube did not author, so a binding path is still needed — as
interop, not as the centrepiece. The design reached (2026-09-23, after the owner's constraint
that it must be generic because customers use their own tools) was a **per-project binding
profile**: an ordered chain of rules, first match wins, modelled on the existing
`aiService/models/AiProjectSettings.js` per-project settings precedent.

1. **Regex over test name or classname**, capture group supplied by the customer. The
   universal rule — every framework lets a test be named, so this needs no plugin, no
   annotation support, and no cooperation from a vendor.
2. **A named metadata field**, with the field *name* configurable (JUnit `<property>`, a
   Cucumber tag, a JSON key). Tools that have somewhere structured to put an id disagree on
   which place that is, so it is configured rather than guessed.
3. **An explicit mapping table** (`externalId → TestCaseId`) for customers who cannot modify
   their tests at all — legacy packs, vendor-supplied suites, anything under change control.

**Ruled out: fuzzy name matching.** A silently wrong binding corrupts the audit trail the
product exists to provide, and stays invisible until someone is defending a release. In a
multi-customer product this is not a tunable — it is a line.

**Two conditions that make the design honest rather than merely flexible**, and which should
survive into whatever the automation module does:
- **Resolve before binding.** An extracted `TC-9999` that does not exist must report as
  unresolved, never bind to nothing. Same discipline `releaseLens.js` already applies.
- **Report `matched / unmatched / unresolved` out of total, and keep unmatched results.**
  This is what tells a customer their regex is wrong instead of letting them conclude they
  have no CI coverage.

**Consequence for F13 (traceability matrix), which the programme doc gates on F11.** That
gate's stated reason was "a matrix built before automated results are bound to cases would
report a coverage figure that is confidently wrong." The reason survives the deferral, but
waiting is not the only way to satisfy it: F13 can be built over the link-and-derivation
graph it *can* honestly claim — requirements, cases, plans, defects, releases, now including
WP-F15b's derived release membership — provided the automated-execution dimension is shown as
absent rather than as zero. Absent and zero are different claims, and the difference is the
whole gate.

---

## 2026-09-23 — Test adequacy ("does this test actually cover the requirement?") — deferred, documented for later

Recorded at the owner's request while planning F13: *"I am good with getting the numbers
based on what we have first and then we can work on the test case quality. But please
document this work for later."*

**The gap, stated precisely.** F13's four segments measure **presence and outcome, not
adequacy**. A requirement with one shallow passing test is indistinguishable from one with
twelve thorough passing tests — both read as "covered, passing". The matrix will tell you
*that* Req-1 is tested and green; it will not tell you whether TC-1 exercises everything
Req-1 promises.

**Why F13 deliberately does not paper over this.** A figure that claims to measure adequacy
but actually measures test-count is worse than an honest gap, because people stop looking
once they see green. F13 ships a **test-count-per-requirement column** as a visible thinness
indicator — crude and gameable, and labelled as an indicator rather than a score — so a human
can see "Req-1: 1 test" beside "Req-7: 9 tests" without the tool pretending to have judged
anything.

**Three routes to real adequacy, in the order they should be built.**

**1. Child-requirement rollup — deterministic, and the structure already exists.** The way
serious traceability handles this: decompose a requirement into acceptance criteria or child
requirements, link tests at *that* level, and coverage becomes "5 of this requirement's 6
criteria have a test" — genuinely adequacy, measured rather than judged. `requirement.js`
already has `parentId`, the workbench tree already uses it, and 4 of 5 project-1 requirements
already have a parent. What is missing is a rollup that computes a parent's coverage from its
children instead of from links on the parent itself, plus the authoring discipline that makes
leaves testable. **Build this first** — it is the only one of the three that produces a number
defensible in an audit.

**2. Defect leakage — empirical, retrospective, computable from data already held.** The
truest adequacy signal is not predictive: defects raised against a requirement *after* its
linked tests all passed. Green tests plus an escaped bug is evidence the tests were
inadequate. Defect→requirement (`5↔2`) and defect→case (`5↔1`) links both exist in live data,
and executions carry timestamps, so the join is available. Retrospective only — but
retrospect is when you decide what to test better next time.

**3. AI assessment — a judgement, and must be labelled as one.** This is where an LLM
genuinely earns its place, unlike link suggestion (where plain TF-IDF/embedding similarity
suffices): read a requirement and its linked cases, and name the stated behaviours nothing
appears to exercise. `aiService` already exists, with `DismissedDuplicate` as a precedent for
suggestion-with-dismissal. **It belongs beside the matrix as "possible gaps to review", never
inside a coverage number.** Build it third — it is far more useful once (1) exists, because
"this criterion has no test" is actionable where "this requirement feels under-tested" is not.

**The standing line, carried from WP-F15b's R2.** Inferred and asserted must stay visibly
distinct. AI suggests links for a human to confirm; it never contributes to the coverage
figure itself. A coverage number that silently includes machine-guessed links is a number
that cannot be defended in an audit, and defending it in an audit is the entire reason a
traceability matrix exists.

---

## 2026-09-24 — F13 (requirement traceability matrix) DONE — a shipped number changes

**The number that was wrong, stated plainly.** Requirement coverage read **0% for every
project, always**, before this package. `coverage.js` gated "tested" on a `LinkIssue` row
matching `{linkType:'tests', srcModule:2}`, but every MANUAL link affordance this workbench
ships (`ReleaseDetail`, `DefectDetail`, `TestRunDetail`, the requirement's own Links tab) hard-
codes `linkType:'relates-to'` — none of them ever write `'tests'`. **Correction (final fix
round, 2026-09-24): "`'tests'` has never once been written by the product" as originally stated
here overstated the premise and is false** — `api/aiApi.ts`'s AI-accept flow (WP-051: a user
accepting an AI-generated test case) writes a bidirectional `'tests'` link, on purpose, every
time it runs. It just happens that none of the 23 live rows in this environment came from that
flow. Live census at the start of this package: **23 of 23 link rows are `relates-to`; zero are
`tests`**. The old gate did not fail occasionally; it failed by construction, on every project,
forever, regardless of which of these two facts about `'tests'` is the true one — R1 (below)
makes the distinction moot going forward: any `linkType` counts. Anyone who had screenshotted
that 0% had screenshotted a bug, not a fact about their data.

**Project 1's own number today: 2 of 5 requirements linked (40%), not the 60% an earlier
planning premise recorded — and the reason is worth more than the correction.** The "3 of 5 /
60%" premise was never right, and it was not made stale by a fixture being cleaned up (an
intermediate account said so; that account is also wrong). `newReq51` does not exist as a
requirement document and, on the evidence, never did — but **its link rows are still live right
now**: `newReq51→TC-1` and `TC-1→newReq51` are both present in `srckube-linkissue`. Nothing was
cleaned up. The premise was built by reading the *link* rows and assuming both endpoints named
real requirements, without checking that `newReq51` resolves to one.

That is this codebase's most-repeated lesson arriving again: **links outlive their endpoints,
so resolve before you count.** It is the same rule `releaseLens.js` already enforces and the
same shape as the known orphan `Bug-1072→TC-4788`, whose two endpoints are both deleted. A
census of link rows is not a census of entities, and the difference is invisible until someone
joins them.

Verified directly against Mongo before writing this entry (`srckube-requirements` and
`srckube-linkissue`, project 1): the project holds exactly `Req-1` … `Req-5`, and `Req-1→TC-1`
and `Req-2→TC-2` are the only requirement↔case links whose requirement end resolves. `Req-3`,
`Req-4` and `Req-5` have none. **2 of 5 = 40% is the real, current, checked number** — still
the thing that must be announced rather than discovered, and still an improvement on an
always-wrong 0%, but it is not 60%, and the shipped code was right to exclude `newReq51`: the
service resolves endpoints before counting, which is precisely why its number disagreed with
the hand-built premise.

**R1 — "tested" means any requirement↔test-case link, either direction, any `linkType`.**
`linkType` is a label on the relationship, not a gate on whether it counts — gating on one
specific value neither the workbench nor its users have ever produced made a real, existing
link invisible. `'tests'` may still be surfaced as a *stronger* signal later; it cannot be the
sole gate. *Cost if wrong:* a shipped number changes (0% → 40% today, and higher wherever a
project already has real links) — a visible change toward the truth, announced here rather than
discovered by a user re-counting their own links.

**R2 — four mutually exclusive, exhaustive segments, not one percentage**, evaluated over a
requirement's linked cases in this precedence: (1) no linked cases → **no tests linked**;
(2) any linked case's *latest* status is `Fail` → **executed, failing**; (3) *every* linked
case's latest status is `Pass` → **executed, all passing**; (4) otherwise → **tests linked, not
fully verified**. **Amended mid-task** after live data surfaced a `TestStatus` of `InProgress` —
a real value the human execution path writes, outside the `Pass`/`Fail`/`No Run` vocabulary
`adapters/normalize.js` documents (that file documents the *CI-ingestion* vocabulary, not the
whole set). The first cut classified "ran and didn't fail" as all-passing, which read a
requirement with one `Pass` and one `No Run` as fully verified, and would have read `InProgress`
as passing too. Corrected: **an unrecognised or non-terminal status must never be read
optimistically as success** — more unknown values will appear over time, so the rule is safe by
default rather than enumerating every status seen so far. This is the exact case Task 4's own
browser journey exists to prove end to end: a requirement with two linked cases, one `Pass` and
one never run, reads **"Tests linked, not fully verified"**, never "executed, all passing".
*Cost if wrong:* a requirement reads as less verified than it is (visible, fixable) rather than
the reverse (invisible, and worse, actionable-looking).

**R2, second correction — "failing" means the case's LATEST status, never "has ever failed".**
Caught in review after R2's own segments were first computed: the initial pass/fail sets were
built from "did any execution of this case, ever, record this status", which meant a case that
failed once and has since passed stayed in `failingCaseIds` forever — a requirement whose only
linked case now shows `Pass` would still be classified `EXECUTED_FAILING`, and the matrix row
would show that same case's own status as `Pass` right next to a segment saying "failing": a
visible, in-row contradiction, worse than two dashboard tiles quietly disagreeing (R3's own
concern) because both halves are on screen together. Fixed by resolving each case's pass/fail
membership from its *latest* execution only (ordered by `updatedAt`/`createdAt`, later overwrites
earlier), with the case evicted from whichever set it was in before the newer status is applied.
"Latest" is also the only defensible reading of "failing" in the product sense: a test that
failed in April and passes today **is** passing, and "has ever failed" gives a requirement no
path back to non-failing once anything has gone red even once — the segment would stop being
actionable the moment it happened once, for good.

**R3 — the matrix and the summary tile are computed by ONE function**
(`classifyRequirementSegment`, `coverage.js`), never two that happen to agree today. Task 2's
`traceability.js` imports it — and the same link traversal (`buildLinkedCaseIdsByReq`) and the
same opt-in-to-success status resolution (`resolveExecutionSets`) — rather than reimplementing
any of the three. A matrix row and the coverage tile it backs can therefore never quietly drift
apart. *Cost if wrong:* one function is harder to cache in two shapes (a `breakdown.data` array
for the tile, a `rows[]` array for the matrix); that cost was taken deliberately.

**R4 — the test-count column is an indicator, never a score.** Rendered as a plain count. No
percentage, no grade, no colour scale implying a threshold. It exists to make a *thin* requirement
visible ("Req-1: 1 test" beside "Req-7: 9 tests") without the tool pretending to have judged
adequacy — see F22 below (renumbered from F19 in the final fix round, 2026-09-24: F19 was
already taken by an unrelated, unplanned gap — see the functional-gaps-program.md numbering note).

**R5 — the automation seam is "do nothing special".** `TestExecution.TestCases[].TestStatus` is
read regardless of the run's `source` field (manual vs CI-posted, WP-033). No `source` filter was
added that a later work package would have to remove, and no empty "automated" column was added
that would render a lie until F11 lands. When automated results are eventually bound to cases,
they land as rows in the same execution records this already reads and simply start appearing —
no shape change, no special-casing required here.

**R6 — every figure keeps its denominator.** A requirement with no linked cases reads as "No
tests linked", never as an aggregated 0%-passing figure that could be mistaken for "everything
failed". A project with zero requirements reports zeros and says so in a `note`, never a bare
number a reader could mistake for "still loading".

**R7 — case↔case (`1↔1`) edges are never traversed.** Four exist live. `buildLinkedCaseIdsByReq`
only recognises a row whose own module tags name one side a requirement and the other a test
case — checked on *both* sides, not just one — so a case↔case row is rejected purely on its
module tags, even in the adversarial case where its ids happen to collide with real requirement/
case ids. Following a case↔case edge would inflate coverage through a relationship that was
never a requirement being covered at all.

**Proven end to end, non-vacuously, on the real live stack.**
`frontend/e2e/specs/traceability-matrix.spec.ts`: create a requirement and two test cases (real
UI draft flows) → link both to the requirement (the requirement's own Links tab, Issue type
"TestCase", `linkType:'relates-to'` — the same, only, link shape the product actually writes) →
build a test plan carrying both cases → create an execution from it → run ONE case to `Pass`
through the real "Run"/"Save" flow, leave the other at `No Run` → force `POST /reports/refresh`
(reportingService's own `ReportCache` serves an entry as fresh for up to 5 minutes regardless of
what changed underneath it — verified live that project 1's `coverage` entry was inside that
window from the background cron sweep before this spec ran, so this call is not optional) → open
`/projects/1/reports` via a deliberate `page.reload()` (this browser session's own Dashboard
landing page had already warmed react-query's `['report','coverage',projectId]` cache entry,
well inside `queryClient.ts`'s 30s `staleTime`; a plain client-side navigation could have served
that pre-fixture tile — the same react-query trap `release-wiring.spec.ts` already documents
once) → assert **one row, testCount 2, `TC-x: Pass` and `TC-y: No Run` both listed individually,
segment "Tests linked, not fully verified"** → export the CSV and assert the **downloaded file's
own content** (via `page.waitForEvent('download')`, not a DOM check) matches that exact row,
byte for byte on the load-bearing fields → clean up (children before parents: link documents,
execution, plan, requirement, both test cases; service identity, never the persona).

Non-vacuity was checked directly, not assumed: `linkType: 'tests'` was reintroduced into
`buildLinkedCaseIdsByReq` (`coverage.js`) — the exact WP-040 bug this package removes — the edit
verified landed via `git diff --stat` before rebuilding, the `reportingservice` container rebuilt
from that change (`docker compose -f backend/docker-compose.yml build reportingservice && ... up
-d reportingservice`, no bind mount — a host-side check against a stale container proves nothing,
the same mistake recorded elsewhere in this programme for WP-F15b), and the spec re-run against
the rebuilt container: it failed exactly where expected, `testCount` reading **0** instead of
**2** for the same requirement, because the reintroduced gate once again made the only link rows
this product writes invisible. The file was then restored and confirmed **byte-identical**
(`git diff --stat` showed no changes), the container rebuilt a second time, and the spec re-run a
final time on the real, correct code: **passed**.

Fixture counts (project 1: 5 requirements, 23 link documents, 14 executions, 8 test plans, 201
test cases globally, 123 defects globally) were identical before the first pass run, after the
deliberate-failure run, and after the final pass run. No Keycloak persona was left behind
(`wp063-e2e-traceability-*`, checked via the Admin API, zero found after each run). One test
execution fixture from an earlier, mid-development failure (a selector bug in this spec's own
first draft, unrelated to the product code) was left behind because the test failed before its
id was captured, outside the `finally` block's `if (id)` guard — found and deleted by hand before
the counts above were taken; the spec itself has never leaked a fixture on a run where it reached
the point of creating one.

**F22 (test adequacy, renumbered from F19 in the final fix round — F19 collided with an
unrelated, unplanned gap in `functional-gaps-program.md`) is the named follow-up, and this
matrix deliberately does not measure it.**
The `testCount` column is a thinness indicator, not a score — see the 2026-09-23 register entry
above ("Test adequacy … deferred, documented for later") for the full three-route design
(child-requirement rollup, defect leakage, AI assessment) this package intentionally left
untouched.

## 2026-09-25 — F23 (the Lens and matrix at scale) DONE — a wall becomes a page, and a testid retirement almost went unnoticed

**The report.** *"in the lens the way test cases, requirements etc are arranged it is fine when
we have one or two but when you have a large release with 100s of testcases it is not going to
look good."* The traceability matrix (F13, shipped hours earlier) had the identical defect in a
worse form — `TraceabilityMatrixSection.tsx` rendered `rows.map(...)` with, inside every row,
two more `.map`s over `testCases`/`defects`: 200 requirements averaging four cases each was
~800 nested items in one pass. Both are now DataGrid, paged client-side at 25/50/100, with a
default sort that puts the two or three items needing attention on the first screen instead of
somewhere in the scroll.

**R1 — summary always visible, detail collapsed by default.** The Lens's `LensGroup` gained a
collapse with its own count in the heading, starting collapsed; the matrix's per-requirement
case/defect lists moved into a compact cell ("4 cases · 1 failing") with the full lists behind a
per-row "View details" toggle, one panel at a time. Neither counts nor breakdowns ever hide
behind the disclosure — only the part that becomes a wall at scale does.

**R2 — default sort surfaces problems first, and this is the ruling that makes the change useful
rather than merely shorter.** Requirements: derived before asserted, then id. Defects: unresolved
before resolved, then id. The matrix: `executedFailing` → `notFullyVerified` → `noTestsLinked` →
`executedPassing`, so a reader opening it lands on what is broken, then unverified, then untested,
with passing rows last because they need nothing. Test cases were the harder case and are covered
by R3's amendment below.

**R3 — client-side paging, no endpoint changes, amended mid-task.** Both payloads already arrive
whole, so paging the render was free. But the lens payload carried **no per-test-case execution
status** — R2, the package's central ruling, could not be satisfied for test cases, the exact
entity the owner reported. The amendment permitted one small additive field: the lens already
fetched every execution and already read `TestStatus` per case, aggregating into counts and
discarding the detail; `coverage.js`'s own `resolveExecutionSets` (WP-F13) produces a
latest-status-per-case map in the same service, reused rather than reimplemented. Each linked and
derived test case in `ReleaseLensData` now carries `latestStatus`, **scoped to the release's own
resolved plans, never project-wide** — the same "which release actually found this" honesty
WP-F15b's R3 was built on, so a pass recorded against an unrelated plan cannot make this release
read green. A case with no execution under any of this release's own plans reads the literal
string **`'Not run in this release'`** — deliberately distinct from an execution that explicitly
recorded `'No Run'`; collapsing the two would tell a release sign-off "this was checked and didn't
run" when the truth is "this was never attempted here." Endpoint splitting, caching and
pagination remained forbidden throughout.

**R4 — CSV export must contain every row, never the visible page.** Both exports still build from
the full, unsorted, unfiltered row array the component was handed — never from DataGrid's own
`apiRef`/paginationModel. This was the risk taken most seriously going in ("paginating a table and
exporting a table are two code paths that look the same from the outside, and the failure is
silent"), and it is the one proven hardest, below.

**R5 — F15b's derived/asserted distinction survives the move into a grid.** The chip moved from a
per-row `Stack` into a `Membership` column (`lens-derived-chip`/`lens-asserted-chip`), with a
`Derived via` column carrying what F15b's `via` caption used to say inline. Mechanism changed;
the distinction a reader needs did not disappear.

**R6 — no empty state reads as a clean bill of health.** Unchanged, standing rule, re-checked
against every new branch this task added (a zero-row group, a zero-requirement project).

**Task 1's own chip hazard, found and fixed before it shipped.** `StatusChip`'s
`resolveStatus` falls through an unrecognised status to a **hash-indexed colour rotation that
includes `'success'`** — live data already has `'InProgress'`, outside the documented
Pass/Fail/No Run vocabulary, and the general case is anything the human execution path writes
that nobody enumerated. An unrecognised test-case status could therefore have painted a **green
chip with a checkmark**, by hash coincidence, in a grid a reader scans by colour before text.
Fixed by handing the column a single-entry `colorMap` keyed to the exact value being rendered
(`testCaseStatusColorMap`), so the lookup can never miss and the rotation's `'success'` entry is
structurally unreachable from this column — not merely unlikely to be hit.

**This regression — and it is a regression, not a pre-existing gap — is the finding worth
recording most.** Tasks 1 and 2 retired the Lens's/matrix's hand-authored per-row testids in
favour of DataGrid's own native `[data-id="<id>"]`, and nothing scanned for existing consumers
of the old names before they were removed. **Correction (final fix round, 2026-09-25): "Two
specs still asserted them" as originally stated here undercounted — it was three files, and the
third was not a spec at all.** `traceability-matrix.spec.ts` (`traceability-table`,
`traceability-row-${reqId}`) and `release-derived-membership.spec.ts` (eight references across
`lens-requirement-linked-row`, `lens-testcase-linked-row`, `lens-requirement-derived-row`,
`lens-testcase-derived-row`) are both under `e2e/specs/**`, which is what Task 3 grepped. But
`frontend/src/Pages/__tests__/reports.test.tsx`, a Jest unit test under `src/**`, also asserted
the exact retired `traceability-table`/bare `traceability-row-Req-1`/`traceability-row-Req-2`
names — undetected by Task 3's own repair because its grep never looked outside `e2e/specs`, and
undetected by CI until the whole-branch review ran `src/Pages`'s suite and got 1 failed / 6
passed. The lesson below is corrected for scope as well as count.
**Six of those eight references were `toHaveCount(0)` assertions — and a retired testid has count
0 by definition, whether or not the fact it was written to protect is still true.** One of the
six is the block the spec's own comment calls "THE STRONGEST ASSERTION IN THIS SPEC" — the
post-detach proof that every derived member disappears once its plan is unlinked. All six passed
green, proving nothing, while the spec's own CI signal read "passing." The remaining two
references (`toHaveCount(1)`/`toHaveCount(2)`, plus the `toContainText`/`.nth()` calls chained off
the same broken locators) did go red, so the spec was not silently green overall — but fixing only
the red lines would have left six hollow assertions guarding nothing, forever. A second, quieter
problem compounded the first: the Lens's groups are now collapsed by default (R1), and
`Collapse ... unmountOnExit` means a collapsed group's rows, chips and even its own "No X linked."
fallback text are not in the DOM at all until the group's toggle is clicked — a `toHaveCount(0)`
against an unexpanded group is vacuous for a second, independent reason on top of the first.

Both specs were rewritten, not patched: `traceability-matrix.spec.ts` now locates its row by the
grid's own `[data-id]`, reads the Test Count/Segment cells by their column's own `data-field`
attribute instead of a `<td>` position, reads the on-screen case/defect cells as the compact
summary R1 now renders there, and opens the row's "View details" toggle before asserting the full
per-case text the old row used to carry directly. `release-derived-membership.spec.ts` now clicks
each `LensGroup`'s own toggle before reading its contents, replaces "no linked-row testid" with
"no `lens-asserted-chip` inside this grid" (a live, non-retired testid — the same fact, through a
selector that can fail), and replaces "no derived-row testid after detach" with "the grid itself
no longer exists" — `ReleaseLensPanel`'s own branch renders a group's plain `No X linked.` text
INSTEAD OF a DataGrid once both `linkedCount` and `derivedCount` read zero, which is a stronger
version of the same fact, not a renamed one. **Lesson for the next testid retirement in this
codebase, corrected (final fix round, 2026-09-25): grep every consumer of the name being
removed before removing it, across `src/**` as well as `e2e/specs/**` — not "grep every spec",
which is the exact narrower scope that let `reports.test.tsx` ship undetected in the first
place.** `reports.test.tsx` is a Jest unit test, not a spec by this codebase's own vocabulary,
and Task 3's repair — reasonably, by the letter of the original lesson — only grepped
`e2e/specs`. A lesson that names the wrong scope is not a safety net; it is a false sense of one.
This package's own final fix round ran one unscoped, repo-wide grep for every testid this
package retired (`traceability-table`, bare `traceability-row-`, `lens-requirement-linked-row`,
`lens-testcase-linked-row`, `lens-requirement-derived-row`, `lens-testcase-derived-row`) and found
no fourth file: every remaining hit is either the three now-fixed/rewritten consumers above, one
of the surviving, non-retired suffixed testids (`traceability-row-${reqId}-cases-summary` /
`-defects-summary` / `-detail-toggle`, never bare), or prose (comments, this register entry)
describing the retirement itself.

**The pattern this stretch of the programme has now met four times: a rule expressed twice
drifts, and only the files inside whatever task's own file list got updated.** WP-F13's final
fix round closed two of these the same week this package shipped: a **third report-type
registry** (`cronJob.js`'s `REPORT_TYPES` never gained `'traceability'` — `ReportCache`'s enum and
`postRefresh`'s own list both had it, the cron sweep silently never did, so the tiles and the
table could read from differently-aged cache entries past five minutes) and a **second coverage
gate** (`linkIssueService`'s own untested-requirements/orphan-testcases endpoints carried their
own independent `{linkType:'tests'}` filter — the exact wrong rule `coverage.js` was fixed away
from in F13 Task 1 — feeding the workbench's "Untested" chip a different answer than the reports
page one navigation away). This package closed the other two: **duplicated segment labels**
(`TraceabilityMatrixSection.tsx` used to keep its own `SEGMENT_LABELS` constant, a second copy of
the four strings `computeCoverage` already sends in `breakdown.data` — now built from that same
prop, so the row's Segment cell and the summary tile render the literally same string object) and
a **duplicated defect-status predicate** ("is this defect still open", copied verbatim into both
`ReleaseDetail.tsx` and `TraceabilityMatrixSection.tsx` — now one function,
`Components/common/defectStatusRules.ts`). Four instances, four different shapes (a cron
allowlist, an API filter, a label table, a boolean predicate), one root cause: nothing in this
programme's workflow checks "does anything else already say this" before a task adds its own
copy. Worth a standing habit, not just four fixes.

**The deliberate follow-up, left exactly where R3 put it.** The release lens is **not cached** —
`controllers/reports.js`'s `getReleaseLens` routes around `getOrCompute` on purpose, because that
cache's key is `(projectId, reportType)`, one row per project, and a lens keyed by
`(projectId, releaseId)` is a finer grain it was never built to hold. Every open of a release's
Lens tab recomputes the whole traversal — every link row, every requirement/test case/defect in
the project, every test plan, every execution — and ships every linked and derived member in one
response, paged only by the render. **Paging the render does not touch this.** At the 30-case
scale this task's own density spec proves against, the payload is trivial; at the 300-case scale
the owner's report was actually about, this is a real cost paid on every tab open, not once. It
stays recorded here rather than silently absorbed into "the Lens is fast now" — R3 forbade
splitting the endpoint or caching it in this package, and that ruling was honoured, not quietly
relitigated.

**A second, unrelated defect found while proving R1's own layout claim in a real browser, out of
this task's scope to fix.** `TraceabilityMatrixSection.tsx`'s own comment claims "the wrapping
Box's overflowX keeps a wide grid scrollable within itself, never widening the page body." Proving
that by shrinking the actual browser viewport (500px down to 360px) found the whole page stuck at
its desktop width regardless — `document.documentElement.scrollWidth` never moved off ~1280.
Root cause, read directly: `Components/NavBar/MainDrawer.tsx`'s content region
(`<Box component="main" sx={{flexGrow:1, ...}}>`, wrapping every non-workbench page) is a flex
item with no `minWidth: 0` of its own, so per the flexbox spec its minimum width defaults to its
content's intrinsic width — it will not shrink below whatever its widest descendant naturally
needs, on any page, regardless of this task's own grids. A real user narrowing this app's browser
window, or opening `/projects/:id/reports` on a smaller laptop, sees the whole page scroll
sideways today. Not fixed here — outside this task's file list, and a one-line change to a
shared layout component used by every page deserves its own verification across all of them, not
a side effect of a testid repair. The two new density specs prove R1's actual, in-scope claim
(this grid's own container holds its overflow) by forcing the grid's own wrapping element narrow
directly via an injected stylesheet rule instead of the whole viewport, which sidesteps this
unrelated defect rather than being blocked by it or silently passing through it unnoticed.

**Two required fields on the already-committed bulk fixture helpers
(`frontend/e2e/support/scaleFixtures.ts`) were missing and would have 400'd the first real use of
either.** `createTestCase` posted `TestCaseSummary` alone; `TestCase.TestCaseDescription` is
`required: [true, ...]` (`testRepoService/models/testrepo.js`) — confirmed live, a bare POST
returns `{"error":"Please add a Display name"}`, the schema's own misleading message text for a
missing DESCRIPTION field. `createRequirement` had the identical gap
(`requirementDescription`, same message, same model shape). A third helper,
`createExecutionForPlan`, was previously named for a `testPlanId` parameter that a first real call
naturally read as the human `TestPlanId` ('PLN-n') and 400'd (`Cast to ObjectId failed for value
"PLN-n"`) — `TestExecution.TestPlanId` is a Mongo `ObjectId` reference, confirmed against the real
product's own call site (`TestPlanDetail.tsx`'s `createTestExecution({..., TestPlanId:
values._id})`). All three fixed in place, the third renamed to `testPlanMongoId` so the
distinction cannot be missed a second time — none of this package's own two new density specs
would have run at all otherwise.

**Proven end to end, non-vacuously, on the real live stack.**
`frontend/e2e/specs/release-lens-density.spec.ts` (new): 30 test cases, one plan, one release,
one execution recording exactly one `Fail`, one `Pass`, 28 `No Run` → open the release's Lens tab
through the real workbench UI (List view, not the default Tree view — module 6 has no tree
presence) → expand the Test cases group (R1: collapsed by default) → assert exactly 25 rows
render, the group's own title states "30 derived via 1 plan," the one failing case is the very
first row with zero interaction, and the one passing case is not on the page until "Go to next
page" is clicked → force the grid's own wrapping element to 220px via an injected stylesheet rule
and assert: the page body still does not scroll, the wrapping element itself stays at exactly
220px (does not grow to fit its child), and `.MuiDataGrid-virtualScroller` one level inside it
genuinely overflows (350px of content in 218px of space) — the overflow contained exactly where
it should be.

A second, new density test added to `traceability-matrix.spec.ts` (per `scaleFixtures.ts`'s own
header comment, its second named consumer): 30 requirements — one `executedFailing` (two linked
cases, one `Fail`, plus a linked open defect), one `executedPassing` (one linked `Pass` case), 28
`noTestsLinked` — proves the same four things for the matrix, plus **R4, run first because it
matters most**: export the CSV from the paged (25-row) grid and read the **downloaded file**
(`page.waitForEvent('download')`, never a DOM check): every one of the project's real 35 rows is
present (5 seeded + 30 fixture, computed from a baseline read before the fixtures existed, never
hardcoded), and the failing requirement's own CSV row still lists **both** its linked cases
(`TC-x: Fail`, `TC-y: Pass`) and its defect (`Bug-z: Open (High)`) — proving the on-screen cell's
move to a compact "2 cases · 1 failing" summary did not also compact the export and quietly lose
the second case or the defect.

**Non-vacuity checked directly, four separate times, not assumed:**
1. Both grids' `pageSize: 25` bumped to `100` — the page-boundary assertion failed both times
   (`Received: 30`/`Received: 35` instead of `25`); reverted, confirmed `git diff --stat` clean,
   re-ran, passed.
2. The traceability export's `exportRows` sliced to `.slice(0, 25)` — the CSV row-count assertion
   failed (`Expected: 35, Received: 25`), the exact silent-truncation failure R4 exists to catch;
   reverted, confirmed clean, re-ran, passed.
3. Both grids' default `sortModel` field changed from `latestStatus`/`segment` to
   `TestCaseId`/`reqId` — the "problem row is on/off the first page with zero interaction"
   assertion failed both times (the passing case appeared where the failing one should be; the
   failing requirement's row disappeared entirely from page 1); reverted, confirmed clean,
   re-ran, passed.
4. The traceability grid's wrapping `overflowX: 'auto'` changed to `'visible'` — the scroll-
   containment assertion **still passed**. Not a false negative: DataGrid's own
   `.MuiDataGrid-virtualScroller` (`overflow: 'auto'` in `@mui/x-data-grid` itself, verified
   directly in `node_modules`) already contains the horizontal overflow one level before the
   app's own wrapping `Box` ever would — this app's explicit `overflowX: 'auto'` on that Box is
   redundant in practice, not load-bearing. Recorded as a minor finding, not a defect: the
   claim R1 makes (the page never scrolls sideways for this grid) is still true, it is simply
   MUI's own default doing the work rather than this app's added CSS. Reverted regardless, since
   the wrapping Box's own comment documents an intentional decision this task did not ask to
   remove.

**Fixture counts, project 1, before and after every run in this task (identical every time,
confirmed after the four deliberate-failure probes above too): 5 requirements, 23 link documents,
14 test executions, 8 test plans, 3 releases, 5 folders — unchanged.** Global: 201 test cases,
126 requirements, 123 defects — unchanged. No Keycloak persona left behind
(`wp063-e2e-lens-density-*`, `wp063-e2e-traceability-density-*`, checked via the Admin API after
every run, zero found).

**Commits:** `f06183e` (already committed, prior session — `scaleFixtures.ts`'s original bulk
fixture helpers) and `335ccf1` (this task: the two testid repairs, the two required-field/
Mongo-id fixes to `scaleFixtures.ts`, the new `release-lens-density.spec.ts` / the
`traceability-matrix.spec.ts` density test, and this entry).

**Final fix round (2026-09-25) — one Major, two Minor, all fixed.** (1) The Major above: a third
file, `reports.test.tsx` (`src/**`, not `e2e/specs/**`), still asserted the retired
`traceability-table`/bare `traceability-row-Req-1`/`traceability-row-Req-2` testids and made
`src/Pages`'s suite fail 1/6. Repaired with the same `disableVirtualization` theme override this
package's own a11y suites already needed, plus a positive per-row assertion (both mocked rows
located by DataGrid's own `[data-id]`, their cases/defects/detail-toggle cells read) so the test
cannot pass with zero rows on screen the way a bare `traceability-grid` check would. The register
text itself is corrected above (three files, not two; the lesson now says `src/**` and
`e2e/specs/**`), and one unscoped, repo-wide grep for all six retired testids from this package
found no fourth file. (2) `segmentPriorityRank`'s unmapped-segment fallback ranked LAST
(`Object.keys(SEGMENT_PRIORITY).length`, i.e. behind `executedPassing`) instead of first —
inverted from this package's own standing rule that an unrecognised value must never be ranked
as benign. Now `?? -1`, ahead of even `executedFailing`: unlike this file's own
`testCaseWorstRank` (which puts an unrecognised per-case *status* in the middle, a legitimate
"not yet verified" reading), an unrecognised *segment* means the frontend's hand-written
`TraceabilitySegment` union has drifted from what `coverage.js`'s `SEGMENTS` actually sends —
a contract break worth surfacing ahead of a known failure, not slotted between two known-good
buckets. A new test pins a segment string that appears nowhere else in the codebase ahead of
`executedFailing`. (3) `ReleaseDetail.tsx`'s `TEST_CASE_STATUS_COLORS` claimed to be "sourced
from TestRunDetail.tsx's own STATUS_KEYS" while `STATUS_KEYS` stayed module-private there — a
comment, not a dependency. `STATUS_KEYS` is now exported and `TEST_CASE_STATUS_COLORS`'s key
type is derived from it directly, so a status TestRunDetail.tsx adds without a matching colour
entry here is a `tsc` error, backed by a new runtime test that iterates the real `STATUS_KEYS`
array and fails if any member has no colour. Each of the three new/changed tests was verified
non-vacuous by reverting its corresponding fix, confirming red, and restoring (`git diff --stat`
clean each time). Full suite before this round: 109 suites / 1 failed, 108 passed; 867 tests / 1
failed, 1 todo, 865 passed. After: 109 suites, all passed; 869 tests / 1 todo, 868 passed. `tsc
--noEmit` and eslint clean on every touched file. No backend changes. **Commit:** `492e9c8`.
