/* eslint-disable testing-library/no-node-access -- `qk.children(...)` is
   Hooks/queryKeys.ts's key-builder function, not DOM node traversal;
   eslint-plugin-testing-library's no-node-access rule pattern-matches on
   the property name alone and false-positives here (same reasoning as
   TestCaseDetail.test.tsx/SourcePanel.test.tsx). */
import React, { useEffect } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkbenchStoreProvider, useWorkbench } from '../../WorkbenchStoreProvider';
import { tabKey, makeDraftEntityId, DefectDraftIntent } from '../../store/workbenchStore';
import { qk } from '../../../Hooks/queryKeys';
import { DefectDetail } from '../modules/DefectDetail';
import { getFields, getDefectList, updateDefect, getComments, uploadAttachment, getUserDirectory, getCreatedBy, postDefect, createLink } from '../../../api/apiCalls';
import { getIssueStatuses, updateDefectStatus } from '../../../api/defectStatusApi';
import { createCaseTemplate } from '../../../api/caseTemplateApi';

// WP-077 Part A -- Defects is module 5, built on the same shared detail kit
// as TestCaseDetail (WP-074)/RequirementDetail (WP-075a): fields from
// getFields(5) via react-query (dynamic, DB-driven, never a hardcoded
// list), entity from getDefectList keyed by qk.entity, per-field inline
// edit, and the kit's Attachments/Links/Comments sections. Source of truth
// for the fetch/save shape is Components/Tabs/DefectContent.tsx (NOT
// modified by this WP -- the legacy page keeps working unchanged).
//
// createLink/getLinkedIssuesApi/deleteLinkcAPI (LinkIssues' own calls) are
// deliberately not mocked here, same as RequirementDetail.test.tsx/
// TestCaseDetail.test.tsx -- DetailTabs only mounts a tab's content once
// it's active, and no test here clicks into the Links tab's interactive
// bits beyond confirming it renders.
jest.mock('../../../api/apiCalls', () => ({
  getFields: jest.fn(),
  getDefectList: jest.fn(),
  updateDefect: jest.fn(),
  getComments: jest.fn(),
  uploadAttachment: jest.fn(),
  getUserDirectory: jest.fn(),
  getCreatedBy: jest.fn(),
  postDefect: jest.fn(),
  createLink: jest.fn(),
}));

// WP-F08 Task 2 -- only needed for the "Save as template" wiring test
// below; mocked here rather than left to hit the real module (which would
// fire an unmocked axios call the instant Save is clicked).
jest.mock('../../../api/caseTemplateApi', () => ({
  createCaseTemplate: jest.fn(),
}));

jest.mock('../../../api/defectStatusApi', () => ({
  getIssueStatuses: jest.fn(),
  updateDefectStatus: jest.fn(),
}));

jest.mock('../../../keycloak', () => ({
  __esModule: true,
  default: {
    tokenParsed: { sub: 'user-abc', preferred_username: 'alice', name: 'Alice' },
    authenticated: true,
  },
}));

// WP-077 RBAC -- these views now gate every write control on can('write'),
// restoring the gate the legacy Edit button had (TabContent.tsx:631) and
// that per-field inline edit dropped. These suites exercise the WRITE
// paths, so they run as a contributor.
jest.mock('../../../Hooks/usePermissions', () => ({
  __esModule: true,
  usePermissions: () => ({ can: () => true, role: 'contributor', isLoading: false, isError: false }),
  default: () => ({ can: () => true, role: 'contributor', isLoading: false, isError: false }),
}));


const mockGetFields = getFields as jest.Mock;
const mockGetDefectList = getDefectList as jest.Mock;
const mockUpdateDefect = updateDefect as jest.Mock;
const mockGetComments = getComments as jest.Mock;
const mockUploadAttachment = uploadAttachment as jest.Mock;
const mockGetUsersList = getUserDirectory as jest.Mock;
const mockGetCreatedBy = getCreatedBy as jest.Mock;
const mockGetIssueStatuses = getIssueStatuses as jest.Mock;
const mockUpdateDefectStatus = updateDefectStatus as jest.Mock;
const mockPostDefect = postDefect as jest.Mock;
const mockCreateLink = createLink as jest.Mock;
const mockCreateCaseTemplate = createCaseTemplate as jest.Mock;

