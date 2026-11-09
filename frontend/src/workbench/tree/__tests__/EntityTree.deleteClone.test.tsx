import React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkbenchStoreProvider, useWorkbench } from '../../WorkbenchStoreProvider';
import EntityTree from '../EntityTree';
import { useMoveNode } from '../../../Hooks/mutations/useMoveNode';
import {
  getFolderList,
  getTcList,
  getTestExecutionList,
  deleteTestCase,
  deleteTestExecution,
} from '../../../api/apiCalls';

// Wave B-3/B-4 (PRODUCT_GAP_REGISTER.md A1/B1) -- the tree row menu
// (EntityTreeNode's existing "Move to..." button, WP-077b) is the natural
// home for a per-entity Delete and Clone, per the dispatch. This suite
// exercises both through the REAL useTreeChildren/react-query stack (only
// api/apiCalls is mocked, per the dispatch's "no network" rule) so that
// "invalidates the tree" can be proven by the deleted row actually
// disappearing after a real refetch, not just by asserting a query key was
// touched.
import { getReleases } from '../../../api/releaseApi';
jest.mock('../../../Hooks/mutations/useMoveNode');
jest.mock('../../../api/apiCalls');
jest.mock('../../../api/releaseApi', () => ({ getReleases: jest.fn() }));

let mockCanWrite = true;
let mockCanDelete = true;
jest.mock('../../../Hooks/usePermissions', () => ({
  __esModule: true,
  usePermissions: () => ({
    can: (action: string) => (action === 'write' ? mockCanWrite : action === 'delete' ? mockCanDelete : false),
    role: 'admin',
    isLoading: false,
    isError: false,
  }),
}));

const mockGetFolderList = getFolderList as jest.Mock;
const mockGetTcList = getTcList as jest.Mock;
const mockGetTestExecutionList = getTestExecutionList as jest.Mock;
const mockDeleteTestCase = deleteTestCase as jest.Mock;
const mockDeleteTestExecution = deleteTestExecution as jest.Mock;

// In-memory "backend" for module 1 (test cases) -- a real array so a
// mocked deleteTestCase can actually remove a row from it, letting the
// real useTreeChildren query genuinely reflect the deletion once
// invalidated, rather than a static fixture that never changes.
//
// deleteTestCase/deleteTestExecution below filter by `_id` (the Mongo id),
// NOT the business key (TC-104/RUN-1) -- every controller's own delete
// handler is `findOneAndDelete({ _id: req.params.id, ... })` (verified by
// reading testrepo.js/testexecution.js's own deleteTestCase/
// deleteTestExecution), confirmed live via a real 404 when this suite's
// first draft called delete with the business id instead. useDeleteEntity
// must resolve the real _id via a lookup before calling delete -- these
// fixtures carry both ids so a test that asserted the WRONG one would fail
// loudly rather than silently pass against a mock too permissive to catch
// the mismatch.
let tcRows: Array<{ TestCaseId: string; parentId: string; id: number; TestCaseSummary?: string; TestCaseDescription?: string; _id?: string }>;
let executionRows: Array<{ TestExecutionId: string; _id?: string }>;

beforeEach(() => {
  jest.clearAllMocks();
  mockCanWrite = true;
  mockCanDelete = true;
  tcRows = [{ TestCaseId: 'TC-104', parentId: '0', id: 1, TestCaseSummary: 'Login works', TestCaseDescription: 'desc', _id: 'mongo-104' }];
  executionRows = [{ TestExecutionId: 'RUN-1', _id: 'mongo-run-1' }];

  mockGetFolderList.mockResolvedValue([]);
  mockGetTcList.mockImplementation(async () => tcRows);
  mockGetTestExecutionList.mockImplementation(async () => executionRows);
  mockDeleteTestCase.mockImplementation(async (id: string) => {
    tcRows = tcRows.filter((r) => r._id !== id);
    return { success: true };
  });
  mockDeleteTestExecution.mockImplementation(async (id: string) => {
    executionRows = executionRows.filter((r) => r._id !== id);
    return { success: true };
  });
  (useMoveNode as jest.Mock).mockReturnValue({ mutate: jest.fn(), isLoading: false });
});

