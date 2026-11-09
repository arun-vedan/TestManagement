import React, { createContext, useContext, useMemo } from 'react';
import type { StoreApi, UseBoundStore } from 'zustand';
import { createWorkbenchStore, WorkbenchState } from './store/workbenchStore';

// WP-072 — the workbench store (WP-070) is a FACTORY, not a singleton,
// because each project must get its own persisted store
// (`workbench:{projectId}` in localStorage) and switching project must
// swap the whole store rather than mutate one shared instance. This
// context holds exactly one store instance per <WorkbenchStoreProvider>,
// memoised on `projectId` so it is only recreated when the project
// actually changes -- not on every render, and not on module/entity
// changes within the same project.
type WorkbenchStoreApi = UseBoundStore<StoreApi<WorkbenchState>>;

const WorkbenchStoreContext = createContext<WorkbenchStoreApi | null>(null);

export interface WorkbenchStoreProviderProps {
  projectId: number;
  children: React.ReactNode;
}

export function WorkbenchStoreProvider({ projectId, children }: WorkbenchStoreProviderProps): JSX.Element {
  const store = useMemo(() => createWorkbenchStore(projectId), [projectId]);

  return (
    <WorkbenchStoreContext.Provider value={store}>
      {children}
    </WorkbenchStoreContext.Provider>
  );
}

/**
 * Selector-based read of the current project's workbench store. Only
 * re-renders the calling component when the SELECTED slice changes --
 * the whole reason Zustand was chosen over Context (spec §5.1). Must be
 * called under a <WorkbenchStoreProvider>.
 */
export function useWorkbench<T>(selector: (state: WorkbenchState) => T): T {
  const store = useContext(WorkbenchStoreContext);
  if (!store) {
    throw new Error('useWorkbench() must be called within a <WorkbenchStoreProvider>');
  }
  return store(selector);
}
