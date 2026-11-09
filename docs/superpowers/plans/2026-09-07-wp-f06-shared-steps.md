# WP-F06 — Shared (reusable) test steps

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A step sequence can be authored once, referenced from many test cases, and edited in one place — so the "log in as an admin" preamble stops being retyped into every case and stops being a bulk edit when it changes.

**Architecture:** A new `SharedStep` collection in `testRepoService` (same service, same DB, same tenant scoping as the test cases that reference it). `TestStepSchema` gains one optional field, `sharedStepId`; a step row carrying it is a *reference*, and the rest of the row is ignored. Storage stays canonical — references are stored as references — and expansion into flat `{testStep, Expected}` rows is **explicit and opt-in** via `?expand=steps` on the two testRepoService read routes. Consumers that need flat steps (execution enrichment, AI, CSV export) ask for expansion; the editor does not, so a read-modify-write round trip can never silently flatten a reference into copies.

**Tech Stack:** Node 18 / Express / Mongoose 7 (backend), React 18 / TypeScript / MUI v5 / react-query (frontend), Jest + supertest (backend tests), Playwright (e2e). CRA via CRACO.

**Spec:** `docs/superpowers/plans/2026-09-05-functional-gaps-program.md` (WP-F06 row) and `docs/superpowers/PRODUCT_GAP_REGISTER.md`.

## Global Constraints

- **No new runtime dependencies** in any service or the frontend. Everything below is achievable with what is already installed.
- Every new protected route is mounted `keycloak.protect(), requireProjectScope(), authorize(<action>)` in that order — reads `'read'`, writes `'write'`, deletes `'delete'`. This matches `backend/testRepoService/routes/testrepo.js` exactly; deviating from it is a tenant-isolation or RBAC hole.
- `projectId` is **always** stamped server-side from `req.projectScope.projectId` and **always** deleted from an incoming update body. Never trust it from the client.
- Every query against `SharedStep` is filtered by `projectId`. A shared step from project A must never be readable, referenceable, or deletable from project B.
- Tests must be non-vacuous. For every test written, the implementer must be able to name the single-line production change that makes it fail, and must state that in their report. This work package exists downstream of a package where a vacuous test shipped.
- No test may mutate or delete seeded data. e2e specs create their own fixtures and remove them in a `finally` block.
- All Mongo inspection goes through `docker exec mongodb mongosh ...`, never a host `mongosh` — there is a second mongod on `127.0.0.1:27017` holding a stale look-alike DB (see `PRODUCT_GAP_REGISTER.md`).
- Frontend test commands run from `/Users/arunganesha/srckubetest/frontend`, never from `frontend/src`.
- The jsdom suite on this machine is **not reliably measurable under load** — run counts vary between 0 and 13 failures with different sets each time. Trust only isolation runs of specific files, and before/after comparisons. Do not report pre-existing flaky failures elsewhere as findings.

## Verified premises

Each of these was checked against the code before this plan was written. An implementer who finds one false must stop and report, not work around it.

1. **No shared/reusable step concept exists.** `grep -rniE "shared[_ ]?step|reusable[_ ]?step|steplibrary|sharedsteps|callstep|stepref"` across all `.js`/`.ts`/`.tsx` outside `node_modules` returns **zero matches**.
2. **`TestStepSchema` is `{testStep: String, Expected: String}` only** — `backend/testRepoService/models/testrepo.js:11-21`. It is embedded as `TestSteps: {type: [TestStepSchema]}` at line 66, and also registered standalone as `mongoose.model("TestStep", TestStepSchema)` at line 248 (that registration has no other reader; leave it alone).
3. **Executions snapshot steps, so history is safe by construction.** `backend/testPlanExecutionService/controllers/testexecution.js:285-330` fetches the case from testRepoService the first time a case is opened in a run and copies `TestSteps` onto the execution document. Editing a shared step later cannot rewrite a completed run. **It fetches via the LIST route** (`/api/v1/testrepo?TestCaseId=<tcid>`), which is why expansion must work on the list route and not only on `/:id`.
4. **`ExecutionTestStepSchema` is strict** (`backend/testPlanExecutionService/models/TestExecution.js:30-41`, fields `testStep`/`Expected`/`status`). An unexpanded reference row copied into an execution would have `sharedStepId` silently stripped and render as a blank step. This is the failure mode Task 3 must test for.
5. **18 files read `TestSteps`.** The largest consumers are `frontend/src/workbench/detail/modules/TestCaseDetail.tsx` (12), `frontend/src/Components/AI/AiTestCaseDrawer.tsx` (8), `backend/testPlanExecutionService/controllers/testexecution.js` (8), `backend/aiService/lib/testCaseCandidates.js` (6). This count is why expansion is opt-in rather than a reshape.
6. **The step editor is `frontend/src/Components/Tabs/AddDeleteTableRows.tsx` (84 lines) + `TableRows.tsx`**, shared between module 1 (test cases) and module 4 (test runs) and driven by `TCStepsContext`. Module 4 behaviour must be untouched.
7. **Human-readable ids come from a pre-save hook** using `getNextSequence(this.constructor.db, '<name>')` — `backend/testRepoService/models/testrepo.js:214-225`.
10. **Kong has no route for `/api/v1/sharedstep`, so the frontend cannot reach it.** `srckube-kong/kong.yml:367-395` defines the `testRepoService` service with exactly one route, `testRepoRoute`, whose `paths` is `[/api/v1/testrepo]`. Found by Task 1's implementer, verified independently: `grep -c sharedstep srckube-kong/kong.yml` returns **0**. Without a route, Tasks 4-6 get a gateway 404 and would look like a frontend bug. Convention verified too: **all 61 routes in the file have exactly one path each** — none lists two — so this is a new named route under the existing service, not an extra path on `testRepoRoute`.

