# Workbench Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace five copy-pasted module pages with one persistent workbench shell, and move all server state into React Query so the UI can no longer diverge from the cache.

**Architecture:** A `<Workbench>` shell mounted once under `ProjectRouteLayout` hosts a module rail, a mode-switchable source panel (tree/list/search), a cross-module tab strip, and a detail area. Server data lives only in React Query — each expanded folder is its own cached query, so there is no local tree copy to fall out of sync. Client state (tabs, selection, expansion, panel mode) lives in one Zustand store with selector subscriptions. Migration is strangler-fig: the shell is built alongside the existing pages and modules move into it one work package at a time.

**Tech Stack:** React 18, TypeScript 4.9, MUI 5, `@tanstack/react-query` 5.102.8, Zustand (new), `react-dnd` (promoted to a direct dependency), CRA/craco, Jest + React Testing Library + jest-axe, Playwright.

**Spec:** [docs/superpowers/specs/2026-09-02-workbench-foundation-design.md](../specs/2026-09-02-workbench-foundation-design.md)

## Global Constraints

- **GR-1 — Verify before acting.** Every claim in this plan is a hypothesis until confirmed against current code. Re-check the specific files before changing them.
- **GR-2 — Commit discipline.** Small commits, descriptive messages, on branch `Aswin-Dev-Final`. Never `git checkout .`, `git reset --hard`, `git clean`, or any history rewrite.
- **GR-4 — A capability isn't delivered until the UI surfaces it.**
- **GR-10 — Definition of done**: acceptance criteria met; verification executed and output recorded; tests green; work committed; completion report appended to `EXECUTION_LOG.md` with date, WP ID, what was done, evidence, deviations.
- **Frontend-only.** No backend, Kong, or docker changes in any WP here. GR-3/GR-5/GR-6/GR-7 (backend/Kong/migration rules) do not apply to this plan.
- **Gates that must exit 0 at every WP boundary**, run from `frontend/`:
  - `CI=true npm run build`
  - `npx tsc --noEmit`
  - `npx eslint 'src/**/*.{ts,tsx}'`
  - `CI=true npm test -- --watchAll=false`
- **Never leave the suite red between WPs.** A WP that breaks a test updates that test inside the same WP.
- **Branding anchor `#244855` is retained.** No WP may change the primary brand colour.
- **These six hexes must not appear in `src/` after WP-078**: `#196db6`, `#1ABC9C`, `#ef4050`, `#F2545B`, `#1F618D`, and any bare `#fff`/`#ffffff` newly introduced in workbench code.

---

## Verified baseline (checked against code 2026-09-02)

Confirm each before relying on it (GR-1).

| Claim | Evidence |
|---|---|
| 5 module pages share one copy-pasted shell | `Pages/{requirements,testcases,testPlan,testExecution,defects}.tsx`, all `Grid md={2}/md={10}` + `Paper height:'90vh'` |
| Server data copied into `useState` and mutated | `queryClient.ts` header comment; `folderStructure.tsx:38` |
| Two sources of truth for the tree | `folderStructure.tsx:38` (`useState(objects)`) vs `setObjects` at `:175` and in `CustomNode.tsx` |
| Context mutated with no setter | `folderStructure/CustomNode.tsx:141`, `folderList/CustomNode.tsx:134` |
| Buggy tab close | `ScrollableTabs.tsx:31` picks `tabs[tabs.length-2]` regardless of closed tab |
| 17 context files, 7 providers | `ls src/Context` = 17; `grep -c "Provider value" App.tsx` = 7 |
| `@mui/x-tree-view` ^6.17.0 installed, **zero imports** | `grep -rl "@mui/x-tree-view" src` = empty |
| `react-accessible-treeview` ^2.8.3 installed, **zero imports** | `grep -rl "react-accessible-treeview" src` = empty |
| `react-dnd` imported by `App.tsx` but **not a direct dependency** | not in `package.json`; `App.tsx` imports `DndProvider` from it |
| `fieldsService` field routes lack scope/RBAC | `routes/field.js` vs `routes/savedView.js` — **sub-project 3, do not fix here** |

---

## File structure

**Created**

```
src/workbench/
  Workbench.tsx                 shell + layout; mounted once
  ModuleRail.tsx                6 module entries
  SourcePanel.tsx               tree|list|search mode host
  Splitter.tsx                  resizable divider, persisted width
  TabStrip.tsx                  cross-module tabs
  EntityDetail.tsx              dispatch on module
  RegionErrorBoundary.tsx       per-region boundary
  modules.ts                    ModuleId enum, slug<->id map, labels, icons
  store/
    workbenchStore.ts           Zustand store + actions
    persist.ts                  per-project localStorage
  tree/
    EntityTree.tsx              accessible role="tree"
    EntityTreeNode.tsx          row: toggle, icon, label, status
    useTreeKeyboard.ts          roving tabindex + arrow keys
  list/
    EntityList.tsx              DataGrid, absorbs the two GridSections
  detail/
    DetailHeader.tsx  FieldGrid.tsx  DetailTabs.tsx
    LinksSection.tsx  AttachmentsSection.tsx  CommentsSection.tsx
    modules/
      TestCaseDetail.tsx  RequirementDetail.tsx  TestPlanDetail.tsx
      TestRunDetail.tsx   DefectDetail.tsx
src/Hooks/queries/
  useTreeChildren.ts  useEntity.ts  useEntitySearch.ts  useCoverage.ts
src/Hooks/mutations/
  useMoveNode.ts  useCreateFolder.ts  useRenameFolder.ts  useSaveEntity.ts
src/Theme/tokens.ts             neutral ramp + status palette + density
```

**Modified**: `App.tsx` (providers removed, routes), `queryClient.ts` (refetch back on), `Theme/theme.tsx` (tokens), `Layouts/LegacyRedirect.tsx` (workbench targets), `Components/common/StatusChip.tsx` (token-driven), `package.json`.

