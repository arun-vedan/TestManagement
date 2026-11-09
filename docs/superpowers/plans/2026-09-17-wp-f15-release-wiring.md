# WP-F15/F18 — Wire releases into the tool

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A release stops being an island. It becomes a workbench module you can browse and open, it can be linked to the defects, requirements and test cases it actually covers, and a lens answers "what is in this release and is it ready?"

**Architecture:** No new schema fields on any entity. Releases join the **existing generic link graph** (`linkIssueService`), which already accepts any module pair and already reads bidirectionally. Module 6 gets the list and detail views every other module has. The lens is derived in `reportingService`, which already performs this class of join.

**Tech Stack:** Node 18 / Express / Mongoose 5.13.23, React 18 / TypeScript / MUI v5 / react-query, Jest + supertest, Playwright.

**Spec:** `docs/superpowers/plans/2026-09-05-functional-gaps-program.md` rows F15 and F18.

## Global Constraints

- **No new runtime dependencies.** **No `releaseId` field added to any entity** — see R1.
- Routes keep `keycloak.protect(), requireProjectScope(), authorize(<action>)` in that order; `projectId` always from `req.projectScope`, never the body.
- **Containers have NO bind mount.** The compose file is `backend/docker-compose.yml`, **not** the repo root — `docker compose build` from the root fails with "no configuration file provided". Rebuild after every source change or you are testing stale code.
- Mongo ONLY via `docker exec mongodb mongosh --quiet -u srckuberoot -p "$MONGO_ROOT_PASSWORD" --authenticationDatabase admin --eval '...'`. NEVER any host-side client — a stray native `mongod` squats on `127.0.0.1:27017` and host clients silently read the WRONG database. **Find each database's name by listing databases; do not guess** — guessing a non-existent name returns 0 for every query and reads like a clean answer, which has already produced one false premise in this programme.
- Do not mutate or delete seeded data: 14 executions in `srckube-testexecution`, 5 requirements and 3 defects in project 1, 4 folders. Report counts before and after.
- Tests non-vacuous: name the single-line break for each, and perform the probes the tasks ask for.
- Frontend commands from `/Users/arunganesha/srckubetest/frontend`, never `frontend/src`. The jsdom suite is unmeasurable under load and a full run times out — isolation runs only.
- No line-number cites in comments. No comment asserting a file exists or does not exist.

## Verified premises

Checked against the code and live data before this plan was written.

1. **Nothing outside `releaseService` carries a release reference.** Grepped every model in `backend/*/models/`. Releases link OUT to test plans only, via `Release.linkedTestPlanIds: [String]`.
2. **The link service is already any-to-any and unconstrained.** `linkIssueService`'s `srcModule` and `destinationModule` are plain `Number` with **no enum** — module 6 can be linked to anything today with zero schema change. Real links exist in the same shape (`Bug-1 → TC-1`, `sourceId`/`srcModule` → `destinationId`/`destinationModule`), 21 of them across modules 1, 2 and 5.
3. **Links are bidirectional by CLIENT-SIDE DOUBLE WRITE, not by a backend read.** ~~The controller matches `{sourceId, destinationId}` OR the swapped pair… no second record.~~ **That was wrong, and Task 3 caught it.** There is no `$or` read anywhere in `linkIssueService`. The swapped-pair match I read exists in `deleteLinks` — it deletes *both* directions, which is itself the evidence that two records exist. Bidirectionality comes from `linkissue.tsx` issuing a forward and a reverse `createLink`.
   Confirmed in live data: of 11 logical links, **10 are stored as mirrored pairs and 1 is a single document** — a one-way link, visible from one side only.
   **Consequence worth carrying:** if the second write fails, the link is silently one-directional. Anything that creates links outside the client (a script, a fixture, a future service) gets a half-link unless it writes both rows itself.