// Mirrors the real getFields(5) shape verified through Kong against a real
// service token (see the dispatch's "VERIFIED CONTEXT"): summary(TextArea)
// description(Editor) Status(IssueDropDown) assignedTo(UserDropDown)
// Priority(DropDown) Severity(DropDown) testSeverity(DropDown). `Priority`
// deliberately included to prove dynamic DropDown fields still work
// alongside the two new types; `hiddenField` proves isDisplayed still gates
// them exactly as it does for every other module.
const FIELDS = [
  { fieldName: 'summary', displayName: 'Summary', fieldType: 'TextArea', isDisplayed: true, isMandatory: true, isDefault: true },
  { fieldName: 'Status', displayName: 'Status', fieldType: 'IssueDropDown', isDisplayed: true, isMandatory: false, isDefault: true },
  { fieldName: 'assignedTo', displayName: 'Assigned To', fieldType: 'UserDropDown', isDisplayed: true, isMandatory: false, isDefault: true },
  { fieldName: 'Priority', displayName: 'Priority', fieldType: 'DropDown', isDisplayed: true, isMandatory: false, isDefault: false, defaultValue: ['Low', 'High'] },
  { fieldName: 'hiddenField', displayName: 'Hidden', fieldType: 'Text', isDisplayed: false, isMandatory: false, isDefault: false },
];

// assignedTo is a raw Keycloak user id on the wire -- verified against a
// real seeded defect (srckube-defects.defects, e.g. Bug-1/2/3 all store
// "assignedTo": "c16a3041-...") -- DefectContent.tsx:219-221 resolves it to
// a username via getCreatedBy before display; DefectDetail must do the same
// or the assignedTo picker renders blank (a real bug this WP's own browser
// verification caught).
const DEFECT_RECORD = {
  _id: 'defect-mongo-1',
  defectId: 'DEF-1',
  summary: 'Login button does nothing',
  Status: 'Open',
  assignedTo: 'user-id-c16a3041',
  attachment: [{ attachmentId: 'att-1', name: 'screenshot.png' }],
  dynamicFields: { Priority: 'High', hiddenField: 'nope' },
};

