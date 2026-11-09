/* eslint-disable testing-library/no-node-access -- `qk.children(...)` is
   Hooks/queryKeys.ts's key-builder function, not DOM node traversal;
   eslint-plugin-testing-library's no-node-access rule pattern-matches on
   the property name alone and false-positives here (same reasoning as
   AiDuplicateAuditToolbar.test.tsx and Hooks/__tests__/useTreeChildren.test.tsx). */
import React, { useEffect } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkbenchStoreProvider, useWorkbench } from '../../WorkbenchStoreProvider';
import { tabKey, makeDraftEntityId } from '../../store/workbenchStore';
import { qk } from '../../../Hooks/queryKeys';
import { TestCaseDetail } from '../modules/TestCaseDetail';
import { getFields, getTcList, updateTestCase, getComments, updateTestCaseStatus, saveTestCase } from '../../../api/apiCalls';
import { listSharedSteps } from '../../../api/sharedStepApi';
import { createCaseTemplate } from '../../../api/caseTemplateApi';

// WP-074 Part A -- TestCaseDetail is the first module built on the shared
// detail kit (DetailHeader/FieldGrid/DetailTabs/LinksSection/
// CommentsSection). Nothing here is wired into the running app yet (that
// is Steps 5-10 of this WP); this only proves the component itself.
//
// react-quill is not exercised by any field in these fixtures (no
// fieldType: 'Editor'), so unlike DefectContent.a11y.test.tsx it does not
// need a mock here -- merely importing it (FieldGrid does, unconditionally)
// does not touch the DOM APIs that make rendering it awkward under jsdom.
jest.mock('../../../api/apiCalls', () => ({
  getFields: jest.fn(),
  getTcList: jest.fn(),
  updateTestCase: jest.fn(),
  saveTestCase: jest.fn(),
  // Comments (Components/comments/displayComments.tsx) is always mounted
  // (it sits below the tabs, exactly where TabContent.tsx:866 put it) and
  // fetches on mount regardless of anything this test cares about.
  getComments: jest.fn(),
  // WP-074e Part 1a -- LifecycleStatus's own API calls, exercised once it
  // is reachable again from TestCaseDetail.
  updateTestCaseStatus: jest.fn(),
  getTestCaseVersions: jest.fn(),
  updateRequirementStatus: jest.fn(),
  getRequirementVersions: jest.fn(),
}));

// WP-F06 Task 6 fix round 1 -- TestCaseDetail now queries listSharedSteps()
// itself (to resolve a reference row's LIVE title -- see that file's own
// header comment for why the stored `sharedStepTitle` goes stale). None of
// the fixtures below carry a `sharedStepId`, so this query's `enabled` gate
// stays false and it is never actually called for the suite's existing
// tests -- mocked here only so the one new test below that DOES exercise a
// reference row doesn't reach a real, unmocked axios call.
jest.mock('../../../api/sharedStepApi', () => ({
  listSharedSteps: jest.fn(),
}));

// WP-F08 Task 2 -- only needed for the "Save as template" wiring test
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

// WP-F05b fix round 1 -- this file had no usePermissions mock at all, so
// the real hook ran, its getProjects() query never resolved a member/role
// under jsdom, and canWrite was false for every test here (every FieldGrid
// control silently rendered disabled-but-present -- harmless for
// fireEvent.change, which still dispatches the underlying event regardless
// of the `disabled` attribute, but TagsSection hides its add-tag input
// entirely rather than disabling it, so this file's own new
// create-with-tags regression test needs write access to reach it at all).
// Matches DefectDetail.test.tsx's own identical static mock.
jest.mock('../../../Hooks/usePermissions', () => ({
  __esModule: true,
  usePermissions: () => ({ can: () => true, role: 'contributor', isLoading: false, isError: false }),
  default: () => ({ can: () => true, role: 'contributor', isLoading: false, isError: false }),
}));

const mockGetFields = getFields as jest.Mock;
const mockGetTcList = getTcList as jest.Mock;
const mockUpdateTestCase = updateTestCase as jest.Mock;
const mockSaveTestCase = saveTestCase as jest.Mock;
const mockGetComments = getComments as jest.Mock;
const mockUpdateTestCaseStatus = updateTestCaseStatus as jest.Mock;
const mockListSharedSteps = listSharedSteps as jest.Mock;
const mockCreateCaseTemplate = createCaseTemplate as jest.Mock;

