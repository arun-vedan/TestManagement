import { ModuleId } from '../../modules';
import { MoveNodeVars } from '../../../Hooks/mutations/useMoveNode';

// WP-077b -- react-dnd item type shared by every draggable/droppable
// EntityTreeNode (folders in every module, leaves in modules 1/2 only --
// see isNodeMovable below) and the root drop strip in EntityTree.tsx. One
// constant, one `accept`/`type` pair, so a drag started on any node can be
// dropped on any folder or the root zone.
export const ENTITY_DRAG_TYPE = 'workbench-entity-node';

// The payload react-dnd carries from a drag source to a drop target.
// Deliberately just the fields useMoveNode's MoveNodeVars needs to be
// built from (see buildMoveVars) plus nothing else -- no name/status, so
// nothing here tempts a drop target into rendering drag payload instead of
// its own data.
export interface DragPayload {
  id: string;
  parentId: string;
  droppable: boolean;
}

// WP-071 §11.5 (see Hooks/mutations/useMoveNode.ts's own header comment):
// a folder moves via updateFolderByParam regardless of module, but a leaf
// only has a mover in modules 1 (test cases) and 2 (requirements) --
// modules 3/4/5 have none yet and useMoveNode deliberately THROWS if asked
// to move one. This function is the single gate that decides whether a
// node may ever become a drag source (used both by EntityTreeNode's
// useDrag `canDrag` and to decide whether the drag ref gets connected to
// the DOM node at all -- see EntityTreeNode.tsx for why "connected at all"
// matters for testability), so nothing upstream of it can ever reach a
// drop path that would throw.
export function isNodeMovable(module: ModuleId, droppable: boolean): boolean {
  if (droppable) return true;
  return module === 1 || module === 2;
}

// A folder is a valid drop target for a dragged node unless that would be
// a no-op: dropping a node onto itself, or onto the parent it is already
// directly under.
export function canDropOnFolder(dragged: DragPayload, targetFolderId: string): boolean {
  if (dragged.id === targetFolderId) return false;
  if (dragged.parentId === targetFolderId) return false;
  return true;
}

// The tree root ('0') is a valid drop target unless the node is already
// sitting directly at the root -- also a no-op.
export function canDropOnRoot(dragged: DragPayload, rootParentId = '0'): boolean {
  return dragged.parentId !== rootParentId;
}

export function buildMoveVars(dragged: DragPayload, toParentId: string): MoveNodeVars {
  return {
    id: dragged.id,
    fromParentId: dragged.parentId,
    toParentId,
    droppable: dragged.droppable,
  };
}
