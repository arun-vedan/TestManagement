/* eslint-disable testing-library/no-node-access -- `qk.children(...)` is
   Hooks/queryKeys.ts's key-builder function, not DOM node traversal;
   eslint-plugin-testing-library's no-node-access rule pattern-matches on
   the property name alone and false-positives here (same reasoning as
   TestCaseDetail.test.tsx/SourcePanel.test.tsx). */
import React, { useEffect } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkbenchStoreProvider, useWorkbench } from '../../WorkbenchStoreProvider';
import { tabKey, makeDraftEntityId } from '../../store/workbenchStore';
import { qk } from '../../../Hooks/queryKeys';
import { RequirementDetail } from '../modules/RequirementDetail';
import { getFields, getReqList, updateRequirement, getComments, uploadAttachment, saveRequirement } from '../../../api/apiCalls';
import { usePermissions } from '../../../Hooks/usePermissions';
import * as linkApi from '../../../api/linkApi';
import { createCaseTemplate } from '../../../api/caseTemplateApi';

// WP-166 follow-up -- AI entry points render only while AI is available
// (Components/AI/AiAvailable.tsx, its own suite covers the probe). Stubbed
// here as a switch so each test states which world it is in.
let mockAiState: 'available' | 'hidden' = 'available';
jest.mock('../../../Components/AI/AiAvailable', () => ({
  AiAvailable: ({ children }: { children: React.ReactNode }) => (mockAiState === 'available' ? children : null),
  useAiAvailability: () => ({ state: mockAiState, message: null }),
}));
beforeEach(() => {
  mockAiState = 'available';
});


// WP-075a Part 2b -- RequirementDetail follows TestCaseDetail's established
// pattern exactly (WP-074a): fields from getFields(2) via react-query
// (dynamic, DB-driven, never a hardcoded list), entity from getReqList
// keyed by qk.entity, per-field inline edit, the kit's Links/Comments/
// Attachments sections, lifecycle status, untested-coverage from
// useCoverage (not CoverageContext), and both module-2 AI drawers wired so
// their callbacks invalidate/patch react-query rather than mutating local
// state.
jest.mock('../../../api/apiCalls', () => ({
  getFields: jest.fn(),
  getReqList: jest.fn(),
  updateRequirement: jest.fn(),
  getComments: jest.fn(),
  uploadAttachment: jest.fn(),
  updateRequirementStatus: jest.fn(),
  getRequirementVersions: jest.fn(),
  saveRequirement: jest.fn(),
}));

jest.mock('../../../api/linkApi', () => ({
  getUntestedRequirements: jest.fn(),
  getOrphanTestCases: jest.fn(),
}));

// WP-F08 Task 2 -- only needed for the "Save as template" wiring tests
// below; mocked here rather than left to hit the real module (which would
// fire an unmocked axios call the instant Save is clicked).
jest.mock('../../../api/caseTemplateApi', () => ({
  createCaseTemplate: jest.fn(),
}));

jest.mock('../../../keycloak', () => ({
  __esModule: true,
  default: {
    tokenParsed: { sub: 'user-abc', preferred_username: 'alice', name: 'Alice' },
    authenticated: true,
  },
}));

jest.mock('../../../Hooks/usePermissions', () => ({
  __esModule: true,
  usePermissions: jest.fn(),
  default: jest.fn(),
}));

// AiTestCaseDrawer/AiLintPanel each have their own full test suites
// (Components/AI/__tests__/). Mocked here to isolate RequirementDetail's
// OWN wiring: which props they're given, and whether their callbacks reach
// react-query rather than a useState copy.
jest.mock('../../../Components/AI/AiTestCaseDrawer', () => ({
  __esModule: true,
  AiTestCaseDrawer: ({ open, requirementId, reqId, requirementSummary, onAccepted }: any) =>
    open ? (
      <div data-testid="ai-test-case-drawer">
        drawer requirementId={String(requirementId)} reqId={String(reqId)} summary={String(requirementSummary)}
        <button onClick={onAccepted}>simulate accept</button>
      </div>
    ) : null,
}));
jest.mock('../../../Components/AI/AiLintPanel', () => ({
  __esModule: true,
  AiLintPanel: ({ open, requirementId, onApplied }: any) =>
    open ? (
      <div data-testid="ai-lint-panel">
        lint requirementId={String(requirementId)}
        <button onClick={() => onApplied({ requirementDescription: 'fixed by lint' })}>simulate apply</button>
      </div>
    ) : null,
}));

