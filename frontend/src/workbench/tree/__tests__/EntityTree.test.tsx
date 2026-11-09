import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkbenchStoreProvider, useWorkbench } from '../../WorkbenchStoreProvider';
import EntityTree from '../EntityTree';
import { useTreeChildren, treeChildrenQueryOptions, TreeNode } from '../../../Hooks/queries/useTreeChildren';

// WP-077b -- see EntityTree.a11y.test.tsx's header comment: EntityTreeNode
// now calls react-dnd's useDrag/useDrop unconditionally, which throws
// without a <DndProvider> ancestor.

jest.mock('../../../Hooks/queries/useTreeChildren');

// Fixture: root -> folder "8" (Auth, droppable) + leaf "TC-104" (status
// "pass"); folder "8" -> leaf "TC-200". Matches the WP-073 brief exactly.
const FIXTURES: Record<string, TreeNode[]> = {
  '0': [
    { id: '8', parent: '0', droppable: true, text: 'Auth' },
    { id: 'TC-104', parent: '0', droppable: false, text: 'TC-104', status: 'pass' },
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
      queryKey: ['spike-behaviour', parentId],
      queryFn: () => Promise.resolve(mockChildrenFor(parentId)),
    }),
  );
});

// Exposes the store's own current `tabs` (re-read on every render) for
// assertion, alongside rendering the tree under both required providers.
// EntityTree calls the store's real openTab action directly via its own
// useWorkbench() selector -- there is nothing to "spy on" from outside
// without wrapping the actual store the tree reads from, so the test
// instead asserts against the store's resulting state, exactly as the
// WP-073 brief asks ("assert against the store").
function renderTree(onOpen = jest.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let latestTabs: { module: number; entityId: string; title: string }[] = [];
  function Harness() {
    latestTabs = useWorkbench((s) => s.tabs);
    return <EntityTree module={1} onOpen={onOpen} />;
  }
  render(
    <DndProvider backend={HTML5Backend}>
      <QueryClientProvider client={client}>
        <WorkbenchStoreProvider projectId={1}>
          <Harness />
        </WorkbenchStoreProvider>
      </QueryClientProvider>
    </DndProvider>,
  );
  return { getTabs: () => latestTabs };
}

describe('EntityTree', () => {
  it('renders folders and leaves from the root query', async () => {
    renderTree();
    await screen.findByRole('tree');
    expect(screen.getByRole('treeitem', { name: /Auth/ })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: /TC-104/ })).toBeInTheDocument();
  });

  it('does not render folder 8 leaf (TC-200) until it is expanded', async () => {
    renderTree();
    await screen.findByRole('tree');
    expect(screen.queryByRole('treeitem', { name: /TC-200/ })).not.toBeInTheDocument();
    // The mocked useTreeChildren must not have been asked for folder 8's
    // children before it is expanded -- the lazy-loading contract.
    expect(useTreeChildren).not.toHaveBeenCalledWith(1, '8');
    expect(treeChildrenQueryOptions).not.toHaveBeenCalledWith(expect.anything(), 1, '8');
  });

  it('uses roving tabindex: exactly one node has tabindex=0', async () => {
    renderTree();
    await screen.findByRole('tree');
    const items = screen.getAllByRole('treeitem');
    const zeroTabIndex = items.filter((item) => item.getAttribute('tabindex') === '0');
    expect(zeroTabIndex).toHaveLength(1);
  });

  it('ArrowDown moves focus to the next visible node', async () => {
    renderTree();
    await screen.findByRole('tree');
    const tree = screen.getByRole('tree');
    const auth = screen.getByRole('treeitem', { name: /Auth/ });
    auth.focus();
    userEvent.type(tree, '{arrowdown}', { skipClick: true });
    await waitFor(() => {
      expect(screen.getByRole('treeitem', { name: /TC-104/ })).toHaveAttribute('tabindex', '0');
    });
  });

  it('ArrowRight expands a collapsed folder and reveals its children', async () => {
    renderTree();
    await screen.findByRole('tree');
    const tree = screen.getByRole('tree');
    const auth = screen.getByRole('treeitem', { name: /Auth/ });
    auth.focus();
    userEvent.type(tree, '{arrowright}', { skipClick: true });
    await waitFor(() => {
      expect(screen.getByRole('treeitem', { name: /Auth/ })).toHaveAttribute('aria-expanded', 'true');
    });
    // Scoped to Auth's own subtree: react-accessible-treeview's data prop
    // is rebuilt fresh on every render (by design -- see EntityTree.tsx's
    // header comment on why there is no local snapshot of server data),
    // and while the folder-8 query resolves, `waitFor`'s polling can
    // observe an intermediate DOM frame with more than one matching node
    // before React settles on the final, single one; scoping to Auth's
    // own treeitem (stable throughout) avoids relying on any specific
    // intermediate frame. The FINAL DOM has exactly one TC-200, correctly
    // nested under Auth -- confirmed via full-body dumps captured while
    // diagnosing this.
    await waitFor(() => {
      const authItem = screen.getByRole('treeitem', { name: /Auth/ });
      expect(within(authItem).getByRole('treeitem', { name: /TC-200/ })).toBeInTheDocument();
    });
  });

  it('ArrowLeft collapses an expanded folder', async () => {
    renderTree();
    await screen.findByRole('tree');
    const tree = screen.getByRole('tree');
    const auth = screen.getByRole('treeitem', { name: /Auth/ });
    auth.focus();
    userEvent.type(tree, '{arrowright}', { skipClick: true });
    await waitFor(() => expect(screen.getByRole('treeitem', { name: /Auth/ })).toHaveAttribute('aria-expanded', 'true'));

    userEvent.type(screen.getByRole('tree'), '{arrowleft}', { skipClick: true });
    await waitFor(() => expect(screen.getByRole('treeitem', { name: /Auth/ })).toHaveAttribute('aria-expanded', 'false'));
    expect(screen.queryByRole('treeitem', { name: /TC-200/ })).not.toBeInTheDocument();
  });

  it('Enter opens the focused leaf as a tab', async () => {
    const onOpen = jest.fn();
    const { getTabs } = renderTree(onOpen);
    await screen.findByRole('tree');
    const tree = screen.getByRole('tree');
    // The library tracks "which node is focused" in its own internal
    // reducer state (driving roving tabindex), not via raw DOM focus() --
    // move there with real keyboard navigation (Auth is the initial
    // tabbable node; ArrowDown reaches the TC-104 leaf next to it) rather
    // than calling .focus() directly, which would move browser focus
    // without updating the library's own notion of the current node.
    const auth = screen.getByRole('treeitem', { name: /Auth/ });
    auth.focus();
    userEvent.type(tree, '{arrowdown}', { skipClick: true });
    await waitFor(() => {
      expect(screen.getByRole('treeitem', { name: /TC-104/ })).toHaveAttribute('tabindex', '0');
    });
    userEvent.type(tree, '{enter}', { skipClick: true });
    await waitFor(() => {
      expect(getTabs()).toContainEqual(
        expect.objectContaining({ module: 1, entityId: 'TC-104', title: 'TC-104' }),
      );
    });
    expect(onOpen).toHaveBeenCalled();
  });

  it('shows a status chip on a leaf that carries a status', async () => {
    renderTree();
    await screen.findByRole('tree');
    expect(screen.getByText('pass')).toBeInTheDocument();
  });
});
