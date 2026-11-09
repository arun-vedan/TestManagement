import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import Workbench from '../Workbench';
import { useTreeChildren, TreeNode } from '../../Hooks/queries/useTreeChildren';
import { getFields, getTcList, updateTestCase, getComments } from '../../api/apiCalls';

// WP-074 Step 6 -- end-to-end proof (through the real shell, not a
// component in isolation) that opening a node from the tree opens a tab
// AND the detail region renders that entity via the real TestCaseDetail.
// This is the scenario Workbench.test.tsx's mocked-tree tests deliberately
// do NOT cover (they mock useTreeChildren with empty data and never
// interact with a node), and EntityTree.test.tsx proves the tab opens but
// never renders a Workbench shell around it to check the detail region.
jest.mock('../../Hooks/queries/useTreeChildren');
jest.mock('../../api/apiCalls', () => ({
  getFields: jest.fn(),
  getTcList: jest.fn(),
  updateTestCase: jest.fn(),
  getComments: jest.fn(),
}));
jest.mock('../../keycloak', () => ({
  __esModule: true,
  default: {
    tokenParsed: { sub: 'user-abc', preferred_username: 'alice', name: 'Alice' },
    authenticated: true,
  },
}));

const mockGetFields = getFields as jest.Mock;
const mockGetTcList = getTcList as jest.Mock;
const mockUpdateTestCase = updateTestCase as jest.Mock;
const mockGetComments = getComments as jest.Mock;

const ROUTE_PATH = '/projects/:projectId/workbench/:module/:entityId?';

const TREE_FIXTURES: Record<string, TreeNode[]> = {
  '0': [
    { id: 'TC-104', parent: '0', droppable: false, text: 'TC-104', status: 'pass' },
    { id: 'TC-205', parent: '0', droppable: false, text: 'TC-205', status: 'draft' },
  ],
};

function tcRecord(id: string) {
  return { _id: `mongo-${id}`, TestCaseId: id, TestCaseSummary: `Summary for ${id}`, TestSteps: [] };
}

// WP-077b -- see Workbench.test.tsx's matching comment: EntityTree's nodes
// now need a <DndProvider> ancestor.
function renderWorkbenchAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <DndProvider backend={HTML5Backend}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path={ROUTE_PATH} element={<Workbench />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </DndProvider>,
  );
}

describe('Workbench integration -- opening a tree node', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    (useTreeChildren as jest.Mock).mockImplementation((_module: unknown, parentId: string | number) => ({
      data: TREE_FIXTURES[String(parentId)] ?? [],
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    }));
    mockGetFields.mockResolvedValue([]);
    mockGetTcList.mockImplementation((query: string) => {
      const id = query.replace('TestCaseId=', '');
      return Promise.resolve([tcRecord(id)]);
    });
    mockUpdateTestCase.mockResolvedValue({ success: true });
    mockGetComments.mockResolvedValue([]);
  });

  it('opens a tab and renders the real TestCaseDetail for the clicked leaf', async () => {
    renderWorkbenchAt('/projects/1/workbench/testcases');

    await screen.findByRole('tree');
    const leaf = screen.getByRole('treeitem', { name: /TC-104/ });
    await userEvent.click(leaf);

    // Tab strip shows the newly opened tab.
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /TC-104/ })).toBeInTheDocument();
    });

    // Detail region renders the REAL TestCaseDetail for TC-104, not a
    // placeholder -- DetailHeader shows the fetched TestCaseId + summary.
    await waitFor(() => {
      expect(screen.getByTestId('workbench-detail')).toHaveTextContent('TC-104');
    });
    expect(screen.getByTestId('workbench-detail')).toHaveTextContent('Summary for TC-104');
    expect(mockGetTcList).toHaveBeenCalledWith('TestCaseId=TC-104');
  });

  // The strip used to reserve 40px plus a divider with no tabs open, which
  // read as a dead band between the app bar and the workbench (owner report,
  // 2026-11-06). It stays MOUNTED either way -- Workbench.test.tsx asserts its
  // identity survives a module switch -- it just takes no space while empty.
  it('the tab strip takes no space until a tab is open', async () => {
    renderWorkbenchAt('/projects/1/workbench/testcases');

    const strip = screen.getByTestId('workbench-tab-strip');
    // jsdom does no layout, so assert what produces height instead: no
    // min-height, no divider, and NOTHING inside (TabStrip used to render
    // its own 40px spacer here, which kept the gap even at min-height 0).
    expect(strip).toHaveStyle({ minHeight: '0', borderBottomWidth: '0px' });
    expect(strip).toBeEmptyDOMElement();

    await screen.findByRole('tree');
    await userEvent.click(screen.getByRole('treeitem', { name: /TC-104/ }));
    await screen.findByRole('tab', { name: /TC-104/ });

    expect(strip).toHaveStyle({ minHeight: '40px', borderBottomWidth: '1px' });
  });

  it('opening a second entity keeps both tabs and switches the detail region', async () => {
    renderWorkbenchAt('/projects/1/workbench/testcases');

    await screen.findByRole('tree');
    await userEvent.click(screen.getByRole('treeitem', { name: /TC-104/ }));
    await waitFor(() => expect(screen.getByTestId('workbench-detail')).toHaveTextContent('TC-104'));

    await userEvent.click(screen.getByRole('treeitem', { name: /TC-205/ }));

    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /TC-104/ })).toBeInTheDocument();
    });
    expect(screen.getByRole('tab', { name: /TC-205/ })).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId('workbench-detail')).toHaveTextContent('TC-205');
    });
    expect(screen.getByTestId('workbench-detail')).not.toHaveTextContent('Summary for TC-104');
  });
});
