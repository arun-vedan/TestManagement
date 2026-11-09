# Workbench Foundation — state management + persistent shell

**Date**: 2026-09-02
**Status**: Approved (owner, 2026-09-02)
**Sub-project**: 1 of 4 (see "Programme context" below)
**Supersedes**: the per-module page shell established pre-WP-044 and left in place by WP-043/WP-044.

---

## 1. Problem

Five module pages — `Pages/requirements.tsx`, `testcases.tsx`, `testPlan.tsx`,
`testExecution.tsx`, `defects.tsx` — are near-identical copies of one shell:
a `Grid` split `md={2} / md={10}`, both halves a `Paper` hardcoded to
`height: 90vh`, a drag-drop folder tree on the left
(`Components/folderStructure/`), and browser-style Chrome tabs on the right
(`Components/Tabs/ScrollableTabs.tsx`) rendering a single 882-line
`TabContent.tsx` that branches on `selectedModule === 1|2|3|4|5`.

Three classes of defect follow from that structure.

### 1.1 Server state is copied into `useState`, then mutated locally

`frontend/src/queryClient.ts` documents this in its own comments: the migrated
pages "build a mutable local tree (folders + items) that downstream components
(folderStructure.tsx) mutate directly via drag/drop and local 'new draft' tab
rows, **bypassing the query cache entirely**."

Because the cache and the rendered tree can diverge, `refetchOnWindowFocus`
and `refetchOnReconnect` are both disabled — again per that file's comments, a
background refetch "would overwrite the local `objects` tree state out from
under an in-progress drag/drop." Refetching is switched off to conceal a
divergence. The consequence is that the UI can show stale data indefinitely
with no mechanism that corrects it.

### 1.2 Two sources of truth for the same tree

`Components/folderStructure/folderStructure.tsx:38` holds
`useState<NodeModel[]>(objects)` — a copy of `MyContext`'s array, initialised
once at mount and never re-synced. `<Tree>` renders that copy. But lazily
loaded children (`CustomNode.tsx` `handleToggle`) and newly created folders
(`folderStructure.tsx:175`) are written to `MyContext` via `setObjects`.
Reads come from one place, writes go to another.

### 1.3 Context state mutated in place, with no setter

`Components/folderStructure/CustomNode.tsx:141` and its duplicate
`Components/folderList/CustomNode.tsx:134`:

```js
ReqFoldObject.reqOpenFoldObject = ReqFoldObject.reqOpenFoldObject.filter(item => item !== nodeId)
```

This reassigns a context value directly. No setter is called, so no re-render
is scheduled and React may discard the write on the next render pass.
Collapsing a folder is unreliable by construction.

### 1.4 Structural duplication in the UI

- **17 context files**, 7 nested providers in `App.tsx`, several holding the
  same shape per module (`tcListContext`, `teTCContext`, `testPlanTCContext`,
  `tesptPlanSelectedTC`, `teSelectedTC`).
- **Two competing list UIs on one page.** WP-043 added `TestCaseGridSection`
  and `DefectGridSection` (DataGrid, saved views, bulk ops) *stacked above*
  the tree rather than replacing it — `Pages/testcases.tsx:130-146`. Saved
  views and bulk operations therefore exist for two modules out of six.
- **Buggy tab close.** `ScrollableTabs.tsx:31` selects the next active tab as
  `tabs[tabs.length-2]` irrespective of which tab was closed, and the `else`
  branch of `active()` mutates `ntabs` entries without calling a setter.

### 1.5 Why the redesign makes this urgent rather than optional

The approved target (§3) is a workbench that never unmounts. Today's stale
local copies are partially rescued by route changes remounting the page. Under
a persistent shell that rescue disappears, so 1.1–1.3 must be fixed as part of
the shell work, not after it.

---

## 2. Programme context

The owner's request covers four sub-projects. Each gets its own spec, design
and implementation plan. This document specifies **sub-project 1 only**.