9. **`expand` is NOT excluded from the Mongo filter, and must be.** `backend/shared/service-core/middleware/advancedResults.js` reads `const removeFields = ['select', 'sort', 'page', 'limit'];`. Every other query key is copied straight into the filter, so `?expand=steps` on the list route would query `{expand: 'steps'}` and return **zero rows** — silently breaking execution enrichment, which is the single most important consumer of expansion. This is a required change, not a check. Verified safe to fix globally: no model in any service declares a field named `expand` (grepped across `backend/*/models/`), so excluding it cannot mask a real filter in any of the 17 routes that mount this middleware (17 real mountings across 17 files; a raw grep for `advancedResults(` returns 34 lines, but exactly half of those are comments -- a distinction that produced two wrong counts before it was measured properly).

8. **Settings tabs are `members`/`apikeys`/`audit`/`fields`/`modules`/`folders`** (`frontend/src/Pages/settings/index.tsx:34-39`). `modules` and `folders` are `ReservedTab` stubs belonging to WP-F17.

## Rulings made while planning

- **R1 — A new collection, not a 7th workbench module.** `ModuleId` is `1|2|3|4|5|6` and all six slots are taken (`frontend/src/workbench/modules.ts`). Adding module 7 would drag in the rail, tree, list, detail, tab strip and draft machinery for an asset that is never assigned, executed, or defect-linked. *Cost if wrong:* if shared steps later need first-class browse/search, they need a module then; the collection and API built here are unchanged by that.
- **R2 — Storage canonical, expansion opt-in.** The tempting design is to expand on every read so all 18 consumers work unchanged. It is a trap: the editor reads, the user edits one unrelated row, the editor PUTs back what it read, and every reference silently becomes a copy — the exact bug the feature exists to prevent, with no error and no way to notice. *Cost if wrong:* three call sites must pass `expand=steps` (Task 3) instead of zero.
- **R3 — UI home is the Steps tab, not Settings.** Insert-a-shared-step belongs where the author already is. Management (rename, edit, usage, delete) rides in a dialog opened from the same place. Settings' free slots are `modules` and `folders`, which WP-F17 owns. *Cost if wrong:* a Settings tab can be added later against the same API with no server change.
- **R4 — Deleting an in-use shared step is refused, not cascaded.** 409 with the usage count and the referencing `TestCaseId`s. Blanking steps in 40 test cases because someone tidied a library is unrecoverable. *Cost if wrong:* an extra "find usages, detach, then delete" step for the user, which the dialog makes explicit.
- **R5 — No new versioning for shared steps.** Premise 3 makes run history safe already. Live test cases showing the current text of a shared step is the point of the feature.

---

### Task 1: `SharedStep` model, CRUD API, and usage query

**Files:**
- Create: `backend/testRepoService/models/SharedStep.js`
- Create: `backend/testRepoService/controllers/sharedStep.js`
- Create: `backend/testRepoService/routes/sharedStep.js`
- Modify: `backend/testRepoService/server.js` (mount the router beside line 100)
- Test: `backend/testRepoService/__tests__/sharedStep.test.js`

**Interfaces:**
- Consumes: `@srckube/service-core` — `getNextSequence`, `advancedResults`, `requireProjectScope`, `authorize`, `initKeycloak`, `asyncHandler`, `audit`, `ErrorResponse`.
- Produces, for Tasks 2-6:
  - Model `SharedStep` with fields `{ id: Number, SharedStepId: String ("SS-<n>"), projectId: Number, title: String, description: String, steps: [{testStep, Expected}], createdBy, updatedBy, createdAt, updatedAt }`.
  - `GET /api/v1/sharedstep` (list, `advancedResults`), `POST /api/v1/sharedstep`, `GET /api/v1/sharedstep/:id`, `PUT /api/v1/sharedstep/:id`, `DELETE /api/v1/sharedstep/:id`, `GET /api/v1/sharedstep/:id/usage`.
  - Usage response shape: `{ success: true, data: { count: Number, testCases: [{ TestCaseId, TestCaseSummary }] } }`.
  - Delete refusal: HTTP **409**, body `{ success: false, error: "<message>", data: { count, testCases } }`.

- [ ] **Step 1: Write the failing test file**

Create `backend/testRepoService/__tests__/sharedStep.test.js`. Follow the existing harness in `backend/testRepoService/__tests__/api.test.js` exactly — read it first for how it boots the app, authenticates, and sets the project header; do not invent a new harness.

Cover, at minimum:

```js
describe('SharedStep CRUD', () => {
  it('creates a shared step with a server-generated SS- id and the caller\'s projectId', async () => {
    const res = await request(app).post('/api/v1/sharedstep')
      .set(authHeaders).set(PROJECT_HEADER, '1')
      .send({ title: 'Log in as admin', steps: [{ testStep: 'Open /login', Expected: 'Login form' }] });
    expect(res.status).toBe(201);
    expect(res.body.data.SharedStepId).toMatch(/^SS-\d+$/);
    expect(res.body.data.projectId).toBe(1);
  });

  it('ignores a projectId supplied in the create body', async () => {
    const res = await request(app).post('/api/v1/sharedstep')
      .set(authHeaders).set(PROJECT_HEADER, '1')
      .send({ title: 'x', projectId: 999, steps: [] });
    expect(res.body.data.projectId).toBe(1);
  });

  it('does not return another project\'s shared step', async () => {
    // create under project 1, read under project 2 -> 404 on /:id, absent from list
  });

  it('rejects a create with no title', async () => { /* 400 */ });
});

describe('SharedStep usage and delete guard', () => {
  it('reports zero usage for an unreferenced shared step', async () => { /* count 0, testCases [] */ });

  it('reports the referencing test cases', async () => {
    // create a shared step, create a test case whose TestSteps contains
    // { sharedStepId: <the _id> }, then GET /:id/usage
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.testCases[0].TestCaseId).toBe(tcId);
  });

  it('refuses to delete a shared step that is in use, with 409 and the usage payload', async () => {
    expect(res.status).toBe(409);
    expect(res.body.data.count).toBe(1);
  });

  it('deletes an unreferenced shared step', async () => { /* 200, then 404 on read */ });

  it('counts usage only within the caller\'s project', async () => {
    // a reference from a project-2 test case must not block a project-1 delete
    // and must not appear in the project-1 usage list
  });
});
```