function renderDetail(
  entityId = 'DEF-1',
  options?: { intent?: DefectDraftIntent; prefill?: Record<string, unknown> },
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let latestTabs: ReturnType<typeof useWorkbench<Array<{ key: string; title: string; dirty: boolean }>>> = [];

  function Harness() {
    const openTab = useWorkbench((s) => s.openTab);
    const setDefectDraftIntent = useWorkbench((s) => s.setDefectDraftIntent);
    const setDraftPrefill = useWorkbench((s) => s.setDraftPrefill);
    latestTabs = useWorkbench((s) => s.tabs);
    useEffect(() => {
      // Mirrors TestRunDetail's real "Raise defect" sequence (A6): record
      // the intent, THEN open the tab that will read it.
      if (options?.intent) {
        setDefectDraftIntent(entityId, options.intent);
      }
      // Wave B-4 (clone) -- same ordering, via the separate generic
      // prefill map useCloneEntity.ts itself writes to.
      if (options?.prefill) {
        setDraftPrefill(entityId, options.prefill);
      }
      openTab({ module: 5, entityId, title: entityId });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <DefectDetail entityId={entityId} />;
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
  mockGetDefectList.mockResolvedValue([DEFECT_RECORD]);
  mockUpdateDefect.mockResolvedValue({ success: true });
  mockGetComments.mockResolvedValue([]);
  mockGetUsersList.mockResolvedValue([]);
  mockGetCreatedBy.mockResolvedValue('alice');
  mockGetIssueStatuses.mockResolvedValue([
    { id: 1, istatus: 'Open', parentId: [] },
    { id: 2, istatus: 'Fixed', parentId: [1] },
  ]);
  mockUpdateDefectStatus.mockResolvedValue({ data: { Status: 'Fixed' } });
  mockPostDefect.mockResolvedValue({ defectId: 'DEF-999' });
  mockCreateCaseTemplate.mockResolvedValue({ _id: 'ct1', CaseTemplateId: 'CT-1' });
});

describe('DefectDetail', () => {
  // WP-F08 Task 2 -- "Save as template" is wired into this module too,
  // and captures the CURRENTLY LOADED defect's fields -- but never its
  // attachment (entityPrefill.ts's own module-5 branch deletes it: an
  // attached file is not a field value, and carrying it forward would
  // silently imply the file came along too).
  it('offers "Save as template" and captures this defect\'s own loaded fields, minus its attachment', async () => {
    renderDetail();
    await screen.findByRole('heading', { level: 6 });

    fireEvent.click(screen.getByRole('button', { name: /save as template/i }));
    const dialog = await screen.findByRole('dialog', { name: /save as template/i });
    fireEvent.change(within(dialog).getByLabelText('Template name'), { target: { value: 'Login button defect' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockCreateCaseTemplate).toHaveBeenCalledTimes(1));
    const payload = mockCreateCaseTemplate.mock.calls[0][0];
    expect(payload.moduleId).toBe(5);
    expect(payload.prefill.summary).toBe(DEFECT_RECORD.summary);
    expect(payload.prefill.Priority).toBe(DEFECT_RECORD.dynamicFields.Priority);
    // The single-line break this catches: removing entityPrefill.ts's
    // `delete prefill.attachment` line makes this fail.
    expect(payload.prefill.attachment).toBeUndefined();
  });


  it('renders the defect id and summary', async () => {
    renderDetail();
    // The header AND the (undhidden, not-excluded-from-the-grid) Summary
    // field both show this text -- DefectContent.tsx does the same double
    // display (verbatim legacy behaviour, not a bug introduced here) --
    // so this scopes to the header itself rather than an ambiguous
    // getByText across the whole page.
    const heading = await screen.findByRole('heading', { level: 6 });
    expect(heading).toHaveTextContent('DEF-1');
    expect(heading).toHaveTextContent('Login button does nothing');
    await screen.findByText(/No comments yet/);
  });

  it('renders dynamic fields from getFields(5), never a hardcoded list', async () => {
    renderDetail();
    await screen.findByText(/DEF-1/);
    await screen.findByText(/No comments yet/);

    expect(mockGetFields).toHaveBeenCalledWith(5);
    expect(screen.getByRole('combobox', { name: 'Priority' })).toHaveTextContent('High');
    expect(screen.queryByText('Hidden')).not.toBeInTheDocument();
  });

  it('renders the Status field through the defect status workflow control, not a plain dropdown', async () => {
    renderDetail();
    await screen.findByText(/DEF-1/);
    await screen.findByText(/No comments yet/);

    // DefectStatus (Components/governance/DefectStatus.tsx) renders a
    // StatusChip + "Change status" button -- proof the IssueDropDown branch
    // actually reached the real status-workflow control, not a MUI Select.
    expect(await screen.findByText('Open')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /change status/i })).toBeInTheDocument();
  });

  it('renders the assignedTo field through the user picker, resolved to a username rather than the raw id', async () => {
    renderDetail();
    await screen.findByText(/DEF-1/);
    await screen.findByText(/No comments yet/);

    // The record's raw assignedTo is a Keycloak user id
    // ("user-id-c16a3041") -- DefectContent.tsx:219-221 resolves it via
    // getCreatedBy before display, and DefectDetail must do the same or
    // DynamicAutocomplete never finds a matching option and the picker
    // renders blank (real bug caught by this WP's browser verification).
    await waitFor(() => expect(mockGetCreatedBy).toHaveBeenCalledWith('user-id-c16a3041'));
    // D6 fix -- this combobox used to have no accessible name at all
    // (`{ name: '' }`); it now carries the field's own displayName
    // ("Assigned To"), threaded through FieldGrid's UserDropDownField into
    // DynamicAutocomplete (dropDownList.tsx).
    const combo = screen.getByRole('combobox', { name: 'Assigned To' });
    expect(combo).toHaveValue('alice');
  });

  it('changing the status goes through a mutation/invalidation, not local state', async () => {
    mockGetDefectList
      .mockResolvedValueOnce([DEFECT_RECORD])
      .mockResolvedValueOnce([{ ...DEFECT_RECORD, Status: 'Fixed' }]);

    renderDetail();
    await screen.findByText(/DEF-1/);
    await screen.findByText(/No comments yet/);

    // DefectStatus's vocabulary is loaded async (istatusservice via
    // getIssueStatuses), unlike LifecycleStatus's hardcoded list -- the
    // "Change status" button stays disabled until that resolves.
    const changeStatusButton = await screen.findByRole('button', { name: /change status/i });
    await waitFor(() => expect(changeStatusButton).not.toBeDisabled());
    fireEvent.click(changeStatusButton);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Fixed' }));

    await waitFor(() => {
      expect(mockUpdateDefectStatus).toHaveBeenCalledWith('defect-mongo-1', 'Fixed');
    });
    // The new status reaches the screen via the entity query's refetch
    // (react-query), not a page-level setFieldValues copy -- DefectDetail
    // keeps no useState mirror of the entity at all.
    expect(await screen.findByText('Fixed')).toBeInTheDocument();
  });

  it('saves a single field without entering a global edit mode, and marks its tab dirty', async () => {
    const { getTabs } = renderDetail();
    await screen.findByText(/DEF-1/);
    await screen.findByText(/No comments yet/);

    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();

    const key = tabKey(5, 'DEF-1');
    expect(getTabs().find((t) => t.key === key)?.dirty).toBe(false);

    // isMandatory adds a trailing "*" to the label's accessible name
    // (FormLabel `required`), so this is a substring match rather than
    // exact -- same convention as every other required field in this kit.
    const summaryInput = screen.getByLabelText('Summary', { exact: false });
    fireEvent.change(summaryInput, { target: { value: 'Login button crashes the app' } });
    expect(getTabs().find((t) => t.key === key)?.dirty).toBe(true);
    fireEvent.blur(summaryInput);

    await waitFor(() => {
      expect(mockUpdateDefect).toHaveBeenCalledWith(
        'defect-mongo-1',
        expect.objectContaining({ summary: 'Login button crashes the app' }),
      );
    });
  });

  it('shows the attachments section with the existing attachment', async () => {
    renderDetail();
    await screen.findByText(/DEF-1/);
    await screen.findByText(/No comments yet/);

    fireEvent.click(screen.getByRole('tab', { name: 'Attachments' }));
    expect(screen.getByRole('link', { name: 'screenshot.png' })).toBeInTheDocument();
  });

  it('uploads a new file and the attachment reaches the entity cache via react-query', async () => {
    mockUploadAttachment.mockResolvedValue({ status: 201, data: { fileID: 'att-2' } });
    renderDetail();
    await screen.findByText(/DEF-1/);
    await screen.findByText(/No comments yet/);
    fireEvent.click(screen.getByRole('tab', { name: 'Attachments' }));

    const file = new File(['x'], 'log.txt', { type: 'text/plain' });
    const input = screen.getByLabelText(/choose file/i);
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: /upload file/i }));

    await waitFor(() => {
      expect(mockUpdateDefect).toHaveBeenCalledWith(
        'defect-mongo-1',
        expect.objectContaining({ attachment: expect.arrayContaining([{ attachmentId: 'att-2', name: 'log.txt' }]) }),
      );
    });
  });

  it('shows the Links section', async () => {
    renderDetail();
    await screen.findByText(/DEF-1/);
    await screen.findByText(/No comments yet/);

    expect(screen.getByRole('tab', { name: 'Links' })).toBeInTheDocument();
  });

  it('shows the Comments section', async () => {
    renderDetail();
    await screen.findByText(/DEF-1/);
    expect(await screen.findByText(/No comments yet/)).toBeInTheDocument();
  });
});

