import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkbenchStoreProvider } from '../../WorkbenchStoreProvider';
import EntityTree from '../EntityTree';
import { useTreeChildren, treeChildrenQueryOptions, TreeNode } from '../../../Hooks/queries/useTreeChildren';
import { useMoveNode } from '../../../Hooks/mutations/useMoveNode';

// WP-077b -- unlike EntityTree.dnd.test.tsx (which mocks 'react-dnd' to
// drive the drop/canDrop handler contract directly), this file uses the
// REAL react-dnd + a real HTML5Backend, wrapped in the SAME <DndProvider>
// pattern App.tsx uses (a fresh one here, since App.tsx's is not
// reachable from a component-only render). This proves, at the DOM level,
// that a non-movable leaf is not merely logically blocked (canDrag) but
// never gets a `draggable="true"` attribute or a dragstart listener wired
// up in the first place -- i.e. there is no way for a mouse user to even
// begin dragging it. Full pointer drag-and-drop (dragstart -> dragover ->
// drop) is NOT simulated here: jsdom's DataTransfer/drag event support is
// not faithful enough to prove anything beyond this attribute-level check
// (see the WP brief) -- that path is covered in the browser check instead.
jest.mock('../../../Hooks/queries/useTreeChildren');
jest.mock('../../../Hooks/mutations/useMoveNode');

const FIXTURES: Record<string, TreeNode[]> = {
  '0': [
    { id: '8', parent: '0', droppable: true, text: 'Auth' },
    { id: 'TC-104', parent: '0', droppable: false, text: 'TC-104' },
  ],
  '8': [
    { id: 'TC-200', parent: '8', droppable: false, text: 'TC-200' },
  ],
};

function mockChildrenFor(parentId: string | number): TreeNode[] {
  return FIXTURES[String(parentId)] ?? [];
}

beforeEach(() => {
  jest.clearAllMocks();
  (useTreeChildren as jest.Mock).mockImplementation((_module: unknown, parentId: string | number) => ({
    data: mockChildrenFor(parentId),
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }));
  (treeChildrenQueryOptions as jest.Mock).mockImplementation(
    (_projectId: number, _module: unknown, parentId: string | number) => ({
      queryKey: ['dnd-dom', parentId],
      queryFn: () => Promise.resolve(mockChildrenFor(parentId)),
    }),
  );
  (useMoveNode as jest.Mock).mockReturnValue({ mutate: jest.fn(), isLoading: false });
});

function renderTree(module: number) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <DndProvider backend={HTML5Backend}>
      <QueryClientProvider client={client}>
        <WorkbenchStoreProvider projectId={1}>
          <EntityTree module={module as 1} />
        </WorkbenchStoreProvider>
      </QueryClientProvider>
    </DndProvider>,
  );
}

/* eslint-disable testing-library/no-node-access -- `.closest('[draggable]')`
   is load-bearing here, not incidental DOM traversal: react-accessible-
   treeview puts role="treeitem" on the LEAF row directly (where it
   coincides with EntityTreeNode's own <Box>, the element react-dnd's
   connector sets `draggable` on) but on the outer <li> wrapper for a
   BRANCH row (one level above EntityTreeNode's <Box>) -- confirmed by
   reading react-accessible-treeview's source (see EntityTree.tsx's header
   comment). There is no Testing Library query for "the nearest ancestor
   carrying a given DOM attribute", and `draggable` is exactly the
   attribute under test, so closest() is the only way to find the actual
   connected element for both node shapes uniformly. */
describe('EntityTree drag DOM wiring (real react-dnd + HTML5Backend)', () => {
  it('a module-1 leaf is a real HTML5 drag source (draggable="true")', async () => {
    renderTree(1);
    const label = await screen.findByText('TC-104');
    expect(label.closest('[draggable]')).toHaveAttribute('draggable', 'true');
  });

  it('a module-3 leaf is NOT a drag source at all (no draggable attribute anywhere in its row)', async () => {
    renderTree(3);
    const label = await screen.findByText('TC-104');
    expect(label.closest('[draggable]')).toBeNull();
  });

  // Folders exist only in modules 1 and 2 (FOLDER_MODULES); module 2 here
  // proves a folder drags even where leaves follow a different module's rules.
  it('a folder is a real drag source in a folder-capable module', async () => {
    renderTree(2);
    const label = await screen.findByText('Auth');
    expect(label.closest('[draggable]')).toHaveAttribute('draggable', 'true');
  });
});

// Source-panel redesign (2026-11-06) -- the "Drop here to move to Root"
// strip used to sit under the tree permanently, a dashed box inviting a drop
// with nothing being dragged. It now appears only for the length of a drag.
describe('EntityTree root drop zone visibility (real react-dnd + HTML5Backend)', () => {
  const dataTransfer = { setData: () => {}, setDragImage: () => {}, getData: () => '', types: [], effectAllowed: '', dropEffect: '' };

  it('is hidden at rest and shown only while an entity is being dragged', async () => {
    renderTree(1);
    const label = await screen.findByText('TC-104');
    const zone = screen.getByTestId('tree-root-drop-zone');
    expect(zone).not.toBeVisible();

    const row = label.closest('[draggable]') as HTMLElement;
    fireEvent.dragStart(row, { dataTransfer });
    await waitFor(() => expect(zone).toBeVisible());
    expect(zone).toHaveTextContent('Drop here to move to Root');

    fireEvent.dragEnd(row, { dataTransfer });
    await waitFor(() => expect(zone).not.toBeVisible());
  });

  it('renders rows without list bullets', async () => {
    renderTree(1);
    await screen.findByText('TC-104');
    screen.getAllByRole('treeitem').forEach((item) => {
      const list = item.closest('ul') as HTMLElement;
      expect(getComputedStyle(list).listStyle).toMatch(/none/);
    });
  });
});
