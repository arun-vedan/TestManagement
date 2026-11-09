# WP-F15b — Derived release membership

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attaching a test plan to a release brings its test cases — and their requirements — with it, without anyone linking them by hand. A release stops reporting on "what someone remembered to link".

**Architecture:** **Derive, do not write.** The lens computes membership by traversal at read time; it creates no link rows. Derived members are shown as derived, visually distinct from links a human asserted. No schema change, no backend entity.

**Tech Stack:** Node 18 / Express / Mongoose 5.13.23, React 18 / TypeScript / MUI v5 / react-query, Jest + supertest, Playwright.

**Spec:** the owner's report — *"in the release section we are linking requirement, test case, plans separately; ideally when we attach a plan to a release we need to get the subsequent details automatically attached"* — and `docs/superpowers/plans/2026-09-05-functional-gaps-program.md` row F15.

## Global Constraints

- **No new runtime dependencies. No new entity. No link rows written by the system** — see R1, which is the whole design.
- Routes keep `keycloak.protect(), requireProjectScope(), authorize('read')`; `projectId` always from `req.projectScope`.
- **Containers have NO bind mount**; the compose file is `backend/docker-compose.yml`, **not** the repo root. Rebuild after every source change.
- Mongo ONLY via `docker exec mongodb mongosh ...`. NEVER a host-side client — a stray `mongod` squats on `127.0.0.1:27017`. Find database names by listing them; do not guess.
- Do not mutate seeded data. Report counts before and after; clean up every fixture on every path.
- Tests non-vacuous: name the single-line break for each, perform the probes, and **verify each probe's edit landed before trusting the run** — several probes in this programme silently applied nothing and reported a passing suite.
- Frontend commands from `/Users/arunganesha/srckubetest/frontend`, never `frontend/src`. Isolation runs only.
- No line-number cites in comments. No comment asserting a file exists or does not exist — seven stale-claim incidents here.

## Verified premises

1. **The lens already exists and already traverses links.** `backend/reportingService/services/releaseLens.js` counts `Release.linkedTestPlanIds` plus module-6 links to modules 2/1/5, querying **both link directions** and collapsing on `module:id`.
2. **It already resolves endpoints before counting.** A link pointing at a deleted entity is excluded — necessary, because deleting an entity does not delete its links (a live orphan, `Bug-1072 → TC-4788`, has both endpoints deleted).
3. **Plan → case is real containment.** `TestPlan.TestCases` is an array of `{TestCaseId, TestCaseSummary, TestStatus, id}` holding **human** `TestCaseId`s (e.g. `TC-1`), verified against live data. This is the strongest hop in the chain — a plan genuinely contains its cases.
4. **Case ↔ requirement links exist** (`srcModule 1 ↔ 2`, both directions present in live data).
5. **Defects link to REQUIREMENTS, not to test cases**, in this data (`srcModule 5 ↔ 2`). So a defect reaches a release via `plan → case → requirement → defect` — three hops. This is why R3 exists.
5b. **The Defect schema carries no execution, run, plan, or case reference** — verified field-by-field against `backend/defectService/models/defects.js`. A defect is connected to anything in this system *only* through a `linkIssue` row. There is therefore no "raised from this release's runs" signal to derive from; R3 is settled, not open.
6. **Link bidirectionality is a client-side double write**, not a backend `$or`. Of 11 logical links, 10 are mirrored pairs and 1 is one-way. Any traversal must query both directions itself.
7. **The lens already fetches every plan and every execution** (`/api/v1/testplan` and `/api/v1/testexecution`, `limit: 10000`, no `select`), so plan→case traversal needs **no new HTTP call** — `resolvedPlans` is already in hand with its `TestCases` array intact.
8. **`linkIssueService` keys on HUMAN ids** (`TC-1`, `REL-1`), never Mongo `_id`s. `ReleaseDetail`'s `entityId` is the Mongo `_id` — releases are the one module where those differ.

## Rulings

- **R1 — derive, never write.** The obvious implementation is to create link rows when a plan is attached. Rejected: (a) once written, a human's link and a machine's are indistinguishable, so unlinking becomes ambiguous — does it return on the next sync? (b) the link graph has no atomicity (premise 6), so auto-writing N rows multiplies a known fragility; (c) deleting an entity orphans its links (premise 2), so auto-rows would accumulate orphans faster. Deriving means detaching a plan instantly removes its members, with nothing to clean up. *Cost if wrong:* traversal cost per lens read, which `ReportCache` already exists to absorb.
- **R2 — derived and asserted must be visibly different.** A derived member is an inference; an explicit link is someone's claim. Collapsing them loses the ability to tell a coverage gap from a linking gap. *Cost if wrong:* this is the ruling most likely to be "simplified away" by a later change; it is the one to defend.
- **R3 — defects stay explicit-only.** Do not inherit defects through requirements. Tempting, and wrong: a defect linked to a requirement may be from any release or any year. Inheriting it would fill a release with historical bugs it never contained, reported with total confidence. The honest alternative — "defects raised from an execution of one of this release's plans" — has **no data behind it**: premise 5b. So the third hop is not implemented in any form. Defects enter a release by an explicit link, and by nothing else. *Cost if wrong:* a release under-reports defects, which is visible and fixable, rather than over-reporting them, which is neither.

