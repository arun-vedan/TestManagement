/* eslint-disable testing-library/no-node-access -- `qk.children(...)` is
   Hooks/queryKeys.ts's key-builder function, not DOM node traversal;
   eslint-plugin-testing-library's no-node-access rule pattern-matches on
   the property name alone and false-positives here (same reasoning as
   AiDuplicateAuditToolbar.test.tsx and Hooks/__tests__/useTreeChildren.test.tsx). */
import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkbenchStoreProvider, useWorkbench } from '../WorkbenchStoreProvider';
import { tabKey } from '../store/workbenchStore';
import { qk } from '../../Hooks/queryKeys';
import { usePermissions } from '../../Hooks/usePermissions';
import { createFolderApi } from '../../api/apiCalls';
import { createRelease } from '../../api/releaseApi';
import { listCaseTemplates } from '../../api/caseTemplateApi';
import { setCurrentProjectId, DEFAULT_PROJECT_ID } from '../../currentProject';
import { ModuleId } from '../modules';
import SourcePanel from '../SourcePanel';

// WP-166 follow-up -- AI entry points render only while AI is available
// (Components/AI/AiAvailable.tsx, its own suite covers the probe). Stubbed
// here as a switch so each test states which world it is in.
let mockAiState: 'available' | 'hidden' = 'available';
jest.mock('../../Components/AI/AiAvailable', () => ({
  AiAvailable: ({ children }: { children: React.ReactNode }) => (mockAiState === 'available' ? children : null),
  useAiAvailability: () => ({ state: mockAiState, message: null }),
}));
beforeEach(() => {
  mockAiState = 'available';
});


// WP-079 Part A -- "New Test Case"/"New folder" gating and API calls need
// a controllable role and a controllable current user, same pattern
// AiDuplicateAuditToolbar.test.tsx and RequirementDetail.test.tsx already
// use for the same two modules.
jest.mock('../../Hooks/usePermissions', () => ({
  __esModule: true,
  usePermissions: jest.fn(),
  default: jest.fn(),
}));
const mockUsePermissions = usePermissions as unknown as jest.Mock;

jest.mock('../../keycloak', () => ({
  __esModule: true,
  default: {
    tokenParsed: { sub: 'user-abc', preferred_username: 'alice', name: 'Alice' },
    authenticated: true,
  },
}));

jest.mock('../../api/apiCalls', () => ({
  createFolderApi: jest.fn(),
}));
const mockCreateFolderApi = createFolderApi as jest.Mock;

// WP-F18b Task 3 -- "New Release" (module-6-only, dialog-based, NOT the
// draft-tab flow the mocks above cover) calls createRelease directly. Real
// module mocked (not requireActual) same reason every other api/*.ts mock
// in this file is: isolates SourcePanel's own dispatch logic from the real
// network layer.
jest.mock('../../api/releaseApi', () => ({
  createRelease: jest.fn(),
}));
const mockCreateRelease = createRelease as jest.Mock;

// WP-F08 Task 2 -- "Start from template" (CaseTemplatePicker) opens
// alongside "New ...". listCaseTemplates is mocked here so opening the
// picker never fires an unmocked axios call; CaseTemplatePicker's own
// suite (Components/templates/__tests__/) covers its internal behaviour.
jest.mock('../../api/caseTemplateApi', () => ({
  listCaseTemplates: jest.fn(),
}));
const mockListCaseTemplates = listCaseTemplates as jest.Mock;

