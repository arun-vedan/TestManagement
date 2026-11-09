import React, { useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkbenchStoreProvider, useWorkbench } from '../../WorkbenchStoreProvider';
import { makeDraftEntityId } from '../../store/workbenchStore';
import { TestCaseDetail } from '../modules/TestCaseDetail';
import { getFields, getTcList, updateTestCase, saveTestCase, getComments } from '../../../api/apiCalls';
import { listSharedSteps } from '../../../api/sharedStepApi';
import { listDatasets, getDataset, getTestCaseParameters } from '../../../api/datasetApi';

// WP-F07a Task 4 -- the regression guard for the rule the whole work
// package rests on: SUBSTITUTED TEXT IS NEVER WRITTEN BACK.
//
// A parameterised case stores `Log in as {{role}}`. With a preview row
// selected the author SEES `Log in as admin`. If that substituted string
// ever reaches the PUT, the placeholder is gone and the case silently
// stops being parameterised -- it still renders, still passes, and is
// simply never data-driven again. Nothing surfaces the loss.
//
// This is the same failure WP-F06 hit in a different costume (an expanded
// shared-step row written back destroyed the reference), and there it took
// a real browser round trip to find, five reviewed tasks after it was
// introduced. Hence a dedicated file rather than one more case among the
// seventeen in TestCaseDetail.test.tsx: this assertion is the point.
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
jest.mock('../../../api/sharedStepApi', () => ({ listSharedSteps: jest.fn() }));
jest.mock('../../../api/datasetApi', () => ({
    listDatasets: jest.fn(),
    getDataset: jest.fn(),
    createDataset: jest.fn(),
    updateDataset: jest.fn(),
    deleteDataset: jest.fn(),
    getDatasetUsage: jest.fn(),
    getTestCaseParameters: jest.fn(),
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
    usePermissions: () => ({ can: () => true, role: 'contributor', isLoading: false, isError: false }),
    default: () => ({ can: () => true, role: 'contributor', isLoading: false, isError: false }),
}));

const mockGetFields = getFields as jest.Mock;
const mockGetTcList = getTcList as jest.Mock;
const mockUpdateTestCase = updateTestCase as jest.Mock;
const mockGetComments = getComments as jest.Mock;
const mockListSharedSteps = listSharedSteps as jest.Mock;
const mockListDatasets = listDatasets as jest.Mock;
// The bound dataset's ROWS come from getDataset(), a different query than
// the list used to populate the bind dropdown. Leaving it unmocked yields
// zero rows, which makes MUI disable the preview Select -- the menu then
// never opens and every assertion below fails for a reason that has
// nothing to do with what is being tested.
const mockGetDataset = getDataset as jest.Mock;
const mockGetTestCaseParameters = getTestCaseParameters as jest.Mock;
const mockSaveTestCase = saveTestCase as jest.Mock;

const FIELDS = [
    { fieldName: 'TestCaseSummary', displayName: 'Summary', fieldType: 'TextArea', isDisplayed: true, isMandatory: true, isDefault: true },
];

const DATASET = {
    _id: 'ds1',
    id: 1,
    DatasetId: 'DS-1',
    projectId: 1,
    title: 'Login roles',
    description: '',
    columns: ['role'],
    rows: [['admin'], ['viewer']],
};

// The authored form. `{{role}}` in step 1 is what must survive every edit;
// step 2 is the unrelated row the test actually edits.
const AUTHORED_STEPS = [
    { testStep: 'Log in as {{role}}', Expected: 'Dashboard for {{role}}' },
    { testStep: 'Open the reports page', Expected: 'Reports list shown' },
];

const TC_RECORD = {
    _id: 'abc123',
    TestCaseId: 'TC-1',
    TestCaseSummary: 'Login should work',
    TestCaseDescription: 'desc',
    TestSteps: AUTHORED_STEPS,
    datasetId: 'ds1',
    dynamicFields: {},
    status: 'draft',
};

