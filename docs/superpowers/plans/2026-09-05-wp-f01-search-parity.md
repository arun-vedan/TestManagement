# WP-F01 — Search parity for test plans and test runs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** make the workbench's search panel work for test plans (module 3) and test runs (module 4), which today say search is unavailable because no backend route exists for either.

**Architecture:** add a `wildcardSearch` controller and a `GET /wildcardsearch` route to `testPlanExecutionService` for each of its two models, following the identical pattern already shipped three times in `testRepoService`, `requirementService` and `defectService`; then register the two matching configs in the frontend's existing `moduleSearchConfigs` registry, which is already built to read "this module supports search, that one doesn't" from that map.

**Tech Stack:** Node 18 / Express / Mongoose (backend), React 18 + TypeScript (frontend), Jest for both, axios for the live backend suite, Playwright for browser verification.

**Spec:** `docs/superpowers/plans/2026-09-05-functional-gaps-program.md` — this is work package F01 of that program. **Read its Global Constraints and Escalation triggers before starting.**

## Global Constraints

Copied verbatim from the program plan. These bind every task below.

- **No new runtime dependency** without orchestrator approval.
- **Every new route** mounts `keycloak.protect()` → `requireProjectScope()` → `authorize('<action>')`, in that order. This package's routes are reads, so `authorize('read')`.
- **Literal path segments register BEFORE `/:id`.** Express matches in registration order and `/:id` swallows any single-segment literal. Both existing route files in this service carry a comment saying so; getting this wrong makes `/wildcardsearch` return a 404 "not found" for an id of `"wildcardsearch"`.
- **Never trust `projectId` from a request body.** It comes from `req.projectScope.projectId`.
- **A backend capability is not delivered until a UI surfaces it.** Backend-only is not done.
- **Verify against the running stack**, not against the code you just wrote.
- **Append to `docs/superpowers/PRODUCT_GAP_REGISTER.md`** at the end.

## Two findings this package must record, not fix

Both were verified by reading source. Neither is in scope here; recording them is.

1. **`TestExecution` has no human-readable title field.** The schema's only top-level strings are `TestExecutionId`, `assignedTo`, `source` and `ciRunUrl` (verified by enumerating the schema's top-level keys in `backend/testPlanExecutionService/models/TestExecution.js`, not inferred from a grep). A run therefore cannot be searched by name, because it has none. That is a product gap, tracked as **WP-F09**. Do not add a title field in this package — it changes a shared model and is an escalation trigger.

2. **The three existing wildcard-search routes pass `req.query.search` straight into `$regex` unescaped, and their frontend helpers do not URL-encode the search text.** So a user searching for `.` matches everything, and a search containing `&` or `#` is truncated in transit. The new code in this package does both correctly (Task 1 and Task 4). Bringing the three existing routes into line is **not in scope** — it changes behaviour on three shipped features and deserves its own package. Record it.

> **Correction during execution (recorded after the fact — do not rewrite the task bodies below):**
> This plan's Task 2 and Task 4, as written, have test runs searchable by `assignedTo` in addition to `TestExecutionId`, and render a run's search result as `Assigned to <value>`. During execution, live data showed `assignedTo` holds a raw Keycloak subject UUID (e.g. `f47ac10b-58cc-4372-a567-0e02b2c3d479`), not a name — nobody types a UUID into a search box, and showing one in a result line is not useful either. The ruling made was: **a test run is searched and displayed by its business id (`TestExecutionId`) ONLY.** This is a real, intentional asymmetry against Task 1's test-plan route, which does search two fields (`TestPlanId` and `objective`) — plans have a second free-text field worth searching; runs do not.
>
> This supersedes, specifically:
> - Task 2's interface note (`` `TestExecutionId: string` and `assignedTo?: string` ``) and Step 1's test comment ("searchable by its business id and by who it is assigned to").
> - Task 2 Step 3's controller body: the shipped `wildcardSearch` in `controllers/testexecution.js` does a single regex on `TestExecutionId` only, with no `$or` and no `assignedTo` branch.
> - Task 4's `getWCRunList` type (`assignedTo?: string` is not part of the shipped signature), its test's expected `summary: 'Assigned to asha'`, and the config's `row.assignedTo ? `Assigned to ${row.assignedTo}` : ''` line — the shipped `testRunSearchConfig` always returns `summary: ''`.
>
> The as-shipped code, tests, and comments (`backend/testPlanExecutionService/controllers/testexecution.js`, `__tests__/api.test.js`, `frontend/src/api/apiCalls.tsx`, `frontend/src/workbench/search/entitySearchConfigs.ts`) are the spec of record for the run route; this plan's task bodies below are left as originally written and are superseded by this note where they conflict.

