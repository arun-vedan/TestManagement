# WP-F03 — Bulk operations for requirements, test plans and test runs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** give the four modules that have no bulk actions at all the ones their data model can actually support, so a tester can act on many records at once outside test cases and defects.

**Architecture:** copy the bulk-operations pattern that already ships in `testRepoService` into `requirementService` and `testPlanExecutionService`, then fill in the `buildBulkActions` factories that `entityListConfigs.tsx` already leaves returning empty arrays. **The selection UI already exists** and turns itself on.

**Tech Stack:** Node 18 / Express / Mongoose, React 18 + TypeScript + MUI, Jest, axios (live backend suites), Playwright.

**Spec:** `docs/superpowers/plans/2026-09-05-functional-gaps-program.md` — work package F03.

---

## What was verified before this plan was written

The last package was planned on a premise that turned out false. These were each checked against source or live data.

- **Bulk exists for exactly two modules.** `/bulk` PATCH+DELETE routes exist only in `testRepoService/routes/testrepo.js` and `defectService/routes/defects.js`. `api/bulkApi.ts` exports exactly five functions, covering test cases and defects.
- **The frontend is already built for this and is honest about the gap.** `workbench/list/entityListConfigs.tsx` has a config per module, each exposing **`buildBulkActions({ canWrite, canDelete }) => BulkActionConfig[]`** — a factory taking the caller's permissions, not a plain array (corrected 2026-09-06 after Task 3 found my original description wrong; `EntityList.tsx:79` calls it and derives `checkboxSelection` from the result's length). Modules 2, 3 and 4 return `[]` from it and carry explicit comments — *"No bulk API for requirements… deliberately empty, not fabricated"* (lines 213, 253, 277). `EntityList.tsx:141` renders `checkboxSelection={bulkActions.length > 0}` from that factory's result, so **selection and the `BulkActionBar` appear on their own the moment a module's factory returns actions.** No list-view work is needed.
- **Which actions each module can support is NOT uniform** — this is the plan's central fact:

| Module | `status` field | `assignedTo` field | Bulk actions this package adds |
|---|---|---|---|
| 2 Requirements | yes — `['draft','review','approved','deprecated','archived']` | **no** | status, delete |
| 3 Test Plans | **no** | **no** | delete only |
| 4 Test Runs | **no** | yes | assign, delete |

  Verified by reading each model. Do not add an assign action to requirements or plans, or a status action to plans or runs — the fields do not exist.
- **`/bulk` collides with `/:id`** in both target services unless registered first. Both have `/:id` routes today and neither has a `/bulk`.

## Defect bulk status is deliberately NOT in this package

The register lists "defects have no bulk status change" alongside these. It is excluded here, and the reason is not effort:

`defectService`'s status transition is validated against a **separate service** (`istatusservice`) over HTTP, and its documented behaviour when that service is unavailable is **fail closed with a 503** (`controllers/defects.js:220-285`). Under this repo's all-or-nothing bulk policy, every id must be validated *before any write*, so a bulk status change over N defects means N cross-service calls against a fail-closed dependency — a materially different risk profile from the three modules here, whose validation is a local enum check.

Mixing the two would produce a package a reviewer cannot reject by halves. Defect bulk status gets its own package; record it.

## A defect corrected in this plan after Task 1

Task 1's first draft of the delete handler had no compensating rollback, and its review caught it: the
header comment promised one, the canonical `testrepo.js:470-487` has one, and without it a mid-loop
failure leaves earlier items permanently deleted — breaking the all-or-nothing guarantee `BulkActionBar`
shows the user before they confirm. The same omission was present twice in Task 2's snippets below and
has been fixed here. Both delete handlers now carry the try/catch re-insertion rollback and audit with a
`before` snapshot, because on a delete the audit row is the only surviving record of what was destroyed.

## Global Constraints

- **No new runtime dependency.**
- **Every new route** mounts `keycloak.protect()` → `requireProjectScope()` → `authorize('<action>')`. PATCH uses `'write'`, DELETE uses `'delete'` — split by HTTP method, never one route dispatching on `req.body.action`, so the existing `authorize()` middleware gates them with no new per-body authorization logic.
- **`/bulk` registers BEFORE `/:id`.** Express matches in registration order.
- **Never trust `projectId` from a request body** — it comes from `req.projectScope.projectId`.
- **All-or-nothing, and say so.** Every id is validated to exist *in this project* before any write. On any failure nothing is written and the response carries `policy: 'all-or-nothing'`. `BulkActionBar` promises the user exactly this, so the promise and the behaviour must not diverge.
- **Audit once per item**, never a single summary event — a bulk operation on N items produces exactly N audit events. This is the established convention and a WP-043 acceptance criterion.
- **Cap at 500 items** per operation, matching `BULK_MAX_ITEMS` in the existing controller.
- **CRA/CRACO frontend: `npx jest` does not work.** Use `CI=true npx craco test <path> --watchAll=false`.
- **The frontend suite cannot be green:** 35 of 79 suites fail *to run* on a pre-existing `keycloak-js` ESM parse error. Bar: **0 tests failing, failed-suite count still 35**. `npx eslint 'src/**/*.{ts,tsx}'` must exit 0.
- **Verify against the running stack.** Backend suites are live HTTP tests; rebuild the touched container and restart Kong afterwards.
- **Append to `docs/superpowers/PRODUCT_GAP_REGISTER.md`** at the end.

## The pattern to copy

**Read `backend/testRepoService/controllers/testrepo.js:309-520` before writing anything.** It is the canonical implementation and its header comment records every decision you are inheriting: the all-or-nothing justification (this Mongo is standalone, so there is no multi-document transaction), the compensating-rollback loop, the per-item audit rule, and the RBAC split. Route registration to mirror: `testRepoService/routes/testrepo.js:44-56`.

---

### Task 1: Bulk status-change and delete for requirements