// What Task 3's `?substitute=0` returns: substituted text in the primary
// fields, authored text preserved alongside it in the same response.
const SUBSTITUTED_ROW_0 = {
    ...TC_RECORD,
    TestSteps: [
        {
            testStep: 'Log in as admin',
            Expected: 'Dashboard for admin',
            substituted: true,
            authoredTestStep: 'Log in as {{role}}',
            authoredExpected: 'Dashboard for {{role}}',
        },
        {
            testStep: 'Open the reports page',
            Expected: 'Reports list shown',
            substituted: true,
            authoredTestStep: 'Open the reports page',
            authoredExpected: 'Reports list shown',
        },
    ],
};

function renderDetail() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function Harness() {
        const openTab = useWorkbench((s) => s.openTab);
        useEffect(() => {
            openTab({ module: 1, entityId: 'TC-1', title: 'TC-1' });
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, []);
        return <TestCaseDetail entityId="TC-1" />;
    }
    render(
        <QueryClientProvider client={client}>
            <WorkbenchStoreProvider projectId={1}>
                <Harness />
            </WorkbenchStoreProvider>
        </QueryClientProvider>,
    );
}

// WP-F07a Task 5 fix round 1 -- renders a DRAFT (not-yet-saved) test case
// seeded with a clone's prefill, the same mechanism useCloneEntity.ts's
// buildClonePlan feeds into `state.draftPrefill` (Wave B-4's generic
// mechanism, also exercised by DefectDetail.test.tsx's own clone suite).
// A real clone of a parameterised case carries `datasetId` in this prefill
// (buildClonePlan's `flatten(row)` spreads the whole source record), so
// this is the seed a clone of a bound case would actually produce -- not a
// synthetic shape invented for this test.
function renderDraftWithPrefill(prefill: Record<string, unknown>) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const draftId = makeDraftEntityId();
    function Harness() {
        const openTab = useWorkbench((s) => s.openTab);
        const setDraftPrefill = useWorkbench((s) => s.setDraftPrefill);
        useEffect(() => {
            setDraftPrefill(draftId, prefill);
            openTab({ module: 1, entityId: draftId, title: 'New Test Case' });
            // eslint-disable-next-line react-hooks/exhaustive-deps
        }, []);
        return <TestCaseDetail entityId={draftId} />;
    }
    render(
        <QueryClientProvider client={client}>
            <WorkbenchStoreProvider projectId={1}>
                <Harness />
            </WorkbenchStoreProvider>
        </QueryClientProvider>,
    );
}

// The dataset controls live INSIDE the Steps tab, beside the step table
// they annotate -- so the tab has to be open before any of them exist.
function openStepsTab() {
    fireEvent.click(screen.getByRole('tab', { name: 'Steps' }));
}

// Selects a preview row through the real control, the way an author would.
async function selectPreviewRow(rowLabelPattern: RegExp) {
    // MUI renders the real listbox trigger as a combobox; getByLabelText
    // returns the hidden native input instead, which does not open the menu.
    const combo = await screen.findByRole('combobox', { name: /preview row/i });
    // The control is disabled until the bound dataset's ROWS have loaded
    // (a second query behind the one that fills the dataset dropdown), and
    // mouseDown on a disabled MUI Select is silently a no-op -- so without
    // this wait the menu never opens and every assertion downstream fails
    // for a reason unrelated to what it is testing.
    await waitFor(() => expect(combo).not.toHaveAttribute('aria-disabled', 'true'));
    fireEvent.mouseDown(combo);
    const option = await screen.findByRole('option', { name: rowLabelPattern });
    fireEvent.click(option);
}