---

### Task 1: Wildcard search for test plans (backend)

**Files:**
- Modify: `backend/testPlanExecutionService/controllers/testplan.js` (append new export at end of file)
- Modify: `backend/testPlanExecutionService/routes/testplan.js:26-28` (insert new route between the `/` block and the `/:id` block)
- Test: `backend/testPlanExecutionService/__tests__/api.test.js` (append new describe block)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `exports.wildcardSearch` in `controllers/testplan.js`. HTTP contract, consumed by Task 4:
  `GET /api/v1/testplan/wildcardsearch?search=<text>` → `200 { success: true, data: TestPlan[] }`, each element a raw Mongoose document carrying at minimum `TestPlanId: string` and `objective?: string`.

- [ ] **Step 1: Write the failing test**

Append to `backend/testPlanExecutionService/__tests__/api.test.js`. Fixtures `PLN-1`..`PLN-7` already exist in project 1 — this suite already depends on them.

```javascript
// WP-F01 -- wildcard search for test plans (module 3). Before this WP no
// wildcardsearch route existed anywhere in this service, which is why
// frontend/src/workbench/search/entitySearchConfigs.ts left modules 3 and
// 4 undefined.
describe('GET /api/v1/testplan/wildcardsearch', () => {
  let client;

  beforeAll(async () => {
    const token = await getServiceToken();
    client = axios.create({
      baseURL: BASE_URL,
      headers: { Authorization: `Bearer ${token}`, [PROJECT_ID_HEADER]: '1' },
      validateStatus: () => true
    });
  });

  it('matches a plan by its business id, case-insensitively', async () => {
    const resp = await client.get('/api/v1/testplan/wildcardsearch', { params: { search: 'pln-3' } });
    expect(resp.status).toBe(200);
    expect(resp.data.success).toBe(true);
    expect(resp.data.data.map((p) => p.TestPlanId)).toContain('PLN-3');
  });

  it('scopes every result to the caller\'s project', async () => {
    const resp = await client.get('/api/v1/testplan/wildcardsearch', { params: { search: 'PLN' } });
    expect(resp.status).toBe(200);
    expect(resp.data.data.length).toBeGreaterThan(0);
    resp.data.data.forEach((p) => expect(p.projectId).toBe(1));
  });

  it('returns an empty array rather than an error when nothing matches', async () => {
    const resp = await client.get('/api/v1/testplan/wildcardsearch', { params: { search: 'zzz-no-such-plan' } });
    expect(resp.status).toBe(200);
    expect(resp.data.data).toEqual([]);
  });

  it('treats regex metacharacters as literal text, not as a pattern', async () => {
    // A user typing "." means the character, not "match anything". The three
    // pre-existing wildcardsearch routes get this wrong; this one does not.
    const resp = await client.get('/api/v1/testplan/wildcardsearch', { params: { search: '.' } });
    expect(resp.status).toBe(200);
    expect(resp.data.data).toEqual([]);
  });

  it('is not swallowed by the /:id route', async () => {
    // Registration order regression guard: if /wildcardsearch is registered
    // after /:id, Express matches getTestPlan with id="wildcardsearch" and
    // this returns 404 or 500, never 200.
    const resp = await client.get('/api/v1/testplan/wildcardsearch', { params: { search: 'PLN' } });
    expect(resp.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend/testPlanExecutionService && npx jest __tests__/api.test.js -t "wildcardsearch" --runInBand`

Expected: FAIL. The route does not exist, so `/api/v1/testplan/wildcardsearch` falls through to `GET /:id` and returns 404 (or 500 on the cast of `"wildcardsearch"` to an ObjectId). The status assertions fail.

- [ ] **Step 3: Write the controller**

Append to the end of `backend/testPlanExecutionService/controllers/testplan.js`:

```javascript
// WP-F01 -- escape user input before it reaches $regex, so a search for
// "." means the character and not "match every document". Kept local to
// this controller deliberately: promoting it to @srckube/service-core is a
// cross-service change, which is an escalation trigger for this package.
const escapeRegex = (text) => String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// WP-F01
// @desc      Search test plans by business id or objective
// @route     GET /api/v1/testplan/wildcardsearch?search=<text>
// @access    Private (read)
//
// Mirrors testRepoService/controllers/testrepo.js:203-218 and
// requirementService/controllers/requirement.js:168-183 -- a
// projectId-scoped $or of a case-insensitive regex over the business key
// and the human-readable field -- with one deliberate difference:
// TestPlan has NO summary/name field. Its only free-text fields are
// objective/scope/entryCriteria/exitCriteria (verified against
// models/TestPlan.js, not assumed), and `objective` is the one
// TestPlanDetail.tsx labels "Objective" and shows first, so it is the
// closest thing a plan has to a title.
exports.wildcardSearch = asyncHandler(async (req, res, next) => {
  const search = escapeRegex(req.query.search);

  const planList = await TestPlan.find({
    projectId: req.projectScope.projectId,
    $or: [
      { TestPlanId: { $regex: search, $options: 'i' } },
      { objective: { $regex: search, $options: 'i' } }
    ]
  });

  res.status(200).json({
    success: true,
    data: planList
  });
});
```

