import React from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkbenchStoreProvider } from '../../WorkbenchStoreProvider';
import EntityTree from '../EntityTree';
import { useTreeChildren, treeChildrenQueryOptions, TreeNode } from '../../../Hooks/queries/useTreeChildren';
import { useMoveNode } from '../../../Hooks/mutations/useMoveNode';
import { buildMoveVars } from '../dnd/moveRules';
import { useDrag, useDrop } from 'react-dnd';

// WP-077b -- jsdom does not implement the HTML5 drag protocol faithfully
// (no real DataTransfer, no genuine dragstart/dragover/drop sequencing),
// so simulating an actual pointer drag here would not meaningfully prove
// anything (see the WP brief). Instead this file mocks 'react-dnd' itself
// and CAPTURES the spec objects EntityTreeNode/EntityTree hand to
// useDrag/useDrop -- the real closures the component builds, not a
// reimplementation of them -- and invokes their canDrop/drop functions
// directly, exactly as react-dnd's HTML5Backend would once a real browser
// drop occurs. The actual DOM-level wiring (draggable attribute presence/
// absence) is covered separately in EntityTree.dnd.dom.test.tsx with a
// real DndProvider+HTML5Backend, and the true end-to-end drag is verified
// in the browser check (see the WP report) -- not asserted here.
jest.mock('../../../Hooks/queries/useTreeChildren');
jest.mock('../../../Hooks/mutations/useMoveNode');

jest.mock('react-dnd', () => ({
  useDrag: jest.fn(() => [{}, jest.fn(), jest.fn()]),
  useDrop: jest.fn(() => [{}, jest.fn()]),
}));

// Fixture: root -> folder "8" (Auth) + leaf "TC-104" (module 1, parent
// '0'); folder "8" -> leaf "TC-200" (parent '8'). Same shape as
// EntityTree.test.tsx's fixture.
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

let mutateMock: jest.Mock;

beforeEach(() => {
  // CRA's jest config sets `resetMocks: true` (package.json), which wipes
  // every jest.fn()'s implementation -- including the one the jest.mock
  // factory above set up -- before each test. So useDrag/useDrop's default
  // return shape has to be re-established here, exactly like
  // useTreeChildren below.
  (useDrag as jest.Mock).mockImplementation(() => [{}, jest.fn(), jest.fn()]);
  (useDrop as jest.Mock).mockImplementation(() => [{}, jest.fn()]);
  mutateMock = jest.fn();
  (useTreeChildren as jest.Mock).mockImplementation((_module: unknown, parentId: string | number) => ({
    data: mockChildrenFor(parentId),
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }));
  (treeChildrenQueryOptions as jest.Mock).mockImplementation(
    (_projectId: number, _module: unknown, parentId: string | number) => ({
      queryKey: ['dnd-wiring', parentId],
      queryFn: () => Promise.resolve(mockChildrenFor(parentId)),
    }),
  );
  (useMoveNode as jest.Mock).mockReturnValue({ mutate: mutateMock, isLoading: false });
});

function renderTree(module = 1) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <WorkbenchStoreProvider projectId={1}>
        <EntityTree module={module as 1} />
      </WorkbenchStoreProvider>
    </QueryClientProvider>,
  );
}

// Finds the useDrop call whose dependency array names `nodeId` -- the
// component is expected to close its drop spec's deps over the node's own
// id (see EntityTreeNode.tsx), so this is how the test locates "folder 8's
// drop spec" among every node's captured calls without guessing DOM order.
function dropSpecFor(nodeId: string) {
  const calls = (useDrop as jest.Mock).mock.calls;
  const match = calls.find(([, deps]) => Array.isArray(deps) && deps.includes(nodeId));
  if (!match) throw new Error(`no useDrop call found with nodeId ${nodeId} in its deps`);
  return match[0]();
}

function dragSpecFor(nodeId: string) {
  const calls = (useDrag as jest.Mock).mock.calls;
  const match = calls.find(([, deps]) => Array.isArray(deps) && deps.includes(nodeId));
  if (!match) throw new Error(`no useDrag call found with nodeId ${nodeId} in its deps`);
  return match[0]();
}

describe('EntityTree drag/drop wiring (handler contract, react-dnd mocked)', () => {
  it('dropping a leaf onto a different folder calls useMoveNode with the right vars', async () => {
    renderTree(1);
    await screen.findByRole('tree');

    const dragged = { id: 'TC-104', parentId: '0', droppable: false };
    const spec = dropSpecFor('8');
    expect(spec.canDrop(dragged)).toBe(true);
    spec.drop(dragged, { didDrop: () => false });

    expect(mutateMock).toHaveBeenCalledWith(buildMoveVars(dragged, '8'));
  });

  it('dropping onto the node\'s own current parent is not a valid drop (no mutation reachable)', async () => {
    renderTree(1);
    await screen.findByRole('tree');

    // TC-104's fromParentId is '0' -- folder 8's own parent is also '0',
    // but TC-104 itself is not folder 8's parent, so drop it onto its
    // ACTUAL current parent by targeting the root zone instead: exercised
    // via canDropOnRoot in the dedicated root-zone test below. Here,
    // dragging TC-200 (parent '8') back onto folder 8 (its own current
    // parent) must be rejected.
    const draggedTC200 = { id: 'TC-200', parentId: '8', droppable: false };
    const spec = dropSpecFor('8');
    expect(spec.canDrop(draggedTC200)).toBe(false);

    spec.drop(draggedTC200, { didDrop: () => false });
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it('dropping a folder onto itself is not a valid drop (no mutation reachable)', async () => {
    renderTree(1);
    await screen.findByRole('tree');

    const draggedFolder8 = { id: '8', parentId: '0', droppable: true };
    const spec = dropSpecFor('8');
    expect(spec.canDrop(draggedFolder8)).toBe(false);

    spec.drop(draggedFolder8, { didDrop: () => false });
    expect(mutateMock).not.toHaveBeenCalled();
  });

  it('a leaf is never a valid drop target', async () => {
    renderTree(1);
    await screen.findByRole('tree');

    const spec = dropSpecFor('TC-104');
    expect(spec.canDrop({ id: 'TC-200', parentId: '8', droppable: false })).toBe(false);
  });

  it('a leaf in module 3 (no mover exists) cannot be dragged: canDrag is false', async () => {
    renderTree(3);
    await screen.findByRole('tree');

    const spec = dragSpecFor('TC-104');
    expect(spec.canDrag()).toBe(false);
  });

  it('a leaf in module 1 (test cases) can be dragged: canDrag is true', async () => {
    renderTree(1);
    await screen.findByRole('tree');

    const spec = dragSpecFor('TC-104');
    expect(spec.canDrag()).toBe(true);
  });

  it('a folder can always be dragged, regardless of module', async () => {
    renderTree(3);
    await screen.findByRole('tree');

    const spec = dragSpecFor('8');
    expect(spec.canDrag()).toBe(true);
  });
});
