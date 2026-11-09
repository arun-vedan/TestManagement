import React, { useEffect } from 'react';
import { Box, ThemeProvider } from '@mui/material';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import theme from '../Theme/theme';
import { MODULE_SLUGS, ModuleId, slugToModule } from './modules';
import { WorkbenchStoreProvider, useWorkbench } from './WorkbenchStoreProvider';
import RegionErrorBoundary from './RegionErrorBoundary';
import ModuleRail from './ModuleRail';
import SourcePanel from './SourcePanel';
import TabStrip from './TabStrip';
import EntityDetail from './EntityDetail';

export interface DetailComponentProps {
  moduleId: ModuleId | null;
  moduleSlug: string;
}

interface WorkbenchShellProps {
  projectId: number;
  moduleSlug: string;
  DetailComponent: React.ComponentType<DetailComponentProps>;
}

function WorkbenchShell({ projectId, moduleSlug, DetailComponent }: WorkbenchShellProps): JSX.Element {
  const moduleId = slugToModule(moduleSlug);
  // WP-F21c -- the URL's own :entityId, used only by the onActivate guard
  // below to tell a real navigation from a mount-time restatement.
  const { entityId: urlEntityId } = useParams();
  const setActiveModule = useWorkbench((state) => state.setActiveModule);
  const hasTabs = useWorkbench((state) => state.tabs.length > 0);
  const navigate = useNavigate();
  const { search } = useLocation();

  // Keep the store's activeModule in sync with the URL, on mount and on
  // every module switch. An unresolvable slug leaves the store's
  // previous activeModule alone -- there is nothing valid to sync to.
  useEffect(() => {
    if (moduleId !== null) {
      setActiveModule(moduleId);
    }
  }, [moduleId, setActiveModule]);

  // Targeted selector (not the whole `tabs` array) so this effect only
  // re-fires when the entity actually shown for THIS module changes, not
  // on every unrelated tab mutation.
  const activeEntityIdForModule = useWorkbench((state) => {
    const activeTab = state.tabs.find((t) => t.key === state.activeTabKey);
    return activeTab && moduleId !== null && activeTab.module === moduleId ? activeTab.entityId : null;
  });

  // Step 6 (WP-074) -- the URL's optional `:entityId` segment reflects the
  // active tab, so the address bar matches what the detail region shows.
  // `replace: true` so opening/switching tabs does not spam browser
  // history. Tabs themselves are already persisted (workbenchStore's
  // zustand `persist` middleware), so a refresh/deep-link re-derives the
  // same URL from the rehydrated store without needing to parse
  // `:entityId` back out on mount.
  useEffect(() => {
    if (moduleId === null) return;
    const path = activeEntityIdForModule
      ? `/projects/${projectId}/workbench/${moduleSlug}/${activeEntityIdForModule}`
      : `/projects/${projectId}/workbench/${moduleSlug}`;
    // Carry the query string through. This sync runs on mount, so building a
    // bare path silently dropped any params the user arrived with -- e.g. the
    // legacy /testrepo?x=y redirect chain lost them, and WP-077 needs the
    // dashboard's `?assignedTo=`/severity drill-down into Defects to survive.
    navigate(`${path}${search}`, { replace: true });
  }, [moduleId, activeEntityIdForModule, projectId, moduleSlug, search, navigate]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Cross-module tab strip. Stays mounted across module switches --
          WP-072's Workbench.test.tsx asserts this exact DOM node keeps its
          identity across a module switch; <TabStrip> renders INSIDE it
          rather than replacing it, so that assertion still holds. */}
      {/* Collapsed while no tab is open: reserving 40px plus a divider for an
          empty strip read as a dead band under the app bar. */}
      <Box
        data-testid="workbench-tab-strip"
        sx={{
          flexShrink: 0,
          minHeight: hasTabs ? 40 : 0,
          borderBottom: hasTabs ? 1 : 0,
          borderColor: 'divider',
        }}
      >
        <TabStrip
          onActivate={({ module, entityId }) => {
            // WP-F21b -- see TabStrip's onActivate docs. The rail owns
            // module switching; a tab click owns its own destination.
            //
            // WP-F21c -- skip an activation that restates where we already
            // are. MUI's <Tabs> fires onChange during mount while resolving
            // its `value` against its children, so this handler can run for
            // an activation the user never performed.
            //
            // HONEST PROVENANCE, because the original justification here did
            // not survive: this guard was written after observing a reload
            // produce eleven navigations oscillating PLN-6 -> PLN-7 -> PLN-6
            // while activeTabKey never moved, and it was claimed to be what
            // fixed that. It is not. WP-F21e tried to pin it down with a
            // reload test and could not: with this guard reverted -- alone,
            // and together with the cross-module restriction below -- the
            // reload behaviour is identical (five navigations, no
            // oscillation), across both three-tab and four-tab
            // configurations, repeatedly. The oscillation was almost
            // certainly a downstream effect of WP-F21d's bug, where
            // EntityTree called openTab() twice per click (once for the
            // deselected node), leaving inconsistent persisted state for the
            // reload to replay. Fixing that removed the symptom.
            //
            // The guard is KEPT because it is still correct and cheap -- a
            // mount-time onChange whose module differs from the URL would
            // otherwise navigate on its own -- but it is a redundant-work
            // guard, not the fix for a reproducible bug, and the reload test
            // that accompanies it is a general stability check rather than a
            // regression test for something it can be shown to prevent.
            //
            // Comparing against the URL rather than store state is
            // deliberate: the URL is what this handler changes, so it is the
            // only thing that can tell a real move from a restatement.
            if (MODULE_SLUGS[module] === moduleSlug && entityId === urlEntityId) return;
            setActiveModule(module);
            // WP-F21e Fix 2 -- only navigate here for a genuine module
            // switch. `activateTab` (called just before this handler, in
            // TabStrip) already moved the store's `activeTabKey`, so for a
            // SAME-module tab click `activeEntityIdForModule` above picks
            // up the new tab and the URL-sync effect fires on its own --
            // to the identical target this call would have produced. That
            // made this an unconditional, redundant `replace` on every tab
            // click, and one that (Fix 1) forgot to carry `search` while
            // the sync effect (line 66) does. Restricting to a real module
            // change removes the redundancy and leaves `search`-preserving
            // navigation to the effect for the case it already handles
            // correctly (this is the pre-6f3b564 behaviour for same-module
            // switches, which worked).
            if (MODULE_SLUGS[module] !== moduleSlug) {
              // WP-F21e Fix 1 -- carry `search` through here too, same
              // reasoning as line 66: a cross-module tab click must not
              // silently drop the dashboard's `?assignedTo=`/severity
              // drill-down params any more than the mount-time sync does.
              navigate(`/projects/${projectId}/workbench/${MODULE_SLUGS[module]}/${entityId}${search}`, {
                replace: true,
              });
            }
          }}
        />
      </Box>
      <Box sx={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <RegionErrorBoundary region="rail">
          <ModuleRail projectId={projectId} activeModule={moduleId} />
        </RegionErrorBoundary>
        <RegionErrorBoundary region="panel">
          <SourcePanel moduleId={moduleId} />
        </RegionErrorBoundary>
        <RegionErrorBoundary region="detail">
          <Box
            data-testid="workbench-detail"
            sx={{ flex: 1, minWidth: 0, overflow: 'auto', p: 2 }}
          >
            <DetailComponent moduleId={moduleId} moduleSlug={moduleSlug} />
          </Box>
        </RegionErrorBoundary>
      </Box>
    </Box>
  );
}