// WP-074 Step 6 -- SourcePanel now dispatches 'list' mode to the real
// <EntityList>, alongside the already-real 'tree' mode (<EntityTree>,
// WP-073). Both are mocked here to isolate SourcePanel's OWN dispatch
// logic (which component renders for which panelMode/moduleId
// combination) -- EntityTree and EntityList each have their own full
// test suites already.
jest.mock('../tree/EntityTree', () => ({
  __esModule: true,
  default: ({ module }: { module: number }) => <div data-testid="entity-tree">tree:{module}</div>,
}));
jest.mock('../list/EntityList', () => ({
  __esModule: true,
  default: ({ module }: { module: number }) => <div data-testid="entity-list">list:{module}</div>,
}));
// Wave B-2 -- 'search' is now a real panel mode (<EntitySearchPanel>,
// src/workbench/search/EntitySearchPanel.tsx), same treatment as tree/list
// above: mocked here so this file only asserts SourcePanel's OWN dispatch
// logic, not EntitySearchPanel's internal behaviour (covered by its own
// full suite, EntitySearchPanel.test.tsx).
jest.mock('../search/EntitySearchPanel', () => ({
  __esModule: true,
  default: ({ module }: { module: number }) => <div data-testid="entity-search">search:{module}</div>,
}));

function renderPanel(
  moduleId: 1 | 2 | 3 | 4 | 5 | 6 | null,
  mode: 'tree' | 'list' | 'search' = 'tree',
  opts: { client?: QueryClient; seed?: (client: QueryClient, setSelection: (id: string | null) => void) => void } = {},
) {
  const client = opts.client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let latestTabs: ReturnType<typeof useWorkbench<Array<{ key: string; module: number; entityId: string; title: string }>>> = [];
  function Harness() {
    const setPanelMode = useWorkbench((s) => s.setPanelMode);
    const setSelection = useWorkbench((s) => s.setSelection);
    latestTabs = useWorkbench((s) => s.tabs);
    React.useEffect(() => {
      setPanelMode(mode);
      opts.seed?.(client, (id) => setSelection((moduleId ?? 1) as ModuleId, id));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <SourcePanel moduleId={moduleId} />;
  }
  const view = render(
    <QueryClientProvider client={client}>
      <WorkbenchStoreProvider projectId={1}>
        <Harness />
      </WorkbenchStoreProvider>
    </QueryClientProvider>,
  );
  return { ...view, client, getTabs: () => latestTabs };
}

beforeEach(() => {
  jest.clearAllMocks();
  setCurrentProjectId(DEFAULT_PROJECT_ID);
  mockUsePermissions.mockReturnValue({ role: 'viewer', isLoading: false, isError: false, can: () => false });
  mockCreateFolderApi.mockResolvedValue('Success');
  mockListCaseTemplates.mockResolvedValue([]);
  mockCreateRelease.mockResolvedValue({ _id: 'release-mongo-9', releaseId: 'REL-9', name: 'Autumn Launch' });
});

describe('SourcePanel', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders the tree in tree mode for module 1', () => {
    renderPanel(1, 'tree');
    expect(screen.getByTestId('entity-tree')).toHaveTextContent('tree:1');
    expect(screen.queryByTestId('entity-list')).not.toBeInTheDocument();
  });

  it('renders the list in list mode for module 1', () => {
    renderPanel(1, 'list');
    expect(screen.getByTestId('entity-list')).toHaveTextContent('list:1');
    expect(screen.queryByTestId('entity-tree')).not.toBeInTheDocument();
  });

  // Wave B-2 -- 'search' now dispatches to the real <EntitySearchPanel>
  // (mocked above), same as 'tree'/'list' dispatch to their own real
  // components -- the literal "Search coming soon" placeholder is gone.
  it('renders the search panel in search mode', () => {
    renderPanel(1, 'search');
    expect(screen.getByTestId('entity-search')).toHaveTextContent('search:1');
    expect(screen.queryByTestId('entity-tree')).not.toBeInTheDocument();
    expect(screen.queryByTestId('entity-list')).not.toBeInTheDocument();
  });

  it('renders neither tree nor list for an unknown module (null moduleId)', () => {
    renderPanel(null, 'tree');
    expect(screen.queryByTestId('entity-tree')).not.toBeInTheDocument();
    renderPanel(null, 'list');
    expect(screen.queryByTestId('entity-list')).not.toBeInTheDocument();
  });
});

