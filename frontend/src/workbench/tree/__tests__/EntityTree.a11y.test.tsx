import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkbenchStoreProvider } from '../../WorkbenchStoreProvider';
import EntityTree from '../EntityTree';
import { useTreeChildren, treeChildrenQueryOptions, TreeNode } from '../../../Hooks/queries/useTreeChildren';

// WP-077b -- EntityTreeNode now calls react-dnd's useDrag/useDrop
// unconditionally (folders in every module, leaves in modules 1/2 --
// see workbench/tree/dnd/moveRules.ts), which throws without a
// <DndProvider> ancestor. Wrapped here with the same real HTML5Backend
// App.tsx will use once WP-078 removes @minoru/react-dnd-treeview; this
// suite exercises no actual drag, so any backend that satisfies the
// context requirement would do.

// WP-073 — EntityTree must never hit the network: useTreeChildren (and the
// query-options helper it shares with EntityTree's per-folder fan-out) are
// mocked so the tree renders deterministic fixture data instead.
jest.mock('../../../Hooks/queries/useTreeChildren');

// Fixture: root has folder "8" (Auth, droppable) and leaf "TC-104"; folder
// "8" has leaf "TC-200" -- the exact shape given in the WP-073 brief.
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
      queryKey: ['spike-a11y', parentId],
      queryFn: () => Promise.resolve(mockChildrenFor(parentId)),
    }),
  );
});

function renderTree() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <DndProvider backend={HTML5Backend}>
      <QueryClientProvider client={client}>
        <WorkbenchStoreProvider projectId={1}>
          <EntityTree module={1} onOpen={jest.fn()} />
        </WorkbenchStoreProvider>
      </QueryClientProvider>
    </DndProvider>,
  );
}

describe('EntityTree accessibility', () => {
  it('has no axe violations', async () => {
    const { container } = renderTree();
    await screen.findByRole('tree');
    expect(await axe(container)).toHaveNoViolations();
  });

  it('exposes a real tree structure', async () => {
    renderTree();
    await screen.findByRole('tree');
    expect(screen.getAllByRole('treeitem').length).toBeGreaterThan(0);
  });

  it('marks a collapsed expandable folder with aria-expanded=false', async () => {
    renderTree();
    await waitFor(() => {
      expect(screen.getByRole('treeitem', { name: /Auth/ })).toHaveAttribute('aria-expanded', 'false');
    });
  });
});