// WP-079 Part B -- the module-5 half of the create flow, mirroring
// TestCaseDetail's draft mode (WP-079 Part A). `entityId` is a draft
// sentinel (makeDraftEntityId(), store's `new:<random>`) -- there is no
// server record for getDefectList to fetch yet, fields still come from
// getFields(5) (dynamic, DB-driven), and edits accumulate in a local draft
// buffer until Create is pressed. Source of truth for the save shape is
// Components/Tabs/DefectContent.tsx's postDefect branch (~lines 138-161):
// nDefectDetails built purely from handleFieldChange, top-level for
// isDefault fields, nested under dynamicFields otherwise. UNLIKE
// TestCaseDetail/RequirementDetail, no parentId is resolved or sent here
// at all: DefectContent.tsx's own handleSave never references one for a
// new defect, and the defects model (backend/defectService/models/
// defects.js) has no parentId field -- verified by reading both. Module 5
// is flat (Hooks/queries/useTreeChildren.ts's fetchLeaves only ever
// returns module-5 leaves for the root parent regardless of which folder
// is selected), so root ('0') is the one tree cache entry a newly created
// defect can ever appear under.
describe('DefectDetail — draft mode (create a new defect)', () => {
  it('never fetches an entity for a draft id', async () => {
    const draftId = makeDraftEntityId();
    renderDetail(draftId);
    await screen.findByRole('button', { name: /^create$/i });
    expect(mockGetDefectList).not.toHaveBeenCalled();
  });

  it('still loads field definitions and renders them empty', async () => {
    const draftId = makeDraftEntityId();
    renderDetail(draftId);
    await screen.findByRole('button', { name: /^create$/i });
    expect(mockGetFields).toHaveBeenCalledWith(5);
    expect(screen.getByRole('combobox', { name: 'Priority' })).not.toHaveTextContent('High');
    expect(screen.queryByText('Hidden')).not.toBeInTheDocument();
  });

  // The core "not settable before the record exists" requirement: Status
  // (IssueDropDown) must show the disabled "Save the defect to set its
  // status" placeholder rather than the real DefectStatus workflow control
  // -- there is no Mongo _id yet for it to act on. FieldGrid's
  // IssueDropDownField already gates this generically on `mongoId` being
  // falsy (WP-077); a draft's values simply never carry one.
  it('does not offer the status control before the record exists', async () => {
    const draftId = makeDraftEntityId();
    renderDetail(draftId);
    await screen.findByRole('button', { name: /^create$/i });

    expect(screen.getByDisplayValue('Save the defect to set its status')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /change status/i })).not.toBeInTheDocument();
    expect(mockGetIssueStatuses).not.toHaveBeenCalled();
  });

  // assignedTo (UserDropDown) is also not offered pre-save: DynamicAutocomplete
  // (Components/Lists/dropDownList.tsx) PUTs the defect directly on
  // selection using the entity id/mongoId it's given, and neither exists
  // yet for a draft -- rendering it here would be a live footgun, not a
  // faithful port of a legacy behaviour (DefectContent.tsx never reaches
  // this picker before its own "newDefect" tab id is replaced either).
  it('does not offer the assignedTo picker before the record exists', async () => {
    const draftId = makeDraftEntityId();
    renderDetail(draftId);
    await screen.findByRole('button', { name: /^create$/i });

    expect(screen.queryByRole('combobox', { name: 'Assigned To' })).not.toBeInTheDocument();
    expect(mockGetUsersList).not.toHaveBeenCalled();
  });

  it('marks the tab dirty the moment a field is edited, before Create is pressed', async () => {
    const draftId = makeDraftEntityId();
    const { getTabs } = renderDetail(draftId);
    await screen.findByRole('button', { name: /^create$/i });

    const key = tabKey(5, draftId);
    expect(getTabs().find((t) => t.key === key)?.dirty).toBe(false);

    const summaryInput = screen.getByLabelText('Summary', { exact: false });
    fireEvent.change(summaryInput, { target: { value: 'Draft summary' } });
    expect(getTabs().find((t) => t.key === key)?.dirty).toBe(true);
  });

  it('Create saves the entered values (summary, dynamic fields) and replaces the draft tab with the returned defectId', async () => {
    const draftId = makeDraftEntityId();
    const { getTabs, client } = renderDetail(draftId);
    const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
    await screen.findByRole('button', { name: /^create$/i });

    const summaryInput = screen.getByLabelText('Summary', { exact: false });
    fireEvent.change(summaryInput, { target: { value: 'Login crashes on submit' } });
    fireEvent.blur(summaryInput);

    const priorityCombo = screen.getByRole('combobox', { name: 'Priority' });
    fireEvent.mouseDown(priorityCombo);
    fireEvent.click(await screen.findByRole('option', { name: 'High' }));

    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(mockPostDefect).toHaveBeenCalledWith(
        expect.objectContaining({
          summary: 'Login crashes on submit',
          dynamicFields: expect.objectContaining({ Priority: 'High' }),
        }),
      );
    });
    // No parentId is ever sent for a defect -- see this describe block's
    // header comment.
    expect(mockPostDefect).not.toHaveBeenCalledWith(expect.objectContaining({ parentId: expect.anything() }));

    const newKey = tabKey(5, 'DEF-999');
    await waitFor(() => {
      expect(getTabs().find((t) => t.key === newKey)).toBeTruthy();
    });
    const newTab = getTabs().find((t) => t.key === newKey);
    expect(newTab?.title).toBe('DEF-999');
    expect(newTab?.dirty).toBe(false);
    expect(getTabs().find((t) => t.key === tabKey(5, draftId))).toBeUndefined();

    // Module 5 is flat -- root ('0') is the one cache entry a new defect
    // can ever appear under (see this describe block's header comment).
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: qk.children(1, 5, '0') }));
  });

  it('shows an error and leaves the draft tab open when Create fails', async () => {
    mockPostDefect.mockRejectedValueOnce(new Error('boom'));
    const draftId = makeDraftEntityId();
    const { getTabs } = renderDetail(draftId);
    await screen.findByRole('button', { name: /^create$/i });

    const summaryInput = screen.getByLabelText('Summary', { exact: false });
    fireEvent.change(summaryInput, { target: { value: 'Will fail' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not create/i);
    expect(getTabs().find((t) => t.key === tabKey(5, draftId))).toBeTruthy();
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

    const summaryInput = screen.getByLabelText('Summary', { exact: false });
    fireEvent.change(summaryInput, { target: { value: 'New defect' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(mockPostDefect).toHaveBeenCalledWith(
        expect.objectContaining({ tags: ['smoke'] }),
      );
    });
  });

  it('does not offer attachments or links before the defect exists', async () => {
    const draftId = makeDraftEntityId();
    renderDetail(draftId);
    await screen.findByRole('button', { name: /^create$/i });

    expect(screen.queryByRole('tab', { name: 'Attachments' })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Links' })).not.toBeInTheDocument();
  });
});

// A6 -- "Raise defect" (TestRunDetail) opens exactly this draft flow, having
// first recorded a defect-draft intent in the workbench store (prefill text
// plus the link that should be created back to the test case). DefectDetail
// is the one place that intent is ever consumed -- these tests lock down
// both halves: the draft renders pre-filled, and completing it creates the
// bidirectional link exactly once, in the same shape
// Components/LinkIssue/linkissue.tsx's own linkIssuesHandle uses.
describe('DefectDetail — draft pre-filled and linked from a raise-defect intent (A6)', () => {
  it('pre-fills the draft fields from the recorded intent', async () => {
    const draftId = makeDraftEntityId();
    renderDetail(draftId, {
      intent: {
        prefill: { summary: 'Test case TC-1 failed in run Run-1' },
        link: { sourceModule: 1, sourceId: 'TC-1', sourceSummary: 'Login works', linkType: 'relates-to' },
      },
    });
    await screen.findByRole('button', { name: /^create$/i });

    const summaryInput = screen.getByLabelText('Summary', { exact: false }) as HTMLTextAreaElement;
    expect(summaryInput.value).toBe('Test case TC-1 failed in run Run-1');
  });

  it('a draft with no recorded intent still renders empty, same as before A6', async () => {
    const draftId = makeDraftEntityId();
    renderDetail(draftId);
    await screen.findByRole('button', { name: /^create$/i });

    const summaryInput = screen.getByLabelText('Summary', { exact: false }) as HTMLTextAreaElement;
    expect(summaryInput.value).toBe('');
  });

  it('Create also creates the bidirectional link recorded in the intent', async () => {
    mockCreateLink.mockResolvedValue({ _id: 'link-1' });
    const draftId = makeDraftEntityId();
    renderDetail(draftId, {
      intent: {
        prefill: { summary: 'Test case TC-1 failed in run Run-1' },
        link: { sourceModule: 1, sourceId: 'TC-1', sourceSummary: 'Login works', linkType: 'relates-to' },
      },
    });
    await screen.findByRole('button', { name: /^create$/i });

    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(mockPostDefect).toHaveBeenCalled());

    // Forward: test case (module 1) -> new defect (module 5).
    await waitFor(() => {
      expect(mockCreateLink).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceId: 'TC-1',
          destinationId: 'DEF-999',
          srcModule: 1,
          destinationModule: 5,
          linkType: 'relates-to',
        }),
      );
    });
    // Reverse: new defect (module 5) -> test case (module 1) -- the same
    // bidirectional shape linkissue.tsx's linkIssuesHandle creates.
    expect(mockCreateLink).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'DEF-999',
        destinationId: 'TC-1',
        srcModule: 5,
        destinationModule: 1,
        linkType: 'relates-to',
      }),
    );
    expect(mockCreateLink).toHaveBeenCalledTimes(2);
  });

  it('does not attempt a link when the draft carries no link intent', async () => {
    const draftId = makeDraftEntityId();
    renderDetail(draftId, { intent: { prefill: { summary: 'no link here' } } });
    await screen.findByRole('button', { name: /^create$/i });

    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(mockPostDefect).toHaveBeenCalled());
    expect(mockCreateLink).not.toHaveBeenCalled();
  });

  it('a plain draft opened without ever going through "Raise defect" creates no link either', async () => {
    const draftId = makeDraftEntityId();
    renderDetail(draftId);
    await screen.findByRole('button', { name: /^create$/i });

    const summaryInput = screen.getByLabelText('Summary', { exact: false });
    fireEvent.change(summaryInput, { target: { value: 'Just a normal defect' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => expect(mockPostDefect).toHaveBeenCalled());
    expect(mockCreateLink).not.toHaveBeenCalled();
  });
});