| # | Sub-project | Status |
|---|---|---|
| 1 | **Foundation: state split + persistent workbench shell** | **this spec** |
| 2 | Detail views: test case, defect, test plan, test run | later spec |
| 3 | Admin → Fields configuration (plain CRUD + scope/RBAC fix) | later spec |
| 4 | Release as module 6 + cross-cutting release lens | later spec |

Decisions taken during brainstorming that constrain all four:

- **Navigation**: persistent workbench — module rail + source panel + global
  cross-module tab strip. Chosen over keeping per-module routes.
- **Tabs are retained deliberately.** The owner requires multiple entities
  open at once to cross-reference test cases, requirements and test plans.
- **State**: server state in React Query only; client state in one workbench
  store. Chosen over a single global store for everything.
- **Release**: becomes a first-class entity (module 6) *and* a scope lens.
- **Fields config**: plain CRUD table matching the existing settings tabs.
- **Visual**: dense professional tool — quiet chrome, colour reserved for
  status, `#244855` retained as brand anchor.

---

## 3. Target architecture

### 3.1 Layout

```
+------+---------------------------------------------------------------+
| AppBar  logo | Project[Acme v] | Release[REL-3 v] | search | bell | @ |
+------+---------------------------------------------------------------+
| rail | REQ-8 x | TC-104 * x | PLN-3 x |                     +         |
|  R   +---------------------+-----------------------------------------+
|  T<  | TEST CASES  [tree|list|search]  TC-104  Login valid creds      |
|  P   | filter...                       Details Steps Links Runs (4)   |
|  E   | > Auth            12            ------------------------------ |
|  D   | v Cart             8            Priority High   Status Active   |
|  L   |     TC-104  PASS                Owner    A.G.   Release REL-3   |
|      |     TC-105  FAIL                Env      UAT                    |
|      | > Payments        23                                            |
+------+---------------------+-----------------------------------------+
        ^ resizable splitter, width persisted
```

The module rail carries six entries: Requirements (moduleId 2), Test Cases (1),
Test Plans (3), Test Runs (4), Defects (5), Releases (6 — introduced by
sub-project 4; the rail slot and store enum are defined here so that work is
additive).

`*` on a tab denotes unsaved changes.

### 3.2 Routing

```
/projects/:projectId/workbench/:module            panel selected, no entity open
/projects/:projectId/workbench/:module/:entityId  that entity is the active tab
```

The **active** tab is represented in the URL, so any open entity is
shareable and refresh-stable. The **set** of open tabs is client state
(§5.2), not URL state — encoding every tab in the URL produces unusable link
lengths and was rejected.

`:module` is the URL-facing slug (`requirements`, `testcases`, `testplans`,
`testruns`, `defects`, `releases`), mapped to the numeric `moduleId` the
backend uses. Slugs are used because numeric module ids in URLs are opaque.

Legacy paths redirect into the workbench, extending the mechanism
`Layouts/LegacyRedirect.tsx` already establishes:

| From | To |
|---|---|
| `/projects/:id/requirements` | `/projects/:id/workbench/requirements` |
| `/projects/:id/testrepo` | `/projects/:id/workbench/testcases` |
| `/projects/:id/testplan` | `/projects/:id/workbench/testplans` |
| `/projects/:id/testexecution` | `/projects/:id/workbench/testruns` |
| `/projects/:id/defects` | `/projects/:id/workbench/defects` |

The pre-WP-044 flat paths (`/testrepo` etc.) already redirect to the
project-scoped paths above and continue to work by chaining through them.
Routes outside the workbench — `/projects`, `/profile`, `dashboard`,
`reports`, `settings`, and `releases` until sub-project 4 — are unchanged.

### 3.3 Component contracts