Write the RBAC cases too, mirroring `backend/testRepoService/__tests__/rbacMatrix.test.js`: a viewer can `GET` but gets 403 on `POST`/`PUT`/`DELETE`; a contributor (write, no delete) gets 403 on `DELETE` only.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /Users/arunganesha/srckubetest/backend/testRepoService && npx jest __tests__/sharedStep.test.js
```
Expected: FAIL — 404s on every route, because nothing is mounted yet.

- [ ] **Step 3: Write the model**

`backend/testRepoService/models/SharedStep.js`:

```js
const mongoose = require("mongoose");
const { getNextSequence } = require("@srckube/service-core");

// WP-F06 -- a step sequence authored once and referenced from many test
// cases. Deliberately NOT a TestCaseRepo with a flag: a shared step has no
// lifecycle status, no version history, no assignee, and is never executed
// or linked to a defect, but it does need a usage query that a test case
// never needs. Sharing the collection would mean every existing test case
// read has to learn to exclude these.
const SharedStepEntrySchema = new mongoose.Schema(
  {
    testStep: { type: String },
    Expected: { type: String },
  },
  { _id: false }
);

const SharedStepSchema = new mongoose.Schema(
  {
    id: { type: Number, unique: true },
    SharedStepId: { type: String, unique: true },
    // Same tenant-scoping contract as TestRepoSchema.projectId: stamped
    // server-side from req.projectScope, never trusted from the body.
    projectId: {
      type: Number,
      required: [true, 'projectId is required'],
      index: true,
    },
    title: {
      type: String,
      required: [true, 'Please add a title'],
      trim: true,
    },
    description: { type: String },
    steps: { type: [SharedStepEntrySchema], default: [] },
    createdBy: { type: String },
    updatedBy: { type: String },
  },
  { timestamps: true }
);

// Mirrors TestRepoSchema's hook (models/testrepo.js:213-225): atomic counter,
// guarded on isNew so an update never re-stamps the id.
SharedStepSchema.pre("save", async function (next) {
  if (!this.isNew) return next();
  try {
    const nextId = await getNextSequence(this.constructor.db, 'sharedstep');
    this.id = nextId;
    this.SharedStepId = "SS-" + nextId;
    return next();
  } catch (error) {
    return next(error);
  }
});

module.exports = mongoose.model("SharedStep", SharedStepSchema);
```

- [ ] **Step 4: Write the controller**

`backend/testRepoService/controllers/sharedStep.js`. Model the handlers on `controllers/testrepo.js` — same `asyncHandler`, same `audit(req, {...})` call after each mutation (`entityType: 'sharedstep'`), same `ErrorResponse` usage.

The two handlers that are not boilerplate:

```js
// The single source of truth for "which test cases reference this shared
// step", used by both the usage route and the delete guard so they can
// never disagree. `TestSteps.sharedStepId` is the reference field added in
// Task 2; a string _id is cast by Mongoose against the ObjectId path.
const findUsage = async (sharedStepId, projectId) => {
  const testCases = await TestCase.find(
    { projectId, 'TestSteps.sharedStepId': sharedStepId },
    'TestCaseId TestCaseSummary'
  ).lean();
  return { count: testCases.length, testCases };
};

// @desc    Which test cases reference this shared step
// @route   GET /api/v1/sharedstep/:id/usage
// @access  Private (read)
exports.getSharedStepUsage = asyncHandler(async (req, res, next) => {
  const { projectId } = req.projectScope;
  const sharedStep = await SharedStep.findOne({ _id: req.params.id, projectId });
  if (!sharedStep) {
    return next(new ErrorResponse(`Shared step not found with id of ${req.params.id}`, 404));
  }
  const usage = await findUsage(sharedStep._id, projectId);
  res.status(200).json({ success: true, data: usage });
});