const mockGetFields = getFields as jest.Mock;
const mockGetReqList = getReqList as jest.Mock;
const mockUpdateRequirement = updateRequirement as jest.Mock;
const mockGetComments = getComments as jest.Mock;
const mockUploadAttachment = uploadAttachment as jest.Mock;
const mockSaveRequirement = saveRequirement as jest.Mock;
const mockUsePermissions = usePermissions as unknown as jest.Mock;
const mockGetUntested = linkApi.getUntestedRequirements as jest.Mock;
const mockGetOrphans = linkApi.getOrphanTestCases as jest.Mock;
const mockCreateCaseTemplate = createCaseTemplate as jest.Mock;

const FIELDS = [
  { fieldName: 'requirementSummary', displayName: 'Summary', fieldType: 'TextArea', isDisplayed: true, isMandatory: true, isDefault: true },
  { fieldName: 'priority', displayName: 'Priority', fieldType: 'Text', isDisplayed: true, isMandatory: false, isDefault: false },
  { fieldName: 'component', displayName: 'Component', fieldType: 'DropDown', isDisplayed: true, isMandatory: false, isDefault: false, defaultValue: ['Auth', 'Billing'] },
  { fieldName: 'hiddenField', displayName: 'Hidden', fieldType: 'Text', isDisplayed: false, isMandatory: false, isDefault: false },
];

const REQ_RECORD = {
  _id: 'req-mongo-1',
  reqId: 'Req-1',
  requirementSummary: 'Users can reset their password',
  status: 'draft',
  attachment: [{ attachmentId: 'att-1', name: 'spec.pdf' }],
  dynamicFields: { priority: 'Low', component: 'Auth', hiddenField: 'nope' },
};