If `asyncHandler` or `TestPlan` is not already required at the top of this file, add them following the existing require block — do not restructure it.

- [ ] **Step 4: Register the route BEFORE `/:id`**

In `backend/testPlanExecutionService/routes/testplan.js`, add `wildcardSearch` to the destructured import from `../controllers/testplan`, then insert this **between** the `router.route('/')` block and the `router.route('/:id')` block:

```javascript
// WP-F01 -- registered BEFORE '/:id'. Express matches in registration
// order, and '/:id' is a single-segment pattern that would otherwise
// swallow '/wildcardsearch' and try to cast it to an ObjectId. Same
// reasoning, and the same comment, as testRepoService/routes/testrepo.js's
// '/bulk' and '/wildcardsearch' registrations.
router
  .route('/wildcardsearch')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), wildcardSearch);
```

- [ ] **Step 5: Rebuild the container and run the test to verify it passes**

```bash
(cd backend && docker compose up -d --build testplanexecutionservice)
(cd srckube-kong && docker compose restart)
```

The Kong restart is required whenever a backend container is recreated — Kong caches upstream DNS and will otherwise route to a stale container IP (TD-21).

Run: `cd backend/testPlanExecutionService && npx jest __tests__/api.test.js -t "wildcardsearch" --runInBand`

Expected: PASS, 5 tests.

- [ ] **Step 6: Add both new routes to the auth-required list**

In the same file's existing `protectedRoutes` array (the "every route requires authentication" describe block near the top), add:

```javascript
      ['get', '/api/v1/testplan/wildcardsearch'],
```

Run: `cd backend/testPlanExecutionService && npx jest __tests__/api.test.js -t "requires authentication" --runInBand`

Expected: PASS — an unauthenticated request returns 401/403, proving `keycloak.protect()` is mounted.

- [ ] **Step 7: Commit**

```bash
git add backend/testPlanExecutionService/controllers/testplan.js \
        backend/testPlanExecutionService/routes/testplan.js \
        backend/testPlanExecutionService/__tests__/api.test.js
git commit -m "WP-F01a: wildcard search for test plans"
```

---

### Task 2: Wildcard search for test runs (backend)

**Files:**
- Modify: `backend/testPlanExecutionService/controllers/testexecution.js` (append new export at end of file)
- Modify: `backend/testPlanExecutionService/routes/testexecution.js:66-68` (insert alongside the `/getexecutiontc` group, which is already ahead of `/:id`)
- Test: `backend/testPlanExecutionService/__tests__/api.test.js` (append new describe block)

**Interfaces:**
- Consumes: nothing from Task 1 — the two controllers are independent files.
- Produces: `exports.wildcardSearch` in `controllers/testexecution.js`. HTTP contract, consumed by Task 4:
  `GET /api/v1/testexecution/wildcardsearch?search=<text>` → `200 { success: true, data: TestExecution[] }`, each element carrying at minimum `TestExecutionId: string` and `assignedTo?: string`.

- [ ] **Step 1: Write the failing test**

Append to `backend/testPlanExecutionService/__tests__/api.test.js`. Fixtures `Run-1`..`Run-14` already exist in project 1.