// @desc    Delete a shared step
// @route   DELETE /api/v1/sharedstep/:id
// @access  Private (delete)
//
// WP-F06 R4: an in-use shared step is NOT deleted and NOT cascaded.
// Cascading would blank the steps of every referencing test case with no
// way back; deleting the document while leaving dangling references would
// make those cases render empty rows. Refusing with the usage payload lets
// the caller show exactly what is in the way.
exports.deleteSharedStep = asyncHandler(async (req, res, next) => {
  const { projectId } = req.projectScope;
  const sharedStep = await SharedStep.findOne({ _id: req.params.id, projectId });
  if (!sharedStep) {
    return next(new ErrorResponse(`Shared step not found with id of ${req.params.id}`, 404));
  }
  const usage = await findUsage(sharedStep._id, projectId);
  if (usage.count > 0) {
    return res.status(409).json({
      success: false,
      error: `${sharedStep.SharedStepId} is used by ${usage.count} test case(s) and cannot be deleted`,
      data: usage,
    });
  }
  await sharedStep.deleteOne();
  await audit(req, { entityType: 'sharedstep', entityId: sharedStep.SharedStepId, action: 'delete',
    before: { SharedStepId: sharedStep.SharedStepId, title: sharedStep.title } });
  res.status(200).json({ success: true, data: {} });
});
```

`createSharedStep` stamps `projectId` from `req.projectScope.projectId` and `createdBy`/`updatedBy` from `req.kauth.grant.access_token.content.sub`. `updateSharedStep` uses `findOneAndUpdate({_id, projectId}, ...)` with `{new: true, runValidators: true}` and `delete req.body.projectId` first. `getSharedSteps` just returns `res.advancedResults`.

- [ ] **Step 5: Write the router and mount it**

`backend/testRepoService/routes/sharedStep.js` — copy the shape of `routes/testrepo.js`, keeping the named `/:id/usage` route registered **before** `/:id`:

```js
const express = require('express');
const { initKeycloak, advancedResults, requireProjectScope, authorize } = require('@srckube/service-core');
const keycloak = initKeycloak();
const {
  getSharedSteps, getSharedStep, createSharedStep,
  updateSharedStep, deleteSharedStep, getSharedStepUsage,
} = require('../controllers/sharedStep');

const router = express.Router({ mergeParams: true });
const SharedStep = require('../models/SharedStep');

router.route('/:id/usage').get(keycloak.protect(), requireProjectScope(), authorize('read'), getSharedStepUsage);

router.route('/')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), advancedResults(SharedStep), getSharedSteps)
  .post(keycloak.protect(), requireProjectScope(), authorize('write'), createSharedStep);

router.route('/:id')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), getSharedStep)
  .put(keycloak.protect(), requireProjectScope(), authorize('write'), updateSharedStep)
  .delete(keycloak.protect(), requireProjectScope(), authorize('delete'), deleteSharedStep);

module.exports = router;
```

In `backend/testRepoService/server.js`, beside the existing `app.use('/api/v1/testrepo',testrepo)` (line 100), add the require next to line 34 and:

```js
app.use('/api/v1/sharedstep', sharedStep)
```

- [ ] **Step 6: Run the tests to verify they pass**

```bash
cd /Users/arunganesha/srckubetest/backend/testRepoService && npx jest __tests__/sharedStep.test.js
```
Expected: PASS. Then run the whole service suite to prove nothing regressed:
```bash
cd /Users/arunganesha/srckubetest/backend/testRepoService && npx jest
```

- [ ] **Step 7: Prove the tests are non-vacuous**

For each of the three highest-value tests, break the production code, confirm the test fails, restore it. Record the result in the report.
- Delete the `projectId` filter from `findUsage` → the cross-project usage test must fail.
- Change the 409 to a 200 in `deleteSharedStep` → the delete-guard test must fail.
- Remove `reqdetails['projectId'] = req.projectScope.projectId` from `createSharedStep` → the stamping test must fail.

- [ ] **Step 8: Commit**

```bash
git add backend/testRepoService
git commit -m "WP-F06 Task 1: SharedStep collection, CRUD, and the delete guard"
```

---

### Task 2: Step references on test cases, and opt-in expansion

**Files:**
- Modify: `backend/testRepoService/models/testrepo.js:11-21` (`TestStepSchema`)
- Create: `backend/testRepoService/utils/expandSteps.js`
- Modify: `backend/testRepoService/controllers/testrepo.js` (`getTestCases`, `getTestCase`)
- Modify: `backend/shared/service-core/middleware/advancedResults.js` (add `'expand'` to `removeFields` — see premise 9; **shared middleware, mounted on 17 list routes**)
- Modify: `srckube-kong/kong.yml` (add the `sharedStepRoute` — see premise 10)
- Test: `backend/testRepoService/__tests__/expandSteps.test.js`

**Interfaces:**
- Consumes: Task 1's `SharedStep` model.
- Produces:
  - `TestStepSchema` gains `sharedStepId: { type: mongoose.Schema.Types.ObjectId, ref: 'SharedStep' }`.
  - `expandSteps(docs, projectId) -> docs` — exported from `utils/expandSteps.js`, takes an array of plain test case objects, returns them with every reference row in `TestSteps` replaced in place by that shared step's `steps`, each expanded row carrying `{ testStep, Expected, sharedStepId, sharedStepTitle, sharedStepIndex }`.
  - `?expand=steps` on `GET /api/v1/testrepo` and `GET /api/v1/testrepo/:id`.

- [ ] **Step 1: Write the failing test**

`backend/testRepoService/__tests__/expandSteps.test.js`:

```js
it('leaves a case with no references untouched', async () => { /* deep-equal in === out */ });

it('replaces a reference row with the shared step\'s rows, in place', async () => {
  // TestSteps: [plain A, ref->SS(2 rows), plain B]  ->  4 rows, order A, s1, s2, B
});

it('marks every expanded row with its origin', async () => {
  expect(out[1]).toMatchObject({ sharedStepId: String(ss._id), sharedStepTitle: 'Log in as admin', sharedStepIndex: 0 });
});

it('drops a reference to a shared step that no longer exists rather than emitting a blank row', async () => {
  // a dangling reference must not become { testStep: undefined } in an execution
});

it('never expands a shared step from another project', async () => {
  // ref to a project-2 shared step, expanded for project 1 -> dropped, not leaked
});

it('resolves all referenced shared steps in one query regardless of how many cases reference them', async () => {
  // spy on SharedStep.find; assert callCount === 1 for 5 cases x 3 refs
});
```

And in `__tests__/api.test.js`, add:

```js
it('returns reference rows unexpanded by default, so a read-modify-write round trip preserves them', async () => {
  const res = await request(app).get(`/api/v1/testrepo/${id}`).set(authHeaders).set(PROJECT_HEADER, '1');
  expect(res.body.data.TestSteps[0].sharedStepId).toBeDefined();
  expect(res.body.data.TestSteps).toHaveLength(1); // NOT the 2 rows of the shared step
});