| Component | Responsibility | Depends on |
|---|---|---|
| `<Workbench>` | Persistent shell and layout. Mounted once under `ProjectRouteLayout`; does not unmount on module switch. | store, router |
| `<ModuleRail>` | Six module entries, active highlight, permission-gated. | store |
| `<SourcePanel>` | Hosts the mode switch: `tree` \| `list` \| `search`. Owns view mode only. | store |
| `<EntityTree>` | Generic tree for any module. | `useTreeChildren` |
| `<EntityList>` | DataGrid for any module. **Absorbs** `TestCaseGridSection` + `DefectGridSection`. | `entityGridApi`, `savedViewApi` |
| `<EntitySearch>` | Flat filtered result list for any module. | `useEntitySearch` |
| `<TabStrip>` | Cross-module tab strip; open/close/reorder/activate; dirty markers. | store |
| `<EntityDetail>` | Dispatches on module to a per-module detail component. | `useEntity` |

Each unit is independently testable: `<EntityTree>` takes a module and renders
from a query hook; `<TabStrip>` takes store state and emits actions; neither
knows about the other.

`<EntityList>` replacing the two stacked grid sections resolves §1.4 and
generalises WP-043's saved views and bulk operations from two modules to all
six.

### 3.4 Detail-view decomposition

`Components/Tabs/TabContent.tsx` (882 lines, five module branches) splits into
per-module components over a shared kit:

```
EntityDetail (dispatch)
├── RequirementDetail   ├── DetailHeader        (id, summary, actions)
├── TestCaseDetail      ├── FieldGrid           (renders from fieldsService)
├── TestPlanDetail      ├── DetailTabs          (Details/Steps/Links/…)
├── TestRunDetail       ├── LinksSection        (linkIssueService)
├── DefectDetail        ├── AttachmentsSection
└── ReleaseDetail (sp4) └── CommentsSection
```

The global Edit/Save/Cancel toggle that currently flips the entire form
becomes **per-field inline edit**. `FieldGrid` continues to render from
`fieldsService` records exactly as `TabContent` does today, which is what makes
sub-project 3 (Fields configuration) drive these views directly.

**Scope note.** This spec defines the decomposition boundaries and requires
that each module's detail render inside the new shell with no functional
regression. Redesigning the *contents* of each detail view is sub-project 2.

---

## 4. Server state — React Query as sole source of truth

No `useState` copy of server data may exist after this work. This is the
acceptance-critical rule.

### 4.1 Query key convention

```
['project', projectId, module, 'children', parentId]
['project', projectId, module, 'entity',   entityId]
['project', projectId, module, 'list',     viewId, filters]
```

`projectId` is the first segment of every key so a project switch invalidates
cleanly, reinforcing the remount behaviour `ProjectRouteLayout` provides.

### 4.2 The tree shape change

Today a single mutable flat array accumulates every lazily loaded child.
Instead, **each expanded folder is its own cached query**:

```
['project', 1, 'testcases', 'children', 0]   root folders + root-level cases
['project', 1, 'testcases', 'children', 8]   folder 8's children
```

`<EntityTree>` renders by walking `expanded` (§5.2) and reading each folder's
own query. The cache *is* the tree. There is no second copy to keep in sync,
which removes the root cause of §1.1 and §1.2 rather than patching them.

Consequently `refetchOnWindowFocus` and `refetchOnReconnect` return to `true`
in `queryClient.ts`, and the comment block justifying their being disabled is
removed. `staleTime` stays at 30s.

### 4.3 Mutations

All writes are React Query mutations that invalidate affected keys. Drag-drop
move — today a direct API call followed by two competing `setState`s:

1. `useMoveNode.mutate({ module, id, fromParentId, toParentId })`
2. `onMutate` — optimistically update the cached children of both the source
   and target parent; snapshot both for rollback.
3. PUT via the existing `updateFolderByParam` / `updateTestCaseByParam` /
   `updateRequirementByParam` calls.
4. `onError` — restore both snapshots.
5. `onSettled` — invalidate both parents.