function renderTree(module: number) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let latestTabs: Array<{ key: string; module: number; entityId: string; title: string }> = [];
  let latestDraftPrefill: Record<string, Record<string, unknown>> = {};
  function Harness() {
    latestTabs = useWorkbench((s) => s.tabs);
    latestDraftPrefill = useWorkbench((s) => s.draftPrefill);
    return <EntityTree module={module as 1} />;
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
  return { getTabs: () => latestTabs, getDraftPrefill: () => latestDraftPrefill };
}

async function openActionsMenu(name: RegExp | string) {
  const button = await screen.findByRole('button', { name: new RegExp(`Actions for ${name}`, 'i') });
  await userEvent.click(button);
  return screen.findByRole('menu');
}

describe('EntityTreeNode delete', () => {
  it('asks for confirmation before deleting; cancelling calls no API', async () => {
    renderTree(1);
    await screen.findByRole('treeitem', { name: 'TC-104', exact: true });

    const menu = await openActionsMenu('TC-104');
    await userEvent.click(within(menu).getByRole('menuitem', { name: /delete/i }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getAllByText(/TC-104/).length).toBeGreaterThan(0);

    await userEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));

    expect(mockDeleteTestCase).not.toHaveBeenCalled();
    // MUI's Dialog exit transition leaves the node in the DOM briefly --
    // wait it out rather than assert against an in-flight animation frame.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('confirming calls the delete endpoint, closes the open tab, and invalidates the tree so the row disappears', async () => {
    const { getTabs } = renderTree(1);
    const row = await screen.findByRole('treeitem', { name: 'TC-104', exact: true });

    // Open a tab for TC-104 first, the same way selecting it in the tree
    // always does -- so this test can prove Delete closes it.
    await userEvent.click(row);
    await waitFor(() => expect(getTabs().some((t) => t.entityId === 'TC-104')).toBe(true));

    const menu = await openActionsMenu('TC-104');
    await userEvent.click(within(menu).getByRole('menuitem', { name: /delete/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /^delete$/i }));

    // Resolved to the Mongo _id, NOT the business TestCaseId -- see this
    // file's fixture comment on why the real backend requires that.
    await waitFor(() => expect(mockDeleteTestCase).toHaveBeenCalledWith('mongo-104'));
    await waitFor(() => expect(getTabs().some((t) => t.entityId === 'TC-104')).toBe(false));
    await waitFor(() => expect(screen.queryByRole('treeitem', { name: 'TC-104', exact: true })).not.toBeInTheDocument());
  });

  it('surfaces a delete failure rather than silently doing nothing', async () => {
    mockDeleteTestCase.mockRejectedValueOnce(new Error('backend exploded'));
    renderTree(1);
    await screen.findByRole('treeitem', { name: 'TC-104', exact: true });

    const menu = await openActionsMenu('TC-104');
    await userEvent.click(within(menu).getByRole('menuitem', { name: /delete/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /^delete$/i }));

    await within(dialog).findByText(/backend exploded/i);
    expect(mockDeleteTestCase).toHaveBeenCalledTimes(1);

    // Close the dialog (a real user dismissing the error) and confirm the
    // row is still there -- the failed delete did not silently remove it
    // from the tree. (While the modal dialog is open, MUI marks the rest
    // of the page aria-hidden, so the row is deliberately unreachable by
    // role until the dialog closes -- that is the dialog behaving
    // correctly, not the row having been removed.)
    await userEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));
    expect(await screen.findByRole('treeitem', { name: 'TC-104', exact: true })).toBeInTheDocument();
  });

  it('hides Delete without can(\'delete\') -- can(\'write\') alone is not enough', async () => {
    mockCanWrite = true;
    mockCanDelete = false;
    renderTree(1);
    await screen.findByRole('treeitem', { name: 'TC-104', exact: true });

    const menu = await openActionsMenu('TC-104');
    expect(within(menu).queryByRole('menuitem', { name: /delete/i })).not.toBeInTheDocument();
    // Clone (gated on can('write')) must still show -- proves the two
    // gates are genuinely independent, not both keyed off the same flag.
    expect(within(menu).getByRole('menuitem', { name: /clone/i })).toBeInTheDocument();
  });

  it('offers Delete for a module-4 (test run) leaf -- every module has a delete endpoint', async () => {
    renderTree(4);
    await screen.findByRole('treeitem', { name: 'RUN-1', exact: true });
    const menu = await openActionsMenu('RUN-1');
    expect(within(menu).getByRole('menuitem', { name: /delete/i })).toBeInTheDocument();
  });
});