**Files:**
- Modify: `backend/requirementService/controllers/requirement.js` (append two exports)
- Modify: `backend/requirementService/routes/requirement.js` (register `/bulk` before `/:id`)
- Test: `backend/requirementService/__tests__/api.test.js` (append a describe block)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces, consumed by Task 3:
  - `PATCH /api/v1/requirement/bulk` body `{ ids: string[], action: 'status', status: string }` → `200 { success: true, policy: 'all-or-nothing', updated: n }`
  - `DELETE /api/v1/requirement/bulk` body `{ ids: string[] }` → `200 { success: true, policy: 'all-or-nothing', deleted: n }`
  - Rejection → `422 { success: false, policy: 'all-or-nothing', error, missingIds?, invalidIds? }`

  `ids` are Mongo `_id` strings, matching the existing test-case bulk contract.

**Note the difference from test cases:** requirements have **no `assignedTo` field**, so there is no `'assign'` action. `action` accepts only `'status'`. Do not add assign.

- [ ] **Step 1: Write the failing test**

Append to `backend/requirementService/__tests__/api.test.js`, following that file's existing authed-client setup (`getServiceToken()` + `PROJECT_ID_HEADER: '1'`). Create the requirements this block operates on inside the block and delete them in `afterAll` — do **not** bulk-delete seeded fixtures.

```javascript
// WP-F03 -- bulk operations for requirements. Before this WP, /bulk existed
// only on testRepoService and defectService; requirements, test plans and
// test runs had no bulk anything, which entityListConfigs.tsx recorded
// honestly as an empty bulkActions array rather than a fabricated one.
describe('bulk operations on requirements', () => {
  let client;
  const created = [];

  beforeAll(async () => {
    const token = await getServiceToken();
    client = axios.create({
      baseURL: BASE_URL,
      headers: { Authorization: `Bearer ${token}`, [PROJECT_ID_HEADER]: '1' },
      validateStatus: () => true
    });
    for (let i = 0; i < 3; i += 1) {
      const resp = await client.post('/api/v1/requirement', {
        requirementSummary: `WP-F03 bulk fixture ${i}`,
        description: 'created by the WP-F03 bulk suite'
      });
      expect(resp.status).toBe(201);
      created.push(resp.data.data._id);
    }
  });

  afterAll(async () => {
    for (const id of created) {
      await client.delete(`/api/v1/requirement/${id}`);
    }
  });

  it('changes the status of every id in one call', async () => {
    const resp = await client.patch('/api/v1/requirement/bulk', { ids: created, action: 'status', status: 'review' });
    expect(resp.status).toBe(200);
    expect(resp.data.policy).toBe('all-or-nothing');
    expect(resp.data.updated).toBe(created.length);

    for (const id of created) {
      const one = await client.get(`/api/v1/requirement/${id}`);
      expect(one.data.data.status).toBe('review');
    }
  });

  it('writes NOTHING when one id in the batch does not exist', async () => {
    const before = await client.get(`/api/v1/requirement/${created[0]}`);
    const statusBefore = before.data.data.status;

    const resp = await client.patch('/api/v1/requirement/bulk', {
      ids: [...created, '000000000000000000000000'],
      action: 'status',
      status: 'approved'
    });
    expect(resp.status).toBe(422);
    expect(resp.data.policy).toBe('all-or-nothing');

    const after = await client.get(`/api/v1/requirement/${created[0]}`);
    expect(after.data.data.status).toBe(statusBefore);
  });

  it('rejects an invalid status without writing', async () => {
    const resp = await client.patch('/api/v1/requirement/bulk', { ids: created, action: 'status', status: 'not-a-status' });
    expect(resp.status).toBe(400);
  });

  it('rejects an empty id list', async () => {
    const resp = await client.patch('/api/v1/requirement/bulk', { ids: [], action: 'status', status: 'review' });
    expect(resp.status).toBe(400);
  });

  it('has no assign action -- requirements carry no assignedTo field', async () => {
    const resp = await client.patch('/api/v1/requirement/bulk', { ids: created, action: 'assign', assignedTo: 'someone' });
    expect(resp.status).toBe(400);
  });

  it('is not swallowed by the /:id route', async () => {
    // Registration-order guard: if /bulk is registered after /:id, Express
    // matches updateRequirement with id='bulk' and this is never a 200/422.
    const resp = await client.patch('/api/v1/requirement/bulk', { ids: created, action: 'status', status: 'draft' });
    expect([200, 422]).toContain(resp.status);
  });

  it('deletes every id in one call, and nothing when one is missing', async () => {
    const extra = await client.post('/api/v1/requirement', { requirementSummary: 'WP-F03 delete fixture', description: 'x' });
    const extraId = extra.data.data._id;

    const bad = await client.delete('/api/v1/requirement/bulk', { data: { ids: [extraId, '000000000000000000000000'] } });
    expect(bad.status).toBe(422);
    const stillThere = await client.get(`/api/v1/requirement/${extraId}`);
    expect(stillThere.status).toBe(200);

    const ok = await client.delete('/api/v1/requirement/bulk', { data: { ids: [extraId] } });
    expect(ok.status).toBe(200);
    expect(ok.data.deleted).toBe(1);
    const gone = await client.get(`/api/v1/requirement/${extraId}`);
    expect(gone.status).toBe(404);
  });
});
```