Divergence is not representable: there is no local array to fall out of sync.

Mutations required by this sub-project: `useMoveNode`, `useCreateFolder`,
`useRenameFolder`, `useSaveEntity`.

### 4.4 Coverage

`Context/CoverageContext.tsx` (untested-requirement ids, driven by
`GET /api/v1/linkIssue/coverage/untested-requirements`) is server state held in
a context. It becomes a query, `['project', id, 'coverage', 'untested']`, and
the context is deleted. Consumers — the badge in `CustomNode`, and the
`refreshUntested` callbacks threaded through the AI drawers — read the query
and invalidate it respectively.

---

## 5. Client state — one workbench store

### 5.1 Choice of Zustand

Under a shell that never unmounts, a single React context holding tabs +
selection + expansion re-renders every subscriber on every change — with the
tree, tab strip, rail and detail all subscribed, a selection change re-renders
the entire workbench. Zustand's selector-based subscriptions confine each
re-render to components reading the changed slice. It is ~1.2kb and adds one
dependency.

**Accepted fallback if the dependency is refused**: a hand-rolled store over
`useSyncExternalStore`, same re-render characteristics, roughly 60 additional
lines to own and test. The store's public API in §5.2 is identical either way,
so this choice is reversible without touching consumers.

### 5.2 Store shape

```ts
type ModuleId = 1 | 2 | 3 | 4 | 5 | 6;
type EntityId = string;

interface Tab {
  key: string;        // `${module}:${entityId}` — stable, dedupes opens
  module: ModuleId;
  entityId: EntityId; // business key (TC-104) or a draft sentinel
  title: string;
  dirty: boolean;
}

interface WorkbenchState {
  activeModule: ModuleId;
  tabs: Tab[];
  activeTabKey: string | null;
  panelMode: 'tree' | 'list' | 'search';
  panelWidth: number;                              // px, splitter
  expanded:  Record<ModuleId, EntityId[]>;
  selection: Record<ModuleId, EntityId | null>;
  releaseScope: string | null;                     // reserved for sub-project 4
}
```

Actions: `setActiveModule`, `openTab`, `closeTab`, `activateTab`,
`reorderTabs`, `setTabDirty`, `setPanelMode`, `setPanelWidth`,
`toggleExpanded`, `setSelection`, `setReleaseScope`.

`closeTab` activates the **nearest surviving neighbour** (right, else left,
else null), fixing `ScrollableTabs.tsx:31`.

`releaseScope` is defined here but unused until sub-project 4, so that work
adds a lens without reshaping the store.

### 5.3 Persistence

Persisted to `localStorage` under `workbench:{projectId}`. Today's single
global `tabs` key leaks tabs across projects — switching project keeps the
previous project's tabs open. Persisted slices: `tabs`, `activeTabKey`,
`activeModule`, `panelMode`, `panelWidth`, `expanded`. Not persisted:
`selection`, `releaseScope`.

On load, tabs are restored optimistically; a tab whose entity 404s on fetch
renders an inline "no longer available" state with a close affordance rather
than being silently dropped.

### 5.4 Context reduction: 17 → 3

**Deleted** (13): `requirementListContext` (`MyContext`), `requirementContext`
(`ReqContext`), `TabContext`, `ReqOpenFoldContext`, `SelectedFolderContext`,
`SelectedModuleContext`, `tcListContext`, `teTCContext`, `testPlanTCContext`,
`tesptPlanSelectedTC`, `teSelectedTC`, `teTCDetailsContext`, `testSteps`.

**Converted to a query** (1): `CoverageContext` (§4.4).

**Retained** (3): `ProjectContext`, `workSpaceContext`, `TemplateContext`.
The latter two serve `NewWorkspace`/`createNewProject`, which are outside the
workbench and outside this sub-project.

Permissions are unaffected: `Hooks/usePermissions` is a React Query hook, not
a context, and is already server state cached by react-query. It is neither
counted nor changed here.

