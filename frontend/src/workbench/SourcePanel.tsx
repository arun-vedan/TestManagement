import React from 'react';
import { Box } from '@mui/material';
import { useWorkbench } from './WorkbenchStoreProvider';
import Splitter from './Splitter';
import EntityTree from './tree/EntityTree';
import EntityList from './list/EntityList';
import EntitySearchPanel from './search/EntitySearchPanel';
import SourcePanelHeader from './SourcePanelHeader';
import { ModuleId } from './modules';

export interface SourcePanelProps {
  /** The module the current URL resolves to, or null for an unknown slug
   *  -- same value Workbench.tsx passes to ModuleRail/DetailComponent,
   *  computed synchronously from the URL rather than read from the store
   *  (whose `activeModule` only catches up one render later, via
   *  WorkbenchShell's effect). */
  moduleId: ModuleId | null;
}

// WP-072 (mode/width plumbing) + WP-073 (the real tree) + WP-074 Step 6
// (the real list) + Wave B-2 (the real search, PRODUCT_GAP_REGISTER.md A2).
// Hosts the tree|list|search mode switch (store's `panelMode`) and the
// resizable width (store's `panelWidth`). `list` renders `<EntityList>`
// for every module; `search` renders `<EntitySearchPanel>` for every
// module. Both already render their own explicit "not available" state
// for modules without a configured registry entry (entityListConfigs.tsx /
// entitySearchConfigs.ts respectively), so there is nothing module-specific
// to gate here.
export default function SourcePanel({ moduleId }: SourcePanelProps): JSX.Element {
  const panelMode = useWorkbench((state) => state.panelMode);
  const panelWidth = useWorkbench((state) => state.panelWidth);
  const setPanelWidth = useWorkbench((state) => state.setPanelWidth);

  return (
    <Box sx={{ display: 'flex', height: '100%', minHeight: 0, flexShrink: 0 }}>
      <Box
        data-testid="workbench-source-panel"
        sx={{
          width: panelWidth,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          borderRight: 1,
          borderColor: 'divider',
        }}
      >
        {/* Title, the "New" menu, the view toggle and the "More actions"
            menu -- every create/import/export/audit action the panel
            offers. See SourcePanelHeader.tsx. */}
        <SourcePanelHeader moduleId={moduleId} />
        <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          {panelMode === 'tree' && moduleId !== null && <EntityTree module={moduleId} />}
          {panelMode === 'list' && moduleId !== null && <EntityList module={moduleId} />}
          {panelMode === 'search' && moduleId !== null && <EntitySearchPanel module={moduleId} />}
          {moduleId === null && (
            // Unknown module slug: Workbench.tsx's EntityDetail already
            // surfaces the "Unknown module" alert in the detail region, so
            // the source panel just stays empty rather than repeating it.
            <Box sx={{ p: 2 }} />
          )}
        </Box>
      </Box>
      <Splitter width={panelWidth} onCommit={setPanelWidth} />
    </Box>
  );
}