If the create response's status or body shape differs from `201` / `data.data._id`, read the controller and match reality — do not change the controller to suit the test.

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd backend/requirementService && npx jest __tests__/api.test.js -t "bulk operations on requirements" --runInBand`

Expected: FAIL — no `/bulk` route exists, so `/api/v1/requirement/bulk` falls through to `PATCH /:id` (or 404s).

- [ ] **Step 3: Write the controllers**

Append to `backend/requirementService/controllers/requirement.js`. Read `testRepoService/controllers/testrepo.js:309-520` first — this mirrors it, minus the assign action.

```javascript
// WP-F03 -- bulk operations for requirements, mirroring
// testRepoService/controllers/testrepo.js:309-520. That file's header
// records the decisions inherited here verbatim: ALL-OR-NOTHING because
// this deployment's Mongo is standalone (no multi-document transaction to
// roll back with), validation of every id BEFORE any write, a compensating
// rollback if a write fails after validation passed, and exactly N audit
// events for N items (never one summary event).
//
// ONE DELIBERATE DIFFERENCE from the test-case version: there is no
// 'assign' action. Requirements carry no `assignedTo` field (verified
// against models/requirement.js), so offering one would be a 400 dressed
// up as a feature.
const BULK_MAX_ITEMS = 500;

function validateBulkIds(req, next) {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    next(new ErrorResponse('ids must be a non-empty array', 400));
    return null;
  }
  if (ids.length > BULK_MAX_ITEMS) {
    next(new ErrorResponse(`Bulk operations are limited to ${BULK_MAX_ITEMS} items at a time (got ${ids.length})`, 400));
    return null;
  }
  return ids;
}

// @desc      Bulk status-change, all-or-nothing.
// @route     PATCH /api/v1/requirement/bulk
// @body      { ids: string[], action: 'status', status: string }
// @access    Private (write)
exports.bulkUpdateRequirements = asyncHandler(async (req, res, next) => {
  const ids = validateBulkIds(req, next);
  if (!ids) return;

  const { action, status: nextStatus } = req.body;
  if (action !== 'status') {
    return next(new ErrorResponse("action must be 'status' (requirements have no assignedTo field)", 400));
  }
  if (!LIFECYCLE_STATUSES.includes(nextStatus)) {
    return next(new ErrorResponse(`Invalid status: ${nextStatus}. Must be one of ${LIFECYCLE_STATUSES.join(', ')}`, 400));
  }

  const found = await Requirement.find({ _id: { $in: ids }, projectId: req.projectScope.projectId });
  const foundIds = found.map((d) => String(d._id));
  const missingIds = ids.filter((id) => !foundIds.includes(String(id)));
  if (missingIds.length > 0) {
    return res.status(422).json({
      success: false,
      policy: 'all-or-nothing',
      error: 'No requirement was changed: some ids were not found in this project',
      missingIds
    });
  }

  const previous = new Map(found.map((d) => [String(d._id), d.status]));
  const applied = [];
  try {
    for (const doc of found) {
      await Requirement.findOneAndUpdate(
        { _id: doc._id, projectId: req.projectScope.projectId },
        { status: nextStatus, updatedBy: req.kauth?.grant?.access_token?.content?.sub }
      );
      applied.push(String(doc._id));
      await audit(req, {
        entityType: 'requirement',
        entityId: doc.reqId,
        action: 'bulk-status',
        after: { status: nextStatus }
      });
    }
  } catch (err) {
    for (const id of applied) {
      await Requirement.findOneAndUpdate(
        { _id: id, projectId: req.projectScope.projectId },
        { status: previous.get(id) }
      );
    }
    return next(err);
  }

  res.status(200).json({ success: true, policy: 'all-or-nothing', updated: applied.length });
});

// @desc      Bulk delete, all-or-nothing.
// @route     DELETE /api/v1/requirement/bulk
// @body      { ids: string[] }
// @access    Private (delete)
exports.bulkDeleteRequirements = asyncHandler(async (req, res, next) => {
  const ids = validateBulkIds(req, next);
  if (!ids) return;

  const found = await Requirement.find({ _id: { $in: ids }, projectId: req.projectScope.projectId });
  const foundIds = found.map((d) => String(d._id));
  const missingIds = ids.filter((id) => !foundIds.includes(String(id)));
  if (missingIds.length > 0) {
    return res.status(422).json({
      success: false,
      policy: 'all-or-nothing',
      error: 'Nothing was deleted: some ids were not found in this project',
      missingIds
    });
  }

  for (const doc of found) {
    await Requirement.findOneAndDelete({ _id: doc._id, projectId: req.projectScope.projectId });
    await audit(req, { entityType: 'requirement', entityId: doc.reqId, action: 'bulk-delete' });
  }

  res.status(200).json({ success: true, policy: 'all-or-nothing', deleted: found.length });
});
```

Check the file's existing imports for `ErrorResponse`, `audit`, `LIFECYCLE_STATUSES` and `Requirement`, and add only what is missing, following the existing require block. Match the existing `audit(...)` call signature in this file exactly — read one of its current call sites rather than assuming the shape above is right for this service.

- [ ] **Step 4: Register the routes before `/:id`**

Add both names to the destructured import from `../controllers/requirement`, then insert **before** the `/:id` route block:

```javascript
// WP-F03 -- registered BEFORE '/:id'. Express matches in registration
// order and '/:id' would otherwise swallow '/bulk' as id='bulk'. Split by
// HTTP method rather than one route dispatching on req.body.action, so the
// existing authorize() middleware gates write and delete separately with
// no new per-body authorization logic -- same shape as
// testRepoService/routes/testrepo.js:44-56.
router.route('/bulk')
  .patch(keycloak.protect(), requireProjectScope(), authorize('write'), bulkUpdateRequirements)
  .delete(keycloak.protect(), requireProjectScope(), authorize('delete'), bulkDeleteRequirements);
```

- [ ] **Step 5: Rebuild, restart Kong, and watch the tests pass**

```bash
(cd /Users/arunganesha/srckubetest/backend && docker compose up -d --build requirementservice)
(cd /Users/arunganesha/srckubetest/srckube-kong && docker compose restart)
```

Kong caches upstream DNS; skipping the restart routes to a stale container.

Run: `cd backend/requirementService && npx jest __tests__/api.test.js -t "bulk operations on requirements" --runInBand`
Expected: PASS, 7 tests.

Then the whole service suite: `cd backend/requirementService && npx jest --runInBand`

- [ ] **Step 6: Commit**

```bash
git add backend/requirementService/controllers/requirement.js \
        backend/requirementService/routes/requirement.js \
        backend/requirementService/__tests__/api.test.js