Deleting `ReqOpenFoldContext` removes the object mutated in place at
`CustomNode.tsx:141`, fixing §1.3 by construction rather than by patch.

---

## 6. Visual system

`Theme/theme.tsx` is **extended, not replaced**; `#244855` remains the brand
anchor. Additions:

- **Neutral ramp** — 9 steps for surfaces, borders, and text, replacing
  ad-hoc greys.
- **Semantic status palette** — `pass`, `fail`, `blocked`, `skipped`,
  `notRun`, `inProgress`. `Components/common/StatusChip.tsx` consumes these
  instead of per-call `colorMap` props.
- **Density** — 13px base, 32px row height, 4px spacing unit; flat borders and
  separation in place of nested `Paper` elevation.
- **Colour discipline** — colour carries status and priority only; all other
  chrome is neutral.

Hardcoded hexes replaced by tokens: `#196db6` and `#1ABC9C`
(`folderStructure.tsx` toolbar), `#ef4050` and `#196db6` (`TabContent.tsx`
action buttons), `#F2545B` (`MainDrawer.tsx` selected nav), `#1F618D`
(headings in `TabContent.tsx`, `folderStructure.tsx`).

The `height: 90vh` / `80vh` hardcoded viewport heights in all five pages are
replaced by a flex layout that fills available space, so the workbench does
not overflow on short viewports or waste space on tall ones.

---

## 7. Error handling

- **Per-region error boundaries** around rail, source panel, and detail area.
  A detail-view crash must not blank the workbench.
- **Query errors** render inline within their own region with a retry action.
  Today a failed tree load raises a page-level snackbar and leaves an empty
  tree with no retry path (`testcases.tsx` `useEffect` on `isError`).
- **Mutation errors** roll back the optimistic update and raise a snackbar via
  the existing `CustomizedSnackbars`.
- **Missing entity** — a tab whose entity 404s renders an inline empty state
  (§5.3), never a crash.

---

## 8. Testing

### 8.1 Existing suite — required outcome

The suite must be green at every work-package boundary, never left red between
packages.

- **Unit/component**: `craco test` — 32 test files today.
- **E2E**: `playwright test` — `auth.spec.ts`, `test-execution.spec.ts`,
  `ai-generation.spec.ts`.
- **Gates**: `CI=true npm run build` exits 0, `npx tsc --noEmit` exits 0,
  `npx eslint 'src/**/*.{ts,tsx}'` exits 0 (established by WP-002b).

### 8.2 Known breakage, to be handled inside the owning work package

- **`e2e/specs/test-execution.spec.ts`** asserts
  `waitForURL(/\/projects\/1\/testexecution/)` (line 68) and addresses tree
  nodes with `getByRole('button', { name: 'TC-…' })` (lines 76, 84) — the
  label button in `CustomNode.tsx`. Both the URL and that selector change. The
  spec is updated in the same work package that migrates the Test Runs module,
  so the suite never goes red.
- **Seven `*.a11y.test.tsx` files** target components being replaced
  (`folderStructure`, `folderList/CustomNode`, `folderStructure/CustomNode`,
  `testcases`, `testExecution`, plus `Tabs/*`). They are ported to the
  replacement components, not deleted.

### 8.3 Accessibility carried forward deliberately

`CustomNode.tsx` carries a documented WCAG 2.1.1 fix and an explanation of why
`role="treeitem"` was impossible: `@minoru/react-dnd-treeview` renders rows
inside `role="list"`/`role="listitem"` wrappers, so `role="treeitem"` triggers
an `aria-required-parent` violation, and wrapping the toggle button in a
`role="button"` row triggers `nested-interactive`.

`<EntityTree>` must implement a correct `role="tree"` / `role="group"` /
`role="treeitem"` structure with roving tabindex and arrow-key navigation —
the outcome that comment says the old library prevented. An axe test asserting
zero violations on the new tree is an acceptance criterion, and the WP that
builds `<EntityTree>` must state which tree library (or hand-rolled
implementation) it selected and why.

