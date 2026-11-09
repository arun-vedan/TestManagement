import { useQueryClient } from '@tanstack/react-query';
import { CsvImportDialog } from '../Components/Import/CsvImportDialog';
import { usePermissions } from '../Hooks/usePermissions';
import { getCurrentProjectId } from '../currentProject';

// Wave C-1 (Register A3) -- CSV import for test cases (module 1 only; no
// other module has an import endpoint, backend/testRepoService/
// controllers/importExport.js, WP-045). The backend has existed since
// before this WP with no UI ever wired to it -- this makes it reachable
// from the Test Cases source panel, next to the existing New Test Case /
// New folder / Audit duplicates actions (SourcePanel.tsx), the same
// module-1-only placement AiDuplicateAuditToolbar.tsx already established
// for the other write-capable, dialog-driven action there.
//
// Gated on 'write' like every other control that creates records here
// (CreateActions in SourcePanel.tsx, AiDuplicateAuditToolbar.tsx) -- import
// creates test cases, so a viewer must never see the entry point at all
// (server-side authorize('write') is the real boundary; this is UI
// decoration on top of it, same as usePermissions.ts's own header comment
// states).
//
// Source-panel redesign (2026-11-06): the trigger is now an "Import CSV" item
// in SourcePanelHeader's "More actions" menu, which owns `open`. Only the
// dialog lives here -- a dialog rendered inside a menu item would bubble its
// clicks back up the React tree into that item.
export interface CsvImportToolbarProps {
  open: boolean;
  onClose: () => void;
}

export default function CsvImportToolbar({ open, onClose }: CsvImportToolbarProps): JSX.Element | null {
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const projectId = getCurrentProjectId();

  if (!can('write')) {
    return null;
  }

  const handleImported = () => {
    // An imported row's parentId comes from the file (or is absent, which
    // buildImportReport treats as no parent), not from whatever is
    // currently selected in the tree -- unlike NewFolderControl/
    // TestCaseDetail's own create flow, a single import can land rows
    // under many different folders in one commit. Invalidating only the
    // currently-selected folder's qk.children entry could easily miss
    // most of the new rows, so this invalidates every module-1 children
    // query project-wide (a partial queryKey match -- qk.children's own
    // key shape is ['project', projectId, module, 'children', parentId],
    // so dropping the trailing parentId invalidates all of them at once).
    queryClient.invalidateQueries({ queryKey: ['project', projectId, 1, 'children'] });
  };

  return <CsvImportDialog open={open} onClose={onClose} onImported={handleImported} />;
}