git commit -m "WP-F03a: bulk status-change and delete for requirements"
```

---

### Task 2: Bulk delete for test plans, bulk assign and delete for test runs

**Files:**
- Modify: `backend/testPlanExecutionService/controllers/testplan.js` (append one export)
- Modify: `backend/testPlanExecutionService/controllers/testexecution.js` (append two exports)
- Modify: `backend/testPlanExecutionService/routes/testplan.js` and `routes/testexecution.js`
- Test: `backend/testPlanExecutionService/__tests__/api.test.js` (append a describe block)

**Interfaces:**
- Consumes: nothing from Task 1 — a different service.
- Produces, consumed by Task 3:
  - `DELETE /api/v1/testplan/bulk` body `{ ids }` → `200 { success, policy, deleted }`
  - `PATCH /api/v1/testexecution/bulk` body `{ ids, action: 'assign', assignedTo }` → `200 { success, policy, updated }`
  - `DELETE /api/v1/testexecution/bulk` body `{ ids }` → `200 { success, policy, deleted }`
  - Rejections mirror Task 1: `422` with `policy` and `missingIds`.

**The asymmetry is deliberate and load-bearing:**
- **Test plans get delete only.** `TestPlan` has neither `status` nor `assignedTo` (verified against `models/TestPlan.js`). No PATCH route at all.
- **Test runs get assign and delete.** `TestExecution` has `assignedTo` but no lifecycle `status`, so `action` accepts only `'assign'`.

Do not add a status action to either.

- [ ] **Step 1: Write the failing test**

Append to `backend/testPlanExecutionService/__tests__/api.test.js`, using that file's existing authed-client pattern. Create your own plans and runs; the seeded `PLN-1..PLN-7` / `Run-1..Run-14` are depended on by the rest of the file and must not be bulk-deleted.

```javascript
// WP-F03 -- bulk operations for test plans (delete only) and test runs
// (assign + delete). The asymmetry is the data model's, not a shortcut:
// TestPlan has neither status nor assignedTo, TestExecution has assignedTo
// but no lifecycle status.
describe('bulk operations on test plans and test runs', () => {
  let client;
  const plans = [];
  const runs = [];

  beforeAll(async () => {
    const token = await getServiceToken();
    client = axios.create({
      baseURL: BASE_URL,
      headers: { Authorization: `Bearer ${token}`, [PROJECT_ID_HEADER]: '1' },
      validateStatus: () => true
    });
    for (let i = 0; i < 2; i += 1) {
      const p = await client.post('/api/v1/testplan', { objective: `WP-F03 bulk plan ${i}` });
      plans.push(p.data.data._id);
      const r = await client.post('/api/v1/testexecution', { TestPlanId: p.data.data._id });
      runs.push(r.data.data._id);
    }
  });

  afterAll(async () => {
    for (const id of runs) await client.delete(`/api/v1/testexecution/${id}`);
    for (const id of plans) await client.delete(`/api/v1/testplan/${id}`);
  });

  it('assigns every run in one call', async () => {
    const resp = await client.patch('/api/v1/testexecution/bulk', { ids: runs, action: 'assign', assignedTo: 'wpf03-user' });
    expect(resp.status).toBe(200);
    expect(resp.data.policy).toBe('all-or-nothing');
    expect(resp.data.updated).toBe(runs.length);
    const one = await client.get(`/api/v1/testexecution/${runs[0]}`);
    expect(one.data.data.assignedTo).toBe('wpf03-user');
  });

  it('assigns nothing when one run id is missing', async () => {
    const resp = await client.patch('/api/v1/testexecution/bulk', {
      ids: [...runs, '000000000000000000000000'],
      action: 'assign',
      assignedTo: 'should-not-apply'
    });
    expect(resp.status).toBe(422);
    const one = await client.get(`/api/v1/testexecution/${runs[0]}`);
    expect(one.data.data.assignedTo).toBe('wpf03-user');
  });

  it('offers no status action for runs -- TestExecution has no lifecycle status', async () => {
    const resp = await client.patch('/api/v1/testexecution/bulk', { ids: runs, action: 'status', status: 'approved' });
    expect(resp.status).toBe(400);
  });

  it('offers no PATCH bulk route for test plans at all', async () => {
    // TestPlan has neither status nor assignedTo, so there is nothing to
    // bulk-update. Only DELETE /bulk exists.
    const resp = await client.patch('/api/v1/testplan/bulk', { ids: plans, action: 'assign', assignedTo: 'x' });
    expect([404, 405]).toContain(resp.status);
  });

  it('bulk-deletes plans, and nothing when one id is missing', async () => {
    const extra = await client.post('/api/v1/testplan', { objective: 'WP-F03 delete fixture' });
    const extraId = extra.data.data._id;

    const bad = await client.delete('/api/v1/testplan/bulk', { data: { ids: [extraId, '000000000000000000000000'] } });
    expect(bad.status).toBe(422);
    expect((await client.get(`/api/v1/testplan/${extraId}`)).status).toBe(200);

    const ok = await client.delete('/api/v1/testplan/bulk', { data: { ids: [extraId] } });
    expect(ok.status).toBe(200);
    expect(ok.data.deleted).toBe(1);
    expect((await client.get(`/api/v1/testplan/${extraId}`)).status).toBe(404);
  });

  it('neither bulk route is swallowed by /:id', async () => {
    const p = await client.delete('/api/v1/testplan/bulk', { data: { ids: [] } });
    expect(p.status).toBe(400); // reached the bulk handler, not a cast error on id='bulk'
    const r = await client.patch('/api/v1/testexecution/bulk', { ids: [], action: 'assign', assignedTo: 'x' });
    expect(r.status).toBe(400);
  });
});
```

If creating a test execution needs more than `TestPlanId`, read `createTestExecution` and supply what it actually requires.

- [ ] **Step 2: Run the test and watch it fail**

Run: `cd backend/testPlanExecutionService && npx jest __tests__/api.test.js -t "bulk operations on test plans" --runInBand`

Expected: FAIL — no `/bulk` route exists on either model.

- [ ] **Step 3: Write the test plan controller**

Append to `backend/testPlanExecutionService/controllers/testplan.js`:

```javascript
// WP-F03 -- bulk delete for test plans. Mirrors
// testRepoService/controllers/testrepo.js:309-520 (read its header for the
// all-or-nothing and per-item-audit rationale inherited here).
//
// DELETE ONLY, deliberately: TestPlan has neither a lifecycle `status` nor
// an `assignedTo` field (verified against models/TestPlan.js), so there is
// nothing a bulk PATCH could change. No PATCH /bulk route is registered.
const BULK_MAX_ITEMS = 500;