4. **Module 6 has no list and no detail.** `entityListConfigs.tsx` says in two places that module 6 deliberately has no entry; `workbench/detail/modules/` contains five components and no `ReleaseDetail`. Module 6 IS already in the rail with a slug and label (`modules.ts`), and is excluded from `DRAFT_CAPABLE_MODULES`.
5. **The release API is complete already.** `frontend/src/api/releaseApi.ts` exports `getReleases`, `getRelease`, `createRelease`, `updateRelease`, `deleteRelease`, `linkTestPlan`, `unlinkTestPlan`, `getGateStatus`. `Pages/releases.tsx` already does full CRUD and gate management — so this work is about reach, not about building release CRUD again.
6. **`Release` fields:** `releaseId` (human id), `name`, `projectId`, `targetDate`, `status` (`planned|in-progress|frozen|released|cancelled`), `linkedTestPlanIds: [String]`, `qualityGates: [{type, threshold, severity}]`, `notes`.
7. **`computeReleaseReadiness` is project-scoped, not release-scoped** — its signature takes `(projectId, headers)`. "Release readiness" today reports on the whole project, which is a real gap this package should close or explicitly leave open.

## Rulings

- **R1 — no `releaseId` on any entity.** The roadmap already recommended deriving rather than adding the field to five services. Premise 2 makes that stronger than when it was written: the link graph is *already* general enough, so declaring membership needs no schema change at all. *Cost if wrong:* a link is a weaker statement than a field — you cannot enforce "a defect belongs to exactly one release." If that constraint is ever wanted, it is a later change, and this package does not block it.
- **R2 — releases become a real workbench module.** List + detail, like every other module. `Pages/releases.tsx` stays as-is and is not migrated in this package; two entry points is acceptable for now and cheaper than a port done twice. *Cost if wrong:* a later consolidation.
- **R3 — the lens is derived in `reportingService`.** It already performs this class of join and owns `ReportCache`. *Cost if wrong:* a derived figure is only as good as the links; this is stated in the UI by R5.
- **R4 — release membership is explicit, not inferred.** A release contains what someone linked to it, plus its `linkedTestPlanIds`. We do NOT infer membership from dates, sprints or status. *Cost if wrong:* someone must do the linking; the alternative is a lens that quietly invents membership, which is worse than one that shows an honest empty state.
- **R5 — the lens states what it counted.** Any release view showing coverage or readiness says how many linked items it is counting, so an empty or partial release reads as "nothing linked yet" rather than "everything is fine." *Cost if wrong:* the exact failure this programme has hit repeatedly — a confident number computed over nothing.

---

### Task 1: Releases appear in the workbench list

**Files:** modify `frontend/src/workbench/list/entityListConfigs.tsx`; tests beside it.

Add the module 6 entry the file twice says is missing. Columns: release id, name, status, target date, linked test plan count. Follow the existing five configs exactly — including the shared `tagsColumn` placement rule (last) if tags apply.

- [ ] **Step 1: Write the failing test** — module 6's config exists, renders the named columns, and a release row shows its status and target date.
- [ ] **Step 2: Run to verify failure.** — [ ] **Step 3: Implement.** — [ ] **Step 4: Run isolation suites.**
- [ ] **Step 5: Prove non-vacuity** — remove the module 6 entry; the test must fail.
- [ ] **Step 6: Commit.**

---

### Task 2: `ReleaseDetail` — the module's detail view

**Files:** create `frontend/src/workbench/detail/modules/ReleaseDetail.tsx`; wire it wherever the other five are selected; tests + a11y suite beside it.

Read `TestPlanDetail.tsx` first — it is the closest analogue (an entity that owns a list of linked children). Reuse `DetailHeader`, `FieldGrid`, `DetailTabs`, `CommentsSection` as the other modules do.

Content: name, status, target date, notes; the quality gates with their current status via `getGateStatus`; and linked test plans with add/remove via the existing `linkTestPlan`/`unlinkTestPlan`.

- [ ] **Step 1: Write the failing tests** — renders a release's fields; shows gate status; lists linked test plans; a viewer (`can('write') === false`) sees no edit controls; unlinking a test plan calls `unlinkTestPlan`.
- [ ] **Step 2: Run to verify failure.** — [ ] **Step 3: Implement.** — [ ] **Step 4: a11y suite with a non-vacuity guard** asserting the interactive controls are genuinely mounted — an axe pass over a component that never rendered means nothing, and this project has shipped exactly that.
- [ ] **Step 5: Run isolation suites, eslint, `tsc --noEmit`.** — [ ] **Step 6: Commit.**

