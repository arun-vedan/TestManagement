import React from 'react';
import { Box, ButtonBase, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { MODULE_ICONS, MODULE_LABELS, MODULE_SLUGS, ModuleId } from './modules';
import { useWorkbench } from './WorkbenchStoreProvider';

const MODULE_IDS = Object.keys(MODULE_LABELS).map(Number) as ModuleId[];

interface Props {
  projectId: number;
  /** The module the current URL resolves to, or null for an unknown slug. */
  activeModule: ModuleId | null;
}

// WP-F19 — the rail was 96px wide with a 20px icon and a 12px caption, so
// "Requirements" and "Test Plans" wrapped and read as decoration rather
// than navigation. Widened to 148px with a 24px icon and body2 labels.
// The accessible name is still exactly MODULE_LABELS[moduleId] (the icon
// stays aria-hidden), so every getByRole('button', { name }) query, the
// axe suite, and the Playwright journeys are unaffected by this.
//
// WP-072 — one entry per module (WP-070's MODULE_LABELS, all six), each
// with its module icon above the label (WP-076: the rail shipped
// label-only and lost the per-module iconography the legacy MainDrawer
// nav had). The icon is aria-hidden, so the accessible name stays exactly
// the module label and existing getByRole('button', { name }) queries and
// the axe suite are unaffected.
// Real <button>s (via MUI's ButtonBase) so the accessible name is the
// module label with no extra wiring; the active entry gets
// aria-current="page" per the APG convention for a same-page nav rail.
export default function ModuleRail({ projectId, activeModule }: Props): JSX.Element {
  const navigate = useNavigate();
  const setActiveModule = useWorkbench((state) => state.setActiveModule);

  const handleSelect = (moduleId: ModuleId): void => {
    setActiveModule(moduleId);
    navigate(`/projects/${projectId}/workbench/${MODULE_SLUGS[moduleId]}`);
  };

  return (
    <Box
      component="nav"
      aria-label="Modules"
      data-testid="workbench-module-rail"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        width: 148,
        flexShrink: 0,
        overflowY: 'auto',
        borderRight: 1,
        borderColor: 'divider',
      }}
    >
      {MODULE_IDS.map((moduleId) => {
        const isActive = moduleId === activeModule;
        const Icon = MODULE_ICONS[moduleId];
        return (
          <ButtonBase
            key={moduleId}
            onClick={() => handleSelect(moduleId)}
            aria-current={isActive ? 'page' : undefined}
            sx={{
              flexDirection: 'column',
              alignItems: 'stretch',
              textAlign: 'center',
              py: 2,
              px: 1,
              bgcolor: isActive ? 'action.selected' : 'transparent',
              borderLeft: 2,
              borderColor: isActive ? 'primary.main' : 'transparent',
            }}
          >
            <Icon
              fontSize="medium"
              aria-hidden
              data-testid={`module-icon-${moduleId}`}
              sx={{ display: 'block', mx: 'auto', mb: 0.75, color: isActive ? 'primary.main' : 'text.secondary' }}
            />
            <Typography
              variant="body2"
              sx={{ fontWeight: isActive ? 600 : 500, lineHeight: 1.25, color: isActive ? 'primary.main' : 'text.primary' }}
            >
              {MODULE_LABELS[moduleId]}
            </Typography>
          </ButtonBase>
        );
      })}
    </Box>
  );
}