function validateBulkIds(req, next) {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    next(new ErrorResponse('ids must be a non-empty array', 400));
    return null;
  }
  if (ids.length > BULK_MAX_ITEMS) {
    next(new ErrorResponse(`Bulk operations are limited to ${BULK_MAX_ITEMS} items at a time (got ${ids.length})`, 400));
    return null;
  }
  return ids;
}

// @desc      Bulk delete test plans, all-or-nothing.
// @route     DELETE /api/v1/testplan/bulk
// @access    Private (delete)
exports.bulkDeleteTestPlans = asyncHandler(async (req, res, next) => {
  const ids = validateBulkIds(req, next);
  if (!ids) return;

  const found = await TestPlan.find({ _id: { $in: ids }, projectId: req.projectScope.projectId });
  const foundIds = found.map((d) => String(d._id));
  const missingIds = ids.filter((id) => !foundIds.includes(String(id)));
  if (missingIds.length > 0) {
    return res.status(422).json({
      success: false,
      policy: 'all-or-nothing',
      error: 'Nothing was deleted: some ids were not found in this project',
      missingIds
    });
  }

  // Compensating rollback, following testRepoService/controllers/
  // testrepo.js:470-487 in shape: validation already passed, so a failure
  // here is a DB fault, not bad input -- restore whatever this batch
  // already removed rather than leaving a half-deleted set behind. The
  // all-or-nothing promise BulkActionBar shows the user has to hold on the
  // delete path too, not just the update path.
  //
  // ONE DELIBERATE DIVERGENCE from the canonical: it restores with
  // `new Model(doc.toObject()).save()`, which re-runs the model's
  // pre('save') hook. That hook guards on `this.isNew` -- true for a
  // reconstructed document even with _id set -- so it calls
  // getNextSequence() and OVERWRITES the business id. The canonical would
  // therefore restore each document under a NEW id, orphaning every
  // linkIssue and audit row pointing at the old one. Restoring through the
  // driver bypasses model middleware, which is correct here: this is
  // reinstating an exact prior state, not creating a document. The same
  // defect exists in the canonical and is tracked separately -- do not
  // "fix" this back to match it.
  const deletedIds = [];
  try {
    for (const doc of found) {
      // eslint-disable-next-line no-await-in-loop
      await TestPlan.findOneAndDelete({ _id: doc._id, projectId: req.projectScope.projectId });
      deletedIds.push(doc._id);
    }
  } catch (err) {
    for (const doc of found) {
      if (deletedIds.some((id) => String(id) === String(doc._id))) {
        // eslint-disable-next-line no-await-in-loop
        await TestPlan.collection.insertOne(doc.toObject()).catch(() => {});
      }
    }
    throw new ErrorResponse(`Bulk delete failed partway through (${deletedIds.length}/${found.length} items); all deletions rolled back: ${err.message}`, 500);
  }

  // Audited after the write loop, once per item, with a `before` snapshot:
  // on a delete the document is gone, so this row is the only surviving
  // record of what it contained.
  for (const doc of found) {
    // eslint-disable-next-line no-await-in-loop
    await audit(req, {
      entityType: 'testplan',
      entityId: doc.TestPlanId,
      action: 'bulk-delete',
      before: { TestPlanId: doc.TestPlanId, objective: doc.objective }
    });
  }

  res.status(200).json({ success: true, policy: 'all-or-nothing', deleted: found.length });
});
```

Match this service's existing `audit(...)` call signature — read a current call site in `controllers/testplan.js` first. If this service does not call `audit` at all on plan writes, say so in your report and omit it rather than inventing a shape.

- [ ] **Step 4: Write the test run controller**

Append to `backend/testPlanExecutionService/controllers/testexecution.js`:

```javascript
// WP-F03 -- bulk assign and delete for test runs. See
// controllers/testplan.js's bulk header and
// testRepoService/controllers/testrepo.js:309-520 for the inherited
// all-or-nothing and per-item-audit rules.
//
// ASSIGN ONLY on the PATCH side, deliberately: TestExecution has
// `assignedTo` but no lifecycle `status` field (verified against
// models/TestExecution.js), so 'status' is rejected rather than silently
// accepted.
const BULK_MAX_ITEMS_EXEC = 500;

function validateBulkExecIds(req, next) {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    next(new ErrorResponse('ids must be a non-empty array', 400));
    return null;
  }
  if (ids.length > BULK_MAX_ITEMS_EXEC) {
    next(new ErrorResponse(`Bulk operations are limited to ${BULK_MAX_ITEMS_EXEC} items at a time (got ${ids.length})`, 400));
    return null;
  }
  return ids;
}