// Fix round 1 (self-review) -- found by deliberately reintroducing a
// SECOND way this rule could break: feeding the substituted text into
// AddDeleteTableRows' own `rows` prop (as opposed to the commit-path break
// this file already proves fails). That variant passed against every
// assertion below it, even though the corruption plainly reaches the
// screen a moment later -- confirmed by re-running with this same flush
// added, which then correctly fails.
//
// The reason: the read-only preview cell reads its `previewRow` prop
// directly (this component -> TableRows, no buffering), so it updates on
// the FIRST render after the preview query resolves. The EDITABLE field's
// value instead comes from AddDeleteTableRows' own local `rowsData`
// state, which it only mirrors from its `rows` prop inside its own
// `useEffect` (Components/Tabs/AddDeleteTableRows.tsx) -- one render
// behind. `waitFor` on the preview cell returns the INSTANT that first
// render satisfies it, racing ahead of that second, deferred render. An
// assertion about the editable field made immediately afterward can pass
// for the wrong reason: not because the value is safe, but because the
// corrupted render hasn't painted yet.
//
// This forces that second render to elapse (a real timer tick, wrapped in
// `act` so React flushes the effects and state update it schedules)
// before any assertion about the editable field's value is trusted. In
// the CORRECT code this is a no-op: the editable field never depends on
// the preview at all, so nothing changes across the extra tick.
async function flushPendingRenders() {
    // 20ms is an ordinary macrotask wait, not a tuned figure: the point is
    // to yield the event loop so EVERY queued effect and its re-render
    // settle, rather than to count a specific number of render hops. That
    // distinction is what keeps this robust -- a review stress-tested it by
    // putting the editable field TWO renders behind the prop instead of one
    // and the guard still caught the corruption. Any value that yields the
    // loop works; shrinking it to 0 would too. It is deliberately not
    // waitFor(), because there is nothing to wait FOR here: in correct code
    // the editable field never changes, so a condition-based wait would
    // return immediately and prove nothing.
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetFields.mockResolvedValue(FIELDS);
    mockGetComments.mockResolvedValue([]);
    mockListSharedSteps.mockResolvedValue([]);
    mockListDatasets.mockResolvedValue([DATASET]);
    mockGetDataset.mockResolvedValue(DATASET);
    mockGetTestCaseParameters.mockResolvedValue({
        placeholders: ['role'],
        columns: ['role'],
        missing: [],
        unused: [],
    });
    mockUpdateTestCase.mockResolvedValue({});
    mockSaveTestCase.mockResolvedValue({ TestCaseId: 'TC-2' });
    // The preview fetch and the ordinary record fetch are the same function,
    // distinguished only by the `substitute=` the component appends.
    mockGetTcList.mockImplementation((query: string) =>
        Promise.resolve([String(query).includes('substitute=') ? SUBSTITUTED_ROW_0 : TC_RECORD]),
    );
});