```javascript
// WP-F01 -- wildcard search for test runs (module 4).
//
// FINDING (recorded, not fixed here): TestExecution has no human-readable
// title field at all -- its only top-level strings are TestExecutionId,
// assignedTo, source and ciRunUrl. So a run is searchable by its business
// id and by who it is assigned to, and by nothing else. Naming a run is
// WP-F09.
describe('GET /api/v1/testexecution/wildcardsearch', () => {
  let client;

  beforeAll(async () => {
    const token = await getServiceToken();
    client = axios.create({
      baseURL: BASE_URL,
      headers: { Authorization: `Bearer ${token}`, [PROJECT_ID_HEADER]: '1' },
      validateStatus: () => true
    });
  });

  it('matches a run by its business id, case-insensitively', async () => {
    const resp = await client.get('/api/v1/testexecution/wildcardsearch', { params: { search: 'run-1' } });
    expect(resp.status).toBe(200);
    expect(resp.data.success).toBe(true);
    expect(resp.data.data.map((r) => r.TestExecutionId)).toContain('Run-1');
  });

  it('scopes every result to the caller\'s project', async () => {
    const resp = await client.get('/api/v1/testexecution/wildcardsearch', { params: { search: 'Run' } });
    expect(resp.status).toBe(200);
    expect(resp.data.data.length).toBeGreaterThan(0);
    resp.data.data.forEach((r) => expect(r.projectId).toBe(1));
  });

  it('returns an empty array rather than an error when nothing matches', async () => {
    const resp = await client.get('/api/v1/testexecution/wildcardsearch', { params: { search: 'zzz-no-such-run' } });
    expect(resp.status).toBe(200);
    expect(resp.data.data).toEqual([]);
  });

  it('treats regex metacharacters as literal text, not as a pattern', async () => {
    const resp = await client.get('/api/v1/testexecution/wildcardsearch', { params: { search: '.' } });
    expect(resp.status).toBe(200);
    expect(resp.data.data).toEqual([]);
  });

  it('is not swallowed by the /:id route', async () => {
    const resp = await client.get('/api/v1/testexecution/wildcardsearch', { params: { search: 'Run' } });
    expect(resp.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend/testPlanExecutionService && npx jest __tests__/api.test.js -t "testexecution/wildcardsearch" --runInBand`

Expected: FAIL — the route does not exist and `/:id` claims the path.

- [ ] **Step 3: Write the controller**

Append to the end of `backend/testPlanExecutionService/controllers/testexecution.js`:

```javascript
// WP-F01 -- see controllers/testplan.js for why this is local rather than
// promoted into @srckube/service-core.
const escapeRegex = (text) => String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// WP-F01
// @desc      Search test runs by business id or assignee
// @route     GET /api/v1/testexecution/wildcardsearch?search=<text>
// @access    Private (read)
//
// FINDING, recorded rather than worked around: TestExecution has NO
// human-readable title field -- verified by enumerating the schema's
// top-level keys in models/TestExecution.js, where the only strings are
// TestExecutionId, assignedTo, source and ciRunUrl. So this route searches
// the two fields that exist. It deliberately does NOT join to the parent
// plan to borrow its objective: that would turn one search into N+1
// queries, and the real fix is to give a run a name of its own (WP-F09).
exports.wildcardSearch = asyncHandler(async (req, res, next) => {
  const search = escapeRegex(req.query.search);

  const runList = await TestExecution.find({
    projectId: req.projectScope.projectId,
    $or: [
      { TestExecutionId: { $regex: search, $options: 'i' } },
      { assignedTo: { $regex: search, $options: 'i' } }
    ]
  });

  res.status(200).json({
    success: true,
    data: runList
  });
});
```

- [ ] **Step 4: Register the route BEFORE `/:id`**

In `backend/testPlanExecutionService/routes/testexecution.js`, add `wildcardSearch` to the destructured import from `../controllers/testexecution`, then insert immediately after the `/updateattachment` line and **before** the `router.route('/:id')` block:

```javascript
// WP-F01 -- grouped with the other literal sub-routes above, all of which
// are registered ahead of the '/:id' catch-all for the reason given in
// testRepoService/routes/testrepo.js: Express matches in registration
// order and '/:id' would swallow this path.
router
  .route('/wildcardsearch')
  .get(keycloak.protect(), requireProjectScope(), authorize('read'), wildcardSearch);
```

- [ ] **Step 5: Rebuild and run the test to verify it passes**

```bash
(cd backend && docker compose up -d --build testplanexecutionservice)
(cd srckube-kong && docker compose restart)
```

Run: `cd backend/testPlanExecutionService && npx jest __tests__/api.test.js -t "testexecution/wildcardsearch" --runInBand`

Expected: PASS, 5 tests.

- [ ] **Step 6: Add the route to the auth-required list**

In the same file's `protectedRoutes` array, add:

```javascript
      ['get', '/api/v1/testexecution/wildcardsearch'],
```

Run: `cd backend/testPlanExecutionService && npx jest __tests__/api.test.js -t "requires authentication" --runInBand`

Expected: PASS.

- [ ] **Step 7: Run the whole service suite against the live stack**

Run: `cd backend/testPlanExecutionService && npx jest --runInBand`

Expected: PASS, with no regression in the pre-existing suites. Record the output — the program's definition of done requires it.

- [ ] **Step 8: Commit**

```bash
git add backend/testPlanExecutionService/controllers/testexecution.js \
        backend/testPlanExecutionService/routes/testexecution.js \
        backend/testPlanExecutionService/__tests__/api.test.js
git commit -m "WP-F01b: wildcard search for test runs"
```

---

