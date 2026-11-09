import React, { useRef } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useDrop } from 'react-dnd';
import { Box, Button, CircularProgress, Typography } from '@mui/material';
import TreeView, { INode, ITreeViewOnSelectProps } from 'react-accessible-treeview';
import { ModuleId, DRAFT_CAPABLE_MODULES } from '../modules';
import { useWorkbench } from '../WorkbenchStoreProvider';
import { useTreeChildren, treeChildrenQueryOptions, TreeNode } from '../../Hooks/queries/useTreeChildren';
import { useMoveNode } from '../../Hooks/mutations/useMoveNode';
import { useDeleteEntity } from '../../Hooks/mutations/useDeleteEntity';
import { useCloneEntity } from '../../Hooks/mutations/useCloneEntity';
import { usePermissions } from '../../Hooks/usePermissions';
import { getCurrentProjectId } from '../../currentProject';
import EntityTreeNode, { EntityTreeNodeMetadata } from './EntityTreeNode';
import { ENTITY_DRAG_TYPE, DragPayload, canDropOnRoot, buildMoveVars } from './dnd/moveRules';

// WP-073 — library decision (GR-1 spike, recorded in full in the WP-073
// completion report): @mui/x-tree-view@6.17 and react-accessible-treeview@2.9
// were both already installed with zero imports. A genuine render-and-
// inspect spike (not just source reading) found two concrete blockers in
// @mui/x-tree-view for OUR lazy-per-folder-query design (a folder's real
// children are unknown until it is expanded and its query resolves):
//   1. TreeItem's aria-expanded is only emitted when it currently has React
//      children (`expandable = Boolean(children)`); a collapsed, not-yet-
//      fetched folder gets NO aria-expanded attribute at all (confirmed:
//      `null`, not "false") unless given a placeholder child -- extra
//      indirection this WP would have to invent and maintain everywhere.
//   2. It manages focus via a single-tabstop `aria-activedescendant`
//      pattern: the tree ROOT gets tabIndex=0 and EVERY treeitem is
//      tabIndex=-1 (confirmed empirically), not real roving tabindex.
// react-accessible-treeview instead lets a node be flagged `isBranch: true`
// up front (independent of whether its children have loaded), which
// correctly renders aria-expanded="false" on an unexpanded, unfetched
// folder with no placeholder hack, and its keyboard layer genuinely
// implements roving tabindex (`tabIndex: tabbableId === node.id ? 0 : -1`)
// plus ArrowUp/Down/Left/Right/Home/End/Enter out of the box -- so
// useTreeKeyboard.ts (in the plan's file list) is NOT implemented here: the
// library does the job, proven by the keyboard tests in EntityTree.test.tsx
// passing with no custom keyboard code at all.
//
// react-accessible-treeview's <TreeView> owns a single role="tree" with one
// flat `data: INode[]` describing everything CURRENTLY known -- it is not
// designed to be nested per-level. To keep "each expanded folder is its own
// cached query, no local array copy" (spec) while still handing it one
// array, this component calls the *actual* `useTreeChildren` hook for the
// always-visible root, and fans out across every OTHER currently-expanded
// folder id with react-query's `useQueries` (necessary because the number
// of expanded folders varies render to render, and calling `useTreeChildren`
// itself a variable number of times in a loop would violate the rules of
// hooks). `useQueries` is fed `treeChildrenQueryOptions` -- the exact same
// query key and fetch logic `useTreeChildren` itself uses (extracted, not
// duplicated) -- so a folder's query is still the single cached source of
// truth; nothing here is copied into local state. The merged `INode[]` is
// computed fresh every render directly from these query results (no
// useState, no useMemo needed at this scale) -- if a query's `data`
// reference hasn't changed, neither has the computed array's content.
const ROOT_NODE_ID = '__root__';

export interface EntityTreeProps {
  module: ModuleId;
  onOpen?: (node: TreeNode) => void;
}