function renderDetail(
  entityId = 'Req-1',
  opts: {
    seed?: (client: QueryClient, setSelection: (id: string | null) => void) => void;
    prefill?: Record<string, unknown>;
  } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let latestTabs: ReturnType<typeof useWorkbench<Array<{ key: string; title: string; dirty: boolean }>>> = [];

  function Harness() {
    const openTab = useWorkbench((s) => s.openTab);
    const setSelection = useWorkbench((s) => s.setSelection);
    const setDraftPrefill = useWorkbench((s) => s.setDraftPrefill);
    latestTabs = useWorkbench((s) => s.tabs);
    useEffect(() => {
      if (opts.prefill) {
        setDraftPrefill(entityId, opts.prefill);
      }
      openTab({ module: 2, entityId, title: entityId });
      opts.seed?.(client, (id) => setSelection(2, id));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <RequirementDetail entityId={entityId} />;
  }

  render(
    <QueryClientProvider client={client}>
      <WorkbenchStoreProvider projectId={1}>
        <Harness />
      </WorkbenchStoreProvider>
    </QueryClientProvider>,
  );
  return { getTabs: () => latestTabs, client };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetFields.mockResolvedValue(FIELDS);
  mockGetReqList.mockResolvedValue([REQ_RECORD]);
  mockUpdateRequirement.mockResolvedValue({ success: true });
  mockGetComments.mockResolvedValue([]);
  mockUsePermissions.mockReturnValue({ can: () => true });
  mockGetUntested.mockResolvedValue([]);
  mockGetOrphans.mockResolvedValue([]);
  mockSaveRequirement.mockResolvedValue({ reqId: 'Req-999' });
});

describe('RequirementDetail', () => {
  it('renders the requirement id and summary', async () => {
    renderDetail();
    expect(await screen.findByText(/Req-1/)).toBeInTheDocument();
    expect(screen.getByText(/Users can reset their password/)).toBeInTheDocument();
    await screen.findByText(/No comments yet/);
  });

  it('renders dynamic fields from field definitions (never hardcoded)', async () => {
    renderDetail();
    await screen.findByText(/Req-1/);
    await screen.findByText(/No comments yet/);

    expect(mockGetFields).toHaveBeenCalledWith(2);
    expect(screen.getByLabelText('Priority')).toHaveValue('Low');
    expect(screen.getByRole('combobox', { name: 'Component' })).toHaveTextContent('Auth');
    expect(screen.queryByText('Hidden')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Summary')).not.toBeInTheDocument();
  });

  it('saves a single field without entering a global edit mode', async () => {
    renderDetail();
    await screen.findByText(/Req-1/);
    await screen.findByText(/No comments yet/);

    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();

    const priorityInput = screen.getByLabelText('Priority');
    fireEvent.change(priorityInput, { target: { value: 'High' } });
    fireEvent.blur(priorityInput);

    await waitFor(() => {
      expect(mockUpdateRequirement).toHaveBeenCalledWith(
        expect.objectContaining({ dynamicFields: { priority: 'High' } }),
        'req-mongo-1',
      );
    });
  });

  it('marks its tab dirty on change', async () => {
    const { getTabs } = renderDetail();
    await screen.findByText(/Req-1/);
    await screen.findByText(/No comments yet/);

    const key = tabKey(2, 'Req-1');
    expect(getTabs().find((t) => t.key === key)?.dirty).toBe(false);

    const priorityInput = screen.getByLabelText('Priority');
    fireEvent.change(priorityInput, { target: { value: 'High!' } });
    expect(getTabs().find((t) => t.key === key)?.dirty).toBe(true);
  });

  it('shows the attachments section with the existing attachment', async () => {
    renderDetail();
    await screen.findByText(/Req-1/);
    await screen.findByText(/No comments yet/);

    fireEvent.click(screen.getByRole('tab', { name: 'Attachments' }));
    expect(screen.getByRole('link', { name: 'spec.pdf' })).toBeInTheDocument();
  });

  it('uploads a new file and the attachment reaches the entity cache via react-query', async () => {
    mockUploadAttachment.mockResolvedValue({ status: 201, data: { fileID: 'att-2' } });
    renderDetail();
    await screen.findByText(/Req-1/);
    await screen.findByText(/No comments yet/);
    fireEvent.click(screen.getByRole('tab', { name: 'Attachments' }));

    const file = new File(['x'], 'notes.txt', { type: 'text/plain' });
    const input = screen.getByLabelText(/choose file/i);
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: /upload file/i }));

    await waitFor(() => {
      expect(mockUpdateRequirement).toHaveBeenCalledWith(
        expect.objectContaining({ attachment: expect.arrayContaining([{ attachmentId: 'att-2', name: 'notes.txt' }]) }),
        'req-mongo-1',
      );
    });
  });

  it('renders the lifecycle status control once loaded', async () => {
    renderDetail();
    await screen.findByText(/Req-1/);
    await screen.findByText(/No comments yet/);

    expect(screen.getByText('draft')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /change status/i })).toBeInTheDocument();
  });

  it('shows the untested-coverage badge when this requirement is in useCoverage\'s untested set', async () => {
    mockGetUntested.mockResolvedValue([{ reqId: 'Req-1' }]);
    renderDetail();
    await screen.findByText(/Req-1/);
    await screen.findByText(/No comments yet/);

    expect(await screen.findByText('Untested')).toBeInTheDocument();
  });

  it('does not show the untested-coverage badge when this requirement is covered', async () => {
    mockGetUntested.mockResolvedValue([{ reqId: 'Req-999' }]);
    renderDetail();
    await screen.findByText(/Req-1/);
    await screen.findByText(/No comments yet/);
    await waitFor(() => expect(mockGetUntested).toHaveBeenCalled());

    expect(screen.queryByText('Untested')).not.toBeInTheDocument();
  });

  it('hides the AI actions for a viewer without write permission', async () => {
    mockUsePermissions.mockReturnValue({ can: () => false });
    renderDetail();
    await screen.findByText(/Req-1/);
    await screen.findByText(/No comments yet/);

    expect(screen.queryByRole('button', { name: /generate test cases/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /lint requirement/i })).not.toBeInTheDocument();
  });

  // WP-F08 Task 2 -- "Save as template" is gated exactly like every other
  // write action on this view (canWrite): a viewer sees neither it nor
  // (once opened) the dialog it would show.
  it('hides "Save as template" for a viewer without write permission', async () => {
    mockUsePermissions.mockReturnValue({ can: () => false });
    renderDetail();
    await screen.findByText(/Req-1/);
    expect(screen.queryByRole('button', { name: /save as template/i })).not.toBeInTheDocument();
  });

  it('renders "Save as template" for a contributor', async () => {
    renderDetail();
    await screen.findByText(/Req-1/);
    expect(screen.getByRole('button', { name: /save as template/i })).toBeInTheDocument();
  });

  it('"Save as template" captures THIS requirement\'s own loaded fields, not a blank form', async () => {
    mockCreateCaseTemplate.mockResolvedValue({ _id: 'ct1', CaseTemplateId: 'CT-1' });
    renderDetail();
    await screen.findByText(/Req-1/);

    fireEvent.click(screen.getByRole('button', { name: /save as template/i }));
    const dialog = await screen.findByRole('dialog', { name: /save as template/i });
    fireEvent.change(within(dialog).getByLabelText('Template name'), { target: { value: 'Password reset requirement' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockCreateCaseTemplate).toHaveBeenCalledTimes(1));
    const payload = mockCreateCaseTemplate.mock.calls[0][0];
    // The single-line break this catches: passing an empty object instead
    // of this component's own `values` as SaveAsTemplateDialog's `record`
    // prop makes this fail -- these are REQ_RECORD's own fields, read off
    // the dialog's captured prefill, not typed into the test.
    expect(payload.moduleId).toBe(2);
    expect(payload.prefill.requirementSummary).toBe(REQ_RECORD.requirementSummary);
    expect(payload.prefill.priority).toBe(REQ_RECORD.dynamicFields.priority);
  });

  // WP-063b's recorded product race: TabContent.tsx:589 enabled "Generate
  // test cases (AI)" before the requirement had loaded, so an early click
  // POSTed with no requirementId and 400d. This proves that race is not
  // reintroduced here.
  it('offers neither AI action while AI is unavailable (closed beta: off for the deployment)', async () => {
    mockAiState = 'hidden';
    renderDetail();
    // Same "fully loaded" signals the AI-available tests below wait on.
    await screen.findByText(/Req-1/);
    await screen.findByText(/No comments yet/);
    expect(screen.queryByRole('button', { name: /generate test cases/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /lint requirement/i })).not.toBeInTheDocument();
  });

  it('does not offer the AI generate action until the entity has actually loaded', async () => {
    let resolveReqList!: (rows: typeof REQ_RECORD[]) => void;
    mockGetReqList.mockReturnValue(new Promise((resolve) => { resolveReqList = resolve; }));

    renderDetail();

    // Still loading -- the whole detail view (buttons included) must not
    // be interactable yet.
    expect(screen.queryByRole('button', { name: /generate test cases/i })).not.toBeInTheDocument();

    resolveReqList([REQ_RECORD]);
    await screen.findByText(/Req-1/);
    await screen.findByText(/No comments yet/);

    const generateButton = await screen.findByRole('button', { name: /generate test cases/i });
    expect(generateButton).toBeEnabled();
  });

  it('opens the AiTestCaseDrawer with the loaded requirement, and onAccepted invalidates coverage rather than local state', async () => {
    renderDetail();
    await screen.findByText(/Req-1/);
    await screen.findByText(/No comments yet/);

    fireEvent.click(screen.getByRole('button', { name: /generate test cases/i }));
    const drawer = screen.getByTestId('ai-test-case-drawer');
    expect(drawer).toHaveTextContent('requirementId=req-mongo-1');
    expect(drawer).toHaveTextContent('reqId=Req-1');

    expect(mockGetUntested).toHaveBeenCalledTimes(1);
    fireEvent.click(within(drawer).getByRole('button', { name: /simulate accept/i }));

    await waitFor(() => expect(mockGetUntested).toHaveBeenCalledTimes(2));
  });

  it('opens the AiLintPanel, and onApplied patches the entity cache rather than local state', async () => {
    const { client } = renderDetail();
    await screen.findByText(/Req-1/);
    await screen.findByText(/No comments yet/);

    fireEvent.click(screen.getByRole('button', { name: /lint requirement/i }));
    const panel = screen.getByTestId('ai-lint-panel');
    expect(panel).toHaveTextContent('requirementId=req-mongo-1');

    fireEvent.click(within(panel).getByRole('button', { name: /simulate apply/i }));

    await waitFor(() => {
      expect(client.getQueryData(qk.entity(1, 2, 'Req-1'))).toMatchObject({
        requirementDescription: 'fixed by lint',
      });
    });
  });
});