### Task 3: Frontend API helpers

**Files:**
- Modify: `frontend/src/api/apiCalls.tsx:204` (append after `getWCDefectList`)
- Test: `frontend/src/api/__tests__/apiCalls.test.ts` (append; create the file only if it does not exist)

**Interfaces:**
- Consumes: the two HTTP contracts produced by Tasks 1 and 2.
- Produces:
  - `getWCPlanList(searchText: string): Promise<Array<{ TestPlanId: string | number; objective?: string }>>`
  - `getWCRunList(searchText: string): Promise<Array<{ TestExecutionId: string | number; assignedTo?: string }>>`

  Both resolve `response.data.data`, i.e. the raw document array — the same shape `getWCTCList` already returns. Task 4 consumes both by exactly these names.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/api/__tests__/apiCalls.test.ts`. `api/axios.ts` has a **default** export, so the mock uses the `__esModule: true` / `default:` shape — copied from the pattern `api/__tests__/aiApi.test.ts:28-34` already uses. A named-import mock will silently not apply.

```typescript
import axiosPrivate from '../axios';
import { getWCPlanList, getWCRunList } from '../apiCalls';

// WP-F01 -- these two helpers URL-encode the search text, which the three
// pre-existing WC helpers (getWCTCList/getWCReqList/getWCDefectList) do
// not: an unencoded "&" or "#" is silently truncated in transit. Bringing
// those three into line is deliberately out of this WP's scope.
jest.mock('../axios', () => ({
    __esModule: true,
    default: { get: jest.fn() },
}));

const mockGet = axiosPrivate.get as jest.Mock;

beforeEach(() => {
  mockGet.mockReset();
});

describe('getWCPlanList', () => {
  it('calls the test plan wildcardsearch route and unwraps data.data', async () => {
    mockGet.mockResolvedValue({ data: { success: true, data: [{ TestPlanId: 'PLN-3', objective: 'Verify login' }] } });
    const rows = await getWCPlanList('login');
    expect(mockGet).toHaveBeenCalledWith('api/v1/testplan/wildcardsearch?search=login');
    expect(rows).toEqual([{ TestPlanId: 'PLN-3', objective: 'Verify login' }]);
  });

  it('URL-encodes the search text', async () => {
    mockGet.mockResolvedValue({ data: { success: true, data: [] } });
    await getWCPlanList('a&b');
    expect(mockGet).toHaveBeenCalledWith('api/v1/testplan/wildcardsearch?search=a%26b');
  });
});

describe('getWCRunList', () => {
  it('calls the test run wildcardsearch route and unwraps data.data', async () => {
    mockGet.mockResolvedValue({ data: { success: true, data: [{ TestExecutionId: 'Run-7', assignedTo: 'asha' }] } });
    const rows = await getWCRunList('Run-7');
    expect(mockGet).toHaveBeenCalledWith('api/v1/testexecution/wildcardsearch?search=Run-7');
    expect(rows).toEqual([{ TestExecutionId: 'Run-7', assignedTo: 'asha' }]);
  });
});
```

Do not change `apiCalls.tsx`'s import to suit the test — `import axiosPrivate from "./axios"` on line 1 is what every other helper in the file already uses.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && CI=true npx craco test src/api/__tests__/apiCalls.test.ts --watchAll=false`

Expected: FAIL with "getWCPlanList is not a function" or a TypeScript resolution error — neither export exists.

- [ ] **Step 3: Write the helpers**

Append to `frontend/src/api/apiCalls.tsx` immediately after `getWCDefectList`:

```typescript
// WP-F01 -- test plans (module 3) and test runs (module 4). Unlike the
// three helpers above these encode the search text: an unencoded "&" or
// "#" in a query string is truncated by the time it reaches Express.
export let getWCPlanList = async (searchText) => {
    let planList = await axiosPrivate.get(`api/v1/testplan/wildcardsearch?search=${encodeURIComponent(searchText)}`)
    return planList.data.data
}

export let getWCRunList = async (searchText) => {
    let runList = await axiosPrivate.get(`api/v1/testexecution/wildcardsearch?search=${encodeURIComponent(searchText)}`)
    return runList.data.data
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && CI=true npx craco test src/api/__tests__/apiCalls.test.ts --watchAll=false`

Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/apiCalls.tsx frontend/src/api/__tests__/apiCalls.test.ts
git commit -m "WP-F01c: frontend helpers for plan and run wildcard search"
```

---

### Task 4: Register both modules in the search registry

**Files:**
- Modify: `frontend/src/workbench/search/entitySearchConfigs.ts` (header comment, two new configs, the registry map)
- Test: `frontend/src/workbench/search/__tests__/entitySearchConfigs.test.ts` (replace the two negative tests with positive ones)

**Interfaces:**
- Consumes: `getWCPlanList` and `getWCRunList` from Task 3.
- Produces: `moduleSearchConfigs[3]` and `moduleSearchConfigs[4]`, both `EntitySearchConfig`. `EntitySearchPanel` already reads this map and needs no change — a defined entry is all it takes for a module's search to become available.

- [ ] **Step 1: Write the failing test**

In `frontend/src/workbench/search/__tests__/entitySearchConfigs.test.ts`, add the two new helpers to the existing `jest.mock` factory and the mock consts:

```typescript
jest.mock('../../../api/apiCalls', () => ({
    getWCTCList: jest.fn(),
    getWCReqList: jest.fn(),
    getWCDefectList: jest.fn(),
    getWCPlanList: jest.fn(),
    getWCRunList: jest.fn(),
}));