**Deleted (by WP-078)**: `Components/Tabs/TabContent.tsx`, `ScrollableTabs.tsx`, `Components/folderStructure/`, `Components/folderList/`, `Components/entityGrid/`, and the 13 contexts in spec §5.4.

---

## Work package sequence

| WP | Title | Depends on | Ships |
|---|---|---|---|
| WP-070 | Design tokens + workbench store | — | No UI change |
| WP-071 | Server-state layer: tree queries + mutations | WP-070 | No UI change |
| WP-072 | Workbench shell, routing, error boundaries | WP-070 | Empty shell behind new route |
| WP-073 | Accessible `<EntityTree>` + `<TabStrip>` | WP-071, WP-072 | Shell becomes usable |
| WP-074 | Migrate **Test Cases** (first vertical slice) | WP-073 | Test Cases fully in workbench |
| WP-075 | Migrate **Requirements** | WP-074 | |
| WP-076 | Migrate **Test Plans** + **Test Runs** | WP-074 | E2E spec updated here |
| WP-077 | Migrate **Defects** | WP-074 | |
| WP-078 | Teardown: contexts, `TabContent`, dead deps | WP-075..077 | Acceptance sweep |

WP-075, WP-076, WP-077 are mutually independent once WP-074 establishes the pattern, and may run in parallel by different agents.

---

## Task 1 (WP-070): Design tokens + workbench store

**Files:**
- Create: `src/Theme/tokens.ts`, `src/workbench/modules.ts`, `src/workbench/store/workbenchStore.ts`, `src/workbench/store/persist.ts`
- Modify: `src/Theme/theme.tsx`, `frontend/package.json`
- Test: `src/workbench/store/__tests__/workbenchStore.test.ts`, `src/Theme/__tests__/tokens.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `ModuleId = 1|2|3|4|5|6`, `MODULE_SLUGS: Record<ModuleId,string>`, `slugToModule(s: string): ModuleId | null`, `MODULE_LABELS: Record<ModuleId,string>`
  - `useWorkbenchStore` with state per spec §5.2 and actions `setActiveModule, openTab, closeTab, activateTab, reorderTabs, setTabDirty, setPanelMode, setPanelWidth, toggleExpanded, setSelection, setReleaseScope`
  - `tabKey(module: ModuleId, entityId: string): string`
  - `tokens.status: Record<'pass'|'fail'|'blocked'|'skipped'|'notRun'|'inProgress', string>`, `tokens.neutral: string[]` (9 steps)

- [ ] **Step 1: Add the Zustand dependency and promote `react-dnd`**

`react-dnd` is imported by `App.tsx` but is not a direct dependency — it resolves only by hoisting from `@minoru/react-dnd-treeview`, which WP-078 removes. Promote it now so no later WP breaks the import.

```bash
cd frontend
npm install zustand@5.0.2 react-dnd@16.0.1 react-dnd-html5-backend@16.0.1
```

Confirm exact versions land in `package.json` (no `^latest`; WP-016 forbids floating versions).

- [ ] **Step 2: Write the failing store test**

Create `src/workbench/store/__tests__/workbenchStore.test.ts`:

```ts
import { createWorkbenchStore, tabKey } from '../workbenchStore';

describe('workbench store — tabs', () => {
  it('opens a tab and makes it active', () => {
    const s = createWorkbenchStore(1);
    s.getState().openTab({ module: 1, entityId: 'TC-104', title: 'Login' });
    expect(s.getState().tabs).toHaveLength(1);
    expect(s.getState().activeTabKey).toBe(tabKey(1, 'TC-104'));
  });

  it('dedupes: reopening an entity activates the existing tab', () => {
    const s = createWorkbenchStore(1);
    s.getState().openTab({ module: 1, entityId: 'TC-104', title: 'Login' });
    s.getState().openTab({ module: 2, entityId: 'REQ-8', title: 'Auth' });
    s.getState().openTab({ module: 1, entityId: 'TC-104', title: 'Login' });
    expect(s.getState().tabs).toHaveLength(2);
    expect(s.getState().activeTabKey).toBe(tabKey(1, 'TC-104'));
  });

  it('holds tabs from different modules simultaneously', () => {
    const s = createWorkbenchStore(1);
    s.getState().openTab({ module: 1, entityId: 'TC-104', title: 'Login' });
    s.getState().openTab({ module: 2, entityId: 'REQ-8', title: 'Auth' });
    s.getState().openTab({ module: 3, entityId: 'PLN-3', title: 'Reg' });
    expect(s.getState().tabs.map(t => t.module)).toEqual([1, 2, 3]);
  });

  // Guards ScrollableTabs.tsx:31, which activated tabs[tabs.length-2]
  // regardless of which tab was closed.
  it('closing the active tab activates its right neighbour', () => {
    const s = createWorkbenchStore(1);
    s.getState().openTab({ module: 1, entityId: 'A', title: 'A' });
    s.getState().openTab({ module: 1, entityId: 'B', title: 'B' });
    s.getState().openTab({ module: 1, entityId: 'C', title: 'C' });
    s.getState().activateTab(tabKey(1, 'B'));
    s.getState().closeTab(tabKey(1, 'B'));
    expect(s.getState().activeTabKey).toBe(tabKey(1, 'C'));
  });

  it('closing the last tab falls back to the left neighbour', () => {
    const s = createWorkbenchStore(1);
    s.getState().openTab({ module: 1, entityId: 'A', title: 'A' });
    s.getState().openTab({ module: 1, entityId: 'B', title: 'B' });
    s.getState().closeTab(tabKey(1, 'B'));
    expect(s.getState().activeTabKey).toBe(tabKey(1, 'A'));
  });

  it('closing the only tab clears the active key', () => {
    const s = createWorkbenchStore(1);
    s.getState().openTab({ module: 1, entityId: 'A', title: 'A' });
    s.getState().closeTab(tabKey(1, 'A'));
    expect(s.getState().activeTabKey).toBeNull();
  });

  it('closing a non-active tab leaves the active tab alone', () => {
    const s = createWorkbenchStore(1);
    s.getState().openTab({ module: 1, entityId: 'A', title: 'A' });
    s.getState().openTab({ module: 1, entityId: 'B', title: 'B' });
    s.getState().closeTab(tabKey(1, 'A'));
    expect(s.getState().activeTabKey).toBe(tabKey(1, 'B'));
  });
});