function buildTreeData(
  rootChildren: TreeNode[],
  expandedIds: string[],
  folderChildrenById: Record<string, TreeNode[]>,
): INode<EntityTreeNodeMetadata>[] {
  const nodes: INode<EntityTreeNodeMetadata>[] = [
    { id: ROOT_NODE_ID, name: '', parent: null, children: rootChildren.map((n) => n.id) },
  ];
  const seen = new Set<string>([ROOT_NODE_ID]);

  const addLevel = (parentId: string, children: TreeNode[]): void => {
    // WP-077b -- `parentId` here is react-accessible-treeview's SYNTHETIC
    // tree-parent id (ROOT_NODE_ID for the always-visible root pass, or a
    // real folder id for a nested pass); the node's actual DOMAIN parent
    // (what useMoveNode's fromParentId must be) is '0' for the root pass
    // and that same folder id otherwise -- they coincide except at the
    // root, so this is the one place that translation happens. Stashed in
    // metadata.parentId so EntityTreeNode's drag item / "Move to..." menu
    // can read a node's current parent without needing its own copy of
    // the tree structure.
    const domainParentId = parentId === ROOT_NODE_ID ? '0' : parentId;
    children.forEach((child) => {
      if (seen.has(child.id)) return;
      seen.add(child.id);
      const isLoadedExpandedFolder = child.droppable && expandedIds.includes(child.id);
      const loadedChildren = isLoadedExpandedFolder ? folderChildrenById[child.id] ?? [] : [];
      nodes.push({
        id: child.id,
        name: child.text,
        parent: parentId,
        isBranch: child.droppable,
        children: loadedChildren.map((c) => c.id),
        metadata: { droppable: child.droppable, status: child.status, parentId: domainParentId },
      });
    });
  };

  addLevel(ROOT_NODE_ID, rootChildren);
  expandedIds.forEach((folderId) => {
    addLevel(folderId, folderChildrenById[folderId] ?? []);
  });

  return nodes;
}

