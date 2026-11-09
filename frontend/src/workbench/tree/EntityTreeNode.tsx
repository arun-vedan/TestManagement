import React, { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  Menu,
  MenuItem,
  Typography,
} from '@mui/material';
import ArrowRightIcon from '@mui/icons-material/ArrowRight';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import DriveFileMoveOutlinedIcon from '@mui/icons-material/DriveFileMoveOutlined';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { useDrag, useDrop } from 'react-dnd';
import { INodeRendererProps } from 'react-accessible-treeview';
import { tokens, StatusToken } from '../../Theme/tokens';
import { StatusChip, StatusChipColor } from '../../Components/common/StatusChip';
import { ModuleId } from '../modules';
import { MoveNodeVars } from '../../Hooks/mutations/useMoveNode';
import { DeleteEntityVars } from '../../Hooks/mutations/useDeleteEntity';
import {
  ENTITY_DRAG_TYPE,
  DragPayload,
  isNodeMovable,
  canDropOnFolder,
  buildMoveVars,
} from './dnd/moveRules';

function isStatusToken(value: string | undefined): value is StatusToken {
  return !!value && Object.prototype.hasOwnProperty.call(tokens.status, value);
}

// Maps tokens.status's execution-status vocabulary onto StatusChip's
// existing MUI-standard color set (Components/common/StatusChip.tsx),
// reusing the shared status-pill primitive instead of hand-rolling a new
// colored chip -- so no raw hex is introduced here, and no dependency on a
// <ThemeProv> that isn't guaranteed to be mounted above this tree today
// (App.tsx applies no app-wide ThemeProvider; several pages wrap
// themselves individually, but Workbench.tsx currently does not -- a
// pre-existing gap outside this WP's file list, flagged in the WP-073
// report rather than fixed here).
const STATUS_CHIP_COLORS: Record<StatusToken, StatusChipColor> = {
  pass: 'success',
  fail: 'error',
  blocked: 'warning',
  skipped: 'default',
  notRun: 'default',
  inProgress: 'info',
};

// react-accessible-treeview constrains node metadata to a flat
// string-keyed record (IFlatMetadata) -- the index signature below is
// required to satisfy that constraint, not an invitation to nest objects.
export interface EntityTreeNodeMetadata {
  droppable: boolean;
  status?: string;
  // WP-077b -- the node's actual domain parent id (EntityTree.tsx's
  // buildTreeData translates react-accessible-treeview's synthetic tree
  // parent into this). Needed here so a drag item / "Move to..." menu can
  // be built without this component owning any separate copy of the tree.
  parentId: string;
  [key: string]: string | number | boolean | undefined | null;
}

export interface EntityTreeNodeProps extends INodeRendererProps {
  module: ModuleId;
  onMove: (vars: MoveNodeVars) => void;
  // Every folder currently known to the tree (root-level + nested under
  // an expanded ancestor) -- EntityTree.tsx computes this once per render
  // from the same `data` array everything else here reads from.
  folderOptions: { id: string; name: string }[];
  // Wave B-3/B-4 (PRODUCT_GAP_REGISTER.md A1/B1) -- delete and clone,
  // surfaced from the same per-row menu as the "Move to..." button above.
  // Both gates are read ONCE by EntityTree.tsx (usePermissions is
  // react-query-cached, so this costs nothing extra per row) rather than
  // here per-node, so every row in the tree agrees on the same answer.
  // `canDelete` is can('delete') -- NOT can('write'); `canClone` is
  // can('write') AND the module actually has a create flow to clone into
  // (DRAFT_CAPABLE_MODULES, workbench/modules.ts).
  canDelete: boolean;
  canClone: boolean;
  onDelete: (vars: DeleteEntityVars) => Promise<unknown>;
  onClone: (id: string) => Promise<unknown>;
}

// getNodeProps() types (react-accessible-treeview's IBranchProps/LeafProps)
// omit `ref` from IBranchProps even though the library's own implementation
// always returns one for both node kinds (confirmed by reading
// react-accessible-treeview's source: both branch and leaf getNodeProps()
// return a `ref` callback that feeds the library's own node-lookup refs,
// used for keyboard scroll-into-view) -- this local type fills the typing
// gap rather than casting to `any`.
type NodePropsWithRef = ReturnType<INodeRendererProps['getNodeProps']> & {
  ref?: (node: HTMLElement | null) => void;
};