describe('workbench store — expansion', () => {
  it('toggleExpanded adds then removes, per module', () => {
    const s = createWorkbenchStore(1);
    s.getState().toggleExpanded(1, '8');
    expect(s.getState().expanded[1]).toEqual(['8']);
    s.getState().toggleExpanded(1, '8');
    expect(s.getState().expanded[1]).toEqual([]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd frontend && CI=true npm test -- --watchAll=false workbenchStore`
Expected: FAIL — `Cannot find module '../workbenchStore'`.

- [ ] **Step 4: Implement `modules.ts`**

```ts
// src/workbench/modules.ts
export type ModuleId = 1 | 2 | 3 | 4 | 5 | 6;

export const MODULE_SLUGS: Record<ModuleId, string> = {
  1: 'testcases', 2: 'requirements', 3: 'testplans',
  4: 'testruns',  5: 'defects',      6: 'releases',
};

export const MODULE_LABELS: Record<ModuleId, string> = {
  1: 'Test Cases', 2: 'Requirements', 3: 'Test Plans',
  4: 'Test Runs',  5: 'Defects',      6: 'Releases',
};

const SLUG_TO_MODULE = Object.entries(MODULE_SLUGS)
  .reduce<Record<string, ModuleId>>((acc, [id, slug]) => {
    acc[slug] = Number(id) as ModuleId;
    return acc;
  }, {});

export function slugToModule(slug: string): ModuleId | null {
  return SLUG_TO_MODULE[slug] ?? null;
}
```

Module ids match the existing backend convention already used by `folderStructure.tsx` and `linkIssueService` (1 test case, 2 requirement, 3 plan, 4 execution, 5 defect). 6 is new and reserved for Release (sub-project 4).

- [ ] **Step 5: Implement the store**

```ts
// src/workbench/store/workbenchStore.ts
import { create, StoreApi, UseBoundStore } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { ModuleId } from '../modules';

export type EntityId = string;
export type PanelMode = 'tree' | 'list' | 'search';

export interface Tab {
  key: string;
  module: ModuleId;
  entityId: EntityId;
  title: string;
  dirty: boolean;
}

export const tabKey = (module: ModuleId, entityId: EntityId) => `${module}:${entityId}`;

const emptyByModule = <T,>(v: T): Record<ModuleId, T> =>
  ({ 1: v, 2: v, 3: v, 4: v, 5: v, 6: v });

export interface WorkbenchState {
  activeModule: ModuleId;
  tabs: Tab[];
  activeTabKey: string | null;
  panelMode: PanelMode;
  panelWidth: number;
  expanded: Record<ModuleId, EntityId[]>;
  selection: Record<ModuleId, EntityId | null>;
  releaseScope: string | null;

  setActiveModule: (m: ModuleId) => void;
  openTab: (t: { module: ModuleId; entityId: EntityId; title: string }) => void;
  closeTab: (key: string) => void;
  activateTab: (key: string) => void;
  reorderTabs: (from: number, to: number) => void;
  setTabDirty: (key: string, dirty: boolean) => void;
  setPanelMode: (mode: PanelMode) => void;
  setPanelWidth: (px: number) => void;
  toggleExpanded: (m: ModuleId, id: EntityId) => void;
  setSelection: (m: ModuleId, id: EntityId | null) => void;
  setReleaseScope: (releaseId: string | null) => void;
}

export function createWorkbenchStore(projectId: number): UseBoundStore<StoreApi<WorkbenchState>> {
  return create<WorkbenchState>()(
    persist(
      (set, get) => ({
        activeModule: 1,
        tabs: [],
        activeTabKey: null,
        panelMode: 'tree',
        panelWidth: 300,
        expanded: emptyByModule<EntityId[]>([]),
        selection: emptyByModule<EntityId | null>(null),
        releaseScope: null,

        setActiveModule: (m) => set({ activeModule: m }),

        openTab: ({ module, entityId, title }) => {
          const key = tabKey(module, entityId);
          const existing = get().tabs.find((t) => t.key === key);
          if (existing) {
            set({ activeTabKey: key });
            return;
          }
          set({
            tabs: [...get().tabs, { key, module, entityId, title, dirty: false }],
            activeTabKey: key,
          });
        },

        // Nearest surviving neighbour: right, else left, else null.
        // Replaces ScrollableTabs.tsx:31's tabs[tabs.length-2].
        closeTab: (key) => {
          const tabs = get().tabs;
          const idx = tabs.findIndex((t) => t.key === key);
          if (idx === -1) return;
          const remaining = tabs.filter((t) => t.key !== key);
          let activeTabKey = get().activeTabKey;
          if (activeTabKey === key) {
            const neighbour = remaining[idx] ?? remaining[idx - 1] ?? null;
            activeTabKey = neighbour ? neighbour.key : null;
          }
          set({ tabs: remaining, activeTabKey });
        },

        activateTab: (key) => set({ activeTabKey: key }),

        reorderTabs: (from, to) => {
          const tabs = [...get().tabs];
          const [moved] = tabs.splice(from, 1);
          if (!moved) return;
          tabs.splice(to, 0, moved);
          set({ tabs });
        },

        setTabDirty: (key, dirty) =>
          set({ tabs: get().tabs.map((t) => (t.key === key ? { ...t, dirty } : t)) }),

        setPanelMode: (panelMode) => set({ panelMode }),
        setPanelWidth: (panelWidth) => set({ panelWidth }),

        toggleExpanded: (m, id) => {
          const cur = get().expanded[m] ?? [];
          const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
          set({ expanded: { ...get().expanded, [m]: next } });
        },

        setSelection: (m, id) => set({ selection: { ...get().selection, [m]: id } }),
        setReleaseScope: (releaseScope) => set({ releaseScope }),
      }),
      {
        // Per project: today's global 'tabs' key leaks tabs across projects.
        name: `workbench:${projectId}`,
        storage: createJSONStorage(() => localStorage),
        partialize: (s) => ({
          tabs: s.tabs,
          activeTabKey: s.activeTabKey,
          activeModule: s.activeModule,
          panelMode: s.panelMode,
          panelWidth: s.panelWidth,
          expanded: s.expanded,
        }),
      },
    ),
  );
}
```

- [ ] **Step 6: Run the store test to verify it passes**

Run: `cd frontend && CI=true npm test -- --watchAll=false workbenchStore`
Expected: PASS, 9 tests.

- [ ] **Step 7: Write the failing tokens test**

Create `src/Theme/__tests__/tokens.test.ts`:

```ts
import { tokens } from '../tokens';
import theme from '../theme';

describe('design tokens', () => {
  it('exposes all six execution status colours', () => {
    expect(Object.keys(tokens.status).sort()).toEqual(
      ['blocked', 'fail', 'inProgress', 'notRun', 'pass', 'skipped'],
    );
  });

  it('exposes a 9-step neutral ramp', () => {
    expect(tokens.neutral).toHaveLength(9);
    tokens.neutral.forEach((c) => expect(c).toMatch(/^#[0-9a-f]{6}$/i));
  });

  it('retains #244855 as the brand anchor', () => {
    expect(theme.palette.primary.main.toLowerCase()).toBe('#244855');
  });

  it('sets the dense base font size', () => {
    expect(theme.typography.fontSize).toBe(13);
  });
});
```

- [ ] **Step 8: Run it to verify it fails**

Run: `cd frontend && CI=true npm test -- --watchAll=false tokens`
Expected: FAIL — `Cannot find module '../tokens'`.

- [ ] **Step 9: Implement `tokens.ts` and wire it into the theme**

```ts
// src/Theme/tokens.ts
export const tokens = {
  brand: '#244855',
  neutral: [
    '#ffffff', '#f7f8f9', '#eceef0', '#dfe2e6', '#c3c8ce',
    '#9aa3ac', '#6b757f', '#454d55', '#1c2126',
  ],
  status: {
    pass:       '#2e7d32',
    fail:       '#c62828',
    blocked:    '#ed6c02',
    skipped:    '#6b757f',
    notRun:     '#9aa3ac',
    inProgress: '#0288d1',
  },
  density: { rowHeight: 32, spacing: 4, fontSize: 13 },
} as const;

export type StatusToken = keyof typeof tokens.status;
```

In `Theme/theme.tsx`, import `tokens`, set `typography.fontSize: tokens.density.fontSize`, `spacing: tokens.density.spacing`, and add a `status` key to the palette via module augmentation. Do **not** change `palette.primary`.

- [ ] **Step 10: Run all gates**

```bash
cd frontend
CI=true npm test -- --watchAll=false
npx tsc --noEmit
npx eslint 'src/**/*.{ts,tsx}'
CI=true npm run build
```
Expected: all exit 0. No visual change yet — nothing consumes these.

- [ ] **Step 11: Commit**

```bash
git add frontend/package.json frontend/package-lock.json frontend/src/Theme frontend/src/workbench
git commit -m "WP-070: design tokens + workbench store

Adds the token set (neutral ramp, execution status palette, density) and
the Zustand workbench store (tabs, selection, expansion, panel mode),
persisted per project. Promotes react-dnd to a direct dependency: App.tsx
imports it today but it resolved only by hoisting from
@minoru/react-dnd-treeview, which WP-078 removes.

closeTab activates the nearest surviving neighbour, replacing
ScrollableTabs.tsx:31's tabs[tabs.length-2].

No UI consumes any of this yet.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2 (WP-071): Server-state layer — tree queries and mutations

**Files:**
- Create: `src/Hooks/queries/useTreeChildren.ts`, `useEntity.ts`, `useCoverage.ts`; `src/Hooks/mutations/useMoveNode.ts`, `useCreateFolder.ts`, `useRenameFolder.ts`
- Create: `src/Hooks/queryKeys.ts`
- Modify: `src/queryClient.ts`
- Test: `src/Hooks/__tests__/useTreeChildren.test.tsx`, `src/Hooks/__tests__/useMoveNode.test.tsx`

**Interfaces:**
- Consumes: `ModuleId` from `src/workbench/modules.ts`; existing API functions in `src/api/apiCalls.tsx` (`getFolderList`, `getTcList`, `getReqList`, `getTestPlanList`, `updateFolderByParam`, `updateTestCaseByParam`, `updateRequirementByParam`, `createFolderApi`).
- Produces:
  - `qk.children(projectId, module, parentId)`, `qk.entity(projectId, module, entityId)`, `qk.list(...)`, `qk.coverage(projectId)`
  - `useTreeChildren(module: ModuleId, parentId: string | number): UseQueryResult<TreeNode[]>`
  - `TreeNode = { id: string; parent: string; droppable: boolean; text: string; status?: string }`
  - `useMoveNode(module: ModuleId)` returning a mutation taking `{ id, fromParentId, toParentId, droppable }`

- [ ] **Step 1: Write the failing query-key test**

Create `src/Hooks/__tests__/useTreeChildren.test.tsx`:

```tsx
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useTreeChildren } from '../queries/useTreeChildren';
import { qk } from '../queryKeys';
import * as api from '../../api/apiCalls';

jest.mock('../../api/apiCalls');

const wrapper = (client: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

describe('useTreeChildren', () => {
  it('caches each parent under its own key', () => {
    expect(qk.children(1, 1, 0)).toEqual(['project', 1, 1, 'children', 0]);
    expect(qk.children(1, 1, 8)).toEqual(['project', 1, 1, 'children', 8]);
  });

  it('returns folders and leaves merged for one parent', async () => {
    (api.getFolderList as jest.Mock).mockResolvedValue([
      { id: 8, parentFolder: 0, folderName: 'Auth' },
    ]);
    (api.getTcList as jest.Mock).mockResolvedValue([
      { TestCaseId: 'TC-104', parentId: 0 },
    ]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useTreeChildren(1, 0), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([
      { id: '8',      parent: '0', droppable: true,  text: 'Auth'   },
      { id: 'TC-104', parent: '0', droppable: false, text: 'TC-104' },
    ]);
  });

  it('does not fetch a parent until it is requested', async () => {
    (api.getFolderList as jest.Mock).mockResolvedValue([]);
    (api.getTcList as jest.Mock).mockResolvedValue([]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useTreeChildren(1, 0), { wrapper: wrapper(client) });
    await waitFor(() => expect(api.getFolderList).toHaveBeenCalledTimes(1));
    expect(api.getFolderList).not.toHaveBeenCalledWith(8, 1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && CI=true npm test -- --watchAll=false useTreeChildren`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `queryKeys.ts` and `useTreeChildren.ts`**

```ts
// src/Hooks/queryKeys.ts
import { ModuleId } from '../workbench/modules';

export const qk = {
  children: (projectId: number, module: ModuleId, parentId: string | number) =>
    ['project', projectId, module, 'children', parentId] as const,
  entity: (projectId: number, module: ModuleId, entityId: string) =>
    ['project', projectId, module, 'entity', entityId] as const,
  list: (projectId: number, module: ModuleId, viewId: string | null, filters: unknown) =>
    ['project', projectId, module, 'list', viewId, filters] as const,
  coverage: (projectId: number) =>
    ['project', projectId, 'coverage', 'untested'] as const,
};
```

`useTreeChildren` fetches the folders for `parentId` plus that parent's leaf entities, using the per-module leaf fetcher (`getTcList` for 1, `getReqList` for 2, `getTestPlanList` for 3, and the execution/defect equivalents for 4/5 — confirm the exact function names in `api/apiCalls.tsx` per GR-1), and maps both into `TreeNode[]`. Ids are normalised to strings because folder ids are numeric and entity ids are business keys like `TC-104` — the existing code casts around this mismatch (`treeDataAsObjects` in `Pages/testcases.tsx`), and normalising here removes the cast.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && CI=true npm test -- --watchAll=false useTreeChildren`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the failing optimistic-rollback test**

This is acceptance criterion §11.5 — it must be proved by test, not inspection.

```tsx
// src/Hooks/__tests__/useMoveNode.test.tsx
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useMoveNode } from '../mutations/useMoveNode';
import { qk } from '../queryKeys';
import * as api from '../../api/apiCalls';

jest.mock('../../api/apiCalls');

describe('useMoveNode', () => {
  const node = { id: 'TC-104', parent: '0', droppable: false, text: 'TC-104' };

  const setup = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(qk.children(1, 1, '0'), [node]);
    client.setQueryData(qk.children(1, 1, '8'), []);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    return { client, wrapper };
  };

  it('moves the node between cached parents optimistically', async () => {
    (api.updateTestCaseByParam as jest.Mock).mockResolvedValue({ status: 200 });
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useMoveNode(1), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ id: 'TC-104', fromParentId: '0', toParentId: '8', droppable: false });
    });

    expect(client.getQueryData(qk.children(1, 1, '8'))).toEqual([{ ...node, parent: '8' }]);
    expect(client.getQueryData(qk.children(1, 1, '0'))).toEqual([]);
  });

  it('rolls both parents back when the API rejects', async () => {
    (api.updateTestCaseByParam as jest.Mock).mockRejectedValue(new Error('boom'));
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useMoveNode(1), { wrapper });

    await act(async () => {
      await result.current
        .mutateAsync({ id: 'TC-104', fromParentId: '0', toParentId: '8', droppable: false })
        .catch(() => undefined);
    });

    await waitFor(() => {
      expect(client.getQueryData(qk.children(1, 1, '0'))).toEqual([node]);
      expect(client.getQueryData(qk.children(1, 1, '8'))).toEqual([]);
    });
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd frontend && CI=true npm test -- --watchAll=false useMoveNode`
Expected: FAIL — module not found.

- [ ] **Step 7: Implement `useMoveNode`**

```ts
// src/Hooks/mutations/useMoveNode.ts — shape; fill per-module API call per GR-1
onMutate: async ({ id, fromParentId, toParentId }) => {
  await queryClient.cancelQueries({ queryKey: qk.children(projectId, module, fromParentId) });
  await queryClient.cancelQueries({ queryKey: qk.children(projectId, module, toParentId) });
  const prevFrom = queryClient.getQueryData(qk.children(projectId, module, fromParentId));
  const prevTo   = queryClient.getQueryData(qk.children(projectId, module, toParentId));
  // remove from source, append to target with parent rewritten
  return { prevFrom, prevTo, fromParentId, toParentId };
},
onError: (_e, _vars, ctx) => {
  if (!ctx) return;
  queryClient.setQueryData(qk.children(projectId, module, ctx.fromParentId), ctx.prevFrom);
  queryClient.setQueryData(qk.children(projectId, module, ctx.toParentId), ctx.prevTo);
},
onSettled: (_d, _e, vars) => {
  queryClient.invalidateQueries({ queryKey: qk.children(projectId, module, vars.fromParentId) });
  queryClient.invalidateQueries({ queryKey: qk.children(projectId, module, vars.toParentId) });
},
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `cd frontend && CI=true npm test -- --watchAll=false useMoveNode`
Expected: PASS, 2 tests.

- [ ] **Step 9: Re-enable background refetching**

In `src/queryClient.ts` set `refetchOnWindowFocus: true` and `refetchOnReconnect: true`, keep `staleTime: 30_000`, and **replace** the comment block justifying their being disabled with a note that the local mutable tree it described no longer exists (cite this WP).

- [ ] **Step 10: Run all gates, then commit**

```bash
cd frontend && CI=true npm test -- --watchAll=false && npx tsc --noEmit && npx eslint 'src/**/*.{ts,tsx}' && CI=true npm run build
git add frontend/src/Hooks frontend/src/queryClient.ts
git commit -m "WP-071: per-folder tree queries + optimistic move mutation

Each expanded folder is now its own cached query, so the cache is the tree
and there is no local copy to diverge from it. Re-enables
refetchOnWindowFocus/refetchOnReconnect, which queryClient.ts had disabled
solely to stop background refetches clobbering that local copy.

Move is optimistic across both parents with rollback on error, proved by
test rather than inspection.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3 (WP-072): Workbench shell, routing, error boundaries

**Files:**
- Create: `src/workbench/Workbench.tsx`, `ModuleRail.tsx`, `SourcePanel.tsx`, `Splitter.tsx`, `RegionErrorBoundary.tsx`, `WorkbenchStoreProvider.tsx`
- Modify: `src/App.tsx`
- Test: `src/workbench/__tests__/Workbench.test.tsx`, `RegionErrorBoundary.test.tsx`, `Splitter.test.tsx`

**Interfaces:**
- Consumes: `useWorkbenchStore`, `slugToModule`, `MODULE_LABELS` (WP-070).
- Produces: route `/projects/:projectId/workbench/:module/:entityId?`; `<RegionErrorBoundary region="rail"|"panel"|"detail">`.

- [ ] **Step 1: Write the failing shell test**

```tsx
// src/workbench/__tests__/Workbench.test.tsx
it('renders all six modules in the rail', () => { /* assert 6 rail buttons by MODULE_LABELS */ });
it('switching module does not unmount the tab strip', () => { /* assert same DOM node identity across switch */ });
it('an unknown module slug renders a not-found state, not a crash', () => { /* route to /workbench/bogus */ });
it('a crashing detail region leaves rail and panel mounted', () => { /* throw in a stub detail; assert rail present */ });
```

Write these as real assertions, not comments, before implementing.

- [ ] **Step 2: Run to verify failure.** Run: `CI=true npm test -- --watchAll=false Workbench`. Expected: FAIL.

- [ ] **Step 3: Implement `RegionErrorBoundary`** — a class component with `componentDidCatch`, rendering an inline error with a "Try again" button that resets its own state. One boundary per region so a detail crash cannot blank the shell.

- [ ] **Step 4: Implement `Workbench`, `ModuleRail`, `SourcePanel`, `Splitter`.** Flex layout filling available height — **do not** reintroduce `height: '90vh'` or `'80vh'`. `Splitter` writes to `setPanelWidth` on drag end (not per mousemove) and clamps to `[220, 640]`.

- [ ] **Step 5: Add the route in `App.tsx`** as a child of `ProjectRouteLayout`:
`<Route path="workbench/:module/:entityId?" element={<Workbench />} />`. Leave all existing module routes in place — this WP ships the shell alongside them, per the strangler approach.

- [ ] **Step 6: Run the tests to verify they pass.** Expected: PASS.

- [ ] **Step 7: Gates + commit** (`WP-072: workbench shell, routing, per-region error boundaries`).

---

## Task 4 (WP-073): Accessible `<EntityTree>` and `<TabStrip>`

**Files:**
- Create: `src/workbench/tree/EntityTree.tsx`, `EntityTreeNode.tsx`, `useTreeKeyboard.ts`; `src/workbench/TabStrip.tsx`
- Test: `src/workbench/tree/__tests__/EntityTree.test.tsx`, `EntityTree.a11y.test.tsx`, `src/workbench/__tests__/TabStrip.test.tsx`, `TabStrip.a11y.test.tsx`

**Interfaces:**
- Consumes: `useTreeChildren`, `useMoveNode` (WP-071); store actions (WP-070).
- Produces: `<EntityTree module={ModuleId} onOpen={(node) => void} />`, `<TabStrip />`.

**Library decision — required before implementing (GR-1).** `@mui/x-tree-view@^6.17.0` and `react-accessible-treeview@^2.8.3` are **both already installed with zero imports**. `@minoru/react-dnd-treeview` provides drag-and-drop but makes a correct `role="tree"` impossible — `folderStructure/CustomNode.tsx` documents that its rows sit inside `role="list"`/`role="listitem"` wrappers, so `role="treeitem"` triggers `aria-required-parent`, and wrapping the toggle in a `role="button"` row triggers `nested-interactive`.

Evaluate, then **record the decision and evidence in the completion report**. Baseline recommendation: `@mui/x-tree-view` for structure and ARIA, with drag-and-drop supplied by `react-dnd` directly (now a direct dependency as of WP-070). Do not add a new tree dependency without recording why the two installed ones were rejected.

- [ ] **Step 1: Write the failing a11y test**

```tsx
// src/workbench/tree/__tests__/EntityTree.a11y.test.tsx
import { axe } from 'jest-axe';

it('has no axe violations', async () => {
  const { container } = renderTree();
  expect(await axe(container)).toHaveNoViolations();
});

it('exposes a real tree structure', () => {
  renderTree();
  expect(screen.getByRole('tree')).toBeInTheDocument();
  expect(screen.getAllByRole('treeitem').length).toBeGreaterThan(0);
});

it('marks expandable nodes with aria-expanded', () => {
  renderTree();
  expect(screen.getByRole('treeitem', { name: /Auth/ })).toHaveAttribute('aria-expanded', 'false');
});
```

- [ ] **Step 2: Write the failing keyboard test**

```tsx
it('ArrowDown moves focus to the next visible node', async () => { /* … */ });
it('ArrowRight expands a collapsed folder', async () => { /* … */ });
it('ArrowLeft collapses an expanded folder', async () => { /* … */ });
it('Enter opens the focused leaf as a tab', async () => { /* … */ });
it('uses roving tabindex: exactly one node has tabindex=0', () => { /* … */ });
```

These encode WCAG 2.1.1 plus the APG tree pattern — the outcome `CustomNode.tsx` records as unreachable with the old library.

- [ ] **Step 3: Run both to verify they fail.** Expected: FAIL.

- [ ] **Step 4: Implement `EntityTree` + `EntityTreeNode` + `useTreeKeyboard`.** Render from `useTreeChildren` per expanded folder; no local array. Leaf rows show a status token chip where the module has one.

- [ ] **Step 5: Write and run the failing `TabStrip` tests** — renders one tab per store tab, close button removes it, dirty tab shows the marker, `aria-selected` tracks the active tab, tabs from different modules render together with their module icon.

- [ ] **Step 6: Implement `TabStrip`** with MUI `Tabs` styled dense. Do **not** use `@sinm/react-chrome-tabs`.

- [ ] **Step 7: Run all tests to verify they pass.**

- [ ] **Step 8: Gates + commit** (`WP-073: accessible EntityTree + TabStrip`), recording the tree-library decision in the message.

---

## Task 5 (WP-074): Migrate Test Cases — first vertical slice

This WP establishes the pattern WP-075/076/077 copy. It is the only migration WP that may change shared detail components.

**Files:**
- Create: `src/workbench/detail/{DetailHeader,FieldGrid,DetailTabs,LinksSection,AttachmentsSection,CommentsSection}.tsx`, `src/workbench/detail/modules/TestCaseDetail.tsx`, `src/workbench/list/EntityList.tsx`
- Modify: `src/App.tsx`, `src/Layouts/LegacyRedirect.tsx`
- Delete: `src/Pages/testcases.tsx`, `src/Components/entityGrid/TestCaseGridSection.tsx`
- Test: port `src/Pages/__tests__/testcases.a11y.test.tsx` and `Components/entityGrid/__tests__/TestCaseGridSection.test.tsx` to the new components

- [ ] **Step 1: Extract the shared detail kit from `TabContent.tsx`.** `FieldGrid` renders from `fieldsService` records exactly as `TabContent` does today (`field.fieldType`, `isDisplayed`, `isMandatory`) — behaviour-preserving extraction, no field-rendering changes. Sub-project 3 configures these records; sub-project 2 redesigns the layout.

- [ ] **Step 2: Write `TestCaseDetail` tests first** — renders id and summary, renders dynamic fields, renders the steps table, saves a single field without entering a global edit mode, marks its tab dirty on change.

- [ ] **Step 3: Run to verify failure.**

- [ ] **Step 4: Implement `TestCaseDetail`** using the kit. **Per-field inline edit** replaces the global Edit/Save/Cancel toggle.

- [ ] **Step 5: Implement `EntityList`**, absorbing `TestCaseGridSection` (saved views + bulk ops via existing `savedViewApi`/`bulkApi`), parameterised by module so WP-075/076/077 reuse it unchanged.

- [ ] **Step 6: Wire Test Cases into the shell** — rail entry active, `SourcePanel` renders `EntityTree`/`EntityList`/search for module 1, `EntityDetail` dispatches to `TestCaseDetail`.

- [ ] **Step 7: Redirect the legacy route.** `/projects/:id/testrepo` → `/projects/:id/workbench/testcases` in `LegacyRedirect.tsx`; remove the `testrepo` route element. Verify the pre-WP-044 flat `/testrepo` still resolves by chaining.

- [ ] **Step 8: Delete `Pages/testcases.tsx` and `TestCaseGridSection.tsx`**, port their tests, and confirm nothing imports the deleted files: `grep -rn "Pages/testcases\|TestCaseGridSection" src/`.

- [ ] **Step 9: Run every gate, including E2E.**

```bash
cd frontend
CI=true npm test -- --watchAll=false
npx playwright test
npx tsc --noEmit && npx eslint 'src/**/*.{ts,tsx}' && CI=true npm run build
```

`ai-generation.spec.ts` touches the requirements flow, not test cases, so it should stay green here. **If it does not, fix it in this WP** — do not defer.

- [ ] **Step 10: Commit** (`WP-074: migrate Test Cases into the workbench`).

---

## Task 6 (WP-075): Migrate Requirements

Same nine steps as WP-074, substituting module 2. Additional work specific to this module:

- [ ] `RequirementDetail` must retain the attachments section (`selectedModule === 2` branch in `TabContent.tsx:783-789`) and the AI drawers (`AiTestCaseDrawer`, `AiLintPanel`), including their `onAccepted`/`onApplied` callbacks.
- [ ] Replace `CoverageContext` with `useCoverage` (WP-071). The untested badge in the tree and the `refreshUntested` callbacks become a query read and an invalidation respectively.
- [ ] `ai-generation.spec.ts` exercises this flow — run it and fix any selector drift **in this WP**.
- [ ] Delete `Pages/requirements.tsx`; redirect `/projects/:id/requirements`.

---

## Task 7 (WP-076): Migrate Test Plans and Test Runs

Same pattern for modules 3 and 4. Additional work:

- [ ] `TestPlanDetail` from `Components/Tabs/TestPlanContent.tsx` (345 lines) and `PlanDetails.tsx`; `TestRunDetail` from `TestExecutionContent.tsx` (413 lines).
- [ ] `Pages/testPlan.tsx` is the **only** page still fetching in a raw `useEffect` (it never got the WP-015 react-query migration). It must move to `useTreeChildren` like the rest — do not port the `useEffect`.
- [ ] **Update `e2e/specs/test-execution.spec.ts`.** Line 68 asserts `waitForURL(/\/projects\/1\/testexecution/)` — change to the workbench URL. Lines 76 and 84 use `getByRole('button', { name: fixture.testExecutionId })` against the old tree label button; retarget to `getByRole('treeitem', { name: … })`. The spec's own comment at lines 99-105 notes some rows are not addressable by role and asks for that to be revisited once they are real controls — the accessible tree from WP-073 makes that possible, so resolve the note or restate why it stands.
- [ ] Delete `Pages/testPlan.tsx` and `Pages/testExecution.tsx`; redirect both legacy routes.
- [ ] Port `Pages/__tests__/testExecution.a11y.test.tsx` and `Components/Tabs/__tests__/TestExecutionContent.a11y.test.tsx`.

---

## Task 8 (WP-077): Migrate Defects

Same pattern for module 5. Additional work:

- [ ] `DefectDetail` from `Components/Tabs/DefectContent.tsx` (455 lines), retaining the defect status workflow and `statusHistory` display.
- [ ] `EntityList` for defects absorbs `DefectGridSection`; keep `DefectFilterPanel`'s query-param drill-down from the dashboard working (`?assignedTo=`, severity filters).
- [ ] Delete `Pages/defects.tsx` and `Components/entityGrid/DefectGridSection.tsx`; redirect the legacy route.
- [ ] Port `Components/Tabs/__tests__/DefectContent.a11y.test.tsx` and `entityGrid/__tests__/DefectGridSection.test.tsx`.

---

## Task 9 (WP-078): Teardown and acceptance sweep

**Files:** delete 13 contexts, `TabContent.tsx`, `ScrollableTabs.tsx`, `Components/folderStructure/`, `Components/folderList/`, `Components/Tabs/{DefectContent,TestPlanContent,TestExecutionContent,PlanDetails}.tsx`; modify `App.tsx`, `package.json`.

- [ ] **Step 1: Delete the 13 contexts** listed in spec §5.4, and the providers wrapping them in `App.tsx`. Verify: `grep -rn "requirementListContext\|requirementContext\|TabContext\|ReqOpenFoldContext\|SelectedFolderContext\|SelectedModuleContext\|tcListContext\|teTCContext\|testPlanTCContext\|tesptPlanSelectedTC\|teSelectedTC\|teTCDetailsContext\|testSteps" src/` returns nothing.

- [ ] **Step 2: Confirm the direct-mutation bug is gone.** `grep -rn "ReqFoldObject.reqOpenFoldObject =" src/` returns nothing.

- [ ] **Step 3: Delete `TabContent.tsx` and the old shell components.** Verify no imports remain.

- [ ] **Step 4: Remove dead dependencies.**

```bash
cd frontend
npm uninstall @sinm/react-chrome-tabs @minoru/react-dnd-treeview
```

Also remove `@mui/x-tree-view` **or** `react-accessible-treeview` — whichever WP-073 did not select. Confirm `react-dnd` survives as a direct dependency (WP-070) and `App.tsx`'s `DndProvider` import still resolves: `npx tsc --noEmit`.

- [ ] **Step 5: Purge the hardcoded hexes.** `grep -rniE "#196db6|#1ABC9C|#ef4050|#F2545B|#1F618D" src/` returns nothing.

- [ ] **Step 6: Run the full acceptance sweep** — all 12 criteria from spec §11, recording actual command output for each.

```bash
cd frontend
grep -rn "useState.*NodeModel\[\]\|useState<tObject\[\]>" src/            # AC3  -> empty
grep -n "refetchOnWindowFocus\|refetchOnReconnect" src/queryClient.ts     # AC4  -> true, true
grep -rn "ReqFoldObject.reqOpenFoldObject =" src/                          # AC6  -> empty
ls src/Components/Tabs/TabContent.tsx 2>&1                                 # AC8  -> No such file
grep -rn "TestCaseGridSection\|DefectGridSection" src/                     # AC9  -> empty
grep -rniE "#196db6|#1ABC9C|#ef4050|#F2545B|#1F618D" src/                  # AC10 -> empty
CI=true npm test -- --watchAll=false                                       # AC11, AC12
npx playwright test                                                        # AC12
npx tsc --noEmit && npx eslint 'src/**/*.{ts,tsx}' && CI=true npm run build # AC12
```

- [ ] **Step 7: Manual verification (GR-1 — no browser in the agent environment).** Record explicitly in the completion report which criteria were verified by command output and which could not be observed visually. WP-016's report set the precedent: it disclosed that "every page renders" was never observed. Do not claim visual verification that did not happen.

- [ ] **Step 8: Commit and append the completion report** to `EXECUTION_LOG.md` per GR-10.

---

## Self-review

**Spec coverage** — every section maps to a task:

| Spec § | Task |
|---|---|
| §3.1 layout, splitter | WP-072 |
| §3.2 routing + legacy redirects | WP-072 (route), WP-074..077 (redirects) |
| §3.3 component contracts | WP-072, WP-073, WP-074 |
| §3.4 `TabContent` decomposition | WP-074 (kit), WP-075..077 (per module) |
| §4.1 key convention | WP-071 |
| §4.2 per-folder tree query + refetch back on | WP-071 |
| §4.3 mutations + optimistic rollback | WP-071 |
| §4.4 coverage → query | WP-075 |
| §5.1 Zustand choice | WP-070 |
| §5.2 store shape | WP-070 |
| §5.3 per-project persistence | WP-070 |
| §5.4 17→3 contexts | WP-078 (deleted as last consumer migrates) |
| §6 visual tokens, hex purge | WP-070 (tokens), WP-078 (purge) |
| §7 error handling | WP-072 |
| §8.2 E2E breakage | WP-076 |
| §8.3 a11y tree | WP-073 |
| §8.4 new tests | WP-070..073 |
| §9 strangler migration | WP-074..078 ordering |
| §11 acceptance | WP-078 sweep |

**Gaps found and closed during review:**
- `Pages/testPlan.tsx` still fetches in a raw `useEffect` (never migrated by WP-015). Called out explicitly in WP-076 so it is not ported forward.
- `react-dnd` being a phantom dependency was not in the spec. Added to WP-070 Step 1, since WP-078 removing `@minoru/react-dnd-treeview` would otherwise break `App.tsx` silently.
- The spec left the tree library open. WP-073 now names the two already-installed candidates and requires the decision to be recorded.

**Type consistency:** `ModuleId`, `EntityId`, `Tab`, `tabKey`, `TreeNode`, `qk.*` are defined in WP-070/WP-071 and used with identical names and signatures in WP-072..078. `createWorkbenchStore(projectId)` is the factory in every reference.