- **R5 — one unfiltered link fetch, not N filtered ones.** Deriving requirements needs links whose endpoint is a *derived case*, and `advancedResults` copies query params straight into the Mongo filter with no `$in` support — so the choice is one call for the whole link collection or one call per case. Take the single call: it matches the "fetch everything, filter client-side" pattern this service already uses for plans, requirements, cases and defects, and `ReportCache` absorbs it. *Cost if wrong:* the call grows with the link collection (21 rows live); revisit if it ever needs a real bulk-read endpoint.
- **R4 — every figure keeps its denominator.** Already the lens's rule. Derivation makes it more important, not less: "12 cases via 2 plans" and "12 cases linked directly" are different facts and must read differently.

---

### Task 1: The lens derives membership through plans

**Files:** modify `backend/reportingService/services/releaseLens.js`; tests in that service.

Extend the lens: for each plan already in `resolvedPlans` (premise 7 — no new fetch needed), take its `TestCases[].TestCaseId` and treat those cases as **derived** members. Then follow each derived case's links to requirements (premise 4, via R5's link fetch), also derived.

The response must distinguish, per entity type, **explicit** from **derived**, and say via what — a derived case belongs to the release *because plan PLN-3 is attached*. A count alone is not enough to satisfy R2.

Keep premise 2's behaviour: resolve endpoints, exclude what no longer exists. A deleted case still listed in a plan's `TestCases` must not be counted.

- [ ] **Step 1: Write the failing tests** — a release with one attached plan containing 3 cases reports 3 derived cases and 0 explicit; a case that is BOTH in an attached plan and explicitly linked is reported once, marked explicit (an assertion outranks an inference); requirements linked to derived cases are derived, and the link is found in **both** directions (premise 6 — a one-way link row must still traverse); a plan listing a deleted case does not count it; a release with no plans and no links reports zeros **and says so**; a defect linked to a derived requirement is **not** counted (R3).
- [ ] **Step 2: Run to verify failure.** — [ ] **Step 3: Implement.** — [ ] **Step 4: Rebuild the container; run the service suite.**
- [ ] **Step 5: Prove non-vacuity** — drop the plan traversal → the derived-cases test fails; drop the `projectId` filter → the cross-project test fails; return derived and explicit under one key → the distinctness test fails.
- [ ] **Step 6: Decide and report on R3's option (b)** — whether defects raised from this release's plan executions can be derived cleanly from the execution record. Implement it only if clean; otherwise state plainly why not and leave defects explicit-only.
- [ ] **Step 7: Commit.**

---

### Task 2: The release view shows what is derived

**Files:** modify `frontend/src/workbench/detail/modules/ReleaseDetail.tsx`; tests + a11y.

Render the lens's derived members distinctly from explicit links — a chip, a section, a label, whichever reads best, but **a user must be able to tell at a glance which items someone linked and which the system inferred, and why** (R2).

- [ ] **Step 1: Write the failing tests** — derived items render marked as derived and name their source plan; explicit links render unmarked; a release with only derived members does not read as "nothing linked"; a release with neither reads as an honest empty state, not a zero score.
- [ ] **Step 2: Run to verify failure.** — [ ] **Step 3: Implement.** — [ ] **Step 4: a11y suite with a non-vacuity guard** asserting the controls genuinely mount.
- [ ] **Step 5: Prove non-vacuity** — render derived items identically to explicit ones; the distinctness test must fail.
- [ ] **Step 6: Run isolation suites, eslint, `tsc --noEmit`. Commit.**

---

### Task 3: Browser journey, and close it

**Files:** create `frontend/e2e/specs/release-derived-membership.spec.ts`; update `PRODUCT_GAP_REGISTER.md` and the roadmap.

Journey: create a release → create a plan containing 2 test cases, one of which is linked to a requirement → attach the plan to the release → **open the release and see 2 derived cases and 1 derived requirement without having linked any of them** → detach the plan → see them disappear → clean up.

That detach step is the argument for R1 in one assertion: nothing to unwind, no stale rows.

Follow `release-wiring.spec.ts` for structure, including its setup shape (persona, context and API client created **inside** the `try`). Cleanup needs delete rights; the shared `contributor` persona has `write: true, delete: false`.

- [ ] **Step 1: Write it.** — [ ] **Step 2: Prove non-vacuity** by dropping the plan traversal; the journey must fail. Restore; report both. — [ ] **Step 3: Run it.** — [ ] **Step 4: Sweep** releases, links, plans, cases and Keycloak users (Keycloak is on POSTGRES — Admin API); report counts. — [ ] **Step 5: Register entry** recording R1-R4 and, plainly, the reversal: WP-F15's R4 said membership is explicit and never inferred. That was the right call before the owner had used it; they then hit its cost. State what changed and why. — [ ] **Step 6: Commit.**

---

## Self-review

**Spec coverage.** The owner asked for plan attachment to bring its details with it. Task 1 computes it, Task 2 shows it, Task 3 proves it. What they get is exactly what they asked for; only the mechanism differs from the obvious one, for the reasons in R1.

**The risk I am most wary of.** R3. Every instinct says "and the defects too", and the chain technically supports it — but a defect reaching a release through a requirement is three hops of inference presented as fact. This programme has shipped confident numbers computed over the wrong set more than once. Under-reporting is recoverable; a release quietly claiming bugs it never contained is not.

**Type consistency.** `TestPlan.TestCases[].TestCaseId` and `linkIssueService`'s `sourceId`/`destinationId` are both **human** ids, so the traversal joins on the same key space throughout. Two places differ and must not leak into a link query: `ReleaseDetail`'s `entityId` and `Release.linkedTestPlanIds` are both Mongo `_id`s.
