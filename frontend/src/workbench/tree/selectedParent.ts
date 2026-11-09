import { QueryClient } from '@tanstack/react-query';
import { ModuleId } from '../modules';
import { EntityId } from '../store/workbenchStore';
import { qk } from '../../Hooks/queryKeys';
import { TreeNode } from '../../Hooks/queries/useTreeChildren';

// WP-079 Part A -- shared "what folder does a new item/folder belong
// under" rule, lifted from Components/folderStructure/folderStructure.tsx's
// createFolder (lines ~139-149) and createNewReq (lines ~178-190), which
// both apply the exact same rule from whatever node is currently selected:
// a selected FOLDER's own id, else a selected LEAF's parent folder, else
// root ('0'). The workbench store's `selection[module]` only ever holds a
// plain id -- not whether it names a folder or a leaf -- so this resolves
// that the same way AiDuplicateAuditToolbar.tsx's findSelectedNode already
// does: by reading the qk.children cache entries EntityTree itself
// populates (the root's children, plus every currently-expanded folder's),
// which is every node the tree has ever shown the user. Extracted here
// (rather than copied a third time) so SourcePanel's "New folder" control
// and TestCaseDetail's Create action share one implementation.
export function resolveSelectedParentId(
  queryClient: QueryClient,
  projectId: number,
  module: ModuleId,
  selection: EntityId | null,
  expandedIds: EntityId[],
): string {
  if (!selection) return '0';

  const root = queryClient.getQueryData<TreeNode[]>(qk.children(projectId, module, '0'));
  const inRoot = root?.find((n) => n.id === selection);
  const selectedNode =
    inRoot ??
    expandedIds
      .map((folderId) => queryClient.getQueryData<TreeNode[]>(qk.children(projectId, module, folderId)))
      .flatMap((children) => children ?? [])
      .find((n) => n.id === selection);

  if (!selectedNode) return '0';
  return selectedNode.droppable ? selectedNode.id : selectedNode.parent;
}
