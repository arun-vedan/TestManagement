import { useState } from 'react';
import { Alert, Box, CircularProgress, Typography } from '@mui/material';
import { usePermissions } from '../Hooks/usePermissions';
import { getCurrentProjectId } from '../currentProject';
import { ModuleId } from './modules';
import {
  getExportConfig,
  fetchAllRowsForExport,
  rowsToCsv,
  downloadCsv,
  buildExportFilename,
  MAX_EXPORT_ROWS,
} from '../api/exportApi';

// Wave C-2 (Register A3) -- "Export CSV", the export-side counterpart of
// CsvImportToolbar.tsx (Wave C-1). No backend export endpoint exists
// anywhere (see api/exportApi.ts's header comment) and adding one is
// explicitly out of scope for this WP, so this builds the file entirely
// client-side from whichever paginated list API the module already has
// (api/entityGridApi.ts) -- see exportApi.ts's `exportConfigs` for exactly
// which modules that is and why module 6 (releases) is excluded.
//
// Offered for every non-null module (SourcePanelHeader.tsx), unlike
// CsvImportToolbar which is module-1-only -- getExportConfig() returning
// undefined for a module with no list API is what actually decides
// whether anything is shown, so this component itself never needs a
// per-module gate.
//
// PERMISSION GATE: can('read'), the floor this WP's brief asks for.
// Stated plainly rather than left implicit: permissions.ts's
// PERMISSION_MATRIX gives every one of the four roles (admin/manager/
// contributor/viewer) `read: true` -- there is no role in this app that
// can see a module at all but is refused read on it. So this check does
// NOT differentiate between roles the way CsvImportToolbar's can('write')
// gate genuinely does (a viewer really is refused that one); its only real
// effect is hiding the button during usePermissions()'s own loading state
// and for a signed-in user with no membership on this project at all
// (role null) -- both edge cases, not a meaningful per-role restriction.
// Kept anyway for the same reason every other SourcePanel control checks
// permissions before rendering: consistency, and it is genuinely free.
// Source-panel redesign (2026-11-06): the trigger is an "Export CSV" item in
// SourcePanelHeader's "More actions" menu, so this is now a hook (whether to
// offer the item, and running it) plus <CsvExportAlerts> for the outcome,
// rendered under the panel header where the button used to sit.
export interface CsvExport {
  /** False for a module with no list API (releases) or no read access. */
  available: boolean;
  exporting: boolean;
  /** Module-specific caveat, shown as the menu item's secondary text. */
  note?: string;
  errorMessage: string;
  warningMessage: string;
  run: () => Promise<void>;
  dismiss: () => void;
}

export function useCsvExport(moduleId: ModuleId): CsvExport {
  const { can } = usePermissions();
  const projectId = getCurrentProjectId();
  const config = getExportConfig(moduleId);
  const [exporting, setExporting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [warningMessage, setWarningMessage] = useState('');

  const run = async () => {
    if (!config) return;
    setExporting(true);
    setErrorMessage('');
    setWarningMessage('');
    try {
      const { rows, truncated } = await fetchAllRowsForExport(config.fetchPage);
      const csv = rowsToCsv(config.columns, rows);
      const filename = buildExportFilename(config.entityLabel, projectId);
      downloadCsv(csv, filename);
      if (truncated) {
        setWarningMessage(
          `This module has more than ${MAX_EXPORT_ROWS} rows -- only the first ${MAX_EXPORT_ROWS} were exported.`
        );
      }
    } catch (err) {
      setErrorMessage((err as Error)?.message || 'Export failed. Please try again.');
    } finally {
      setExporting(false);
    }
  };

  return {
    available: Boolean(config) && can('read'),
    exporting,
    note: config?.roundTripNote,
    errorMessage,
    warningMessage,
    run,
    dismiss: () => {
      setErrorMessage('');
      setWarningMessage('');
    },
  };
}

export function CsvExportAlerts({ exporter }: { exporter: CsvExport }): JSX.Element | null {
  const { exporting, errorMessage, warningMessage, dismiss } = exporter;
  if (!exporting && !errorMessage && !warningMessage) return null;
  return (
    <Box sx={{ px: 1, py: 0.5 }}>
      {exporting && (
        <Box role="status" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <CircularProgress size={14} />
          <Typography variant="caption">Exporting…</Typography>
        </Box>
      )}
      {errorMessage && (
        <Alert severity="error" onClose={dismiss}>
          {errorMessage}
        </Alert>
      )}
      {warningMessage && (
        <Alert severity="warning" onClose={dismiss}>
          {warningMessage}
        </Alert>
      )}
    </Box>
  );
}