// WP-074d -- nothing in the app called setPanelMode before this, so list
// mode (and the pagination it depends on) was unreachable from the UI.
// This toggle is the only way a user can actually get there.
describe('SourcePanel — tree/list toggle', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('has an accessible group with accessible names for each option, defaulting to tree', () => {
    renderPanel(1, 'tree');
    expect(screen.getByRole('group', { name: /panel view/i })).toBeInTheDocument();
    const treeButton = screen.getByRole('button', { name: /^tree view$/i });
    const listButton = screen.getByRole('button', { name: /^list view$/i });
    const searchButton = screen.getByRole('button', { name: /^search view$/i });
    expect(treeButton).toBeInTheDocument();
    expect(listButton).toBeInTheDocument();
    expect(searchButton).toBeInTheDocument();
    expect(treeButton).toHaveAttribute('aria-pressed', 'true');
    expect(listButton).toHaveAttribute('aria-pressed', 'false');
    expect(searchButton).toHaveAttribute('aria-pressed', 'false');
  });

  it('clicking List switches panelMode and swaps the rendered view', async () => {
    renderPanel(1, 'tree');
    expect(screen.getByTestId('entity-tree')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^list view$/i }));

    expect(await screen.findByTestId('entity-list')).toHaveTextContent('list:1');
    expect(screen.queryByTestId('entity-tree')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^list view$/i })).toHaveAttribute('aria-pressed', 'true');
  });

  // Wave B-2 -- the toggle grew a third option once EntitySearchPanel made
  // 'search' a real, selectable mode instead of a dead-end placeholder.
  it('clicking Search switches panelMode and swaps the rendered view, and the store reflects it', async () => {
    renderPanel(1, 'tree');
    expect(screen.getByTestId('entity-tree')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^search view$/i }));

    // The rendered view swapping to <EntitySearchPanel> IS the proof this
    // persisted via the store: SourcePanel picks which panel to render
    // solely off the store's `panelMode` (see its dispatch below), so
    // there is no local component state that could produce this any other
    // way.
    expect(await screen.findByTestId('entity-search')).toHaveTextContent('search:1');
    expect(screen.queryByTestId('entity-tree')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^search view$/i })).toHaveAttribute('aria-pressed', 'true');
  });

  it('is keyboard reachable: tabbing to the toggle and pressing Enter activates it', async () => {
    renderPanel(1, 'tree');
    await userEvent.tab(); // focus moves into the toggle group's first button (Tree)
    expect(screen.getByRole('button', { name: /^tree view$/i })).toHaveFocus();

    await userEvent.tab(); // move to the List button
    expect(screen.getByRole('button', { name: /^list view$/i })).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    expect(await screen.findByTestId('entity-list')).toHaveTextContent('list:1');
  });

  it('is keyboard reachable: tabbing to Search and pressing Enter activates it', async () => {
    renderPanel(1, 'tree');
    await userEvent.tab(); // Tree
    await userEvent.tab(); // List
    await userEvent.tab(); // Search
    expect(screen.getByRole('button', { name: /^search view$/i })).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    expect(await screen.findByTestId('entity-search')).toHaveTextContent('search:1');
  });
});

// Source-panel redesign (2026-11-06) -- every create action now lives in
// the header's single "New" menu, and export/import/audit in "More actions".
// The menu runs the chosen action only after its exit transition (see
// SourcePanelHeader.tsx's ActionMenu), so results are awaited, not read
// synchronously after the click.
const asContributor = () =>
  mockUsePermissions.mockReturnValue({ role: 'contributor', isLoading: false, isError: false, can: (a: string) => a === 'write' });

async function openMenu(trigger: RegExp, menuName: string): Promise<HTMLElement> {
  await userEvent.click(screen.getByRole('button', { name: trigger }));
  return screen.findByRole('menu', { name: menuName });
}
const openCreateMenu = () => openMenu(/^new$/i, 'Create');
const openMoreMenu = () => openMenu(/^more actions$/i, 'More actions');

async function chooseCreate(item: RegExp): Promise<void> {
  const menu = await openCreateMenu();
  await userEvent.click(within(menu).getByRole('menuitem', { name: item }));
  await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
}

async function createMenuItemNames(): Promise<string[]> {
  const menu = await openCreateMenu();
  return within(menu).getAllByRole('menuitem').map((el) => el.textContent ?? '');
}