---

### Task 3: A release can be linked to anything

**Files:** modify `ReleaseDetail.tsx` to mount `LinksSection`; tests.

This is the task that ends the island, and it needs **no backend change** (premise 2). `LinksSection` takes a `srcModule` number; pass 6.

- [ ] **Step 1: Write the failing tests** — a release's Links tab lists existing links; creating a link to a defect posts `srcModule: 6` with the defect's module and id; **a link created from the release is visible from the defect's own Links tab** (premise 3 — assert this, do not assume it).
- [ ] **Step 2: Run to verify failure.** — [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify bidirectionality LIVE** against the running stack, not only in jsdom: create a release↔defect link through the API and read it back from both sides. Report both responses.
- [ ] **Step 5: Prove non-vacuity** — break the `srcModule` passed to `LinksSection`; the link test must fail.
- [ ] **Step 6: Commit.**

---

### Task 4: The release lens

**Files:** create `backend/reportingService/services/releaseLens.js` + route; tests.

`GET /api/v1/reports/release-lens?releaseId=<id>` returns, for one release: counts of linked requirements / test cases / defects (by status), the linked test plans, and the execution results reachable through those plans.

**Premise 7 matters here:** `computeReleaseReadiness` is project-scoped despite its name. Either make the lens genuinely release-scoped, or state plainly in the report and the register that readiness remains project-wide. Do not let a release-named figure quietly report project-wide numbers.

- [ ] **Step 1: Write the failing tests** — a release with two linked defects and one linked plan reports exactly that; a release with nothing linked reports zeros **and says so** (R5), not an error; a release in another project is invisible.
- [ ] **Step 2: Run to verify failure.** — [ ] **Step 3: Implement.** — [ ] **Step 4: Rebuild the container; run the suite.**
- [ ] **Step 5: Prove non-vacuity** — drop the `projectId` filter; the cross-project test must fail. Drop the link traversal; the counts test must fail.
- [ ] **Step 6: Commit.**

---

### Task 5: The lens in the UI, and closing the package

**Files:** modify `ReleaseDetail.tsx` to show the lens; create `frontend/e2e/specs/release-wiring.spec.ts`; update `PRODUCT_GAP_REGISTER.md` and the roadmap (F15, F18).

The lens panel must satisfy **R5**: show what was counted. "3 linked defects, 1 linked plan, 12 executed" reads honestly; a bare "92%" over one linked item does not.

Journey: create a release → link a defect and a requirement to it → link a test plan → open the release and see the lens count them → confirm the link is visible from the defect's own detail → clean up.

Follow `parameterised-cases.spec.ts` for structure, including its fixed setup shape (persona, context and API client created **inside** the `try`). Cleanup needs delete rights; the shared `contributor` persona has `write: true, delete: false`. Delete children before parents.

- [ ] **Step 1: Write it.** — [ ] **Step 2: Prove non-vacuity** by breaking the lens's link traversal; the journey must fail. — [ ] **Step 3: Run it.** — [ ] **Step 4: Sweep for leaked releases, links, defects, requirements and Keycloak users (Admin API — Keycloak is on POSTGRES, not Mongo); report counts.** — [ ] **Step 5: Register entry** recording R1-R5, that no schema change was needed and why, and whether readiness is still project-scoped. — [ ] **Step 6: Commit.**

---

## Self-review

**Spec coverage.** F15 asks for a release lens and explicitly recommends against adding `releaseId` to five services; R1 honours that and premise 2 strengthens it. F18 asks for releases in the workbench and says it depends on F15's lens answer — Tasks 1-3 give the module its views, Task 4 answers the lens question, Task 5 puts the answer where a user sees it.

**The risk I am most wary of.** R5 exists because a lens over a link graph reports on what someone remembered to link. A release with nothing linked will compute a perfect score over zero items, and this programme has already shipped confident numbers computed over nothing more than once. Every figure ships with its denominator.

**Type consistency.** `Release.releaseId` is the human id (`REL-n` style) and `_id` is the Mongo id; `linkIssueService` stores `sourceId`/`destinationId` as the HUMAN ids (`Bug-1`, `TC-1`), not Mongo ids — match that, or links will be created that nothing can read back.