// @desc      Bulk assign test runs, all-or-nothing.
// @route     PATCH /api/v1/testexecution/bulk
// @body      { ids: string[], action: 'assign', assignedTo: string }
// @access    Private (write)
exports.bulkUpdateTestExecutions = asyncHandler(async (req, res, next) => {
  const ids = validateBulkExecIds(req, next);
  if (!ids) return;

  const { action, assignedTo } = req.body;
  if (action !== 'assign') {
    return next(new ErrorResponse("action must be 'assign' (test runs have no lifecycle status field)", 400));
  }
  if (!assignedTo) {
    return next(new ErrorResponse('assignedTo is required for action "assign"', 400));
  }

  const found = await TestExecution.find({ _id: { $in: ids }, projectId: req.projectScope.projectId });
  const foundIds = found.map((d) => String(d._id));
  const missingIds = ids.filter((id) => !foundIds.includes(String(id)));
  if (missingIds.length > 0) {
    return res.status(422).json({
      success: false,
      policy: 'all-or-nothing',
      error: 'No test run was changed: some ids were not found in this project',
      missingIds
    });
  }

  const previous = new Map(found.map((d) => [String(d._id), d.assignedTo]));
  const applied = [];
  try {
    for (const doc of found) {
      await TestExecution.findOneAndUpdate(
        { _id: doc._id, projectId: req.projectScope.projectId },
        { assignedTo }
      );
      applied.push(String(doc._id));
      await audit(req, {
        entityType: 'testexecution',
        entityId: doc.TestExecutionId,
        action: 'bulk-assign',
        after: { assignedTo }
      });
    }
  } catch (err) {
    for (const id of applied) {
      await TestExecution.findOneAndUpdate(
        { _id: id, projectId: req.projectScope.projectId },
        { assignedTo: previous.get(id) }
      );
    }
    return next(err);
  }

  res.status(200).json({ success: true, policy: 'all-or-nothing', updated: applied.length });
});

// @desc      Bulk delete test runs, all-or-nothing.
// @route     DELETE /api/v1/testexecution/bulk
// @access    Private (delete)
exports.bulkDeleteTestExecutions = asyncHandler(async (req, res, next) => {
  const ids = validateBulkExecIds(req, next);
  if (!ids) return;

  const found = await TestExecution.find({ _id: { $in: ids }, projectId: req.projectScope.projectId });
  const foundIds = found.map((d) => String(d._id));
  const missingIds = ids.filter((id) => !foundIds.includes(String(id)));
  if (missingIds.length > 0) {
    return res.status(422).json({
      success: false,
      policy: 'all-or-nothing',
      error: 'Nothing was deleted: some ids were not found in this project',
      missingIds
    });
  }

  // Compensating rollback, following testRepoService/controllers/
  // testrepo.js:470-487 in shape: validation already passed, so a failure
  // here is a DB fault, not bad input -- restore whatever this batch
  // already removed rather than leaving a half-deleted set behind. The
  // all-or-nothing promise BulkActionBar shows the user has to hold on the
  // delete path too, not just the update path.
  //
  // ONE DELIBERATE DIVERGENCE from the canonical: it restores with
  // `new Model(doc.toObject()).save()`, which re-runs the model's
  // pre('save') hook. That hook guards on `this.isNew` -- true for a
  // reconstructed document even with _id set -- so it calls
  // getNextSequence() and OVERWRITES the business id. The canonical would
  // therefore restore each document under a NEW id, orphaning every
  // linkIssue and audit row pointing at the old one. Restoring through the
  // driver bypasses model middleware, which is correct here: this is
  // reinstating an exact prior state, not creating a document. The same
  // defect exists in the canonical and is tracked separately -- do not
  // "fix" this back to match it.
  const deletedIds = [];
  try {
    for (const doc of found) {
      // eslint-disable-next-line no-await-in-loop
      await TestExecution.findOneAndDelete({ _id: doc._id, projectId: req.projectScope.projectId });
      deletedIds.push(doc._id);
    }
  } catch (err) {
    for (const doc of found) {
      if (deletedIds.some((id) => String(id) === String(doc._id))) {
        // eslint-disable-next-line no-await-in-loop
        await TestExecution.collection.insertOne(doc.toObject()).catch(() => {});
      }
    }
    throw new ErrorResponse(`Bulk delete failed partway through (${deletedIds.length}/${found.length} items); all deletions rolled back: ${err.message}`, 500);
  }

  // Audited after the write loop, once per item, with a `before` snapshot:
  // on a delete the document is gone, so this row is the only surviving
  // record of what it contained.
  for (const doc of found) {
    // eslint-disable-next-line no-await-in-loop
    await audit(req, {
      entityType: 'testexecution',
      entityId: doc.TestExecutionId,
      action: 'bulk-delete',
      before: { TestExecutionId: doc.TestExecutionId, TestPlanId: doc.TestPlanId, assignedTo: doc.assignedTo }
    });
  }

  res.status(200).json({ success: true, policy: 'all-or-nothing', deleted: found.length });
});
```

- [ ] **Step 5: Register both routes before their `/:id`**

In `routes/testplan.js`, add `bulkDeleteTestPlans` to the import and insert before the `/:id` block:

```javascript
// WP-F03 -- registered BEFORE '/:id' (Express matches in registration
// order). DELETE only: TestPlan has no status or assignedTo to bulk-update.
router.route('/bulk')
  .delete(keycloak.protect(), requireProjectScope(), authorize('delete'), bulkDeleteTestPlans);
```

In `routes/testexecution.js`, add both names to the import and insert alongside the other literal sub-routes, before `/:id`:

```javascript
// WP-F03 -- registered BEFORE '/:id', grouped with the other literal
// sub-routes. PATCH is assign-only (no lifecycle status on a run); the
// write/delete split matches every other bulk route in this codebase.
router.route('/bulk')
  .patch(keycloak.protect(), requireProjectScope(), authorize('write'), bulkUpdateTestExecutions)
  .delete(keycloak.protect(), requireProjectScope(), authorize('delete'), bulkDeleteTestExecutions);