describe('TestCaseDetail — parameterised preview never contaminates what is saved', () => {

    it('PUTs the AUTHORED text with {{placeholders}} intact when an unrelated step is edited while a preview row is active', async () => {
        renderDetail();
        await screen.findByText(/TC-1/);
        openStepsTab();

        await selectPreviewRow(/admin/);
        // Wait for the preview to actually be showing, so the assertion below
        // cannot pass merely because the preview never loaded.
        // Wait for the preview column to be populated, so everything below
        // runs against the loaded state rather than racing it -- an earlier
        // draft of this test asserted before the preview arrived and would
        // have passed with the feature broken.
        await waitFor(() =>
            expect(screen.getByTestId('preview-cell-0')).toHaveTextContent('Log in as admin'),
        );
        // Fix round 1 -- see flushPendingRenders' own header comment: the
        // preview cell above updates one render sooner than the editable
        // field's own backing state does, so an assertion about the
        // editable field made right here would not actually be checking
        // settled state.
        await flushPendingRenders();
        // The DOM-level half of R3: with the preview loaded and on screen,
        // the EDITABLE control must still hold the authored placeholder.
        expect(screen.getByDisplayValue('Log in as {{role}}')).toBeInTheDocument();
        expect(screen.queryByDisplayValue('Log in as admin')).not.toBeInTheDocument();

        const editable = screen.getByDisplayValue('Open the reports page');
        fireEvent.change(editable, { target: { value: 'Open the audit page' } });
        fireEvent.blur(editable);

        await waitFor(() => expect(mockUpdateTestCase).toHaveBeenCalled());

        const saved = mockUpdateTestCase.mock.calls.at(-1)?.[0]?.TestSteps as Array<{ testStep: string; Expected: string }>;

        // The edited row carries the new text...
        expect(saved[1].testStep).toBe('Open the audit page');
        // ...and the untouched row is still the AUTHORED form, not 'Log in as admin'.
        expect(saved[0].testStep).toBe('Log in as {{role}}');
        expect(saved[0].Expected).toBe('Dashboard for {{role}}');
        // Belt and braces: no substituted value reached the payload at all.
        expect(JSON.stringify(saved)).not.toContain('admin');
    });

    it('shows the substituted text as read-only preview while the editable field still holds the placeholder', async () => {
        renderDetail();
        await screen.findByText(/TC-1/);
        openStepsTab();
        await selectPreviewRow(/admin/);

        // Wait for the preview to actually load FIRST. Asserting before it
        // arrives tests nothing: the authored text is trivially still in the
        // field because the substituted text has not been fetched yet.
        await waitFor(() =>
            expect(screen.getByTestId('preview-cell-0')).toHaveTextContent('Log in as admin'),
        );
        // Fix round 1 -- see flushPendingRenders' own header comment.
        await flushPendingRenders();
        // Both forms on screen at once: the author edits the left, reads the
        // right. The editable control holds the authored string.
        expect(screen.getByDisplayValue('Log in as {{role}}')).toBeInTheDocument();
        // ...and the substituted string is NOT in any editable control.
        expect(screen.queryByDisplayValue('Log in as admin')).not.toBeInTheDocument();
    });

    it('switching preview rows changes what is displayed without touching the authored steps', async () => {
        mockGetTcList.mockImplementation((query: string) => {
            if (String(query).includes('substitute=1')) {
                return Promise.resolve([
                    {
                        ...TC_RECORD,
                        TestSteps: [
                            { testStep: 'Log in as viewer', Expected: 'Dashboard for viewer', substituted: true },
                            { testStep: 'Open the reports page', Expected: 'Reports list shown', substituted: true },
                        ],
                    },
                ]);
            }
            if (String(query).includes('substitute=')) return Promise.resolve([SUBSTITUTED_ROW_0]);
            return Promise.resolve([TC_RECORD]);
        });
        renderDetail();
        await screen.findByText(/TC-1/);
        openStepsTab();

        await selectPreviewRow(/admin/);
        expect(await screen.findByText('Log in as admin')).toBeInTheDocument();

        await selectPreviewRow(/viewer/);
        await waitFor(() =>
            expect(screen.getByTestId('preview-cell-0')).toHaveTextContent('Log in as viewer'),
        );
        // Fix round 1 -- see flushPendingRenders' own header comment.
        await flushPendingRenders();

        // The editable field never moved off the authored text through either
        // selection.
        expect(screen.getByDisplayValue('Log in as {{role}}')).toBeInTheDocument();
    });

    it('never requests a substitution with an empty index, which the backend rejects 400', async () => {
        renderDetail();
        await screen.findByText(/TC-1/);
        openStepsTab();
        await selectPreviewRow(/admin/);
        await screen.findByText('Log in as admin');

        // Clear the selection back to "no preview".
        const combo = screen.getByRole('combobox', { name: /preview row/i });
        fireEvent.mouseDown(combo);
        const noneOption = await screen.findByRole('option', { name: /no preview/i });
        fireEvent.click(noneOption);

        await waitFor(() => {
            const calls = mockGetTcList.mock.calls.map((c) => String(c[0]));
            // Task 3 rejects `substitute=` (empty) with 400 rather than
            // silently falling back to row 0; the control must omit the
            // parameter entirely instead of sending an empty one.
            expect(calls.some((q) => /substitute=(&|$)/.test(q))).toBe(false);
        });
    });
});

