import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkbenchStoreProvider, useWorkbench } from '../../../workbench/WorkbenchStoreProvider';
import { isDraftEntityId } from '../../../workbench/store/workbenchStore';
import { CaseTemplatePicker } from '../CaseTemplatePicker';
import { listCaseTemplates, deleteCaseTemplate, CaseTemplate } from '../../../api/caseTemplateApi';
import { usePermissions } from '../../../Hooks/usePermissions';
import { TestCaseDetail } from '../../../workbench/detail/modules/TestCaseDetail';
import { getFields, getTcList, getComments } from '../../../api/apiCalls';
import { listSharedSteps } from '../../../api/sharedStepApi';

// WP-F08 Task 2 -- starting from a template must open a REAL draft:
// unsaved, showing Create, prefilled with the template's captured fields
// -- the exact same mechanism useCloneEntity.ts uses for the tree row's
// "Clone" action (openDraftFromPrefill, extracted so the two can never
// diverge), just fed a STORED prefill instead of a freshly-fetched live
// record.
jest.mock('../../../api/caseTemplateApi', () => ({
  listCaseTemplates: jest.fn(),
  deleteCaseTemplate: jest.fn(),
}));
// Named AND default export must be the SAME mock function -- TestCaseDetail
// (mounted for the "opens a real, prefilled draft" test below) uses the
// named import, while SharedStepPicker/SharedStepManagerDialog (mounted
// unconditionally underneath it, both closed) use the default import.
// Two separate jest.fn()s here would leave the default one perpetually
// unconfigured and crash on destructuring `usePermissions()`'s result.
jest.mock('../../../Hooks/usePermissions', () => {
  const mock = jest.fn();
  return { __esModule: true, usePermissions: mock, default: mock };
});
// Needed only for the "opens a real, prefilled draft" test below, which
// mounts the actual TestCaseDetail to prove what the user would see, not
// just what the store recorded. Same full mock list TestCaseDetail.test.tsx
// itself uses (CommentsSection etc. mount unconditionally beneath the
// draft form).
jest.mock('../../../api/apiCalls', () => ({
  getFields: jest.fn(),
  getTcList: jest.fn(),
  updateTestCase: jest.fn(),
  saveTestCase: jest.fn(),
  getComments: jest.fn(),
  updateTestCaseStatus: jest.fn(),
  getTestCaseVersions: jest.fn(),
  updateRequirementStatus: jest.fn(),
  getRequirementVersions: jest.fn(),
}));
jest.mock('../../../api/sharedStepApi', () => ({
  listSharedSteps: jest.fn(),
}));
jest.mock('../../../keycloak', () => ({
  __esModule: true,
  default: { tokenParsed: { sub: 'user-abc', preferred_username: 'alice', name: 'Alice' }, authenticated: true },
}));

const mockListCaseTemplates = listCaseTemplates as jest.Mock;
const mockDeleteCaseTemplate = deleteCaseTemplate as jest.Mock;
const mockUsePermissions = usePermissions as unknown as jest.Mock;
const mockGetFields = getFields as jest.Mock;
const mockGetTcList = getTcList as jest.Mock;
const mockGetComments = getComments as jest.Mock;
const mockListSharedSteps = listSharedSteps as jest.Mock;

function template(overrides: Partial<CaseTemplate> = {}): CaseTemplate {
  return {
    _id: 'ct1',
    id: 1,
    CaseTemplateId: 'CT-1',
    projectId: 1,
    moduleId: 1,
    name: 'Regression — login flow',
    description: 'Standard login regression',
    prefill: {
      TestCaseSummary: 'Login should work',
      TestSteps: [{ testStep: 'Log in as {{role}}', Expected: 'Dashboard for {{role}}' }],
      datasetId: 'ds1',
    },
    ...overrides,
  };
}

function renderPicker(open = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = jest.fn();
  let latestTabs: ReturnType<typeof useWorkbench<Array<{ key: string; module: number; entityId: string; title: string }>>> = [];
  let latestPrefills: ReturnType<typeof useWorkbench<Record<string, unknown>>> = {};

  function Harness() {
    latestTabs = useWorkbench((s) => s.tabs);
    latestPrefills = useWorkbench((s) => s.draftPrefill);
    return <CaseTemplatePicker projectId={1} module={1} open={open} onClose={onClose} />;
  }

  render(
    <QueryClientProvider client={client}>
      <WorkbenchStoreProvider projectId={1}>
        <Harness />
      </WorkbenchStoreProvider>
    </QueryClientProvider>,
  );
  return { onClose, getTabs: () => latestTabs, getPrefills: () => latestPrefills };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUsePermissions.mockReturnValue({ role: 'contributor', isLoading: false, isError: false, can: () => true });
  mockListCaseTemplates.mockResolvedValue([template()]);
});