// Mirrors the shape TabContent.tsx reads from getFields(1): fieldName,
// displayName, fieldType, isDisplayed, isMandatory, isDefault, and (for
// DropDown) defaultValue. TestCaseSummary is deliberately included to
// prove FieldGrid excludes it from the generic grid (TabContent.tsx:705)
// -- it is rendered by DetailHeader instead.
const FIELDS = [
  { fieldName: 'TestCaseSummary', displayName: 'Summary', fieldType: 'TextArea', isDisplayed: true, isMandatory: true, isDefault: true },
  { fieldName: 'priority', displayName: 'Priority', fieldType: 'Text', isDisplayed: true, isMandatory: false, isDefault: false },
  { fieldName: 'environment', displayName: 'Environment', fieldType: 'DropDown', isDisplayed: true, isMandatory: false, isDefault: false, defaultValue: ['QA', 'Prod'] },
  { fieldName: 'hiddenField', displayName: 'Hidden', fieldType: 'Text', isDisplayed: false, isMandatory: false, isDefault: false },
];

const TC_RECORD = {
  _id: 'abc123',
  TestCaseId: 'TC-1',
  TestCaseSummary: 'Login should work',
  TestSteps: [{ testStep: 'Open app', Expected: 'App opens' }],
  dynamicFields: { priority: 'Low', environment: 'QA', hiddenField: 'nope' },
  status: 'draft',
};