// Releases appear in the tree since 2026-11-06, but useDeleteEntity has no
// module-6 branch (a release is deleted from ReleaseDetail), so a tree Delete
// would only ever throw. Releases are not draft-capable either, so with
// neither action the row offers no actions menu at all.
describe('EntityTree release rows (module 6)', () => {
  // Set per test: CRA's jest config resets mock implementations between tests.
  beforeEach(() => {
    (getReleases as jest.Mock).mockResolvedValue([{ _id: 'mongo-rel-9', releaseId: 'REL-9', name: 'Autumn Launch' }]);
  });

  it('shows the release, labelled REL-n, with no Delete/Clone menu even for a full admin', async () => {
    renderTree(6);
    await screen.findByRole('treeitem', { name: 'REL-9', exact: true });
    expect(screen.queryByRole('button', { name: /actions for REL-9/i })).not.toBeInTheDocument();
  });

  it('opens the same tab the list view opens: keyed by _id, titled REL-n', async () => {
    const { getTabs } = renderTree(6);
    await userEvent.click(await screen.findByRole('treeitem', { name: 'REL-9', exact: true }));
    await waitFor(() => expect(getTabs()).toHaveLength(1));
    expect(getTabs()[0]).toEqual(expect.objectContaining({ module: 6, entityId: 'mongo-rel-9', title: 'REL-9' }));
  });
});

describe('EntityTreeNode clone', () => {
  it("opens a pre-filled draft from the source entity's own values", async () => {
    const { getTabs, getDraftPrefill } = renderTree(1);
    await screen.findByRole('treeitem', { name: 'TC-104', exact: true });

    const menu = await openActionsMenu('TC-104');
    await userEvent.click(within(menu).getByRole('menuitem', { name: /clone/i }));

    await waitFor(() => expect(mockGetTcList).toHaveBeenCalledWith('TestCaseId=TC-104'));
    await waitFor(() => {
      expect(getTabs().find((t) => t.module === 1 && t.entityId.startsWith('new:'))).toBeTruthy();
    });
    const draftTab = getTabs().find((t) => t.module === 1 && t.entityId.startsWith('new:'))!;
    expect(draftTab.title).toMatch(/copy of/i);
    const prefill = getDraftPrefill()[draftTab.entityId];
    expect(prefill.TestCaseSummary).toBe('Copy of Login works');
    expect(prefill.TestCaseDescription).toBe('desc');
  });

  it('is not offered for module 4 (test runs have no create-from-scratch flow to clone into)', async () => {
    renderTree(4);
    await screen.findByRole('treeitem', { name: 'RUN-1', exact: true });
    const menu = await openActionsMenu('RUN-1');
    expect(within(menu).queryByRole('menuitem', { name: /clone/i })).not.toBeInTheDocument();
  });

  it('is hidden without can(\'write\')', async () => {
    mockCanWrite = false;
    renderTree(1);
    await screen.findByRole('treeitem', { name: 'TC-104', exact: true });
    const menu = await openActionsMenu('TC-104');
    expect(within(menu).queryByRole('menuitem', { name: /clone/i })).not.toBeInTheDocument();
    // Delete (gated on can('delete'), still true here) must still show.
    expect(within(menu).getByRole('menuitem', { name: /delete/i })).toBeInTheDocument();
  });
});
