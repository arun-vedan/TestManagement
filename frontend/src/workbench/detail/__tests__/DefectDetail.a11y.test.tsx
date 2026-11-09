import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material';
import { axe } from 'jest-axe';
import theme from '../../../Theme/theme';
import { DefectDetail } from '../modules/DefectDetail';
import { WorkbenchStoreProvider } from '../../WorkbenchStoreProvider';
import { getFields, getDefectList, getComments, getCreatedBy, getUserDirectory } from '../../../api/apiCalls';
import { getIssueStatuses } from '../../../api/defectStatusApi';

// WP-077 Step 2 — ported from the deleted
// Components/Tabs/__tests__/DefectContent.a11y.test.tsx (component-level
// a11y suite for the defect form target page) now that DefectContent.tsx's
// real successor is DefectDetail (module 5,
// workbench/detail/modules/DefectDetail.tsx), mounted by EntityDetail.tsx
// rather than TabContent.tsx/Pages/defects.tsx.
//
// Of that file's four assertions, only ONE ports forward as-is:
//   1. "axe clean in view mode" -> the baseline axe-clean check below. The
//      "(not editing)" qualifier is dropped because it no longer means
//      anything -- see #2.
//   2. "axe clean in edit mode, with Save/Close carrying real accessible
//      names" and
//   3. "the Edit/Save/Close controls are real, distinctly labeled buttons"
//      -- NOT PORTED. DefectContent.tsx had a page-level Edit/Save/Close
//      mode (the WP-046 fix these two tests existed to pin); the shared
//      detail kit this WP builds on (TestCaseDetail/RequirementDetail/
//      TestPlanDetail/TestRunDetail, WP-074..076) replaced that with
//      per-field inline edit and has NO global edit mode at all, for any
//      module -- there are no Edit/Save/Close buttons to be accessibly
//      named or otherwise. This is already proven by the negative
//      assertion in DefectDetail.test.tsx ("saves a single field without
//      entering a global edit mode": `queryByRole('button', {name:
//      /^edit$/i})` / `/^save$/i` both assert not.toBeInTheDocument()).
//      Nothing is silently dropped -- the capability itself doesn't exist
//      in the new architecture, for any of the five migrated modules, not
//      just Defects.
//   4. "a viewer with no write permission sees no Edit control" -- NOT
//      PORTED, and NOT because it's redundant like #2/#3: this is a real,
//      verified gap. Grep confirms DefectDetail.tsx (like TestCaseDetail/
//      TestPlanDetail/TestRunDetail) never calls usePermissions at all --
//      only RequirementDetail does, and only to gate its AI actions, never
//      field editability. So unlike #2/#3 (an intentional design change),
//      #4 is a capability regression the whole kit shares, pre-existing
//      across every module migrated so far (WP-074..076), not introduced
//      or fixed by this WP. RESOLVED immediately after the cutover: the
//      whole detail kit now gates its write controls on can('write')
//      (FieldGrid's readOnly prop plus the plan/run action buttons), so
//      the legacy "viewer sees no Edit affordance" behaviour is back --
//      see rbac.test.tsx. This note is kept for the history of
//      gaps prior waves have flagged (e.g. WP-076's dashboard drill-down
//      regression, since fixed).
//
// D6 (docs/superpowers/PRODUCT_GAP_REGISTER.md) CLOSED HERE.
//
// Fixture originally mirrored the ORIGINAL DefectContent.a11y.test.tsx's own
// DEF_FIELDS exactly (Summary + a TextArea + the IssueDropDown Status
// field), deliberately EXCLUDING assignedTo/UserDropDown: rendering
// UserDropDownField (Components/Lists/dropDownList.tsx's
// DynamicAutocomplete) failed axe on its own, with an unlabeled combobox
// (`aria-label`/`aria-labelledby`/`<label>` all absent -- DefectDetail.
// test.tsx's own `getByRole('combobox', { name: '' })` query already
// silently documented the same empty accessible name, just never through
// axe). That was a genuine gap in a shared component, excluded from this
// fixture rather than fixed at the time the defect a11y suite was ported.
//
// Fixed now: DynamicAutocomplete's `renderInput` merges an `aria-label`
// (dropDownList.tsx) sourced from a new `displayName` prop, threaded
// through by FieldGrid's UserDropDownField from the field's own
// `displayName` ("Assigned To") rather than a hardcoded string. `assignedTo`
// is restored to this fixture below as the real proof: this suite is
// axe-clean WITH the field present, not merely by continuing to exclude it.
// LinkIssues/react-quill still need no mock here -- the axe pass never
// opens the Links tab and neither Summary/Status/assignedTo is Editor-type
// (DetailTabs only mounts a tab's content once it's active, same reasoning
// as DefectDetail.test.tsx's own header comment).