describe('CaseTemplatePicker', () => {
  it('lists templates for the module and filters by name search', async () => {
    mockListCaseTemplates.mockResolvedValue([
      template({ _id: 'ct1', name: 'Regression — login flow' }),
      template({ _id: 'ct2', name: 'Smoke — checkout' }),
    ]);
    renderPicker();

    expect(await screen.findByText('Regression — login flow')).toBeInTheDocument();
    expect(screen.getByText('Smoke — checkout')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/search templates/i), { target: { value: 'checkout' } });

    expect(screen.queryByText('Regression — login flow')).not.toBeInTheDocument();
    expect(screen.getByText('Smoke — checkout')).toBeInTheDocument();
  });

  it('starting from a template opens a real draft (a fresh draft id, not the template\'s own id) seeded with its prefill', async () => {
    const t = template();
    mockListCaseTemplates.mockResolvedValue([t]);
    const { onClose, getTabs, getPrefills } = renderPicker();

    fireEvent.click(await screen.findByRole('button', { name: /^use$/i }));

    await waitFor(() => expect(getTabs()).toHaveLength(1));
    const [tab] = getTabs();
    // The single-line break this catches: opening the template's OWN
    // CaseTemplateId as the tab's entityId (instead of a freshly minted
    // draft id) makes this fail -- that would render a "real record"
    // detail view, not a draft, and there is no such CT-1 record in
    // module 1's collection to even fetch.
    expect(isDraftEntityId(tab.entityId)).toBe(true);
    expect(tab.module).toBe(1);
    expect(tab.title).toBe('Regression — login flow');
    expect(getPrefills()[tab.entityId]).toEqual(t.prefill);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // The strongest version of "starting from a template opens a draft
  // prefilled with its fields, and the draft is a real draft (unsaved,
  // shows Create)" -- mounts the ACTUAL TestCaseDetail the opened tab
  // would render, through the real draftPrefill mechanism, rather than
  // only inspecting store state.
  it('the opened draft renders TestCaseDetail\'s Create form, prefilled, not a saved record', async () => {
    mockGetFields.mockResolvedValue([
      { fieldName: 'TestCaseSummary', displayName: 'Summary', fieldType: 'TextArea', isDisplayed: true, isMandatory: true, isDefault: true },
    ]);
    mockGetTcList.mockResolvedValue([]);
    mockGetComments.mockResolvedValue([]);
    mockListSharedSteps.mockResolvedValue([]);
    const t = template();
    mockListCaseTemplates.mockResolvedValue([t]);

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let openedEntityId = '';

    function Harness() {
      const tabs = useWorkbench((s) => s.tabs);
      openedEntityId = tabs[0]?.entityId ?? '';
      // A real caller closes the picker once a template is used (see
      // SourcePanel.tsx's StartFromTemplateButton) -- MUI's Dialog marks
      // everything OUTSIDE itself aria-hidden while open, which would
      // otherwise hide TestCaseDetail from every accessibility-tree query
      // below (findByRole included) even after it mounts.
      const [pickerOpen, setPickerOpen] = useState(true);
      return (
        <>
          <CaseTemplatePicker projectId={1} module={1} open={pickerOpen} onClose={() => setPickerOpen(false)} />
          {openedEntityId ? <TestCaseDetail entityId={openedEntityId} /> : null}
        </>
      );
    }

    render(
      <QueryClientProvider client={client}>
        <WorkbenchStoreProvider projectId={1}>
          <Harness />
        </WorkbenchStoreProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /^use$/i }));

    // Not a saved record: shows the draft's own "Create" action, never a
    // fetch against getTcList for the (nonexistent) draft entityId.
    expect(await screen.findByRole('button', { name: /^create$/i })).toBeInTheDocument();
    expect(mockGetTcList).not.toHaveBeenCalled();
    // Prefilled with the template's captured fields.
    expect(screen.getByDisplayValue('Login should work')).toBeInTheDocument();
  });

  it('does not render a Use button for a viewer without write permission', async () => {
    mockUsePermissions.mockReturnValue({ role: 'viewer', isLoading: false, isError: false, can: () => false });
    renderPicker();
    await screen.findByText('Regression — login flow');
    expect(screen.queryByRole('button', { name: /^use$/i })).not.toBeInTheDocument();
  });

  it('shows an empty state when no templates exist for the module', async () => {
    mockListCaseTemplates.mockResolvedValue([]);
    renderPicker();
    expect(await screen.findByText(/no templates exist yet/i)).toBeInTheDocument();
  });

  // The case most likely to regress: a contributor has write:true but
  // delete:false, distinct from a viewer who has neither. Gating the
  // delete control on canWrite (or on nothing) instead of canDelete would
  // pass every viewer-only check and still be wrong.
  it('does not render a Delete control for a contributor without delete permission', async () => {
    mockUsePermissions.mockReturnValue({
      role: 'contributor',
      isLoading: false,
      isError: false,
      can: (a: string) => a === 'read' || a === 'write',
    });
    renderPicker();

    expect(await screen.findByRole('button', { name: /^use$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^delete/i })).not.toBeInTheDocument();
  });

  it('deleting a template calls deleteCaseTemplate with its id and refreshes the list', async () => {
    mockDeleteCaseTemplate.mockResolvedValue(undefined);
    renderPicker();
    expect(await screen.findByText('Regression — login flow')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /delete regression — login flow/i }));
    const confirmDialog = await screen.findByRole('dialog', { name: /delete regression — login flow/i });
    fireEvent.click(within(confirmDialog).getByRole('button', { name: /^delete$/i }));

    await waitFor(() => expect(mockDeleteCaseTemplate).toHaveBeenCalledWith('ct1'));
    // Refresh: the list query is invalidated and refetched after a
    // successful delete, not just left showing stale data.
    await waitFor(() => expect(mockListCaseTemplates).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /delete regression — login flow/i })).not.toBeInTheDocument()
    );
  });

  it('cancelling the delete confirmation does not call deleteCaseTemplate', async () => {
    renderPicker();
    expect(await screen.findByText('Regression — login flow')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /delete regression — login flow/i }));
    const confirmDialog = await screen.findByRole('dialog', { name: /delete regression — login flow/i });
    fireEvent.click(within(confirmDialog).getByRole('button', { name: /^cancel$/i }));

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /delete regression — login flow/i })).not.toBeInTheDocument()
    );
    expect(mockDeleteCaseTemplate).not.toHaveBeenCalled();
  });
});