// WP-073 — accessible role="tree" source panel content. Renders directly
// from useTreeChildren/useQueries results per expanded folder -- no local
// array copy of the tree, and a folder's own query only exists (is only
// mounted) once it is in the store's `expanded[module]` set.
export default function EntityTree({ module, onOpen }: EntityTreeProps): JSX.Element {
  const projectId = getCurrentProjectId();
  const expandedIds = useWorkbench((s) => s.expanded[module]);
  const selection = useWorkbench((s) => s.selection[module]);
  const toggleExpanded = useWorkbench((s) => s.toggleExpanded);
  const setSelection = useWorkbench((s) => s.setSelection);
  const openTab = useWorkbench((s) => s.openTab);

  const rootQuery = useTreeChildren(module, '0');
  const folderQueries = useQueries({
    queries: expandedIds.map((id) => treeChildrenQueryOptions(projectId, module, id)),
  });
  const moveNode = useMoveNode(module);

  // Wave B-3 -- see the comment where these are used (below `data`) for
  // why <TreeView> needs a `key` that changes exactly when a node
  // disappears from `data`.
  const previousTreeIdsRef = useRef<Set<string> | null>(null);
  const treeResetKeyRef = useRef(0);

  // Wave B-3/B-4 (PRODUCT_GAP_REGISTER.md A1/B1) -- delete is its own RBAC
  // action (`authorize('delete')`, not `'write'` -- every backend delete
  // route is mounted on it, see the dispatch's "VERIFIED" section), so it
  // is gated on can('delete') here, independently of can('write'). Clone
  // is gated on can('write') (it creates, it doesn't delete) AND on the
  // module actually having a create flow to clone into -- the exact same
  // DRAFT_CAPABLE_MODULES set SourcePanel.tsx's own "New ..." button
  // already uses, so "can this module be cloned" can never drift from
  // "can this module be created" (module 4's executions are created FROM
  // a plan, never from a blank/cloned draft; module 6 has no detail
  // component at all yet).
  const { can } = usePermissions();
  // Releases (module 6) are deleted from ReleaseDetail; useDeleteEntity has
  // no module-6 branch, so a tree Delete on a release could only throw.
  const canDelete = can('delete') && module !== 6;
  const canClone = can('write') && DRAFT_CAPABLE_MODULES.has(module);
  const deleteEntity = useDeleteEntity(module);
  const cloneEntity = useCloneEntity(module);

  // WP-077b -- the root itself is a valid drop target (spec: "folders ...
  // and the tree root"), but it must NOT be the whole tree's DOM subtree
  // (a drop anywhere on a row would then bubble up here too, silently
  // reinterpreting "dropped on a leaf" as "move to root" -- exactly the
  // invalid target the spec rules out). Instead this connects to a small
  // dedicated strip rendered below <TreeView> (JSX below), so it only
  // fires for a drop released on empty space beneath every row.
  const [{ isOverRoot, canDropAtRoot, isDragging }, rootDropRef] = useDrop<
    DragPayload,
    void,
    { isOverRoot: boolean; canDropAtRoot: boolean; isDragging: boolean }
  >(
    () => ({
      accept: ENTITY_DRAG_TYPE,
      canDrop: (dragged) => canDropOnRoot(dragged),
      // `drop` re-checks canDropOnRoot itself -- see EntityTreeNode.tsx's
      // matching comment on why this isn't left to the caller alone.
      drop: (dragged, monitor) => {
        if (monitor.didDrop()) return;
        if (!canDropOnRoot(dragged)) return;
        moveNode.mutate(buildMoveVars(dragged, '0'));
      },
      collect: (monitor) => ({
        isOverRoot: monitor.isOver(),
        canDropAtRoot: monitor.canDrop(),
        isDragging: monitor.getItem() !== null,
      }),
    }),
    [moveNode],
  );

  if (rootQuery.isLoading) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 2 }}>
        <CircularProgress size={16} />
        <Typography variant="body2" color="text.secondary">Loading…</Typography>
      </Box>
    );
  }

  if (rootQuery.isError) {
    return (
      <Box role="alert" sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Typography variant="body2">Could not load the tree.</Typography>
        <Button size="small" variant="outlined" onClick={() => rootQuery.refetch()} sx={{ alignSelf: 'flex-start' }}>
          Retry
        </Button>
      </Box>
    );
  }

  const failedFolderIndex = folderQueries.findIndex((q) => q.isError);
  const folderChildrenById: Record<string, TreeNode[]> = {};
  expandedIds.forEach((id, i) => {
    folderChildrenById[id] = folderQueries[i]?.data ?? [];
  });

  const data = buildTreeData(rootQuery.data ?? [], expandedIds, folderChildrenById);

  // Wave B-3 (delete an entity) -- react-accessible-treeview's own
  // `useTree` hook re-derives its internal selectedIds Set from this
  // CONTROLLED prop on every render, and (independently of any click) can
  // re-invoke `onSelect` for whatever is in that set at mount/update time.
  // Before delete existed, `selection` could only ever name a node that
  // genuinely still exists (nothing removed rows from the tree). Now that
  // a row CAN disappear out from under a stale `selection` (the deleted
  // entity's own id, still sitting in the store until something else
  // overwrites it), passing it straight through crashed the library with
  // "Node with id=<X> doesn't exist in the tree" the first time a
  // just-deleted, still-"selected" row's id got looked up against the
  // POST-delete `data` array (confirmed live via this WP's own required
  // browser verification -- not reproducible in the mocked-API unit
  // suites, which never model a real deleted-while-selected node). This
  // is deliberately computed here, not fixed by clearing the store's
  // `selection` on delete: `data` only ever reflects EXPANDED folders'
  // children, so a selected node can legitimately be temporarily absent
  // from `data` too (its parent folder collapsed) without having been
  // deleted -- filtering the prop we actually hand the library is correct
  // in both cases, whereas clearing the store's own selection would lose
  // it across a collapse/re-expand.
  const selectedIds = selection && data.some((n) => n.id === selection) ? [selection] : [];

  // Wave B-3 (delete an entity) -- the `selectedIds` filter above (and an
  // equivalent one would be needed for `expandedIds`) only covers state
  // OUR OWN code feeds the library through a CONTROLLED prop. It does not
  // cover react-accessible-treeview's OWN internal, uncontrolled
  // "tabbableId" (its roving-tabindex bookkeeping, set by clicks/keyboard
  // nav, with no prop of ours to override it): once ANY node becomes the
  // tabbable one, the library keeps that id in its own useReducer state
  // until something else changes it, INDEPENDENT of `selectedIds`/
  // `expandedIds`. If that exact node is later removed from `data`
  // (delete, or a move that carries it into a currently-collapsed
  // folder), the library's own update effect looks up the stale
  // tabbableId against the new `data` and throws "Node with id=<X>
  // doesn't exist in the tree" -- confirmed live via this WP's required
  // browser verification (not reproducible in the mocked-API unit
  // suites, which never drive a real click that lets the library's own
  // internal state track a node this way before removing it).
  //
  // There is no prop to fix this with -- so `<TreeView>` is remounted
  // FROM SCRATCH (via `key`) on exactly the renders where `data` loses an
  // id it had a moment ago. A fresh mount re-derives tabbableId from the
  // CURRENT data (its own default is the new data's first child), which
  // is guaranteed to still exist. This must happen SYNCHRONOUSLY during
  // render, not in a useEffect here: <TreeView> is a CHILD of this
  // component, so its own passive effects (the ones that crash) flush
  // BEFORE any effect declared in this parent -- a key change decided a
  // tick later would already be too late. Comparing against a ref
  // mutated inline during render (not in an effect) is the documented
  // "adjust state during rendering" escape hatch for exactly this
  // "derive a value from how props changed since last render" need
  // (https://react.dev/reference/react/useState#storing-information-from-previous-renders)
  // -- safe here because this app runs outside StrictMode (confirmed:
  // src/index.tsx never wraps in it) and without concurrent-rendering
  // features that would ever discard/retry this render.
  const currentIds = new Set(data.map((n) => String(n.id)));
  if (previousTreeIdsRef.current && Array.from(previousTreeIdsRef.current).some((id) => !currentIds.has(id))) {
    treeResetKeyRef.current += 1;
  }
  previousTreeIdsRef.current = currentIds;

  // WP-077b -- the "Move to..." keyboard alternative's candidate list.
  // Deliberately scoped to folders CURRENTLY KNOWN to `data` (the root's
  // own folders, plus any folder nested under an already-expanded one) --
  // not a separate full-tree fetch, so this stays "computed fresh from
  // the same query-driven array" rather than introducing a second source
  // of truth for the tree's shape. A folder a user hasn't expanded yet
  // simply isn't offered as a destination until it is (or its ancestor
  // chain is); this is a real scope limit, not a bug -- see the WP report.
  const folderOptions = data
    .filter((n) => n.id !== ROOT_NODE_ID && n.isBranch)
    .map((n) => ({ id: String(n.id), name: n.name }));

  const handleSelect = ({ element, isBranch, isSelected }: ITreeViewOnSelectProps): void => {
    if (element.id === ROOT_NODE_ID) return;
    // WP-F21d -- act only on the node being SELECTED.
    //
    // TreeView fires onSelect for the node being DESELECTED too, which is
    // why its payload carries `isSelected` at all. Without this guard,
    // clicking a second entity produced two calls in a row --
    //   openTab 1:TC-695  (the click)
    //   openTab 1:TC-1824 (the deselection of the previous node)
    // -- and the second reset activeTabKey to the entity the user had just
    // navigated away from. The app snapped straight back to the first
    // ticket, with no navigation to show for it, which is what the owner
    // reported as the screen flipping between two tickets.
    //
    // handleExpand immediately below already learned this for expansion
    // ("TreeView calls onExpand for both expand AND collapse actions") and
    // guards it. Selection was missed.
    if (!isSelected) return;
    const id = String(element.id);
    setSelection(module, id);
    if (!isBranch) {
      const title = element.name;
      openTab({ module, entityId: id, title });
      if (onOpen) {
        const metadata = element.metadata as EntityTreeNodeMetadata | undefined;
        onOpen({ id, parent: String(element.parent ?? '0'), droppable: false, text: title, status: metadata?.status });
      }
    }
  };

  const handleExpand = ({ element }: { element: INode<EntityTreeNodeMetadata> }): void => {
    if (element.id === ROOT_NODE_ID) return;
    const id = String(element.id);
    const isCurrentlyExpanded = expandedIds.includes(id);
    // TreeView calls onExpand for both expand AND collapse actions; only
    // toggle the store when the library's own notion of "expanded" and
    // ours have actually diverged, so this stays purely reactive to user
    // interaction rather than re-toggling on every render.
    const nodeIsBranch = data.find((n) => n.id === element.id)?.isBranch;
    if (!nodeIsBranch) return;
    // react-accessible-treeview's onExpand fires with the node's NEW
    // expanded state already applied internally; compare against the
    // store's view and toggle once to reconcile.
    const wasExpanded = isCurrentlyExpanded;
    if (!wasExpanded) {
      toggleExpanded(module, id);
    }
  };

  const handleCollapse = ({ element }: { element: INode<EntityTreeNodeMetadata> }): void => {
    if (element.id === ROOT_NODE_ID) return;
    const id = String(element.id);
    if (expandedIds.includes(id)) {
      toggleExpanded(module, id);
    }
  };

  return (
    <Box
      sx={{
        // react-accessible-treeview renders plain <ul>/<li>; without this the
        // browser's default list bullets and indent show on every row.
        '& ul': { listStyle: 'none', m: 0, p: 0 },
        pt: 0.5,
      }}
    >
      {failedFolderIndex !== -1 && (
        <Box role="alert" sx={{ p: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
          <Typography variant="body2">Some folders failed to load.</Typography>
          <Button
            size="small"
            variant="text"
            onClick={() => folderQueries.forEach((q) => q.isError && q.refetch())}
          >
            Retry
          </Button>
        </Box>
      )}
      <TreeView
        key={treeResetKeyRef.current}
        data={data}
        aria-label="Entity tree"
        selectedIds={selectedIds}
        expandedIds={expandedIds}
        onSelect={handleSelect}
        onExpand={(props) => {
          if (props.isExpanded) {
            handleExpand(props as unknown as { element: INode<EntityTreeNodeMetadata> });
          } else {
            handleCollapse(props as unknown as { element: INode<EntityTreeNodeMetadata> });
          }
        }}
        nodeRenderer={(props) => (
          <EntityTreeNode
            {...props}
            module={module}
            onMove={moveNode.mutate}
            folderOptions={folderOptions}
            canDelete={canDelete}
            canClone={canClone}
            onDelete={(vars) => deleteEntity.mutateAsync(vars)}
            onClone={(id) => cloneEntity.mutateAsync(id)}
          />
        )}
      />
      {/* WP-077b -- pointer-only root drop strip (see the useDrop hook
          above for why this is its own element rather than wrapping the
          whole tree). The keyboard-reachable equivalent is each movable
          node's own "Move to... > Root" menu item (EntityTreeNode.tsx),
          which is what satisfies WCAG 2.2 SC 2.5.7 here -- this strip
          itself is not required to be, and is not, keyboard-operable.
          Shown only while an entity is being dragged: at rest it was a
          permanent dashed box reading "Drop here" with nothing to drop.
          Kept mounted (display:none) so its drop target stays connected. */}
      <Box
        ref={rootDropRef}
        data-testid="tree-root-drop-zone"
        sx={{
          display: isDragging ? 'block' : 'none',
          m: 1,
          p: 1,
          borderRadius: 1,
          border: '1px dashed',
          borderColor: isOverRoot && canDropAtRoot ? 'primary.main' : 'divider',
          bgcolor: isOverRoot && canDropAtRoot ? 'action.hover' : 'transparent',
          textAlign: 'center',
        }}
      >
        <Typography variant="caption" color="text.secondary">
          Drop here to move to Root
        </Typography>
      </Box>
    </Box>
  );
}
