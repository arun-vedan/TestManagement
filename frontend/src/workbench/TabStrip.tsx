import React from 'react';
import { Box, Tab, Tabs } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { useWorkbench } from './WorkbenchStoreProvider';
import { MODULE_ICONS, ModuleId } from './modules';

// WP-073 — cross-module tab strip, slotted into Workbench.tsx's
// `workbench-tab-strip` seam.
//
// Closing a tab: the "x" is a NON-interactive <span> inside the tab's own
// label, not a nested <button>. That is forced by ARIA and confirmed by
// axe: a real <button> inside MUI's <Tab> (itself a <button role="tab">)
// trips `nested-interactive`, and moving it to a non-tab sibling anywhere
// inside the <Tabs> (role="tablist") subtree trips `aria-required-children`
// -- axe walks the whole tablist subtree, not just direct children.
//
// A span carrying an onClick has no interactive ARIA role, so neither rule
// fires. Keyboard users are NOT left with a mouse-only control: Delete and
// Backspace on the focused tab close it, which is the APG-documented
// keyboard interaction for closable tabs. The span is aria-hidden so it
// cannot pollute the tab's accessible name.
//
// An earlier revision of this file rendered every close button in a
// separate cluster alongside <Tabs>. That passed axe but was rejected on
// review: with several tabs open nothing indicated which "x" belonged to
// which tab.
export interface TabStripProps {
  /**
   * WP-F21b -- called when the user activates a tab, with that tab's own
   * module and entity.
   *
   * Activating a tab is a NAVIGATION, and the destination is the tab's
   * module -- not whatever module the URL currently names. Workbench.tsx's
   * URL-sync effect cannot express that: it derives the path from
   * `activeEntityIdForModule`, which yields the active tab's entityId ONLY
   * when the tab's module equals the URL slug's module. Nothing else
   * changed that slug, so activating a tab from a DIFFERENT module left the
   * guard returning null and the effect navigating to the current module's
   * BARE route -- dropping the entity and staying on the wrong module. With
   * tabs open across two modules, clicking the other module's tab showed
   * neither ticket.
   *
   * Deriving that effect from the active tab instead would break the module
   * rail: a rail click changes the URL's module while the active tab still
   * belongs to the old one, and the effect would navigate straight back. So
   * the rail keeps owning module switches, and a tab click states its own
   * destination through this callback.
   *
   * Optional, and the router hooks live in Workbench rather than here on
   * purpose: this component is rendered bare (`<TabStrip />`) by several
   * jsdom suites that have no Router, and calling useNavigate() here would
   * break every one of them for behaviour they do not test.
   */
  onActivate?: (tab: { module: ModuleId; entityId: string }) => void;
}

export default function TabStrip({ onActivate }: TabStripProps = {}): JSX.Element {
  const tabs = useWorkbench((s) => s.tabs);
  const activeTabKey = useWorkbench((s) => s.activeTabKey);
  const activateTab = useWorkbench((s) => s.activateTab);
  const closeTab = useWorkbench((s) => s.closeTab);

  // Nothing at all while no tab is open: a placeholder here held the strip
  // 40px tall, which showed as a dead band under the app bar.
  if (tabs.length === 0) {
    return null;
  }

  return (
    <Tabs
      value={activeTabKey ?? false}
      onChange={(_event, key: string) => {
        activateTab(key);
        const tab = tabs.find((t) => t.key === key);
        if (tab) onActivate?.({ module: tab.module, entityId: tab.entityId });
      }}
      variant="scrollable"
      scrollButtons="auto"
      aria-label="Open tabs"
      sx={{ minHeight: 0, '& .MuiTab-root': { minHeight: 0, py: 1, textTransform: 'none' } }}
    >
      {tabs.map((tab) => {
        const Icon = MODULE_ICONS[tab.module];
        const accessibleName = tab.dirty ? `${tab.title} — unsaved changes` : tab.title;
        return (
          <Tab
            key={tab.key}
            value={tab.key}
            aria-label={accessibleName}
            // APG closable-tab keyboard path. The visible "x" below is
            // deliberately not focusable, so this is the ONLY way to close
            // a tab from the keyboard -- it is not an optional extra.
            onKeyDown={(event: React.KeyboardEvent) => {
              if (event.key === 'Delete' || event.key === 'Backspace') {
                event.preventDefault();
                closeTab(tab.key);
              }
            }}
            label={
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <Icon fontSize="small" aria-hidden data-testid={`tab-icon-${tab.key}`} />
                <Box component="span">{tab.title}</Box>
                {tab.dirty && (
                  <Box
                    component="span"
                    aria-hidden
                    data-testid={`tab-dirty-${tab.key}`}
                    sx={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      bgcolor: 'warning.main',
                      flexShrink: 0,
                    }}
                  />
                )}
                <Box
                  component="span"
                  aria-hidden
                  data-testid={`tab-close-${tab.key}`}
                  onClick={(event: React.MouseEvent) => {
                    // Stop the click reaching the enclosing <Tab> button,
                    // which would activate the tab we are closing.
                    event.stopPropagation();
                    closeTab(tab.key);
                  }}
                  sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    ml: 0.5,
                    borderRadius: '50%',
                    cursor: 'pointer',
                    '&:hover': { bgcolor: 'action.hover' },
                  }}
                >
                  <CloseIcon fontSize="inherit" />
                </Box>
              </Box>
            }
          />
        );
      })}
    </Tabs>
  );
}
