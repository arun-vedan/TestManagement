import React from 'react';
import { Typography } from '@mui/material';
import { useLocation } from 'react-router-dom';
import { TestExecutionFilterPanel } from '../Components/dashboardDrilldown/TestExecutionFilterPanel';
import { DefectFilterPanel } from '../Components/dashboardDrilldown/DefectFilterPanel';
import { ModuleId } from './modules';
import { useWorkbench } from './WorkbenchStoreProvider';
import TestCaseDetail from './detail/modules/TestCaseDetail';
import RequirementDetail from './detail/modules/RequirementDetail';
import TestPlanDetail from './detail/modules/TestPlanDetail';
import TestRunDetail from './detail/modules/TestRunDetail';
import DefectDetail from './detail/modules/DefectDetail';
import ReleaseDetail from './detail/modules/ReleaseDetail';

export interface EntityDetailProps {
  moduleId: ModuleId | null;
  moduleSlug: string;
}

// WP-074 Step 6 -- the real detail-region dispatcher, replacing
// Workbench.tsx's placeholder `DefaultDetail` as the shell's DEFAULT
// `DetailComponent`. Module 1 (Test Cases) renders the real
// `TestCaseDetail`, built in Steps 1-4 of this WP; module 2 (Requirements)
// renders `RequirementDetail` (WP-075a Part 2b); modules 3/4 (Test Plans/
// Test Runs) render `TestPlanDetail`/`TestRunDetail` (WP-076 Part A);
// module 5 (Defects) renders `DefectDetail` (WP-077 Part A); module 6
// (Releases) renders `ReleaseDetail` (WP-F15/F18 Task 2) -- the last of the
// six modules to get a real detail component, so the "not migrated yet"
// placeholder this file used to fall back to for it is gone: every value
// `ModuleId` can hold now dispatches to a real component below.
// `moduleId === null` (an unknown URL slug) reproduces `DefaultDetail`'s
// exact alert -- Workbench.test.tsx's "unknown module slug" assertion
// exercises this component now that it is the default, not a hypothetical
// placeholder.
export default function EntityDetail({ moduleId, moduleSlug }: EntityDetailProps): JSX.Element {
  // Targeted selector (not the whole `tabs` array) so this only re-renders
  // when the ENTITY actually shown here changes -- not on every unrelated
  // tab mutation (e.g. another tab's dirty flag flipping).
  const search = new URLSearchParams(useLocation().search);
  const entityId = useWorkbench((state) => {
    const activeTab = state.tabs.find((t) => t.key === state.activeTabKey);
    return activeTab && moduleId !== null && activeTab.module === moduleId ? activeTab.entityId : null;
  });

  if (moduleId === null) {
    return (
      <Typography role="alert">
        Unknown module &quot;{moduleSlug}&quot;.
      </Typography>
    );
  }

  // Dashboard drill-down, checked BEFORE every module's own dispatch --
  // WP-076 originally needed this to run ahead of the (now-removed)
  // not-migrated guard for Defects (not yet migrated at the time); now that
  // every module (including Releases, WP-F15/F18 Task 2) has a real detail
  // component, this ordering is what keeps the drill-down winning over it
  // too whenever no tab is open, per this WP's explicit "don't regress the
  // drill-down" requirement. Pages/dashboard's "View all" links build
  // /projects/:id/testexecution?assignedTo=&status= and
  // /defects?assignedTo=&open=&severity= (dashboardLinks.ts). Those now
  // redirect into the workbench and the query string survives the chain --
  // but until this branch existed nothing consumed it, so the links landed
  // on an unfiltered tree where the deleted pages rendered a filtered list.
  // Reuses the SAME panels those pages used rather than reimplementing the
  // filtering. Only when no entity is open: an open tab wins, since the
  // user has navigated past the drill-down.
  if (entityId === null) {
    if (moduleId === 4 && (search.get('assignedTo') || search.get('status'))) {
      return <TestExecutionFilterPanel searchParams={search} />;
    }
    if (moduleId === 5 && (search.get('assignedTo') || search.get('open') || search.get('severity'))) {
      return <DefectFilterPanel searchParams={search} />;
    }
  }

  if (entityId === null) {
    return (
      <Typography color="text.secondary">
        Select an item from the source panel to see its details.
      </Typography>
    );
  }

  // `key` is load-bearing, not decoration. The detail kit's field controls
  // hold per-field draft buffers in local state (that is how per-field
  // inline edit works). Without a key, React reuses those component
  // instances across an entity switch and the buffers survive -- observed
  // in a real browser as TC-1's header and comments rendered beside
  // TC-695's Description, which a save would have written to the wrong
  // record. Keying by entityId discards the whole subtree per entity.
  if (moduleId === 1) {
    return <TestCaseDetail key={entityId} entityId={entityId} />;
  }
  if (moduleId === 2) {
    return <RequirementDetail key={entityId} entityId={entityId} />;
  }
  if (moduleId === 3) {
    return <TestPlanDetail key={entityId} entityId={entityId} />;
  }
  if (moduleId === 4) {
    return <TestRunDetail key={entityId} entityId={entityId} />;
  }
  if (moduleId === 5) {
    return <DefectDetail key={entityId} entityId={entityId} />;
  }
  return <ReleaseDetail key={entityId} entityId={entityId} />;
}