function renderDetail(
  entityId = 'TC-1',
  opts: {
    seed?: (client: QueryClient, setSelection: (id: string | null) => void) => void;
    // Wave B-4 (clone) -- mirrors DefectDetail.test.tsx's own
    // `options.intent` harness: recorded BEFORE the tab opens, exactly
    // the ordering useCloneEntity.ts itself uses.
    prefill?: Record<string, unknown>;
  } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let latestTabs: ReturnType<typeof useWorkbench<Array<{ key: string; entityId: string; title: string; dirty: boolean }>>> = [];

  function Harness() {
    const openTab = useWorkbench((s) => s.openTab);
    const setSelection = useWorkbench((s) => s.setSelection);
    const setDraftPrefill = useWorkbench((s) => s.setDraftPrefill);
    latestTabs = useWorkbench((s) => s.tabs);
    useEffect(() => {
      if (opts.prefill) {
        setDraftPrefill(entityId, opts.prefill);
      }
      openTab({ module: 1, entityId, title: entityId });
      opts.seed?.(client, (id) => setSelection(1, id));
      // Mount-only: this seeds the tab this test asserts dirty-tracking
      // against, mirroring how the real shell would already have an open
      // tab before TestCaseDetail renders inside it.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <TestCaseDetail entityId={entityId} />;
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
  mockGetTcList.mockResolvedValue([TC_RECORD]);
  mockUpdateTestCase.mockResolvedValue({ success: true });
  mockSaveTestCase.mockResolvedValue({ TestCaseId: 'TC-999' });
  mockGetComments.mockResolvedValue([]);
  mockUpdateTestCaseStatus.mockResolvedValue({ data: { status: 'review' } });
  // None of the fixtures above carry a sharedStepId, so this stays unused
  // for every existing test (the query's `enabled` gate never opens) --
  // only the WP-F06 Task 6 fix-round-1 test below overrides it.
  mockListSharedSteps.mockResolvedValue([]);
  mockCreateCaseTemplate.mockResolvedValue({ _id: 'ct1', CaseTemplateId: 'CT-1' });
});

describe('TestCaseDetail', () => {
  it('renders the test case id and summary', async () => {
    renderDetail();
    expect(await screen.findByText(/TC-1/)).toBeInTheDocument();
    expect(screen.getByText(/Login should work/)).toBeInTheDocument();
    // Comments (always mounted below the tabs) fetches on mount; letting
    // that settle before the test ends avoids an unrelated act() warning
    // from its own post-render setState, not something this WP owns.
    await screen.findByText(/No comments yet/);
  });

  // WP-F08 Task 2 -- "Save as template" is wired into this module's real
  // record view, and captures the CURRENTLY LOADED record's fields (R1),
  // not a blank form or a form typed by the test.
  it('offers "Save as template" and captures this test case\'s own loaded fields on save', async () => {
    renderDetail();
    await screen.findByText(/TC-1/);

    const saveAsTemplateButton = screen.getByRole('button', { name: /save as template/i });
    fireEvent.click(saveAsTemplateButton);
    const dialog = await screen.findByRole('dialog', { name: /save as template/i });
    fireEvent.change(within(dialog).getByLabelText('Template name'), { target: { value: 'Login regression' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockCreateCaseTemplate).toHaveBeenCalledTimes(1));
    const payload = mockCreateCaseTemplate.mock.calls[0][0];
    expect(payload.moduleId).toBe(1);
    // TC_RECORD's own fields, read back off the dialog's captured prefill
    // -- the single-line break this catches: passing an empty object
    // instead of this component's own `values` as SaveAsTemplateDialog's
    // `record` prop makes both fail.
    expect(payload.prefill.TestCaseSummary).toBe(TC_RECORD.TestCaseSummary);
    expect(payload.prefill.TestSteps).toEqual(TC_RECORD.TestSteps);
  });

  it('renders dynamic fields from the field definitions', async () => {
    renderDetail();
    await screen.findByText(/TC-1/);
    // Comments (always mounted below the tabs) fetches on mount; letting
    // that settle before the test ends avoids an unrelated act() warning
    // from its own post-render setState, not something this WP owns.
    await screen.findByText(/No comments yet/);
    expect(screen.getByLabelText('Priority')).toHaveValue('Low');
    expect(screen.getByRole('combobox', { name: 'Environment' })).toHaveTextContent('QA');
    // isDisplayed: false -- must not appear anywhere in the generic grid.
    expect(screen.queryByText('Hidden')).not.toBeInTheDocument();
    // The two special-cased names (TestCaseSummary here) are excluded from
    // the generic grid -- DetailHeader already showed the summary above.
    expect(screen.queryByLabelText('Summary')).not.toBeInTheDocument();
  });

  it('renders the steps table', async () => {
    renderDetail();
    await screen.findByText(/TC-1/);
    // Comments (always mounted below the tabs) fetches on mount; letting
    // that settle before the test ends avoids an unrelated act() warning
    // from its own post-render setState, not something this WP owns.
    await screen.findByText(/No comments yet/);
    fireEvent.click(screen.getByRole('tab', { name: 'Steps' }));
    const stepsTable = screen.getByRole('table');
    expect(within(stepsTable).getByText('Steps')).toBeInTheDocument();
    expect(within(stepsTable).getByText('Expected')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Open app')).toBeInTheDocument();
    expect(screen.getByDisplayValue('App opens')).toBeInTheDocument();
  });

  // WP-F06 Task 6 fix round 1 -- found by the closing e2e journey and fixed
  // here: a reference row's stored `sharedStepTitle` is a snapshot taken at
  // insert time (TestStepSchema has no way to keep it in sync), so it goes
  // stale the moment the shared step is renamed -- the stored row keeps
  // showing the OLD title forever, since nothing fans a rename out to every
  // referencing test case. The fix resolves the title live from the same
  // `listSharedSteps()` list the picker/manager already query, preferring
  // it over the stored value. Non-vacuous: confirmed by temporarily making
  // the resolver in TestCaseDetail.tsx return the stored title unconditionally
  // (i.e. skipping the live lookup) -- this test failed (it found the STALE
  // title, not the live one) -- then reverting, which restored the pass.
  it('renders a shared-step reference row using the LIVE title, not the stale stored one', async () => {
    const STALE_TITLE = 'Log in as admin (old)';
    const LIVE_TITLE = 'Log in as admin (renamed)';
    const SHARED_STEP_ID = 'shared-mongo-id-1';

    mockGetTcList.mockResolvedValue([
      {
        ...TC_RECORD,
        TestSteps: [
          { testStep: '', Expected: '', sharedStepId: SHARED_STEP_ID, sharedStepTitle: STALE_TITLE },
        ],
      },
    ]);
    // The live library now disagrees with the stored snapshot -- this is
    // exactly what a rename through SharedStepManagerDialog produces.
    mockListSharedSteps.mockResolvedValue([
      { _id: SHARED_STEP_ID, id: 1, SharedStepId: 'SS-1', projectId: 1, title: LIVE_TITLE, steps: [] },
    ]);

    renderDetail();
    await screen.findByText(/TC-1/);
    await screen.findByText(/No comments yet/);
    fireEvent.click(screen.getByRole('tab', { name: 'Steps' }));

    expect(await screen.findByText(LIVE_TITLE)).toBeInTheDocument();
    expect(screen.queryByText(STALE_TITLE)).not.toBeInTheDocument();
  });

  it('saves a single field without entering a global edit mode', async () => {
    renderDetail();
    await screen.findByText(/TC-1/);
    // Comments (always mounted below the tabs) fetches on mount; letting
    // that settle before the test ends avoids an unrelated act() warning
    // from its own post-render setState, not something this WP owns.
    await screen.findByText(/No comments yet/);

    // No global Edit/Save/Cancel toggle exists at all -- the one
    // deliberate behaviour change this WP makes (per-field inline edit
    // replaces it).
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();

    const priorityInput = screen.getByLabelText('Priority');
    fireEvent.change(priorityInput, { target: { value: 'High' } });
    fireEvent.blur(priorityInput); // blur -- the chosen commit trigger for free-text fields

    await waitFor(() => {
      expect(mockUpdateTestCase).toHaveBeenCalledWith(
        expect.objectContaining({ dynamicFields: { priority: 'High' } }),
        'abc123',
      );
    });
  });

  it('marks its tab dirty on change', async () => {
    const { getTabs } = renderDetail();
    await screen.findByText(/TC-1/);
    // Comments (always mounted below the tabs) fetches on mount; letting
    // that settle before the test ends avoids an unrelated act() warning
    // from its own post-render setState, not something this WP owns.
    await screen.findByText(/No comments yet/);

    const key = tabKey(1, 'TC-1');
    expect(getTabs().find((t) => t.key === key)?.dirty).toBe(false);

    const priorityInput = screen.getByLabelText('Priority');
    fireEvent.change(priorityInput, { target: { value: 'High!' } });
    // Still focused / not yet blurred -- dirty must already be true, proving
    // dirty-tracking is independent of the commit (blur) itself.
    expect(getTabs().find((t) => t.key === key)?.dirty).toBe(true);
  });

  // D2 / WP-074c bug 2 -- Quill fires its own onChange while normalising the
  // initial content it was handed, with `source: 'api'` rather than 'user'.
  // FieldGrid's EditorField (FieldGrid.tsx) ignores any onChange whose
  // `source !== 'user'` specifically to stop that normalisation pass from
  // being reported as an edit -- without the guard, every tab carrying an
  // Editor field was marked dirty the instant it was opened, before the
  // user touched anything. This was previously guarded only by a code
  // comment and a browser check (EXECUTION_LOG.md, 2026-09-03); no jest
  // regression test existed. Proven non-vacuous by temporarily deleting the
  // `if (source !== 'user') return;` line in FieldGrid.tsx: this test fails
  // (dirty becomes true) with the guard gone, and passes again once it is
  // restored.
  it('does not mark the tab dirty just from opening a record with an Editor field', async () => {
    const fieldsWithEditor = [
      ...FIELDS,
      { fieldName: 'TestCaseDescription', displayName: 'Description', fieldType: 'Editor', isDisplayed: true, isMandatory: false, isDefault: true },
    ];
    mockGetFields.mockResolvedValueOnce(fieldsWithEditor);
    // A plain string, not a serialised Quill Delta -- exactly the shape
    // TC-695 (the real record this bug was found against) stores, and the
    // shape whose normalisation pass triggers Quill's spurious onChange
    // hardest (parseEditorValue's own header comment/test cover the same
    // real record for the *other* WP-074c bug).
    mockGetTcList.mockResolvedValueOnce([{ ...TC_RECORD, TestCaseDescription: 'seeded for the dirty-on-open regression' }]);

    const { getTabs } = renderDetail();
    await screen.findByText(/TC-1/);
    // Comments fetch on mount; let that settle first (see other tests'
    // comment on the same wait for why).
    await screen.findByText(/No comments yet/);
    // Let ReactQuill actually mount and finish normalising the initial
    // content -- this is the exact moment the bug fired. Waiting for the
    // editor to show the real content (not just existing in the DOM) is
    // what proves normalisation has already happened by the time dirty is
    // checked below.
    await waitFor(() => {
      expect(document.querySelector('.ql-editor')).toHaveTextContent('seeded for the dirty-on-open regression');
    });

    const key = tabKey(1, 'TC-1');
    expect(getTabs().find((t) => t.key === key)?.dirty).toBe(false);
  });

  // WP-074e Part 1a -- LifecycleStatus (Sprint 2.1 governance) was rendered
  // by TabContent.tsx:637-650 for module 1 but never ported into
  // TestCaseDetail; deleting Pages/testcases.tsx made it unreachable. This
  // proves it is reachable again, and that a status change goes through
  // React Query rather than a useState copy of server data.
  describe('lifecycle status (WP-074e Part 1a)', () => {
    it('renders the lifecycle control once the test case has loaded', async () => {
      renderDetail();
      await screen.findByText(/TC-1/);
      await screen.findByText(/No comments yet/);

      expect(screen.getByText('draft')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /change status/i })).toBeInTheDocument();
    });

    it('a status change invalidates the entity query rather than setting local state', async () => {
      // Models the server actually having moved to 'review' by the time
      // LifecycleStatusSection's post-mutation invalidate triggers a
      // refetch -- proving the new status reaches the screen via that
      // refetch (React Query), not a page-level setFieldValues copy (which
      // TestCaseDetail keeps none of at all).
      mockGetTcList
        .mockResolvedValueOnce([TC_RECORD])
        .mockResolvedValueOnce([{ ...TC_RECORD, status: 'review' }]);

      renderDetail();
      await screen.findByText(/TC-1/);
      await screen.findByText(/No comments yet/);

      fireEvent.click(screen.getByRole('button', { name: /change status/i }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'review' }));

      await waitFor(() => {
        expect(mockUpdateTestCaseStatus).toHaveBeenCalledWith('abc123', 'review');
      });
      expect(await screen.findByText('review')).toBeInTheDocument();
    });
  });
});

// WP-079 Part A -- the workbench has had no create flow at all: this is
// the module-1 half of it. `entityId` here is a draft sentinel
// (makeDraftEntityId(), store's `new:<random>`), not a business key --
// there is no server record for getTcList to fetch, so TestCaseDetail must
// not call it at all. Fields still come from getFields(1) (dynamic,
// DB-driven, same as a real entity) -- only the entity data itself is
// local until Create is pressed.
describe('TestCaseDetail — draft mode (create a new test case)', () => {
  it('never fetches an entity for a draft id', async () => {
    const draftId = makeDraftEntityId();
    renderDetail(draftId);
    await screen.findByRole('button', { name: /^create$/i });
    expect(mockGetTcList).not.toHaveBeenCalled();
  });

  it('still loads field definitions and renders them empty', async () => {
    const draftId = makeDraftEntityId();
    renderDetail(draftId);
    await screen.findByRole('button', { name: /^create$/i });
    expect(mockGetFields).toHaveBeenCalledWith(1);
    expect(screen.getByLabelText('Priority')).toHaveValue('');
    // MUI's Select always renders a (zero-width) placeholder span even
    // with no value selected, so this checks for the absence of any real
    // option's text rather than an empty DOM node.
    const environmentCombo = screen.getByRole('combobox', { name: 'Environment' });
    expect(environmentCombo).not.toHaveTextContent('QA');
    expect(environmentCombo).not.toHaveTextContent('Prod');
    // isDisplayed: false still excluded, same as the real-entity path.
    expect(screen.queryByText('Hidden')).not.toBeInTheDocument();
  });

  it('marks the tab dirty the moment a field is edited, before Create is pressed', async () => {
    const draftId = makeDraftEntityId();
    const { getTabs } = renderDetail(draftId);
    await screen.findByRole('button', { name: /^create$/i });

    const key = tabKey(1, draftId);
    expect(getTabs().find((t) => t.key === key)?.dirty).toBe(false);

    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: 'High' } });
    expect(getTabs().find((t) => t.key === key)?.dirty).toBe(true);
  });

  it('Create saves the entered values (summary, dynamic fields, parentId) and replaces the draft tab with the returned business id', async () => {
    const draftId = makeDraftEntityId();
    const { getTabs, client } = renderDetail(draftId);
    const invalidateSpy = jest.spyOn(client, 'invalidateQueries');
    await screen.findByRole('button', { name: /^create$/i });

    fireEvent.change(screen.getByLabelText('Summary'), { target: { value: 'New login flow' } });
    const priorityInput = screen.getByLabelText('Priority');
    fireEvent.change(priorityInput, { target: { value: 'High' } });
    fireEvent.blur(priorityInput); // commit trigger for free-text fields, same as the real-entity path
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(mockSaveTestCase).toHaveBeenCalledWith(
        expect.objectContaining({
          TestCaseSummary: 'New login flow',
          parentId: 0, // nothing selected -> legacy root default
          dynamicFields: expect.objectContaining({ priority: 'High' }),
        }),
      );
    });

    const newKey = tabKey(1, 'TC-999');
    await waitFor(() => {
      expect(getTabs().find((t) => t.key === newKey)).toBeTruthy();
    });
    const newTab = getTabs().find((t) => t.key === newKey);
    expect(newTab?.title).toBe('TC-999');
    expect(newTab?.dirty).toBe(false);
    // The draft tab itself is gone -- replaceTab swaps in place, it
    // doesn't add a second tab (legacy TabContent.tsx's filter-then-append
    // bug this WP explicitly does not reproduce).
    expect(getTabs().find((t) => t.key === tabKey(1, draftId))).toBeUndefined();

    // The tree's root-children query is what EntityTree reads from
    // (Hooks/queries/useTreeChildren.ts) -- invalidating it is what makes
    // the freshly-created row appear without a manual refresh.
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: qk.children(1, 1, '0') }));
  });

  it("derives parentId from the currently selected folder, per the legacy rule", async () => {
    const draftId = makeDraftEntityId();
    const { getTabs } = renderDetail(draftId, {
      seed: (client, setSelection) => {
        client.setQueryData(qk.children(1, 1, '0'), [{ id: '7', parent: '0', droppable: true, text: 'Folder 7' }]);
        setSelection('7');
      },
    });
    await screen.findByRole('button', { name: /^create$/i });

    fireEvent.change(screen.getByLabelText('Summary'), { target: { value: 'Under folder 7' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(mockSaveTestCase).toHaveBeenCalledWith(expect.objectContaining({ parentId: 7 }));
    });
    await waitFor(() => {
      expect(getTabs().find((t) => t.key === tabKey(1, 'TC-999'))).toBeTruthy();
    });
  });

  it('shows an error and leaves the draft tab open when Create fails', async () => {
    mockSaveTestCase.mockRejectedValueOnce(new Error('boom'));
    const draftId = makeDraftEntityId();
    const { getTabs } = renderDetail(draftId);
    await screen.findByRole('button', { name: /^create$/i });

    fireEvent.change(screen.getByLabelText('Summary'), { target: { value: 'Will fail' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not create/i);
    expect(getTabs().find((t) => t.key === tabKey(1, draftId))).toBeTruthy();
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

    fireEvent.change(screen.getByLabelText('Summary'), { target: { value: 'New login flow' } });
    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(mockSaveTestCase).toHaveBeenCalledWith(
        expect.objectContaining({ tags: ['smoke'] }),
      );
    });
  });

  // Wave B-4 (clone an entity, PRODUCT_GAP_REGISTER.md B1) -- proves the
  // OTHER half of useCloneEntity.ts's contract: given a draft whose
  // prefill was already recorded (the tree row's "Clone" action does this
  // before ever opening the tab), the draft form renders pre-filled, and
  // Create then saves it through the exact same normal create path the
  // "Create saves the entered values..." test above already covers -- a
  // clone is nothing but an ordinary new record with a head start.
  it('seeded from a clone prefill: renders pre-filled and Create saves it as a normal new record', async () => {
    const draftId = makeDraftEntityId();
    const { getTabs } = renderDetail(draftId, {
      prefill: {
        TestCaseSummary: 'Copy of Login should work',
        TestCaseDescription: 'Original description',
        priority: 'Low',
        TestSteps: [{ testStep: 'Open app', Expected: 'App opens' }],
      },
    });
    await screen.findByRole('button', { name: /^create$/i });

    expect(screen.getByLabelText('Summary')).toHaveValue('Copy of Login should work');
    expect(screen.getByLabelText('Priority')).toHaveValue('Low');
    fireEvent.click(screen.getByRole('tab', { name: 'Steps' }));
    expect(screen.getByDisplayValue('Open app')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Details' }));

    fireEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(mockSaveTestCase).toHaveBeenCalledWith(
        expect.objectContaining({
          TestCaseSummary: 'Copy of Login should work',
          TestCaseDescription: 'Original description',
          dynamicFields: expect.objectContaining({ priority: 'Low' }),
        }),
      );
    });
    await waitFor(() => {
      expect(getTabs().find((t) => t.key === tabKey(1, 'TC-999'))).toBeTruthy();
    });
  });
});