// Wave B-4 (clone an entity) -- a SEPARATE prefill mechanism from A6's
// defectDraftIntents above (the store's generic `draftPrefill` map, read by
// every draft-capable module -- workbenchStore.ts's DraftPrefill comment).
// Cloning a defect must never accidentally create a link (that is A6's own,
// unrelated feature): a clone's prefill carries no `link`, and this
// component's clone effect never touches consumeDefectDraftIntent at all.
describe('DefectDetail — draft pre-filled from a clone prefill (B-4)', () => {
  it('renders pre-filled and Create saves it as a normal new record, with no link created', async () => {
    const draftId = makeDraftEntityId();
    renderDetail(draftId, { prefill: { summary: 'Copy of Login button does nothing', Priority: 'High' } });
    await screen.findByRole('button', { name: /^create$/i });

    const summaryInput = screen.getByLabelText('Summary', { exact: false }) as HTMLTextAreaElement;
    expect(summaryInput.value).toBe('Copy of Login button does nothing');

    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(mockPostDefect).toHaveBeenCalledWith(
        expect.objectContaining({
          summary: 'Copy of Login button does nothing',
          dynamicFields: expect.objectContaining({ Priority: 'High' }),
        }),
      );
    });
    expect(mockCreateLink).not.toHaveBeenCalled();
  });
});