// WP-079 Part B -- the module-2 half of the create flow, mirroring
// TestCaseDetail's draft mode (WP-079 Part A) exactly: `entityId` is a
// draft sentinel (makeDraftEntityId(), store's `new:<random>`), there is no
// server record for getReqList to fetch, fields still come from
// getFields(2) (dynamic, DB-driven), and edits accumulate in a local draft
// buffer until Create is pressed. Source of truth for the save shape is
// Components/Tabs/TabContent.tsx's newReq branch (~lines 443-467):
// requirementSummary/requirementDescription top-level, every other field
// split by its own definition's isDefault, plus a resolved parentId.
describe('RequirementDetail — draft mode (create a new requirement)', () => {
  it('never fetches an entity for a draft id', async () => {
    const draftId = makeDraftEntityId();
    renderDetail(draftId);
    await screen.findByRole('button', { name: /^create$/i });
    expect(mockGetReqList).not.toHaveBeenCalled();
  });

  it('still loads field definitions and renders them empty', async () => {
    const draftId = makeDraftEntityId();
    renderDetail(draftId);
    await screen.findByRole('button', { name: /^create$/i });
    expect(mockGetFields).toHaveBeenCalledWith(2);
    expect(screen.getByLabelText('Priority')).toHaveValue('');
    const componentCombo = screen.getByRole('combobox', { name: 'Component' });
    expect(componentCombo).not.toHaveTextContent('Auth');
    expect(componentCombo).not.toHaveTextContent('Billing');
    expect(screen.queryByText('Hidden')).not.toBeInTheDocument();
  });

  it('marks the tab dirty the moment a field is edited, before Create is pressed', async () => {
    const draftId = makeDraftEntityId();
    const { getTabs } = renderDetail(draftId);
    await screen.findByRole('button', { name: /^create$/i });

    const key = tabKey(2, draftId);
    expect(getTabs().find((t) => t.key === key)?.dirty).toBe(false);

    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: 'High' } });
    expect(getTabs().find((t) => t.key === key)?.dirty).toBe(true);
  });

  it('Create saves the entered values (summary, dynamic fields, parentId) and replaces the draft tab with the returned reqId', async () => {
    const draftId = makeDraftEntityId();
    const { getTabs, client } = renderDetail(draftId);
    const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
    await screen.findByRole('button', { name: /^create$/i });

    fireEvent.change(screen.getByLabelText('Summary'), { target: { value: 'New password reset flow' } });
    const priorityInput = screen.getByLabelText('Priority');
    fireEvent.change(priorityInput, { target: { value: 'High' } });
    fireEvent.blur(priorityInput);
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(mockSaveRequirement).toHaveBeenCalledWith(
        expect.objectContaining({
          requirementSummary: 'New password reset flow',
          parentId: 0,
          dynamicFields: expect.objectContaining({ priority: 'High' }),
        }),
      );
    });

    const newKey = tabKey(2, 'Req-999');
    await waitFor(() => {
      expect(getTabs().find((t) => t.key === newKey)).toBeTruthy();
    });
    const newTab = getTabs().find((t) => t.key === newKey);
    expect(newTab?.title).toBe('Req-999');
    expect(newTab?.dirty).toBe(false);
    expect(getTabs().find((t) => t.key === tabKey(2, draftId))).toBeUndefined();

    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: qk.children(1, 2, '0') }));
  });

  it('derives parentId from the currently selected folder, per the legacy rule', async () => {
    const draftId = makeDraftEntityId();
    const { getTabs } = renderDetail(draftId, {
      seed: (client, setSelection) => {
        client.setQueryData(qk.children(1, 2, '0'), [{ id: '7', parent: '0', droppable: true, text: 'Folder 7' }]);
        setSelection('7');
      },
    });
    await screen.findByRole('button', { name: /^create$/i });

    fireEvent.change(screen.getByLabelText('Summary'), { target: { value: 'Under folder 7' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(mockSaveRequirement).toHaveBeenCalledWith(expect.objectContaining({ parentId: 7 }));
    });
    await waitFor(() => {
      expect(getTabs().find((t) => t.key === tabKey(2, 'Req-999'))).toBeTruthy();
    });
  });

  it('shows an error and leaves the draft tab open when Create fails', async () => {
    mockSaveRequirement.mockRejectedValueOnce(new Error('boom'));
    const draftId = makeDraftEntityId();
    const { getTabs } = renderDetail(draftId);
    await screen.findByRole('button', { name: /^create$/i });

    fireEvent.change(screen.getByLabelText('Summary'), { target: { value: 'Will fail' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not create/i);
    expect(getTabs().find((t) => t.key === tabKey(2, draftId))).toBeTruthy();
  });

  // WP-F05b fix round 1 -- regression test for a Critical silent-data-loss
  // bug: `tags` is a fixed schema field (WP-F05a/Task 1), not one of the
  // admin Fields Configuration entries `fields.forEach` above loops over,
  // so a tag typed into TagsSection while creating a draft used to be
  // silently dropped -- the chip appeared, Create fired, and the saved
  // record came back with no tags and no error message at all.
  it('Create saves tags entered before the entity exists (not silently dropped)', async () => {
    const draftId = makeDraftEntityId();
    renderDetail(draftId);
    await screen.findByRole('button', { name: /^create$/i });

    const tagInput = screen.getByRole('textbox', { name: /add a tag/i });
    fireEvent.change(tagInput, { target: { value: 'smoke' } });
    fireEvent.keyDown(tagInput, { key: 'Enter' });

    fireEvent.change(screen.getByLabelText('Summary'), { target: { value: 'New requirement' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(mockSaveRequirement).toHaveBeenCalledWith(
        expect.objectContaining({ tags: ['smoke'] }),
      );
    });
  });

  it('does not offer AI actions or attachments before the requirement exists', async () => {
    const draftId = makeDraftEntityId();
    renderDetail(draftId);
    await screen.findByRole('button', { name: /^create$/i });

    expect(screen.queryByRole('button', { name: /generate test cases/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /lint requirement/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Attachments' })).not.toBeInTheDocument();
  });

  // Wave B-4 (clone an entity) -- same contract as TestCaseDetail's own
  // "seeded from a clone prefill" test: a prefill recorded before the
  // draft tab opens (useCloneEntity.ts) renders pre-filled, and Create
  // saves it through the exact same normal create path already proven
  // above.
  it('seeded from a clone prefill: renders pre-filled and Create saves it as a normal new record', async () => {
    const draftId = makeDraftEntityId();
    renderDetail(draftId, {
      prefill: { requirementSummary: 'Copy of Users can reset their password', priority: 'Low' },
    });
    await screen.findByRole('button', { name: /^create$/i });

    expect(screen.getByLabelText('Summary')).toHaveValue('Copy of Users can reset their password');
    expect(screen.getByLabelText('Priority')).toHaveValue('Low');

    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(mockSaveRequirement).toHaveBeenCalledWith(
        expect.objectContaining({
          requirementSummary: 'Copy of Users can reset their password',
          dynamicFields: expect.objectContaining({ priority: 'Low' }),
        }),
      );
    });
  });
});