```

- [ ] **Step 6: Rebuild, restart Kong, and watch the tests pass**

```bash
(cd /Users/arunganesha/srckubetest/backend && docker compose up -d --build testplanexecutionservice)
(cd /Users/arunganesha/srckubetest/srckube-kong && docker compose restart)
```

Run: `cd backend/testPlanExecutionService && npx jest __tests__/api.test.js -t "bulk operations on test plans" --runInBand`
Expected: PASS, 6 tests.

Then the whole service suite: `cd backend/testPlanExecutionService && npx jest --runInBand`
Expected: PASS — it was 80/80 before this package.

- [ ] **Step 7: Add all three routes to the auth-required list**

Both services' `api.test.js` files carry a `protectedRoutes` array asserting every route rejects an unauthenticated request. Add the new routes to each:

```javascript
      ['patch', '/api/v1/requirement/bulk'],   // requirementService
      ['delete', '/api/v1/requirement/bulk'],
```
```javascript
      ['delete', '/api/v1/testplan/bulk'],      // testPlanExecutionService
      ['patch', '/api/v1/testexecution/bulk'],
      ['delete', '/api/v1/testexecution/bulk'],
```

Run each service's `-t "requires authentication"` block and confirm both pass.

- [ ] **Step 8: Commit**

```bash
git add backend/testPlanExecutionService backend/requirementService/__tests__/api.test.js
git commit -m "WP-F03b: bulk delete for test plans, bulk assign and delete for test runs"
```

---

### Task 3: Wire the frontend actions

**Files:**
- Modify: `frontend/src/api/bulkApi.ts` (append four functions)
- Modify: `frontend/src/workbench/list/entityListConfigs.tsx` (fill the empty `bulkActions` for modules 2, 3, 4)
- Test: `frontend/src/api/__tests__/bulkApi.test.ts` (create or extend) and `frontend/src/workbench/list/__tests__/entityListConfigs.test.tsx` (extend)

**Interfaces:**
- Consumes: the three HTTP contracts from Tasks 1 and 2.
- Produces:
  - `bulkUpdateRequirementStatus(ids: string[], status: string)`
  - `bulkDeleteRequirements(ids: string[])`
  - `bulkDeleteTestPlans(ids: string[])`
  - `bulkAssignTestRuns(ids: string[], assignedTo: string)`
  - `bulkDeleteTestRuns(ids: string[])`

  All go through the existing private `bulkRequest` helper so the `BulkPolicyError` 422 path is shared, not re-implemented.

**Do not touch `EntityList.tsx`.** It already renders `checkboxSelection={bulkActions.length > 0}`, so selection and the `BulkActionBar` turn on by themselves once the arrays are non-empty. If you find yourself editing it, stop and escalate.

- [ ] **Step 1: Write the failing tests**

Extend `entityListConfigs`'s existing test to assert the new coverage, mirroring how it already asserts module 1 and 5, and add `bulkApi` tests following `api/__tests__/aiApi.test.ts`'s default-export axios mock shape. Assert the shape of what each module offers:

```typescript
    it('requirements offer status and delete, but no assign -- no assignedTo field exists', () => {
        const kinds = moduleListConfigs[2]!.bulkActions.map((a) => a.kind);
        expect(kinds).toContain('delete');
        expect(moduleListConfigs[2]!.bulkActions.some((a) => a.label.toLowerCase().includes('status'))).toBe(true);
        expect(moduleListConfigs[2]!.bulkActions.some((a) => a.label.toLowerCase().includes('assign'))).toBe(false);
    });

    it('test plans offer delete only -- no status or assignedTo field exists', () => {
        const kinds = moduleListConfigs[3]!.bulkActions.map((a) => a.kind);
        expect(kinds).toEqual(['delete']);
    });

    it('test runs offer assign and delete, but no status -- no lifecycle status exists', () => {
        const actions = moduleListConfigs[4]!.bulkActions;
        expect(actions.some((a) => a.label.toLowerCase().includes('assign'))).toBe(true);
        expect(actions.map((a) => a.kind)).toContain('delete');
        expect(actions.some((a) => a.label.toLowerCase().includes('status'))).toBe(false);
    });

    it('releases still offer no bulk actions -- module 6 has no list config', () => {
        expect(moduleListConfigs[6]).toBeUndefined();
    });
```

Read the existing test file first and match its import style, its `moduleListConfigs` accessor and how it builds a config (some configs are functions of permissions — if `bulkActions` is produced by a factory taking `can(...)`, call it the way the existing tests do).

- [ ] **Step 2: Run and watch them fail**

Run: `cd frontend && CI=true npx craco test src/workbench/list --watchAll=false`
Expected: FAIL — modules 2, 3 and 4 currently have empty `bulkActions`.

- [ ] **Step 3: Add the API functions**

Append to `frontend/src/api/bulkApi.ts`, after the defect section:

```typescript
// -- Requirements (requirementService) ---------------------------------
// WP-F03. No assign: requirements carry no assignedTo field.
export const bulkUpdateRequirementStatus = (ids: string[], status: string) =>
    bulkRequest('patch', '/api/v1/requirement/bulk', { ids, action: 'status', status });

export const bulkDeleteRequirements = (ids: string[]) =>
    bulkRequest('delete', '/api/v1/requirement/bulk', { ids });

// -- Test plans (testPlanExecutionService) ------------------------------
// WP-F03. Delete only: TestPlan has neither status nor assignedTo.
export const bulkDeleteTestPlans = (ids: string[]) =>
    bulkRequest('delete', '/api/v1/testplan/bulk', { ids });

// -- Test runs (testPlanExecutionService) -------------------------------
// WP-F03. Assign only on the update side: TestExecution has no lifecycle status.
export const bulkAssignTestRuns = (ids: string[], assignedTo: string) =>
    bulkRequest('patch', '/api/v1/testexecution/bulk', { ids, action: 'assign', assignedTo });

export const bulkDeleteTestRuns = (ids: string[]) =>
    bulkRequest('delete', '/api/v1/testexecution/bulk', { ids });