const mockGetWCPlanList = getWCPlanList as jest.Mock;
const mockGetWCRunList = getWCRunList as jest.Mock;
```

Update the import at the top of the file to include `getWCPlanList, getWCRunList`. Then **replace** the two tests currently asserting modules 3 and 4 are undefined with:

```typescript
    it('has a config for module 3 (test plans) that maps getWCPlanList rows to {id, title}', async () => {
        mockGetWCPlanList.mockResolvedValue([
            { _id: 'm3', TestPlanId: 'PLN-3', objective: 'Verify login', projectId: 1 },
        ]);
        const config = moduleSearchConfigs[3];
        expect(config).toBeDefined();
        const results = await config!.search('login');
        expect(mockGetWCPlanList).toHaveBeenCalledWith('login');
        expect(results).toEqual([{ id: 'PLN-3', title: 'PLN-3', summary: 'Verify login' }]);
    });

    it('has a config for module 3 that tolerates a plan with no objective', async () => {
        // objective is optional on TestPlan -- a plan created before the
        // WP-025 enrichment fields existed has none.
        mockGetWCPlanList.mockResolvedValue([{ _id: 'm3', TestPlanId: 'PLN-1', projectId: 1 }]);
        const results = await moduleSearchConfigs[3]!.search('PLN');
        expect(results).toEqual([{ id: 'PLN-1', title: 'PLN-1', summary: '' }]);
    });

    it('has a config for module 4 (test runs) that maps getWCRunList rows to {id, title}', async () => {
        mockGetWCRunList.mockResolvedValue([
            { _id: 'm4', TestExecutionId: 'Run-7', assignedTo: 'asha', projectId: 1 },
        ]);
        const config = moduleSearchConfigs[4];
        expect(config).toBeDefined();
        const results = await config!.search('Run-7');
        expect(mockGetWCRunList).toHaveBeenCalledWith('Run-7');
        expect(results).toEqual([{ id: 'Run-7', title: 'Run-7', summary: 'Assigned to asha' }]);
    });

    it('has a config for module 4 that shows no assignee line when a run is unassigned', async () => {
        // A run has no title field of its own (WP-F09), so assignedTo is the
        // only descriptive text available -- and it is optional.
        mockGetWCRunList.mockResolvedValue([{ _id: 'm4', TestExecutionId: 'Run-2', projectId: 1 }]);
        const results = await moduleSearchConfigs[4]!.search('Run-2');
        expect(results).toEqual([{ id: 'Run-2', title: 'Run-2', summary: '' }]);
    });
```

Leave the module 6 negative test exactly as it is — releases still have no search.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd frontend && CI=true npx craco test src/workbench/search --watchAll=false`

Expected: FAIL — `moduleSearchConfigs[3]` and `[4]` are `undefined`, so `expect(config).toBeDefined()` fails and the `config!.search` call throws.

- [ ] **Step 3: Add the two configs**

In `frontend/src/workbench/search/entitySearchConfigs.ts`, extend the import on line 2 to `import { getWCTCList, getWCReqList, getWCDefectList, getWCPlanList, getWCRunList } from '../../api/apiCalls';`, then add after `defectSearchConfig`:

```typescript
const testPlanSearchConfig: EntitySearchConfig = {
    entityLabelPlural: 'test plans',
    search: async (searchText) => {
        const rows = (await getWCPlanList(searchText)) as Array<{ TestPlanId: string | number; objective?: string }>;
        return rows.map((row) => ({
            id: String(row.TestPlanId),
            title: String(row.TestPlanId),
            summary: row.objective ?? '',
        }));
    },
};

// A test run has no title field of its own -- TestExecution's only
// top-level strings are TestExecutionId, assignedTo, source and ciRunUrl
// (WP-F01's recorded finding; naming a run is WP-F09). assignedTo is
// therefore the only descriptive text a run can offer, and it is optional.
const testRunSearchConfig: EntitySearchConfig = {
    entityLabelPlural: 'test runs',
    search: async (searchText) => {
        const rows = (await getWCRunList(searchText)) as Array<{ TestExecutionId: string | number; assignedTo?: string }>;
        return rows.map((row) => ({
            id: String(row.TestExecutionId),
            title: String(row.TestExecutionId),
            summary: row.assignedTo ? `Assigned to ${row.assignedTo}` : '',
        }));
    },
};
```