describe('SourcePanel — header', () => {
  it('names the module it is showing', () => {
    renderPanel(2, 'tree');
    expect(screen.getByRole('heading', { name: 'Requirements' })).toBeInTheDocument();
  });

  // Test Runs: an execution is created FROM a plan, never a blank draft,
  // and with no folders there is nothing left to create here.
  it('shows no "New" button for Test Runs, even with write permission', () => {
    asContributor();
    renderPanel(4, 'tree');
    expect(screen.queryByRole('button', { name: /^new$/i })).not.toBeInTheDocument();
  });

  it('shows no "New" button at all for a viewer (no write permission)', () => {
    renderPanel(1, 'tree');
    expect(screen.queryByRole('button', { name: /^new$/i })).not.toBeInTheDocument();
  });

  it.each([
    // Folders only in Test Cases and Requirements (owner decision 2026-11-06).
    [1, ['New Test Case', 'Start from template…', 'New folder']],
    [2, ['New Requirement', 'Start from template…', 'New folder']],
    [3, ['New Test Plan', 'Start from template…']],
    [5, ['New Defect', 'Start from template…']],
    // Releases: dialog-based create, no draft tab and no templates.
    [6, ['New Release']],
  ] as const)('module %i offers exactly %j under "New"', async (moduleId, expected) => {
    asContributor();
    renderPanel(moduleId, 'tree');
    expect(await createMenuItemNames()).toEqual(expected);
  });

  // Every real role has 'read' (permissions.ts's PERMISSION_MATRIX); export
  // is gated on it, so these two tests grant it explicitly.
  it('"More actions" offers export, import and the AI audit for test cases', async () => {
    mockUsePermissions.mockReturnValue({ role: 'contributor', isLoading: false, isError: false, can: (a: string) => a === 'write' || a === 'read' });
    renderPanel(1, 'tree');
    const menu = await openMoreMenu();
    const names = within(menu).getAllByRole('menuitem').map((el) => el.textContent ?? '');
    expect(names).toEqual(['Export CSV', 'Import CSV', 'Audit duplicates (AI)']);
  });

  it('"More actions" leaves out the AI audit while AI is unavailable', async () => {
    mockAiState = 'hidden';
    mockUsePermissions.mockReturnValue({ role: 'admin', isLoading: false, isError: false, can: () => true });
    renderPanel(1, 'tree');
    const menu = await openMoreMenu();
    const names = within(menu).getAllByRole('menuitem').map((el) => el.textContent ?? '');
    expect(names).toEqual(['Export CSV', 'Import CSV']);
  });

  it('"More actions" offers only export to a viewer', async () => {
    mockUsePermissions.mockReturnValue({ role: 'viewer', isLoading: false, isError: false, can: (a: string) => a === 'read' });
    renderPanel(1, 'tree');
    const menu = await openMoreMenu();
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(1);
    // The export caveat is a tooltip DESCRIPTION, never the item's name.
    expect(within(menu).getByRole('menuitem', { name: 'Export CSV' })).toBeInTheDocument();
  });

  it('hides "More actions" entirely when it would be empty (releases have no list API to export)', () => {
    renderPanel(6, 'tree');
    expect(screen.queryByRole('button', { name: /^more actions$/i })).not.toBeInTheDocument();
  });
});