it('expands reference rows only when ?expand=steps is asked for', async () => {
  const res = await request(app).get(`/api/v1/testrepo/${id}?expand=steps`).set(authHeaders).set(PROJECT_HEADER, '1');
  expect(res.body.data.TestSteps).toHaveLength(2);
  expect(res.body.data.TestSteps[0].testStep).toBe('Open /login');
});

it('expands on the list route too, which is the route execution enrichment uses', async () => {
  const res = await request(app).get('/api/v1/testrepo?TestCaseId=TC-1&expand=steps')...
});

it('does not let expand= leak into the Mongo filter and empty the result set', async () => {
  // Without 'expand' in advancedResults' removeFields this returns 0 rows,
  // which would break execution enrichment silently rather than loudly.
  const res = await request(app).get('/api/v1/testrepo?expand=steps').set(authHeaders).set(PROJECT_HEADER, '1');
  expect(res.body.data.length).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/arunganesha/srckubetest/backend/testRepoService && npx jest __tests__/expandSteps.test.js __tests__/api.test.js
```
Expected: FAIL — `expandSteps` does not exist; `sharedStepId` is stripped by the strict `TestStepSchema`.

- [ ] **Step 3: Add the reference field**

In `backend/testRepoService/models/testrepo.js`, replace `TestStepSchema` (lines 11-21) with:

```js
const TestStepSchema = new mongoose.Schema(
  {
    testStep:{
      type: String
    },
    Expected:{
      type: String
    },
    // WP-F06 -- when set, this row is a REFERENCE to a SharedStep, not a
    // step in its own right, and testStep/Expected are ignored. Storage
    // stays canonical: reads return the reference as-is unless the caller
    // asks for ?expand=steps. Expanding on every read would mean the
    // editor reads flat rows, PUTs flat rows back, and silently converts
    // every reference into a copy -- the exact failure this feature exists
    // to prevent, with no error and nothing to notice.
    sharedStepId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SharedStep',
    },
  }
)
```

- [ ] **Step 4: Write the expander**

`backend/testRepoService/utils/expandSteps.js`:

```js
const SharedStep = require('../models/SharedStep');

// WP-F06 -- expand reference rows into flat steps for consumers that need
// a plain sequence (execution enrichment, AI, CSV export). One query for
// the whole page of documents, not one per case: enrichment can pass a
// list of cases and this must not become N+1.
//
// projectId is required and applied to the lookup, so a reference that
// somehow points at another project's shared step resolves to nothing and
// is dropped rather than leaking that project's text.
async function expandSteps(docs, projectId) {
  const list = Array.isArray(docs) ? docs : [docs];

  const ids = new Set();
  for (const doc of list) {
    for (const step of doc?.TestSteps || []) {
      if (step && step.sharedStepId) ids.add(String(step.sharedStepId));
    }
  }
  if (ids.size === 0) return docs;

  const shared = await SharedStep.find(
    { _id: { $in: [...ids] }, projectId },
    'title steps'
  ).lean();
  const byId = new Map(shared.map((s) => [String(s._id), s]));

  for (const doc of list) {
    if (!doc || !Array.isArray(doc.TestSteps)) continue;
    const expanded = [];
    for (const step of doc.TestSteps) {
      if (!step || !step.sharedStepId) {
        expanded.push(step);
        continue;
      }
      const source = byId.get(String(step.sharedStepId));
      // A dangling or cross-project reference is DROPPED, not emitted as a
      // blank row. ExecutionTestStepSchema is strict (testStep/Expected/
      // status), so a blank row would be snapshotted into a run as an
      // empty step with no clue where it came from.
      if (!source) continue;
      source.steps.forEach((s, i) => {
        expanded.push({
          testStep: s.testStep,
          Expected: s.Expected,
          sharedStepId: String(step.sharedStepId),
          sharedStepTitle: source.title,
          sharedStepIndex: i,
        });
      });
    }
    doc.TestSteps = expanded;
  }
  return docs;
}

module.exports = { expandSteps };
```

- [ ] **Step 5: Wire the opt-in into the two read routes**

In `controllers/testrepo.js`, in `getTestCases` (which currently returns `res.advancedResults`) and `getTestCase`:

```js
// WP-F06 -- opt-in only (R2). Note getTestCases is the route execution
// enrichment calls (/api/v1/testrepo?TestCaseId=...), so expansion has to
// work here and not only on /:id.
if (req.query.expand === 'steps') {
  const payload = { ...res.advancedResults };
  payload.data = await expandSteps(
    JSON.parse(JSON.stringify(payload.data)),
    req.projectScope.projectId
  );
  return res.status(200).json(payload);
}
```

Use the same deep-clone-then-expand shape in `getTestCase`. The clone matters: `advancedResults` may hand back hydrated Mongoose documents, and assigning a plain array with extra keys onto a strict subdocument path would drop `sharedStepTitle`/`sharedStepIndex` silently.

**`expand` must not reach the Mongo filter — this is a required edit, already verified (premise 9).** `advancedResults` copies every query key except `select`/`sort`/`page`/`limit` into the Mongo filter, so without this change `?expand=steps` queries `{expand: 'steps'}` and returns zero rows. In `backend/shared/service-core/middleware/advancedResults.js`, in the `removeFields` line:

```js
  // Fields to exclude. WP-F06 adds 'expand': it selects a response SHAPE
  // (see testRepoService's getTestCases) and is never a document field --
  // no model in any service declares one, verified by grep across
  // backend/*/models/ -- so leaving it in reqQuery would filter every list
  // route down to zero rows the moment a caller asks to expand.
  const removeFields = ['select', 'sort', 'page', 'limit', 'expand'];
```

This is shared middleware mounted on 17 list routes. Add a test to `backend/shared/service-core/__tests__/advancedResults.test.js` asserting `?expand=steps` does not reach the filter, and run that suite before moving on.

- [ ] **Step 6: Expose the route through the gateway**

Premise 10: Kong routes `/api/v1/testrepo` and nothing else to `testRepoService`, so Task 1's `/api/v1/sharedstep` endpoints are unreachable from the browser and Tasks 4-6 would fail with a gateway 404 that looks like a frontend bug.

In `srckube-kong/kong.yml`, inside the `testRepoService` service's `routes:` list (the service block beginning `host: testreposervice` / `name: testRepoService` at line ~367), add a second route immediately after the existing `testRepoRoute` entry, matching it field for field including the `jwt` plugin:

```yaml
  - https_redirect_status_code: 426
    name: sharedStepRoute
    path_handling: v0
    paths:
    - /api/v1/sharedstep
    preserve_host: false
    protocols:
    - http
    - https
    regex_priority: 0
    request_buffering: true
    response_buffering: true
    strip_path: false
    plugins:
    - name: jwt
      enabled: true
      config:
        claims_to_verify:
        - exp
```

A separate named route, not a second path on `testRepoRoute`: every one of the 61 routes in this file has exactly one path, and following that convention keeps the route name meaningful in Kong's logs and metrics.

Reload the gateway and prove the route answers — a 401 (no token) is the proof it is ROUTED; a 404 means it is not:

```bash
docker compose restart kong
sleep 5
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8000/api/v1/sharedstep
```
Expected: `401`, not `404`. Record the actual code in the report.

- [ ] **Step 7: Run to verify pass**

```bash
cd /Users/arunganesha/srckubetest/backend/testRepoService && npx jest
```
Expected: PASS, whole suite.

- [ ] **Step 8: Prove non-vacuity**

- Change `if (!source) continue;` to `expanded.push(step);` → the dangling-reference test must fail.
- Remove `projectId` from the `SharedStep.find` → the cross-project test must fail.
- Make expansion unconditional (drop the `req.query.expand` check) → the round-trip-preservation test must fail.
- Remove `'expand'` from `removeFields` → the filter-leak test must fail with an empty result set.

- [ ] **Step 9: Commit**

```bash
git add backend srckube-kong
git commit -m "WP-F06 Task 2: step references, and expansion that is opt-in by design"
```

---

### Task 3: Expanded steps reach executions, AI, and export

**Files:**
- Modify: `backend/testPlanExecutionService/controllers/testexecution.js:299`
- Modify: `backend/testRepoService/controllers/importExport.js` (CSV export path)
- Modify: `backend/aiService` step-reading path — locate it via `grep -rn "TestSteps" backend/aiService`
- Test: `backend/testPlanExecutionService/__tests__/api.test.js`

**Interfaces:**
- Consumes: Task 2's `?expand=steps`.
- Produces: nothing new; this task closes the gap between the two.

- [ ] **Step 1: Write the failing test**

In `backend/testPlanExecutionService/__tests__/api.test.js`:

```js
it('snapshots a shared step\'s rows into the execution, not the unexpanded reference', async () => {
  // A test case whose only step is a reference to a 2-row shared step.
  // Open it in a run (the enrichment path), then read the execution back.
  // ExecutionTestStepSchema is strict, so an unexpanded reference lands as
  // a blank step -- this asserts the real text arrived.
  expect(tc.TestSteps).toHaveLength(2);
  expect(tc.TestSteps[0].testStep).toBe('Open /login');
  expect(tc.TestSteps[0].Expected).toBeTruthy();
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/arunganesha/srckubetest/backend/testPlanExecutionService && npx jest __tests__/api.test.js
```
Expected: FAIL — one blank step, or a length of 1.

- [ ] **Step 3: Ask for expansion at each consumer**

`backend/testPlanExecutionService/controllers/testexecution.js:299`:

```js
      // WP-F06 -- expand=steps because ExecutionTestStepSchema is strict
      // (testStep/Expected/status): an unexpanded reference row would have
      // sharedStepId stripped on save and be snapshotted into the run as a
      // blank step. An execution is a point-in-time snapshot by design
      // (this is what keeps a finished run honest when the shared step is
      // later edited), so it must snapshot the resolved text.
      url: `http://${process.env.testRepoService}/api/v1/testrepo?TestCaseId=${tcid}&expand=steps`,
```

Do the same for the CSV export read in `controllers/importExport.js` and for the aiService path. For each, add a test in that service's own suite asserting expanded text appears.

- [ ] **Step 4: Run to verify pass**

```bash
cd /Users/arunganesha/srckubetest/backend/testPlanExecutionService && npx jest
cd /Users/arunganesha/srckubetest/backend/testRepoService && npx jest
cd /Users/arunganesha/srckubetest/backend/aiService && npx jest
```

- [ ] **Step 5: Prove non-vacuity**

Remove `&expand=steps` from the enrichment URL → the snapshot test must fail. Restore.

- [ ] **Step 6: Commit**

```bash
git add backend
git commit -m "WP-F06 Task 3: expanded steps reach executions, export, and AI"
```

---

### Task 4: The Steps tab renders and preserves references

**Files:**
- Modify: `frontend/src/Components/Tabs/AddDeleteTableRows.tsx`
- Modify: `frontend/src/Components/Tabs/TableRows.tsx`
- Modify: `frontend/src/workbench/detail/modules/TestCaseDetail.tsx:35` (the `TestSteps` type)
- Create: `frontend/src/api/sharedStepApi.ts`
- Test: `frontend/src/Components/Tabs/__tests__/AddDeleteTableRows.sharedSteps.test.tsx`

**Interfaces:**
- Consumes: Task 1's routes, Task 2's row shape.
- Produces: `sharedStepApi.ts` exporting `listSharedSteps()`, `getSharedStep(id)`, `createSharedStep(body)`, `updateSharedStep(id, body)`, `deleteSharedStep(id)`, `getSharedStepUsage(id)` — built with `axiosPrivate` from `frontend/src/api/axios`, spelling the full `/api/v1/sharedstep` path, exactly as every sibling module does (`fieldsApi.ts`, `linkApi.ts`, `savedViewApi.ts`, ...). `axiosPrivate`'s baseURL is the gateway host only, and its request interceptor adds `X-Project-Id` automatically, so no per-call header wiring is needed. `apiCalls.tsx` is off-limits for new call sites, per the WP-015/WP-025 precedent that every sibling module's own header comment repeats.

**Correction:** an earlier draft of this plan told the implementer to use a `serviceApi()` helper with a baseURL already containing `/api/v1`. **No such helper exists in `frontend/src`** — `serviceApi()` lives in `frontend/e2e/support/api.ts` and is a Playwright-only helper. Following the plan as written would have produced a doubled or missing path prefix. Task 4's implementer verified rather than complied and used the real convention.

**Constraint:** `AddDeleteTableRows` is shared with module 4 (Test Runs). Every change here is gated on `props.module === 1` or is inert for rows without `sharedStepId`. Run `TestRunDetail`'s suites before committing.

- [ ] **Step 1: Write the failing test**

```tsx
it('renders a reference row as one read-only shared-step row, not an editable pair', () => {
  // rows: [{ sharedStepId: 'abc', sharedStepTitle: 'Log in as admin' }]
  expect(screen.getByText(/Log in as admin/)).toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});

it('does not let a shared row be edited in place', () => { /* no textbox in that row */ });

it('still allows a plain row beside a reference row to be edited', () => { /* the plain row has textboxes */ });

it('preserves the reference when an unrelated plain row is edited', () => {
  // THE round-trip guard. Edit the plain row, assert setTcSteps was called
  // with an array whose reference row still carries sharedStepId.
  expect(setTcSteps).toHaveBeenCalledWith(
    expect.arrayContaining([expect.objectContaining({ sharedStepId: 'abc' })])
  );
});

it('leaves module 4 rows exactly as they were', () => { /* status column still rendered, no shared UI */ });
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/arunganesha/srckubetest/frontend && npx craco test --watchAll=false --testPathPattern="AddDeleteTableRows"
```

- [ ] **Step 3: Render reference rows**

In `TableRows.tsx`, branch at the top of the row: if `row.sharedStepId` is set, render a single full-width cell showing a `<LinkIcon/>`, the `sharedStepTitle`, and a "shared" `Chip` — read-only, with the delete-row control still available (removing the reference is legitimate; editing it in place is not). Otherwise render exactly what it renders today.

In `AddDeleteTableRows.tsx`, leave `handleChange`, `addTableRows` and `deleteTableRows` structurally alone — they already copy whole row objects, so `sharedStepId` survives. Add the test above that *proves* it rather than assuming it.

- [ ] **Step 4: Extend the type**

`TestCaseDetail.tsx:35`:

```tsx
  TestSteps?: Array<{ testStep: string; Expected: string; sharedStepId?: string; sharedStepTitle?: string }>;
```

- [ ] **Step 5: Run to verify pass, and check module 4 did not move**

```bash
cd /Users/arunganesha/srckubetest/frontend && npx craco test --watchAll=false --testPathPattern="AddDeleteTableRows|TestRunDetail|TestCaseDetail"
```

- [ ] **Step 6: Commit**

```bash
git add frontend/src
git commit -m "WP-F06 Task 4: the Steps tab renders references and keeps them intact"
```

---

### Task 5: Insert a shared step, and manage the library

**Files:**
- Create: `frontend/src/Components/sharedSteps/SharedStepPicker.tsx`
- Create: `frontend/src/Components/sharedSteps/SharedStepManagerDialog.tsx`
- Modify: `frontend/src/workbench/detail/modules/TestCaseDetail.tsx` (Steps tab toolbar)
- Test: `frontend/src/Components/sharedSteps/__tests__/SharedStepPicker.test.tsx`, `.../SharedStepManagerDialog.test.tsx`

**Interfaces:**
- Consumes: `sharedStepApi.ts` from Task 4; `usePermissions()` for gating (read `frontend/src/workbench/list/entityListConfigs.tsx` for how `can('write')`/`can('delete')` is used).
- Produces: nothing consumed downstream except by Task 6's journey.

- [ ] **Step 1: Write the failing tests**

Picker: lists shared steps, filters by typed text, inserting appends `{ sharedStepId, sharedStepTitle }` to the step array, a viewer (`can('write') === false`) never sees the insert control.

Manager: creates a shared step from the dialog; editing one and saving calls `updateSharedStep`; the delete control is hidden without `can('delete')`; **a 409 from delete renders the usage list rather than a generic error** — that last one is the test that matters most, since it is the whole point of R4.

```tsx
it('shows which test cases are blocking a delete when the server refuses', async () => {
  mockDeleteSharedStep.mockRejectedValue({ response: { status: 409, data: {
    error: 'SS-3 is used by 2 test case(s) and cannot be deleted',
    data: { count: 2, testCases: [{ TestCaseId: 'TC-1' }, { TestCaseId: 'TC-9' }] } } } });
  // ... click delete, confirm
  expect(await screen.findByText(/TC-1/)).toBeInTheDocument();
  expect(await screen.findByText(/TC-9/)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify failure**

```bash
cd /Users/arunganesha/srckubetest/frontend && npx craco test --watchAll=false --testPathPattern="SharedStep"
```

- [ ] **Step 3: Build the picker and the dialog**

Both are MUI `<Dialog>`s using react-query (`useQuery(['sharedsteps', projectId], listSharedSteps)`), matching the query-key and error-handling conventions already used in `frontend/src/Components/settings/FieldsPanel.tsx` — read it first and follow it rather than inventing a second style.

In `TestCaseDetail.tsx`, add two buttons above `<AddDeleteTableRows>`, both gated on `canWrite`: **Insert shared step…** (opens the picker) and **Manage shared steps…** (opens the manager).

- [ ] **Step 4: Run to verify pass**

```bash
cd /Users/arunganesha/srckubetest/frontend && npx craco test --watchAll=false --testPathPattern="SharedStep|TestCaseDetail"
```

- [ ] **Step 5: Add the a11y suites**

Add `SharedStepPicker.a11y.test.tsx` and `SharedStepManagerDialog.a11y.test.tsx` following `frontend/src/Components/settings/__tests__/FieldsPanel.a11y.test.tsx`. **Each must include a non-vacuity guard asserting the interactive controls are actually mounted** — an axe suite over a dialog that never opened is a pass that means nothing, which is exactly how WP-F05's a11y suite went vacuous.

- [ ] **Step 6: Lint and commit**

```bash
cd /Users/arunganesha/srckubetest/frontend && npx eslint src/Components/sharedSteps --ext .ts,.tsx
git add frontend/src
git commit -m "WP-F06 Task 5: insert a shared step, and manage the library"
```

---

### Task 6: Browser journey, and close the package

**Files:**
- Create: `frontend/e2e/specs/shared-steps.spec.ts`
- Modify: `docs/superpowers/PRODUCT_GAP_REGISTER.md`
- Modify: `docs/superpowers/plans/2026-09-05-functional-gaps-program.md` (mark F06 done)

- [ ] **Step 1: Write the journey**

Follow `frontend/e2e/specs/tags.spec.ts` for structure: `createE2EPersona('contributor')`, own fixtures, `try/finally` cleanup on every path. Note the shared persona has `write: true, delete: false` — a delete-path assertion needs its own persona.

The journey, which is the only place the whole chain is proven end to end:

1. Create a shared step ("Log in as admin", 2 rows) through the manager dialog.
2. Create a test case; insert that shared step; add one plain step after it.
3. Reload. Assert the reference row still renders as a shared row — **not** as two flattened copies. This is the round-trip guard in the browser.
4. Edit the shared step's first row through the manager.
5. Reopen the test case. Assert the new text shows. **This is the feature**: one edit, every case updated.
6. Attempt to delete the in-use shared step; assert the refusal names the test case.
7. `finally`: detach the reference, delete the test case and the shared step.

- [ ] **Step 2: Prove it non-vacuous**

Neuter the insert handler in `SharedStepPicker.tsx` so it appends a plain row instead of a reference; the journey must fail at step 3 or 5. Restore and re-run. Record both outcomes in the report.

- [ ] **Step 3: Run it**

```bash
cd /Users/arunganesha/srckubetest/frontend && npx playwright test specs/shared-steps.spec.ts
```

- [ ] **Step 4: Sweep for leaked fixtures**

```bash
docker exec mongodb mongosh --quiet -u srckuberoot -p "$MONGO_PW" --authenticationDatabase admin --eval '
var d=db.getSiblingDB("srckube-testrepo");
print("leftover shared steps: " + d.sharedsteps.countDocuments({title:/^e2e-/}));'
```
Expected: 0.

- [ ] **Step 5: Write the register entry**

Append a dated `### 2026-09-07 — after WP-F06` section to `PRODUCT_GAP_REGISTER.md` recording: R1-R5 and their evidence; that expansion is opt-in and **why** (the round-trip trap); that execution history needed no versioning because enrichment already snapshots; and, plainly, any defect a review caught in this package that the package's own tests missed.

- [ ] **Step 6: Commit**

```bash
git add frontend/e2e docs
git commit -m "WP-F06 Task 6: the end-to-end journey, and the register entry closing F06"
```

---

## Self-review

**Spec coverage.** The F06 row asks for reusable/shared steps so a shared login sequence stops being retyped and stops being a bulk edit to change. Task 1 gives them a home, Task 2 gives test cases a way to reference them, Task 3 keeps every existing consumer working, Tasks 4-5 give the author a way to use them, Task 6 proves the one-edit-many-cases property in a browser. The downstream edges hold: F07 needs steps to be *addressable*, which `sharedStepId` + `sharedStepIndex` provide; F08's "a template is a named draft" is unaffected; F14 must not be started before this lands, and now has a settled model to import against.

**Type consistency.** `sharedStepId` is an `ObjectId` in Mongo and a `string` everywhere it crosses the wire — the expander stringifies it (`String(step.sharedStepId)`), the frontend type declares `sharedStepId?: string`, and the usage/delete handlers let Mongoose cast the string param. `SharedStepId` (capital S, the `SS-n` human id) and `sharedStepId` (the reference) are deliberately different things; the plan uses each consistently.

**Known risk, stated rather than hidden.** Task 4 modifies a component shared with Test Runs whose props are untyped. The mitigation is the module-4 inertness test plus running `TestRunDetail`'s suites, but this is the task most likely to need a fix round.