- [ ] **Step 4: Update the registry and its header comment**

Replace the registry block and the comment above it. The existing comment asserts that modules 3 and 4 have no backend route — that is now false, and a stale comment is worse than no comment.

```typescript
// WP-F01 -- modules 3 (test plans) and 4 (test runs) gained wildcardsearch
// routes in testPlanExecutionService, so both now have a config. Module 6
// (releases) still has none: no wildcardsearch route exists in
// releaseService, and EntitySearchPanel reads that absence as "search is
// not available for this module yet" rather than faking it by filtering a
// fetched page (which would silently search only the loaded page).
//
// Backend coverage, each verified by reading the controller:
//   testRepoService            -> /api/v1/testrepo/wildcardsearch       (1)
//   requirementService         -> /api/v1/requirement/wildcardsearch    (2)
//   testPlanExecutionService   -> /api/v1/testplan/wildcardsearch       (3)
//   testPlanExecutionService   -> /api/v1/testexecution/wildcardsearch  (4)
//   defectService              -> /api/v1/defects/wildcardsearch        (5)
export const moduleSearchConfigs: Record<ModuleId, EntitySearchConfig | undefined> = {
    1: testCaseSearchConfig,
    2: requirementSearchConfig,
    3: testPlanSearchConfig,
    4: testRunSearchConfig,
    5: defectSearchConfig,
    6: undefined,
};
```

Also update the file's top-of-file "HONEST COVERAGE" comment block (lines 4-35), which states that no route exists for modules 3 and 4. Replace that claim with the five-route list above; keep the rest of the block, including the explanation of why a client-side filter is not an acceptable substitute.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd frontend && CI=true npx craco test src/workbench/search --watchAll=false`

Expected: PASS. Seven tests: five positive configs, one tolerance test each for plans and runs, and module 6 still undefined.

- [ ] **Step 6: Run the full frontend suite and the linter**

Run: `cd frontend && CI=true npx craco test --watchAll=false`

Expected: **not a green suite.** 35 of 78 suites fail to run on a pre-existing
`keycloak-js` ESM transform gap (`SyntaxError: Unexpected token 'export'` from
`node_modules/keycloak-js`), reached via `src/keycloak.js` <- `src/api/axios.tsx`.
This predates WP-F01 and is out of its scope. The bar is: **362 tests passing,
0 tests failing, and the failed-suite count still 35** -- i.e. you introduced no
new failure. If a suite you touched is among the failures, that IS your problem.

Run: `cd frontend && npx eslint 'src/**/*.{ts,tsx}'`
Expected: exit 0. This gate was cleared in WP-078d and must stay clear.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/workbench/search/entitySearchConfigs.ts \
        frontend/src/workbench/search/__tests__/entitySearchConfigs.test.ts
git commit -m "WP-F01d: register test plan and test run search in the workbench"
```

---

### Task 5: Verify in a real browser, and record

A jsdom test proves the mapping. It does not prove a user can find a plan. The program's definition of done requires a real browser for anything user-visible, and this repo has been burned by the difference before.

**Files:**
- Create: `frontend/e2e/specs/search.spec.ts`
- Modify: `docs/superpowers/PRODUCT_GAP_REGISTER.md` (append a dated section)

- [ ] **Step 1: Write the browser journey**

Follow the existing harness in `frontend/e2e/specs/module-smoke.spec.ts` for login and project navigation — read it first and reuse its helpers rather than writing new ones.

```typescript
import { test, expect } from '@playwright/test';

// WP-F01 -- search parity for modules 3 and 4. module-smoke.spec.ts's own
// lesson applies here: a spec that only asserts the page has a title
// catches nothing. This asserts the searched-for entity actually appears
// in the results list and opens when clicked.
test('a test plan can be found by searching for its id', async ({ page }) => {
  await page.goto('/projects/1/workbench/testplans');
  await page.getByRole('button', { name: /search/i }).click();
  await page.getByRole('textbox', { name: /search/i }).fill('PLN-3');
  await expect(page.getByText('PLN-3')).toBeVisible();
  await page.getByText('PLN-3').first().click();
  await expect(page.getByRole('tab', { name: 'PLN-3' })).toBeVisible();
});

