/* eslint-disable testing-library/no-node-access -- `qk.children(...)` is
   Hooks/queryKeys.ts's key-builder function, not DOM node traversal;
   eslint-plugin-testing-library's no-node-access rule pattern-matches on
   the property name alone and false-positives here (same reasoning as
   Hooks/__tests__/useTreeChildren.test.tsx). */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkbenchStoreProvider, useWorkbench } from '../WorkbenchStoreProvider';
import { qk } from '../../Hooks/queryKeys';
import { usePermissions } from '../../Hooks/usePermissions';
import AiDuplicateAuditToolbar from '../AiDuplicateAuditToolbar';

// WP-074e Part 1b -- Components/AI/AiDuplicateAuditPanel.tsx (WP-052) was
// mounted from Pages/testcases.tsx behind a toolbar button; deleting that
// page in WP-074 made it unreachable (GR-4). This proves the workbench
// toolbar action makes it reachable again for module 1, gated on 'write'
// like the legacy page was, and that parentId is derived from whatever is
// currently selected in the tree exactly like the legacy page derived it
// (a folder's own id; a leaf's parent folder). Since the source-panel
// redesign (2026-11-06) the trigger is a "More actions" menu item
// (SourcePanel.test.tsx covers it); this component is only the panel host.
jest.mock('../../Hooks/usePermissions', () => ({
  __esModule: true,
  usePermissions: jest.fn(),
  default: jest.fn(),
}));
const mockUsePermissions = usePermissions as unknown as jest.Mock;

jest.mock('../../Components/AI/AiDuplicateAuditPanel', () => ({
  __esModule: true,
  AiDuplicateAuditPanel: ({ open, parentId, moduleLabel }: { open: boolean; parentId?: number; moduleLabel?: string }) =>
    open ? (
      <div data-testid="audit-panel">
        open parentId={String(parentId)} moduleLabel={String(moduleLabel)}
      </div>
    ) : null,
}));

function renderToolbar(open: boolean, seed?: (client: QueryClient, setSelection: (id: string | null) => void, toggleExpanded: (id: string) => void) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  function Harness() {
    const setSelection = useWorkbench((s) => s.setSelection);
    const toggleExpanded = useWorkbench((s) => s.toggleExpanded);
    React.useEffect(() => {
      seed?.(client, (id) => setSelection(1, id), (id) => toggleExpanded(1, id));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <AiDuplicateAuditToolbar open={open} onClose={jest.fn()} />;
  }

  return render(
    <QueryClientProvider client={client}>
      <WorkbenchStoreProvider projectId={1}>
        <Harness />
      </WorkbenchStoreProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  localStorage.clear();
});

describe('AiDuplicateAuditToolbar', () => {
  it('renders no panel while closed', () => {
    mockUsePermissions.mockReturnValue({ can: () => true });
    renderToolbar(false);
    expect(screen.queryByTestId('audit-panel')).not.toBeInTheDocument();
  });

  it('renders nothing for a viewer without write permission, even if opened', () => {
    mockUsePermissions.mockReturnValue({ can: () => false });
    const { container } = renderToolbar(true);
    expect(container).toBeEmptyDOMElement();
  });

  it('scopes the panel to the whole project when nothing is selected', () => {
    mockUsePermissions.mockReturnValue({ can: () => true });
    renderToolbar(true);
    expect(screen.getByTestId('audit-panel')).toHaveTextContent('parentId=undefined');
  });

  it('derives parentId from a selected folder node as its own id', () => {
    mockUsePermissions.mockReturnValue({ can: () => true });
    renderToolbar(true, (client, setSelection) => {
      client.setQueryData(qk.children(1, 1, '0'), [
        { id: '8', parent: '0', droppable: true, text: 'Auth' },
      ]);
      setSelection('8');
    });
    expect(screen.getByTestId('audit-panel')).toHaveTextContent('parentId=8');
    expect(screen.getByTestId('audit-panel')).toHaveTextContent('moduleLabel=Auth');
  });

  it("derives parentId from a selected leaf test case's parent folder", () => {
    mockUsePermissions.mockReturnValue({ can: () => true });
    renderToolbar(true, (client, setSelection, toggleExpanded) => {
      client.setQueryData(qk.children(1, 1, '0'), [
        { id: '8', parent: '0', droppable: true, text: 'Auth' },
      ]);
      client.setQueryData(qk.children(1, 1, '8'), [
        { id: 'TC-104', parent: '8', droppable: false, text: 'TC-104' },
      ]);
      toggleExpanded('8');
      setSelection('TC-104');
    });
    const panel = screen.getByTestId('audit-panel');
    expect(panel).toHaveTextContent('parentId=8');
    expect(panel).toHaveTextContent('moduleLabel=undefined');
  });
});