// WP-079 Part A -- the workbench had no create flow at all until these
// controls; they restore draft-tab creation and folder creation.
describe('SourcePanel — create actions', () => {
  it.each([1, 2, 3, 5] as const)('module-%i create item opens a draft tab, titled and keyed as a draft', async (moduleId) => {
    asContributor();
    const { getTabs } = renderPanel(moduleId, 'tree');

    await chooseCreate(/^new (test case|requirement|test plan|defect)$/i);

    await waitFor(() => expect(getTabs()).toHaveLength(1));
    const [tab] = getTabs();
    expect(tab.module).toBe(moduleId);
    expect(tab.title).toMatch(/^New /);
    expect(tab.entityId.startsWith('new:')).toBe(true);
    expect(tab.key).toBe(tabKey(moduleId, tab.entityId));
  });

  it('is keyboard operable: Tab to "New", Enter opens the menu, Enter picks the first item', async () => {
    asContributor();
    const { getTabs } = renderPanel(1, 'tree');

    await userEvent.tab();
    expect(screen.getByRole('button', { name: /^new$/i })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    const menu = await screen.findByRole('menu', { name: 'Create' });
    await waitFor(() => expect(within(menu).getByRole('menuitem', { name: 'New Test Case' })).toHaveFocus());
    await userEvent.keyboard('{Enter}');

    await waitFor(() => expect(getTabs()).toHaveLength(1));
  });

  it('"New folder" prompts for a name, then calls createFolderApi with the real project id and user -- not the legacy hardcoded literals', async () => {
    asContributor();
    setCurrentProjectId(42); // deliberately not the legacy hardcoded `1`
    renderPanel(1, 'tree');

    await chooseCreate(/^new folder$/i);
    const nameInput = await screen.findByRole('textbox', { name: /new folder name/i });
    await userEvent.type(nameInput, 'Regression');
    await userEvent.click(screen.getByRole('button', { name: /confirm new folder/i }));

    await waitFor(() => {
      expect(mockCreateFolderApi).toHaveBeenCalledWith(
        expect.objectContaining({
          createdBy: 'user-abc',
          updatedBy: 'user-abc',
          moduleId: 1,
          projectId: 42,
          parentFolder: 0,
          folderName: 'Regression',
        }),
      );
    });
    expect(mockCreateFolderApi).not.toHaveBeenCalledWith(
      expect.objectContaining({ createdBy: '643402068b556dee6a3e14de' }),
    );
    // The inline input closes once the folder is submitted.
    expect(screen.queryByRole('textbox', { name: /new folder name/i })).not.toBeInTheDocument();
  });

  // Regression guard for the menu's deferred action: MUI hands focus back to
  // the "New" button as the menu closes, which would otherwise steal it from
  // the input the action just rendered.
  it('"New folder" leaves keyboard focus in the name input, so typing + Enter just works', async () => {
    asContributor();
    renderPanel(1, 'tree');

    await chooseCreate(/^new folder$/i);
    await waitFor(() => expect(screen.getByRole('textbox', { name: /new folder name/i })).toHaveFocus());
    await userEvent.keyboard('Keyboard Folder{Enter}');

    await waitFor(() => {
      expect(mockCreateFolderApi).toHaveBeenCalledWith(expect.objectContaining({ folderName: 'Keyboard Folder' }));
    });
  });

  it('"New folder" targets the currently selected folder as its parent', async () => {
    asContributor();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderPanel(1, 'tree', {
      client,
      seed: (c, setSelection) => {
        // Folder ids are numeric on the backend (Folder model) even though
        // the tree carries them as strings -- '7' here, not 'F1', so
        // `Number(parentFolder)` below exercises the real conversion.
        c.setQueryData(qk.children(1, 1, '0'), [{ id: '7', parent: '0', droppable: true, text: 'Folder 7' }]);
        setSelection('7');
      },
    });

    await chooseCreate(/^new folder$/i);
    await userEvent.type(await screen.findByRole('textbox', { name: /new folder name/i }), 'Nested');
    await userEvent.click(screen.getByRole('button', { name: /confirm new folder/i }));

    await waitFor(() => {
      expect(mockCreateFolderApi).toHaveBeenCalledWith(expect.objectContaining({ parentFolder: 7 }));
    });
  });

  it('"New folder" invalidates the tree query for its parent so the row appears without a manual refresh', async () => {
    asContributor();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
    renderPanel(1, 'tree', { client });

    await chooseCreate(/^new folder$/i);
    await userEvent.type(await screen.findByRole('textbox', { name: /new folder name/i }), 'Smoke');
    await userEvent.click(screen.getByRole('button', { name: /confirm new folder/i }));

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ queryKey: qk.children(1, 1, '0') }),
      );
    });
  });

  it('Escape cancels "New folder" without creating anything', async () => {
    asContributor();
    renderPanel(1, 'tree');

    await chooseCreate(/^new folder$/i);
    await userEvent.type(await screen.findByRole('textbox', { name: /new folder name/i }), 'Nope{Escape}');

    expect(screen.queryByRole('textbox', { name: /new folder name/i })).not.toBeInTheDocument();
    expect(mockCreateFolderApi).not.toHaveBeenCalled();
  });
});