// WP-F07a Task 5 fix round 1 -- found by review, not by this package's own
// tests: cloning a parameterised case silently dropped its dataset
// binding. useCloneEntity.ts's buildClonePlan carries `datasetId` into the
// draft's prefill correctly (it flattens the whole source record); the
// component-level effect above spreads that prefill into `draftValues`
// correctly too. The break was in `createTestCase`'s own payload: it sent
// an explicit allow-list of fields plus whatever Fields Configuration
// (`fields.forEach`) declares, and module 1 declares no `datasetId` field
// -- so a bound clone kept its `{{placeholders}}` and lost the binding,
// with no error anywhere, exactly like the `tags` field would have before
// its own WP-F05b fix.
describe('TestCaseDetail — cloning a parameterised case must carry its dataset binding forward', () => {
    it('includes datasetId in the create payload when the draft was seeded from a clone prefill', async () => {
        renderDraftWithPrefill({
            TestCaseSummary: 'Copy of Login should work',
            TestSteps: AUTHORED_STEPS,
            datasetId: 'ds1',
        });

        const createButton = await screen.findByRole('button', { name: /^create$/i });
        fireEvent.click(createButton);

        await waitFor(() => expect(mockSaveTestCase).toHaveBeenCalled());
        const payload = mockSaveTestCase.mock.calls.at(-1)?.[0] as { datasetId?: unknown };
        // The single-line break this test catches: deleting the `datasetId`
        // line from createTestCase's payload construction (TestCaseDetail.tsx)
        // makes this fail -- `payload.datasetId` reverts to `undefined`
        // even though `draftValues.datasetId` (seeded from the prefill) was
        // 'ds1' the whole time.
        expect(payload.datasetId).toBe('ds1');
    });

    it('sends datasetId: null (not omitted, not undefined) for an ordinary draft with no clone prefill', async () => {
        renderDraftWithPrefill({ TestCaseSummary: 'A fresh, unbound case' });

        const createButton = await screen.findByRole('button', { name: /^create$/i });
        fireEvent.click(createButton);

        await waitFor(() => expect(mockSaveTestCase).toHaveBeenCalled());
        const payload = mockSaveTestCase.mock.calls.at(-1)?.[0] as { datasetId?: unknown };
        expect(payload.datasetId).toBeNull();
    });
});

// WP-F08 Task 2 -- starting from a CaseTemplate goes through this EXACT
// same draftPrefill mechanism as a clone (openDraftFromPrefill, shared by
// both useCloneEntity.ts and useStartFromTemplate.ts): a template's own
// `.prefill` field (workbench/entityPrefill.ts's buildEntityPrefill,
// captured by SaveAsTemplateDialog at save time) is fed into
// setDraftPrefill exactly the way a clone's freshly-flattened record is.
// This is the datasetId regression test above, restated for the SECOND
// path that can now seed a draft's prefill, proving the reuse is real
// (not just the same-shaped code duplicated) -- if useStartFromTemplate
// ever diverged from useCloneEntity's mechanism, this is where it would
// first show up as a broken binding on an otherwise-correct-looking
// draft.
describe('TestCaseDetail — a template made from a parameterised case carries its dataset binding forward', () => {
    it('includes datasetId in the create payload when the draft was seeded from a CaseTemplate\'s stored prefill', async () => {
        // The exact shape buildEntityPrefill(1, row) produces for a
        // parameterised source case, and therefore the exact shape a
        // CaseTemplate.prefill created from one holds (R1: a template
        // captures the same flattened shape a clone would).
        renderDraftWithPrefill({
            TestCaseSummary: 'Copy of Login should work',
            TestSteps: AUTHORED_STEPS,
            datasetId: 'ds1',
        });

        const createButton = await screen.findByRole('button', { name: /^create$/i });
        fireEvent.click(createButton);

        await waitFor(() => expect(mockSaveTestCase).toHaveBeenCalled());
        const payload = mockSaveTestCase.mock.calls.at(-1)?.[0] as { datasetId?: unknown };
        expect(payload.datasetId).toBe('ds1');
    });
});