function mergeRefs(
  ...refs: Array<((node: HTMLElement | null) => void) | undefined | null>
): (node: HTMLElement | null) => void {
  return (node) => {
    refs.forEach((ref) => {
      if (ref) ref(node);
    });
  };
}

// WP-073 — the row content react-accessible-treeview's <TreeView> places
// INSIDE the role=treeitem element it owns (branches) or that
// `getNodeProps()` turns the returned element into (leaves) -- see
// EntityTree.tsx's header comment for why this library was chosen over
// @mui/x-tree-view. `getNodeProps()`'s onClick already composes select +
// (for branches) expand/collapse, so there is deliberately no separate
// toggle <IconButton>: CustomNode.tsx (the old tree) documents exactly why
// a nested interactive toggle inside an interactive row fails axe's
// nested-interactive rule, and the chevron here is purely decorative.
//
// WP-077b — the "Move to..." <IconButton> below is a DIFFERENT case from
// that chevron, even though it is also a real interactive control nested
// under this row's DOM node: axe-core's nested-interactive rule (verified
// empirically against this exact axe-core version -- a `<button>` inside a
// bare `role="treeitem"` element produces NO violation, unlike a `<button>`
// inside a `role="button"` row, which does) does not treat `treeitem` as an
// "interactive" ancestor role the way it treats `button`/`link`. EntityTree.
// a11y.test.tsx's existing axe assertion is the actual proof this stays
// clean, not this comment. The button's own onClick/onKeyDown stop
// propagation so it never re-triggers the row's select/expand handler, and
// its Menu (MUI, portaled to document.body) renders OUTSIDE this
// treeitem's DOM subtree entirely -- so the destination-folder list never
// touches the tree's role="tree"/"treeitem" structure, its roving
// tabindex, or its arrow-key navigation. The button is a plain, always-
// tabbable <button> (native tabIndex=0), independent of the tree's own
// roving-tabindex bookkeeping -- reached with a normal Tab, not arrow keys,
// which is the "single-pointer alternative" WCAG 2.2 SC 2.5.7 asks for.
export default function EntityTreeNode({
  element,
  isBranch,
  isExpanded,
  isSelected,
  getNodeProps,
  level,
  module,
  onMove,
  folderOptions,
  canDelete,
  canClone,
  onDelete,
  onClone,
}: EntityTreeNodeProps): JSX.Element {
  const metadata = element.metadata as EntityTreeNodeMetadata | undefined;
  const status = metadata?.status;
  const droppableFolder = !!metadata?.droppable;
  const parentId = metadata?.parentId ?? '0';
  const nodeId = String(element.id);
  const movable = isNodeMovable(module, droppableFolder);

  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);

  // Wave B-3/B-4 -- Delete/Clone menu, confirmation dialog, and their
  // pending/error UI state, all local to this row (mirroring
  // Components/common/BulkActionBar.tsx's own local `running`/`error`
  // state rather than threading a shared mutation's pending/error id
  // across every row). Neither action is ever offered for a folder
  // (`isBranch`) -- delete/clone target the entities this WP scoped
  // (test case/requirement/test plan/run/defect), never a folder.
  const [actionsAnchor, setActionsAnchor] = useState<HTMLElement | null>(null);
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [cloneError, setCloneError] = useState<string | null>(null);
  const showActionsMenu = !isBranch && (canDelete || canClone);

  const closeActionsMenu = (): void => setActionsAnchor(null);

  const openConfirmDelete = (): void => {
    closeActionsMenu();
    setDeleteError(null);
    setConfirmDeleteOpen(true);
  };

  const closeConfirmDelete = (): void => {
    if (deleting) return;
    setConfirmDeleteOpen(false);
    setDeleteError(null);
  };

  // Deliberately NOT closed on a successful delete by watching some
  // shared mutation state -- `onDelete` (EntityTree.tsx's
  // `deleteEntity.mutateAsync`) resolves or rejects for exactly THIS
  // call, so this dialog's own pending/error state can never be confused
  // with another row's concurrent delete.
  const handleConfirmDelete = async (): Promise<void> => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete({ id: nodeId, parentId });
      setConfirmDeleteOpen(false);
    } catch (err) {
      setDeleteError((err as Error)?.message || 'Could not delete this item. Please try again.');
    } finally {
      setDeleting(false);
    }
  };

  const handleClone = async (): Promise<void> => {
    closeActionsMenu();
    setCloneError(null);
    try {
      await onClone(nodeId);
    } catch (err) {
      setCloneError((err as Error)?.message || 'Could not clone this item. Please try again.');
    }
  };

  // WP-077b -- drag source. Always called (rules of hooks), but its
  // connector is only ever attached to the DOM (see combinedRef below)
  // when `movable` is true -- so a non-movable leaf (module 3/4/5) never
  // gets a `draggable` attribute or a dragstart listener at all, not just
  // a `canDrag` that happens to return false. `item` is a function so a
  // fresh payload is built per drag attempt from this render's own
  // parentId/droppable rather than a stale closure.
  const [, dragRef] = useDrag<DragPayload, void, unknown>(
    () => ({
      type: ENTITY_DRAG_TYPE,
      item: (): DragPayload => ({ id: nodeId, parentId, droppable: droppableFolder }),
      canDrag: () => movable,
    }),
    [nodeId, parentId, droppableFolder, movable],
  );

  // WP-077b -- drop target. Only folders ever accept a drop (spec: valid
  // targets are folders + the tree root); a leaf's `canDrop` is
  // permanently false via the `isBranch` guard. `drop` re-checks
  // `canDropOnFolder` itself rather than trusting the caller to have
  // already gated on `canDrop` -- real react-dnd backends do that
  // gating before ever invoking `drop`, but this keeps "no mutation on a
  // self/parent no-op drop" true unconditionally, not just true of
  // today's backend. `monitor.didDrop()` skips handling here if a MORE
  // nested drop target already handled the same native drop (not
  // reachable today since folders don't nest a drop target inside
  // another drop target's rendered content, but kept for the same reason
  // EntityTree.tsx's root-zone drop guards it).
  const [, dropRef] = useDrop<DragPayload, void, unknown>(
    () => ({
      accept: ENTITY_DRAG_TYPE,
      canDrop: (dragged) => isBranch && canDropOnFolder(dragged, nodeId),
      drop: (dragged, monitor) => {
        if (monitor.didDrop()) return;
        if (!isBranch || !canDropOnFolder(dragged, nodeId)) return;
        onMove(buildMoveVars(dragged, nodeId));
      },
    }),
    [isBranch, nodeId, onMove],
  );

  const nodeProps = getNodeProps() as NodePropsWithRef;
  const combinedRef = mergeRefs(
    nodeProps.ref ?? null,
    movable ? (dragRef as unknown as (node: HTMLElement | null) => void) : null,
    isBranch ? (dropRef as unknown as (node: HTMLElement | null) => void) : null,
  );

  // Candidate destinations for the keyboard "Move to..." menu: every known
  // folder except the node's own id (can't move into itself) and its
  // current parent (a no-op) -- the same two exclusions canDropOnFolder
  // enforces for a real drag. Root is offered separately, only when the
  // node isn't already sitting at the root.
  const candidateFolders = folderOptions.filter((f) => f.id !== nodeId && f.id !== parentId);
  const canMoveToRoot = parentId !== '0';
  const hasMoveTargets = candidateFolders.length > 0 || canMoveToRoot;

  const closeMenu = (): void => setMenuAnchor(null);

  const handleMoveTo = (toParentId: string): void => {
    onMove(buildMoveVars({ id: nodeId, parentId, droppable: droppableFolder }, toParentId));
    closeMenu();
  };

  return (
    <>
    <Box
      {...nodeProps}
      // WP-077b -- confirmed via a real Chrome accessibility tree (CDP
      // Accessibility.getFullAXTree), NOT reproducible in jsdom: without
      // this, a row's accessible name is computed from ALL of its visible
      // content, so the "Move to..." button's OWN aria-label
      // ("Move TC-104 to…") gets concatenated onto the row's name,
      // producing "TC-104 Move TC-104 to…" instead of "TC-104". That
      // broke an EXACT accessible-name lookup in the real browser (the
      // kind Playwright's `getByRole(..., { exact: true })` uses) even
      // though every jsdom/jest-axe test here stayed green -- jsdom's
      // accname implementation does not reproduce this particular
      // pollution for this DOM shape (verified directly; see the WP
      // report). An explicit aria-label pins the name to exactly the
      // entity's own label regardless of what else the row ever grows
      // (this button, the status chip, etc), in every environment.
      aria-label={element.name}
      ref={combinedRef}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.5,
        pl: level,
        py: 0.5,
        minHeight: tokens.density.rowHeight,
        pr: 0.5,
        borderRadius: 1,
        cursor: 'pointer',
        '&:hover': { bgcolor: isSelected ? tokens.brandTint : 'action.hover' },
        // Selected row: brand tint plus a left accent bar. Read from the
        // renderer's isSelected rather than CSS on [aria-selected], because
        // the treeitem is this row for a leaf but the wrapping <li> for a
        // branch.
        ...(isSelected && { bgcolor: tokens.brandTint, boxShadow: `inset 3px 0 0 ${tokens.brand}` }),
        // Row actions (Move to…, ⋮) fade in on hover, keyboard focus or an
        // open menu instead of sitting on every row. Opacity rather than
        // display:none so they stay in the tab order and reachable.
        '& .row-action': { opacity: 0, transition: 'opacity 120ms' },
        '&:hover .row-action, &:focus-within .row-action, & .row-action[aria-expanded="true"], & .row-action:focus-visible':
          { opacity: 1 },
        // Also on the selected row, and when the tree's roving focus sits on
        // this row's treeitem (the row itself for a leaf, its <li> for a branch).
        ...(isSelected && { '& .row-action': { opacity: 1 } }),
        '[role="treeitem"]:focus > & .row-action': { opacity: 1 },
      }}
    >
      <Box sx={{ width: 20, display: 'flex', justifyContent: 'center', flexShrink: 0 }} aria-hidden>
        {isBranch ? (
          isExpanded ? <ArrowDropDownIcon fontSize="small" /> : <ArrowRightIcon fontSize="small" />
        ) : (
          <DescriptionOutlinedIcon fontSize="small" color="disabled" />
        )}
      </Box>
      <Typography variant="body2" component="span" sx={{ flex: 1, minWidth: 0 }}>
        {element.name}
      </Typography>
      {isStatusToken(status) && (
        <StatusChip
          status={status}
          colorMap={STATUS_CHIP_COLORS}
          sx={{ height: 20 }}
        />
      )}
      {movable && hasMoveTargets && (
        <>
          <IconButton
            size="small"
            className="row-action"
            aria-haspopup="menu"
            aria-expanded={Boolean(menuAnchor)}
            aria-label={`Move ${element.name} to…`}
            onClick={(event) => {
              event.stopPropagation();
              setMenuAnchor(event.currentTarget);
            }}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <DriveFileMoveOutlinedIcon fontSize="inherit" />
          </IconButton>
          <Menu
            anchorEl={menuAnchor}
            open={Boolean(menuAnchor)}
            onClose={closeMenu}
            MenuListProps={{ 'aria-label': `Move ${element.name} to…`, dense: true }}
          >
            {candidateFolders.map((folder) => (
              <MenuItem key={folder.id} onClick={() => handleMoveTo(folder.id)}>
                {folder.name}
              </MenuItem>
            ))}
            {canMoveToRoot && <MenuItem onClick={() => handleMoveTo('0')}>Root</MenuItem>}
          </Menu>
        </>
      )}
      {showActionsMenu && (
        <>
          <IconButton
            size="small"
            className="row-action"
            aria-haspopup="menu"
            aria-expanded={Boolean(actionsAnchor)}
            aria-label={`Actions for ${element.name}`}
            onClick={(event) => {
              event.stopPropagation();
              setActionsAnchor(event.currentTarget);
            }}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <MoreVertIcon fontSize="inherit" />
          </IconButton>
          <Menu
            anchorEl={actionsAnchor}
            open={Boolean(actionsAnchor)}
            onClose={closeActionsMenu}
            MenuListProps={{ 'aria-label': `Actions for ${element.name}`, dense: true }}
          >
            {canClone && <MenuItem onClick={handleClone}>Clone</MenuItem>}
            {canDelete && (
              <MenuItem onClick={openConfirmDelete} sx={{ color: 'error.main' }}>
                Delete
              </MenuItem>
            )}
          </Menu>
        </>
      )}
    </Box>
    {showActionsMenu && (
      <Dialog open={confirmDeleteOpen} onClose={closeConfirmDelete} maxWidth="sm" fullWidth>
        <DialogTitle>Delete {element.name}?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This permanently deletes “{element.name}”. This cannot be undone.
          </DialogContentText>
          {deleteError && (
            <Alert severity="error" sx={{ mt: 2 }}>
              {deleteError}
            </Alert>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeConfirmDelete} disabled={deleting}>
            Cancel
          </Button>
          <Button color="error" variant="contained" onClick={handleConfirmDelete} disabled={deleting}>
            {deleting ? 'Deleting…' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    )}
    {cloneError && (
      <Alert severity="error" onClose={() => setCloneError(null)} sx={{ mt: 0.5, ml: level }}>
        {cloneError}
      </Alert>
    )}
    </>
  );
}