export interface WorkbenchProps {
  /**
   * Test-only seam: overrides the detail region's content. Defaults to
   * `EntityDetail` (WP-074 Step 6), which dispatches to the real
   * per-module detail component (`TestCaseDetail` for module 1, and so on
   * through `ReleaseDetail` for module 6, the last module to get one --
   * WP-F15/F18 Task 2). Kept as a prop -- rather than hardcoding
   * `EntityDetail` inline -- because Workbench.test.tsx uses it to prove a
   * detail-region crash is contained without needing every module's real
   * detail component to exist.
   */
  DetailComponent?: React.ComponentType<DetailComponentProps>;
}

// WP-072 — the persistent workbench shell. Mounted once as the element
// of /projects/:projectId/workbench/:module/:entityId? (App.tsx); reads
// all three params here and does not remount on module/entity changes,
// so the tab strip (and, once WP-073 lands, its actual tab state) survive
// a module switch.
//
// Layout fills whatever height it is given via flexbox, not a hardcoded
// `90vh`/`80vh` (spec §6). WP-072 shipped this route with no MainLayout
// (a stated, deliberate gap -- "the workbench is currently a dead end",
// no way back to Home/Projects/Reports/Settings from it) and this
// component's own root used `100vh`, since nothing above it established a
// real height. WP-078 Part A closes that gap: App.tsx now wraps this
// route's element in `<MainLayout fillHeight><Workbench /></MainLayout>`,
// which threads one real `100vh` from MainLayout's own top-level shell
// down through MainDrawer's `fillHeight` branch as a definite, flexed
// height. This component's own root uses `height: '100%'` to fill THAT,
// rather than re-declaring `100vh` here and double-counting the chrome
// above it (the app bar/drawer would otherwise push this component's
// content below the viewport by exactly their own height). `minHeight: 0`
// stays down the flex chain either way, so children can shrink instead of
// overflowing.
//
// Workbench.test.tsx / Workbench.a11y.test.tsx deliberately keep mounting
// this component bare (no MainLayout) -- this is a CSS value change only,
// not a structural one, so both stay green unmodified;
// workbench/__tests__/WorkbenchChrome.test.tsx is the one place that
// proves the MainLayout-wrapped composition itself.
export default function Workbench({ DetailComponent = EntityDetail }: WorkbenchProps): JSX.Element {
  const { projectId: projectIdParam, module: moduleSlug } = useParams<{
    projectId: string;
    module: string;
    entityId?: string;
  }>();
  const projectId = Number(projectIdParam);

  return (
    // WP-073 -- the workbench supplies its own theme. App.tsx mounts no
    // app-wide ThemeProvider (ten components/layouts wrap themselves
    // individually), so without this the whole workbench rendered under
    // MUI's DEFAULT theme and none of WP-070's tokens reached it: not
    // palette.status, not spacing: 4, not typography.fontSize: 13.
    // Scoped here deliberately rather than added to App.tsx, which would
    // restyle every legacy page and is not this wave's call.
    <ThemeProvider theme={theme}>
      <Box sx={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <WorkbenchStoreProvider projectId={projectId}>
          <WorkbenchShell projectId={projectId} moduleSlug={moduleSlug ?? ''} DetailComponent={DetailComponent} />
        </WorkbenchStoreProvider>
      </Box>
    </ThemeProvider>
  );
}