// WP-F08 Task 2 -- "Start from template", gated exactly like "New ...":
// draft-capable modules only, write permission only (asserted per module by
// the header block's menu-contents table above).
describe('SourcePanel — start from template', () => {
  it('opens the CaseTemplatePicker, scoped to this module', async () => {
    asContributor();
    mockListCaseTemplates.mockResolvedValue([
      { _id: 'ct1', id: 1, CaseTemplateId: 'CT-1', projectId: 1, moduleId: 1, name: 'Regression — login flow', prefill: {} },
    ]);
    renderPanel(1, 'tree');

    await chooseCreate(/start from template/i);

    expect(await screen.findByRole('dialog', { name: /start from template/i })).toBeInTheDocument();
    expect(await screen.findByText('Regression — login flow')).toBeInTheDocument();
    expect(mockListCaseTemplates).toHaveBeenCalledWith(1);
  });

  it('never queries templates while the picker is closed', () => {
    renderPanel(1, 'tree');
    expect(mockListCaseTemplates).not.toHaveBeenCalled();
  });
});

// WP-F18b Task 3 -- "New Release", module-6-only, dialog-based create
// (createRelease's only required field is `name`, so a small dialog that
// calls it directly and opens the real, already-saved release fits better
// than a blank draft tab). Which modules offer it is covered by the header
// block's menu-contents table.
describe('SourcePanel — New Release (module 6, dialog-based create)', () => {
  // Non-vacuity: renaming the dialog's Create button's onClick away from the
  // handler that calls createRelease, or dropping the openTab call after it
  // resolves, leaves this test with no createRelease call and/or no tab.
  it('creating a release calls createRelease and opens a tab for the new release', async () => {
    asContributor();
    const { getTabs } = renderPanel(6, 'tree');

    await chooseCreate(/^new release$/i);
    const dialog = await screen.findByRole('dialog', { name: /^new release$/i });
    await userEvent.type(within(dialog).getByLabelText(/^name$/i), 'Autumn Launch');
    await userEvent.click(within(dialog).getByRole('button', { name: /^create$/i }));

    await waitFor(() =>
      expect(mockCreateRelease).toHaveBeenCalledWith(expect.objectContaining({ name: 'Autumn Launch' })),
    );

    await waitFor(() => expect(getTabs()).toHaveLength(1));
    const [tab] = getTabs();
    expect(tab.module).toBe(6);
    expect(tab.entityId).toBe('release-mongo-9');
    expect(tab.title).toBe('REL-9');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows an inline error and does not call createRelease when the name is blank', async () => {
    asContributor();
    renderPanel(6, 'tree');

    await chooseCreate(/^new release$/i);
    const dialog = await screen.findByRole('dialog', { name: /^new release$/i });
    await userEvent.click(within(dialog).getByRole('button', { name: /^create$/i }));

    expect(await within(dialog).findByText(/release name is required/i)).toBeInTheDocument();
    expect(mockCreateRelease).not.toHaveBeenCalled();
  });

  it('reopening the dialog starts from empty fields', async () => {
    asContributor();
    renderPanel(6, 'tree');

    await chooseCreate(/^new release$/i);
    let dialog = await screen.findByRole('dialog', { name: /^new release$/i });
    await userEvent.type(within(dialog).getByLabelText(/^name$/i), 'Abandoned');
    await userEvent.click(within(dialog).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    await chooseCreate(/^new release$/i);
    dialog = await screen.findByRole('dialog', { name: /^new release$/i });
    expect(within(dialog).getByLabelText(/^name$/i)).toHaveValue('');
  });
});
