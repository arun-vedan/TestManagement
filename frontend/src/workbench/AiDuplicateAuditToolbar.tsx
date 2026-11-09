import React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AiDuplicateAuditPanel } from '../Components/AI/AiDuplicateAuditPanel';
import { usePermissions } from '../Hooks/usePermissions';
import { qk } from '../Hooks/queryKeys';
import { getCurrentProjectId } from '../currentProject';
import { useWorkbench } from './WorkbenchStoreProvider';
import { TreeNode } from '../Hooks/queries/useTreeChildren';

// WP-074e Part 1b -- Components/AI/AiDuplicateAuditPanel.tsx (WP-052, bulk
// near-duplicate audit) was mounted from Pages/testcases.tsx behind a
// toolbar button; deleting that page in WP-074's workbench cutover made it
// unreachable (a GR-4 violation -- the audit endpoint needs a real UI
// surface, not just an API). Restored here as a module-1-only toolbar
// action in the source panel, the same "natural home" (immediately above
// the tree) the legacy page put it in. Kept module-1-only for now, matching
// where it lived before -- module 2's own AI surfaces (Generate/Lint) are
// RequirementDetail's job (WP-075), not this toolbar's.
//
// Gated on 'write' the same way the legacy page gated it (recovered via
// `git show <pre-WP-074>:frontend/src/Pages/testcases.tsx`): the audit
// itself is read-only, but its actions (link/dismiss) mutate.
//
// Source-panel redesign (2026-11-06): the trigger is now an "Audit
// duplicates (AI)" item in SourcePanelHeader's "More actions" menu, which
// owns `open`; only the panel itself is rendered here (see
// CsvImportToolbar.tsx for why a dialog cannot live inside a menu item).
export interface AiDuplicateAuditToolbarProps {
  open: boolean;
  onClose: () => void;
}

export default function AiDuplicateAuditToolbar({ open, onClose }: AiDuplicateAuditToolbarProps): JSX.Element | null {
  const projectId = getCurrentProjectId();
  const queryClient = useQueryClient();
  const { can: canPerform } = usePermissions();
  const selection = useWorkbench((s) => s.selection[1]);
  const expandedIds = useWorkbench((s) => s.expanded[1]);

  if (!canPerform('write')) {
    return null;
  }

  // Same droppable-node-vs-leaf-node parentId derivation the legacy page
  // and TabContent.tsx's computeParentIdForDuplicateCheck used: a selected
  // FOLDER's own id is the module/folder to audit; a selected TEST CASE
  // (leaf)'s parent folder is. No selection -> undefined -> audit the
  // whole project (auditDuplicates()'s documented default).
  //
  // The workbench store's `selection` only ever holds the plain id
  // (EntityTree.tsx's handleSelect calls setSelection for both branches and
  // leaves) -- not whether it's a folder or its parent. Rather than teach
  // the store a new concept, this reads the exact same react-query cache
  // entries EntityTree itself renders from (qk.children, populated by
  // useTreeChildren/treeChildrenQueryOptions): the root's children, plus
  // every currently-expanded folder's children. That is already every node
  // EntityTree has ever shown the user, so this can't miss a selection.
  const findSelectedNode = (): TreeNode | undefined => {
    if (!selection) return undefined;
    const root = queryClient.getQueryData<TreeNode[]>(qk.children(projectId, 1, '0'));
    const inRoot = root?.find((n) => n.id === selection);
    if (inRoot) return inRoot;
    return expandedIds
      .map((folderId) => queryClient.getQueryData<TreeNode[]>(qk.children(projectId, 1, folderId)))
      .flatMap((children) => children ?? [])
      .find((n) => n.id === selection);
  };

  const selectedNode = findSelectedNode();
  const parentId = selectedNode
    ? Number(selectedNode.droppable ? selectedNode.id : selectedNode.parent)
    : undefined;
  const moduleLabel = selectedNode?.droppable ? selectedNode.text : undefined;

  return (
    <AiDuplicateAuditPanel
      open={open}
      onClose={onClose}
      parentId={parentId}
      moduleLabel={moduleLabel}
      // Same set the AI generate/link flows refresh elsewhere (WP-075a's
      // useCoverage) -- linking a duplicate can change orphan/untested
      // coverage, matching the legacy page's `onLinked={refreshUntested}`.
      onLinked={() => queryClient.invalidateQueries({ queryKey: qk.coverage(projectId) })}
    />
  );
}