test('a test run can be found by searching for its id', async ({ page }) => {
  await page.goto('/projects/1/workbench/testruns');
  await page.getByRole('button', { name: /search/i }).click();
  await page.getByRole('textbox', { name: /search/i }).fill('Run-1');
  await expect(page.getByText('Run-1').first()).toBeVisible();
});

test('releases still report that search is unavailable', async ({ page }) => {
  // Module 6 has no backend route. The panel must say so rather than
  // silently returning nothing, which reads as "no results".
  await page.goto('/projects/1/workbench/releases');
  await page.getByRole('button', { name: /search/i }).click();
  await expect(page.getByText(/not available/i)).toBeVisible();
});
```

If the search mode toggle's accessible names differ from the guesses above, correct the selectors to match the real DOM — read `SourcePanel.tsx` and `EntitySearchPanel.tsx` for the real roles and labels. Do not add test ids to source to make the spec easier.

- [ ] **Step 2: Run it and watch it pass against the live stack**

Follow `docs/e2e-playwright-run-procedure.md` for bringing the stack up and authenticating.

Run: `cd frontend && npx playwright test e2e/specs/search.spec.ts`

Expected: PASS, 3 tests. If the third fails because the panel renders empty rather than saying search is unavailable, that is a genuine bug in `EntitySearchPanel` uncovered by this package — **escalate it, do not fix it here**, since it changes a component this package otherwise does not touch.

- [ ] **Step 3: Update the gap register**

Append to `docs/superpowers/PRODUCT_GAP_REGISTER.md`:

```markdown
### 2026-09-05 — after WP-F01 (search parity for plans and runs)

**Resolved**
- Search now covers five of six modules. `testPlanExecutionService` gained a
  `wildcardsearch` route on both of its models, each registered ahead of
  `/:id` and scoped by `requireProjectScope()` + `authorize('read')`.
  Module 6 (releases) still has none and still says so.

**Newly recorded**
- **A test run has no name.** `TestExecution`'s only top-level strings are
  `TestExecutionId`, `assignedTo`, `source` and `ciRunUrl` — verified by
  enumerating the schema, not grepped. So a run can be searched by its id
  and its assignee and by nothing else, and the search result list has no
  human-readable line to show. This is the product gap behind a weak
  feature, not a weakness of the feature. **OPEN — WP-F09.**
- **The three pre-existing wildcardsearch routes pass `req.query.search`
  into `$regex` unescaped**, so a search for `.` matches every document,
  and their frontend helpers do not URL-encode, so `&` and `#` are
  truncated in transit. The two routes added here do both correctly, which
  makes the behaviour inconsistent across modules until the older three are
  brought into line. **OPEN — deliberately not fixed here: it changes
  behaviour on three shipped features.**

**Checked and FINE**
- Kong needs no change: its `testPlanRoute` and `executionRoute` match on
  the path prefixes `/api/v1/testplan` and `/api/v1/testexecution` with
  `strip_path: false`, so both new sub-paths route without a gateway edit.
```

- [ ] **Step 4: Commit**

```bash
git add frontend/e2e/specs/search.spec.ts docs/superpowers/PRODUCT_GAP_REGISTER.md
git commit -m "WP-F01e: browser journey for search, and register update"
```

---

## Definition of done for this package

- [ ] `cd backend/testPlanExecutionService && npx jest --runInBand` passes against the live stack, output recorded.
- [ ] `cd frontend && CI=true npx craco test --watchAll=false`: 0 tests failing and
      the pre-existing failed-suite count (35, keycloak-js ESM transform) unchanged.
- [ ] `cd frontend && npx eslint 'src/**/*.{ts,tsx}'` exits 0.
- [ ] `npx playwright test e2e/specs/search.spec.ts` passes, output recorded.
- [ ] Every test above was watched **failing** before it was made to pass.
- [ ] `PRODUCT_GAP_REGISTER.md` carries the dated entry from Task 5.
- [ ] The report names the two recorded findings and confirms neither was fixed here.

## Out of scope, and where each excluded thing lives instead

- **Naming a test run** — WP-F09 in the program plan.
- **Escaping and encoding the three older search routes** — recorded in the register; needs its own package because it changes shipped behaviour.
- **Search for releases (module 6)** — no route in `releaseService`; depends on what module 6 becomes after WP-F15's release-lens decision.
- **Searching test case steps, descriptions or any full text** — this package delivers parity with the three existing routes, not a better search. Richer search is a separate package and would want a text index, not a regex.
- **Filters, saved searches, or cross-module search** — not attempted; no route or UI affordance for any of them exists to extend.