jest.mock('../../../api/apiCalls', () => ({
  getFields: jest.fn(),
  getDefectList: jest.fn(),
  updateDefect: jest.fn(),
  getComments: jest.fn(),
  uploadAttachment: jest.fn(),
  getUserDirectory: jest.fn(),
  getCreatedBy: jest.fn(),
  postDefect: jest.fn(),
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

// WP-077 RBAC -- write controls are now gated on can('write'). This suite
// renders the editable form, so it runs as a contributor.
jest.mock('../../../Hooks/usePermissions', () => ({
  __esModule: true,
  usePermissions: () => ({ can: () => true, role: 'contributor', isLoading: false, isError: false }),
  default: () => ({ can: () => true, role: 'contributor', isLoading: false, isError: false }),
}));


const mockGetFields = getFields as jest.Mock;
const mockGetDefectList = getDefectList as jest.Mock;
const mockGetComments = getComments as jest.Mock;
const mockGetCreatedBy = getCreatedBy as jest.Mock;
const mockGetUsersList = getUserDirectory as jest.Mock;
const mockGetIssueStatuses = getIssueStatuses as jest.Mock;

// assignedTo (UserDropDown) restored -- see this file's header comment.
// Same field name/shape as DefectDetail.test.tsx's own broader fixture.
const FIELDS = [
  { fieldName: 'summary', displayName: 'Summary', fieldType: 'TextArea', isDisplayed: true, isMandatory: true, isDefault: true },
  { fieldName: 'description', displayName: 'Description', fieldType: 'TextArea', isDisplayed: true, isMandatory: false, isDefault: true },
  { fieldName: 'Status', displayName: 'Status', fieldType: 'IssueDropDown', isDisplayed: true, isMandatory: false, isDefault: true },
  { fieldName: 'assignedTo', displayName: 'Assigned To', fieldType: 'UserDropDown', isDisplayed: true, isMandatory: false, isDefault: true },
];

// assignedTo is a raw Keycloak user id on the wire (same as
// DefectDetail.test.tsx's own fixture) -- getCreatedBy resolves it to a
// username before DynamicAutocomplete renders it.
const DEFECT_RECORD = {
  _id: 'defect-mongo-1',
  defectId: 'DEF-1',
  summary: 'Login button does nothing',
  description: 'Steps to reproduce...',
  Status: 'Open',
  assignedTo: 'user-id-c16a3041',
  attachment: [],
  dynamicFields: {},
};

function renderDetail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider theme={theme}>
        <WorkbenchStoreProvider projectId={1}>
          <DefectDetail entityId="DEF-1" />
        </WorkbenchStoreProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetFields.mockResolvedValue(FIELDS);
  mockGetDefectList.mockResolvedValue([DEFECT_RECORD]);
  mockGetComments.mockResolvedValue([]);
  mockGetCreatedBy.mockResolvedValue('alice');
  mockGetUsersList.mockResolvedValue([]);
  mockGetIssueStatuses.mockResolvedValue([
    { id: 1, istatus: 'Open', parentId: [] },
    { id: 2, istatus: 'Fixed', parentId: [1] },
  ]);
});

describe('DefectDetail (WP-077, ported from DefectContent.a11y.test.tsx) — the defect form target page', () => {
  it('is axe clean with fields and the status-workflow control rendered', async () => {
    const { container } = renderDetail();
    // Matches DefectDetail.test.tsx's own header-scoped query -- the
    // Summary TextField also carries the same text as its value, so an
    // unscoped getByText/findByText would match ambiguously (findByText
    // never matches inside a <textarea> anyway; the heading is the
    // reliable target).
    await screen.findByRole('heading', { level: 6 });
    await screen.findByText(/No comments yet/);
    // D6 -- the assignedTo picker (DynamicAutocomplete) must have resolved
    // the raw Keycloak id to a username before the axe snapshot, same
    // assertion as DefectDetail.test.tsx's own "resolved to a username"
    // test. Checked BEFORE waiting on the status button below, matching
    // that file's ordering exactly: DynamicAutocomplete's controlled
    // `inputValue` is seeded once from `props.userName` at mount and only
    // resyncs on further prop changes via its own effect, not on every
    // unrelated re-render -- asserting here, right after the data has
    // loaded, is what that other suite already proved stable.
    await waitFor(() => expect(mockGetCreatedBy).toHaveBeenCalledWith('user-id-c16a3041'));
    const assignedToCombo = screen.getByRole('combobox', { name: 'Assigned To' });
    expect(assignedToCombo).toHaveValue('alice');
    // Confirms the status-workflow control (DefectStatus) actually finished
    // loading its vocabulary before the axe snapshot is taken -- while
    // loadingVocab/updating is true the button renders an unlabeled
    // MuiCircularProgress endIcon (DefectStatus.tsx:115), an axe violation
    // of its own that has nothing to do with what this test is checking
    // (same reasoning as DefectDetail.test.tsx's own status-control test,
    // which waits on the identical condition for the identical reason).
    const changeStatusButton = await screen.findByRole('button', { name: /change status/i });
    await waitFor(() => expect(changeStatusButton).not.toBeDisabled());
    expect(await axe(container)).toHaveNoViolations();
  });
});