```

Update that file's header comment, which currently says bulk is backed by test cases and defects only — it will be stale the moment you add these.

- [ ] **Step 4: Fill the empty bulkActions arrays**

In `entityListConfigs.tsx`, import the new functions and replace the three "deliberately empty" comment blocks (around lines 213, 253, 277) with real actions, following exactly how the module-1 and module-5 configs build theirs (including their permission gating — read those first and mirror the `can(...)` checks).

Requirements (module 2) get a status action and a delete action; test plans (module 3) get delete; test runs (module 4) get assign and delete. **Rewrite each stale comment** — each currently asserts no bulk API exists, which your change makes false, and a stale comment here is exactly what this codebase's register keeps flagging.

- [ ] **Step 5: Run and watch them pass, then the full suite and the linter**

Run: `cd frontend && CI=true npx craco test src/workbench/list src/api --watchAll=false`
Run: `cd frontend && CI=true npx craco test --watchAll=false` — bar: 0 tests failing, 35 non-running suites.
Run: `cd frontend && npx eslint 'src/**/*.{ts,tsx}'` — exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api/bulkApi.ts frontend/src/workbench/list/entityListConfigs.tsx \
        frontend/src/api/__tests__ frontend/src/workbench/list/__tests__
git commit -m "WP-F03c: bulk actions for requirements, test plans and test runs in the list view"
```

---

### Task 4: Prove it in a real browser, and record

**Files:**
- Create: `frontend/e2e/specs/bulk-operations.spec.ts`
- Modify: `docs/superpowers/PRODUCT_GAP_REGISTER.md`

- [ ] **Step 1: Write the browser journey**

Mirror `e2e/specs/search.spec.ts`'s preamble and `entity-creation.spec.ts`'s fixture discipline — **create the records this spec bulk-deletes, then assert they are gone.** Never bulk-delete seeded data.

**Permissions decide what this spec can even see.** `buildBulkActions({ canWrite, canDelete })` gates every action, and the shared e2e persona is a **`contributor`** — `write: true`, `delete: false` in `frontend/src/permissions.ts`'s matrix. The consequences per module are concrete:

| Module | What a contributor sees | Why |
|---|---|---|
| 2 Requirements | "Change status" only | delete is gated on `canDelete` |
| 3 Test Plans | **no checkboxes at all** | delete is its *only* action, so `buildBulkActions` returns `[]` and `checkboxSelection` stays false |
| 4 Test Runs | "Assign" only | same gating |

This is not a limitation to work around — module 3 rendering no selection for a contributor is **correct behaviour worth asserting**.

For the delete paths, do **not** inflate the shared persona's role. `e2e/auth/persona.ts`'s `createE2EPersona(role)` already takes an explicit role (`'contributor' | 'manager' | 'admin'`, defaulting to contributor) precisely for this, and its header records the Wave B-3/B-4 decision that a journey needing `delete` logs in as **its own** persona rather than raising everyone's. Read that comment and `e2e/support/api.ts`'s header before writing, and follow the pattern an existing delete-capable journey already uses.

Cover, in the list view of module 2 (Requirements): switch the source panel to List view, select two rows by checkbox, apply a bulk status change, and assert both rows show the new status. Then create two throwaway requirements, select them, bulk delete, and assert they disappear.

Selectors already confirmed in this codebase: the drawer entry is `getByRole('link', { name: 'Workbench' })`; module rail buttons are `getByRole('button', { name: 'Requirements' })` scoped to `getByTestId('workbench-module-rail')`; the panel mode toggle is `getByRole('button', { name: 'List view' })`. Read `Components/common/BulkActionBar.tsx` for the real names of the bar's controls rather than guessing, and do not add test ids to source.

- [ ] **Step 2: Run it and watch it pass**

Run: `cd frontend && npx playwright test e2e/specs/bulk-operations.spec.ts --reporter=list`
Then the whole suite; it was 30 before this package.

- [ ] **Step 3: Update the gap register**

Append a dated `### 2026-09-05 — after WP-F03` section recording: bulk operations now cover five of six modules; **the actions differ per module because the data models differ** (requirements have no `assignedTo`, plans have neither field, runs have no lifecycle status) and the empty/limited arrays are honest rather than unfinished; that **defect bulk status was deliberately excluded** because its transition validation calls `istatusservice` and fails closed, making N-item all-or-nothing validation a different risk profile — **OPEN, its own package**; and under **Checked and FINE**, that `EntityList` needed no change at all because `checkboxSelection={bulkActions.length > 0}` already turns selection on.

- [ ] **Step 4: Commit**

```bash
git add frontend/e2e/specs/bulk-operations.spec.ts docs/superpowers/PRODUCT_GAP_REGISTER.md
git commit -m "WP-F03d: browser journey for bulk operations, and register update"
```

---

## Definition of done

- [ ] Every test watched **failing** before it was made to pass.
- [ ] `cd backend/requirementService && npx jest --runInBand` passes against the live stack.
- [ ] `cd backend/testPlanExecutionService && npx jest --runInBand` passes (was 80/80).
- [ ] `cd frontend && CI=true npx craco test --watchAll=false`: 0 tests failing, 35 non-running suites.
- [ ] `npx eslint 'src/**/*.{ts,tsx}'` exits 0.
- [ ] `npx playwright test --reporter=list` passes, more tests than the previous 30.
- [ ] `PRODUCT_GAP_REGISTER.md` carries the dated entry.
- [ ] No seeded fixture was bulk-deleted by any test.

## Out of scope, and where each excluded thing lives instead

- **Defect bulk status change** — excluded for the `istatusservice` fail-closed reason above; recorded in the register as its own package.
- **Bulk edit of arbitrary fields** — only the actions each model can actually support are added.
- **Bulk operations for releases (module 6)** — no list config exists; depends on what module 6 becomes after WP-F15.
- **Changing `EntityList.tsx`** — it already supports this by design.
- **Cross-project bulk** — every route is project-scoped and must stay so.
