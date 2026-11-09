import { create, StoreApi, UseBoundStore } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { ModuleId } from '../modules';
import type { LinkType } from '../../api/linkApi';

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

// WP-079 Part A -- §5.2 always described `entityId` as "business key
// (TC-104) or a draft sentinel", but nothing before this WP ever created
// one: every module's detail view assumed a real, already-persisted
// record (TestCaseDetail.tsx/DefectDetail.tsx's header comments say so
// explicitly). A draft sentinel is `new:<random>` -- distinct from every
// business key format in use (TC-104, REQ-8, PLN-3, ...) by construction,
// since none of those ever contain a colon. `tabKey` itself needs no
// change: a draft tab's key is simply `${module}:new:<random>`, already
// well-formed for the existing dedupe/activate logic.
export function makeDraftEntityId(): EntityId {
  return `new:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export function isDraftEntityId(entityId: EntityId): boolean {
  return entityId.startsWith('new:');
}

const emptyByModule = <T,>(v: T): Record<ModuleId, T> =>
  ({ 1: v, 2: v, 3: v, 4: v, 5: v, 6: v });

// WP (A6, raise/link a defect from a failing test run) -- a draft tab
// (see makeDraftEntityId above) has no server record for a caller to attach
// data to directly, so a "raise a defect pre-filled with X, and link it
// back to Y once saved" flow has nowhere to put X/Y except the store
// itself. `prefill` seeds the draft's own local edit buffer (module 5's
// DefectDetail `draftValues`, keyed by fieldName -- e.g. `summary`,
// `description`) the moment it mounts; `link` records the *other* half of a
// bidirectional link (see Components/LinkIssue/linkissue.tsx's
// linkIssuesHandle, which this mirrors) that DefectDetail's create-success
// handler completes once the defect has a real id. Consumed exactly once,
// on that success handler, so a link is never created twice.
export interface DefectDraftLinkIntent {
  sourceModule: ModuleId;
  sourceId: EntityId;
  sourceSummary?: string;
  linkType: LinkType;
}

export interface DefectDraftIntent {
  prefill: Record<string, unknown>;
  link?: DefectDraftLinkIntent;
}

// Wave B-4 (clone) -- a generic version of DefectDraftIntent's own
// `prefill`, but not scoped to defects and carrying no `link`: cloning an
// entity is nothing but "open a draft, seed its buffer from the source
// record" (no bidirectional link to create afterwards, unlike A6's
// raise-a-defect-from-a-failing-run flow, which is why this is a separate
// map rather than a field bolted onto DefectDraftIntent). Every
// draft-capable module (DRAFT_CAPABLE_MODULES in workbench/modules.ts --
// 1, 2, 3, 5) reads its own entry here the same way DefectDetail already
// reads `defectDraftIntents`: once, keyed by the draft's own entityId, via
// a `useEffect` in that module's draft branch. Module 3 (Test Plans) has
// no per-field draft form at all -- its entry instead carries a single
// `TestCaseIds` key naming which test cases to pre-select in the "add test
// cases" grid, read by TestPlanDetail the same way.
export type DraftPrefill = Record<string, unknown>;

export interface WorkbenchState {
  activeModule: ModuleId;
  tabs: Tab[];
  activeTabKey: string | null;
  panelMode: PanelMode;
  panelWidth: number;
  expanded: Record<ModuleId, EntityId[]>;
  selection: Record<ModuleId, EntityId | null>;
  releaseScope: string | null;
  defectDraftIntents: Record<EntityId, DefectDraftIntent>;
  draftPrefill: Record<EntityId, DraftPrefill>;

  setActiveModule: (m: ModuleId) => void;
  openTab: (t: { module: ModuleId; entityId: EntityId; title: string }) => void;
  /**
   * Swaps a draft tab (whose key is built from a `new:...` sentinel
   * entityId) for its now-persisted real entity, IN PLACE -- unlike the
   * legacy TabContent.tsx:472-490 this replaces (filter-then-append,
   * which always moved the new tab to the end), the tab keeps its
   * original position among its siblings. Activates the replacement.
   * A no-op if `oldKey` is not a currently open tab (e.g. the draft was
   * already closed before its save resolved).
   */
  replaceTab: (oldKey: string, t: { module: ModuleId; entityId: EntityId; title: string }) => void;
  closeTab: (key: string) => void;
  activateTab: (key: string) => void;
  reorderTabs: (from: number, to: number) => void;
  setTabDirty: (key: string, dirty: boolean) => void;
  setPanelMode: (mode: PanelMode) => void;
  setPanelWidth: (px: number) => void;
  toggleExpanded: (m: ModuleId, id: EntityId) => void;
  setSelection: (m: ModuleId, id: EntityId | null) => void;
  setReleaseScope: (releaseId: string | null) => void;
  /** Records intent for a not-yet-created draft, keyed by its draft entityId. */
  setDefectDraftIntent: (draftEntityId: EntityId, intent: DefectDraftIntent) => void;
  /** Reads and removes the intent in one step, so it can only ever be acted on once. */
  consumeDefectDraftIntent: (draftEntityId: EntityId) => DefectDraftIntent | undefined;
  /** Wave B-4 (clone) -- records a source-entity prefill for a not-yet-opened draft, keyed by its draft entityId. */
  setDraftPrefill: (draftEntityId: EntityId, prefill: DraftPrefill) => void;
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
        defectDraftIntents: {},
        draftPrefill: {},

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

        replaceTab: (oldKey, { module, entityId, title }) => {
          const tabs = get().tabs;
          const idx = tabs.findIndex((t) => t.key === oldKey);
          if (idx === -1) return;
          const newKey = tabKey(module, entityId);
          const nextTabs = [...tabs];
          nextTabs[idx] = { key: newKey, module, entityId, title, dirty: false };
          set({ tabs: nextTabs, activeTabKey: newKey });
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

        setDefectDraftIntent: (draftEntityId, intent) =>
          set({ defectDraftIntents: { ...get().defectDraftIntents, [draftEntityId]: intent } }),

        consumeDefectDraftIntent: (draftEntityId) => {
          const intent = get().defectDraftIntents[draftEntityId];
          if (intent) {
            const next = { ...get().defectDraftIntents };
            delete next[draftEntityId];
            set({ defectDraftIntents: next });
          }
          return intent;
        },

        setDraftPrefill: (draftEntityId, prefill) =>
          set({ draftPrefill: { ...get().draftPrefill, [draftEntityId]: prefill } }),
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
          // Survives a reload the same way an open draft tab itself does
          // (`tabs` above) -- without this, refreshing the page after
          // clicking "Raise defect" but before clicking Create would silently
          // drop both the pre-filled text and the pending link.
          defectDraftIntents: s.defectDraftIntents,
          // Wave B-4 -- survives a reload the same way an open draft tab
          // and defectDraftIntents already do (see that field's comment
          // just above): without this, refreshing the page after clicking
          // "Clone" but before clicking Create would silently drop the
          // pre-filled copy back to a blank draft.
          draftPrefill: s.draftPrefill,
        }),
      },
    ),
  );
}
