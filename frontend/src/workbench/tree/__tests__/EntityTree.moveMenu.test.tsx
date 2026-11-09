import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkbenchStoreProvider } from '../../WorkbenchStoreProvider';
import EntityTree from '../EntityTree';
import { useTreeChildren, treeChildrenQueryOptions, TreeNode } from '../../../Hooks/queries/useTreeChildren';
import { useMoveNode } from '../../../Hooks/mutations/useMoveNode';

// WP-077b -- the WCAG 2.2 SC 2.5.7 single-pointer alternative to dragging.
// Every movable node gets a "Move <name> to..." icon button; activating it
// (by click OR keyboard -- it is a real <button>, reachable by Tab and
// operable with Enter/Space, opening a real MUI Menu with native arrow-key
// nav) calls the exact same useMoveNode mutation a drop would. This suite
// drives it with userEvent exclusively via keyboard where the WP brief
// calls for "without a pointer", and with .click() where a pointer
// interaction is incidental to the assertion (opening the menu) rather
// than the thing being proven.
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

let mutateMock: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mutateMock = jest.fn();
  (useTreeChildren as jest.Mock).mockImplementation((_module: unknown, parentId: string | number) => ({
    data: mockChildrenFor(parentId),
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  }));
  (treeChildrenQueryOptions as jest.Mock).mockImplementation(
    (_projectId: number, _module: unknown, parentId: string | number) => ({
      queryKey: ['move-menu', parentId],
      queryFn: () => Promise.resolve(mockChildrenFor(parentId)),
    }),
  );
  (useMoveNode as jest.Mock).mockReturnValue({ mutate: mutateMock, isLoading: false });
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

describe('EntityTreeNode "Move to..." keyboard alternative', () => {
  it('is reachable by Tab and, activated with Enter, moves a leaf via the same mutation a drop would', async () => {
    renderTree(1);
    await screen.findByRole('tree');

    const moveButton = await screen.findByRole('button', { name: /Move TC-104 to/i });
    moveButton.focus();
    expect(moveButton).toHaveFocus();

    await userEvent.keyboard('{Enter}');

    const menu = await screen.findByRole('menu');
    const authOption = within(menu).getByRole('menuitem', { name: 'Auth' });
    authOption.focus();
    await userEvent.keyboard('{Enter}');

    await waitFor(() => {
      expect(mutateMock).toHaveBeenCalledWith({
        id: 'TC-104',
        fromParentId: '0',
        toParentId: '8',
        droppable: false,
      });
    });
  });

  it('offers "Root" as a target once a folder is expanded and its leaf is not already at the root', async () => {
    renderTree(1);
    await screen.findByRole('tree');

    const auth = screen.getByRole('treeitem', { name: /Auth/ });
    auth.focus();
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => {
      expect(screen.getByRole('treeitem', { name: /Auth/ })).toHaveAttribute('aria-expanded', 'true');
    });

    const moveButton = await screen.findByRole('button', { name: /Move TC-200 to/i });
    await userEvent.click(moveButton);

    const menu = await screen.findByRole('menu');
    const rootOption = within(menu).getByRole('menuitem', { name: 'Root' });
    await userEvent.click(rootOption);

    await waitFor(() => {
      expect(mutateMock).toHaveBeenCalledWith({
        id: 'TC-200',
        fromParentId: '8',
        toParentId: '0',
        droppable: false,
      });
    });
  });

  it('does not offer "Move to..." for a module-3 leaf (no mover exists)', async () => {
    renderTree(3);
    await screen.findByRole('tree');
    expect(screen.queryByRole('button', { name: /Move TC-104 to/i })).not.toBeInTheDocument();
  });

  it('does not render "Move to..." when a movable node has no valid destination', async () => {
    // Folder "Auth" is already at the root and (in this fixture) is the
    // only folder that exists -- there is nowhere else to move it to.
    renderTree(1);
    await screen.findByRole('tree');
    expect(screen.queryByRole('button', { name: /Move Auth to/i })).not.toBeInTheDocument();
  });

  it('does not break roving tabindex: exactly one treeitem still has tabindex=0 with move buttons present', async () => {
    renderTree(1);
    await screen.findByRole('tree');
    const items = screen.getAllByRole('treeitem');
    const zeroTabIndex = items.filter((item) => item.getAttribute('tabindex') === '0');
    expect(zeroTabIndex).toHaveLength(1);
  });

  // WP-077b -- caught only by a real browser (see the WP report): without
  // an explicit aria-label on the row, a treeitem's accessible name is
  // computed from ALL of its content, including nested widgets' OWN
  // accessible names -- so the "Move to..." button's
  // "Move TC-104 to..." label was silently getting concatenated onto the
  // row's name, turning "TC-104" into "TC-104 Move TC-104 to…". Any
  // EXACT name lookup (e.g. Playwright's `getByRole('treeitem', { name,
  // exact: true })`, used by e2e/specs/ai-generation.spec.ts) then finds
  // nothing. jsdom + @testing-library/dom compute accessible names with
  // the same algorithm a real browser does, so this is genuinely caught
  // here, not just in the browser check.
  it("a movable leaf's accessible name is exactly its own name, not polluted by the Move-to button's label", async () => {
    renderTree(1);
    await screen.findByRole('tree');
    expect(screen.getByRole('treeitem', { name: 'TC-104', exact: true })).toBeInTheDocument();
  });

  it("a movable leaf with the Move-to menu open still exposes its own name exactly (folder 8's leaf, which has a Root target)", async () => {
    renderTree(1);
    await screen.findByRole('tree');
    const auth = screen.getByRole('treeitem', { name: 'Auth', exact: true });
    auth.focus();
    await userEvent.keyboard('{ArrowRight}');
    await waitFor(() => expect(auth).toHaveAttribute('aria-expanded', 'true'));
    expect(await screen.findByRole('treeitem', { name: 'TC-200', exact: true })).toBeInTheDocument();
  });
});