### 8.4 New tests required

- Store: tab open/close/dedupe/reorder, `closeTab` neighbour selection,
  per-project persistence isolation.
- Query hooks: `useTreeChildren` caching and invalidation; `useMoveNode`
  optimistic update and rollback on error.
- Components: tree expansion, tab strip behaviour, panel mode switching,
  per-region error boundaries.
- A11y: axe clean on `<EntityTree>`, `<TabStrip>`, `<Workbench>`.

---

## 9. Migration strategy — strangler

`<Workbench>` is built alongside the existing pages; no big-bang cutover.

1. Store, query hooks, and theme tokens land first, consumed by nothing.
2. `<Workbench>` shell renders with one module (Test Cases) behind the new
   route. The old page still serves its own route.
3. Each remaining module migrates one at a time. Its legacy route redirects
   into the workbench, its old page file is deleted, and its tests are ported
   — all in the same work package.
4. Contexts are deleted as their last consumer migrates, not in advance.
5. `@sinm/react-chrome-tabs` is removed from `package.json` once `<TabStrip>`
   serves every module.

Every step leaves the app shippable and the suite green.

---

## 10. Out of scope

- Redesigning the *contents* of detail views (sub-project 2).
- The Fields configuration screen and the `fieldsService` scope/RBAC fix
  (sub-project 3).
- Release as module 6 and the release lens (sub-project 4). Only the store
  slot (`releaseScope`) and the rail slot are reserved here.
- Dashboard, Reports, Settings, Projects, Profile screens.
- Backend changes of any kind. This sub-project is frontend-only.
- Global search / command palette. The `search` panel mode is per-module
  filtering, not cross-entity search.

---

## 11. Acceptance criteria

1. All five modules render inside one `<Workbench>` that does not unmount when
   the active module changes.
2. Tabs span modules; a test case, a requirement and a test plan can be open
   simultaneously and switched between without refetching or losing state.
3. `grep` finds no `useState` holding server-fetched entity or tree data in
   the workbench tree.
4. `refetchOnWindowFocus` and `refetchOnReconnect` are `true` in
   `queryClient.ts`.
5. Drag-drop move updates optimistically and rolls back on a forced API error
   (demonstrated by a test, not by inspection).
6. The 13 contexts in §5.4 are deleted; no direct context mutation remains
   (`grep` for `ReqFoldObject.reqOpenFoldObject =` returns nothing).
7. Tabs persist per project; switching project does not carry tabs across.
8. `TabContent.tsx` no longer exists; each module has its own detail component.
9. `TestCaseGridSection` and `DefectGridSection` are gone, replaced by
   `<EntityList>` available in all migrated modules.
10. Theme exposes neutral and status token sets; the six hardcoded hexes in §6
    appear nowhere in `src/`.
11. Axe reports zero violations on `<EntityTree>`, `<TabStrip>`, `<Workbench>`;
    the tree is keyboard-navigable with arrow keys.
12. Gates green: `craco test`, `playwright test`, `CI=true npm run build`,
    `npx tsc --noEmit`, `npx eslint 'src/**/*.{ts,tsx}'`.

---

## 12. Risks

| Risk | Mitigation |
|---|---|
| E2E selectors and URLs break mid-migration | Specs updated inside the same WP that migrates each module (§8.2) |
| Tree library cannot express `role="tree"` correctly | WP must evaluate and record the choice before building (§8.3) |
| 180px source panel too narrow at 1440px | Resizable splitter with persisted width (§3.1, §5.2) |
| Zustand dependency refused | `useSyncExternalStore` fallback, identical public API (§5.1) |
| `TabContent` decomposition regresses module behaviour | Migrate one module per WP with its tests ported before deletion |
| Restored tabs reference deleted entities | Inline "no longer available" state (§5.3) |
