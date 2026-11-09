/* eslint-disable testing-library/no-node-access -- `qk.children(...)` is
   Hooks/queryKeys.ts's key-builder function, not DOM node traversal;
   eslint-plugin-testing-library's no-node-access rule pattern-matches on
   the property name alone and false-positives here (same reasoning as
   AiDuplicateAuditToolbar.test.tsx and TestCaseDetail.test.tsx). */
// Wave C-1 (Register A3) -- module-1-only "Import CSV". Since the source-panel
// redesign (2026-11-06) the trigger is a "More actions" menu item in
// SourcePanelHeader (whose gating SourcePanel.test.tsx covers) and this
// component is only the dialog host, opened via its `open` prop. Gated on usePermissions().can('write') the
// same way every other write-capable SourcePanel control is (CreateActions
// in SourcePanel.tsx, AiDuplicateAuditToolbar.tsx) -- import creates
// records, so a viewer must never see the entry point at all.
//
// CsvImportDialog itself is mocked here (its own test file
// Components/Import/__tests__/CsvImportDialog.test.tsx covers the actual
// import flow) -- this file's job is only: does it stay hidden from a
// viewer even if opened, and does its onImported wiring invalidate the SAME
// tree-children cache entries EntityTree reads from, across every folder
// (an imported row's parentId comes from the file, so it will not
// necessarily land under whatever is currently selected).
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import CsvImportToolbar from '../CsvImportToolbar';
import { usePermissions } from '../../Hooks/usePermissions';
import { qk } from '../../Hooks/queryKeys';

jest.mock('../../Hooks/usePermissions', () => ({
  __esModule: true,
  usePermissions: jest.fn(),
  default: jest.fn(),
}));
const mockUsePermissions = usePermissions as unknown as jest.Mock;

jest.mock('../../Components/Import/CsvImportDialog', () => ({
  __esModule: true,
  CsvImportDialog: ({ open, onImported }: { open: boolean; onImported: (n: number) => void }) =>
    open ? (
      <div data-testid="import-dialog">
        <button onClick={() => onImported(3)}>fake-import-success</button>
      </div>
    ) : null,
}));

function renderToolbar(open = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <CsvImportToolbar open={open} onClose={jest.fn()} />
    </QueryClientProvider>,
  );
  return { ...utils, client };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('<CsvImportToolbar>', () => {
  it('renders the dialog when opened by a user who can write', () => {
    mockUsePermissions.mockReturnValue({ can: () => true });
    renderToolbar();
    expect(screen.getByTestId('import-dialog')).toBeInTheDocument();
  });

  it('renders nothing for a viewer without write permission, even if opened', () => {
    mockUsePermissions.mockReturnValue({ can: () => false });
    const { container } = renderToolbar();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders no dialog while closed', () => {
    mockUsePermissions.mockReturnValue({ can: () => true });
    renderToolbar(false);
    expect(screen.queryByTestId('import-dialog')).not.toBeInTheDocument();
  });

  it('invalidates every module-1 children query (every folder, project-wide) when the dialog reports an import', () => {
    mockUsePermissions.mockReturnValue({ can: () => true });
    const { client } = renderToolbar();
    // Seed cache entries for two different folders the way EntityTree/
    // useTreeChildren actually populate them -- the imported rows' own
    // parentId comes from the file, so this cannot know in advance which
    // folder(s) got new children and must invalidate broadly for module 1.
    client.setQueryData(qk.children(1, 1, '0'), [{ id: 'TC-1' }]);
    client.setQueryData(qk.children(1, 1, '8'), [{ id: 'TC-2' }]);
    const spy = jest.spyOn(client, 'invalidateQueries');

    fireEvent.click(screen.getByText('fake-import-success'));

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['project', 1, 1, 'children'] }));
  });
});
