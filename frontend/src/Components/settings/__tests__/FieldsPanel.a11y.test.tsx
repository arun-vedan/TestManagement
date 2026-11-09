import { render, screen, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '@mui/material';
import { axe } from 'jest-axe';
import theme from '../../../Theme/theme';
import { FieldsPanel } from '../FieldsPanel';
import { Field, listFields } from '../../../api/fieldsApi';
import usePermissions from '../../../Hooks/usePermissions';

// setupTests.ts extends `expect` with jest-axe's toHaveNoViolations()
// globally -- no local expect.extend() needed here.
//
// Wave D-1 — axe coverage for Settings > Fields, following this repo's
// existing *.a11y.test.tsx convention (see e.g. workbench/detail/
// __tests__/DefectDetail.a11y.test.tsx and workbench/list/__tests__/
// EntityList.a11y.test.tsx for the same split of functional vs a11y
// assertions into separate files). No @mui/x-data-grid here (this is a
// plain MUI <Table>, per the owner's "not a form builder" decision), so
// there is no DataGrid pagination-footer exception to carry forward --
// axe must be fully clean, not "clean except for one documented id".

// See FieldsPanel.test.tsx's identical mock for why the axios module (not
// usePermissions, already fully mocked below with no requireActual) is
// what needs mocking: fieldsApi.ts's `import axiosPrivate from './axios'`
// is what actually pulls in src/keycloak.js's ESM-only `keycloak-js`
// through jest.requireActual below.
jest.mock('../../../api/axios', () => ({
    __esModule: true,
    default: { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() }
}));
jest.mock('../../../api/fieldsApi', () => {
    const actual = jest.requireActual('../../../api/fieldsApi');
    return { ...actual, listFields: jest.fn(), createField: jest.fn(), updateField: jest.fn(), deleteField: jest.fn() };
});
jest.mock('../../../Hooks/usePermissions', () => ({ __esModule: true, default: jest.fn() }));

const mockListFields = listFields as jest.Mock;
const mockUsePermissions = usePermissions as unknown as jest.Mock;

function field(overrides: Partial<Field> = {}): Field {
    return {
        _id: 'f1',
        id: 1,
        fieldName: 'summary',
        displayName: 'Summary',
        fieldType: 'Text',
        moduleId: 1,
        projectId: 7,
        isDisplayed: true,
        isEnabled: true,
        isMandatory: false,
        isDefault: false,
        defaultValue: [],
        ...overrides
    };
}

const FIELDS: Field[] = [
    field(),
    field({ _id: 'f2', id: 2, fieldName: 'priority', displayName: 'Priority', fieldType: 'DropDown', defaultValue: ['Low', 'High'] })
];

function renderPanel() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={queryClient}>
            <ThemeProvider theme={theme}>
                <FieldsPanel projectId={7} />
            </ThemeProvider>
        </QueryClientProvider>
    );
}

beforeEach(() => {
    jest.clearAllMocks();
    mockUsePermissions.mockReturnValue({ role: 'admin', isLoading: false, isError: false, can: () => true });
    mockListFields.mockResolvedValue(FIELDS);
});

test('the table view (with data) is axe-clean', async () => {
    const { container } = renderPanel();
    expect(await screen.findByText('Summary')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
});

// WP-F24 Task 2 -- this used to select module 3 (Test Plans) to exercise
// the empty state; module 3 is no longer offered here at all (R3). Module
// 6 (Releases) is the real-world empty-state case now -- verified live
// against Mongo (WP-F24 Task 1's own header comment in ReleaseDetail.tsx):
// every project but one has zero module-6 field documents, so this is
// Releases' NORMAL state, not a contrived one.
test('the empty state (module 6 Releases, no fields) is axe-clean', async () => {
    mockListFields.mockResolvedValue([]);
    const { container } = renderPanel();
    fireEvent.mouseDown(screen.getByLabelText(/module/i));
    fireEvent.click(screen.getByRole('option', { name: 'Releases' }));
    expect(await screen.findByText(/no fields defined for releases/i)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
});

test('the create dialog, including the dropdown-options field, is axe-clean', async () => {
    const { container } = renderPanel();
    expect(await screen.findByText('Summary')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /new field/i }));
    const dialog = screen.getByRole('dialog');
    fireEvent.mouseDown(within(dialog).getByLabelText(/^type$/i));
    fireEvent.click(screen.getByRole('option', { name: 'DropDown' }));

    expect(within(dialog).getByLabelText(/dropdown options/i)).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
});

test('the delete confirmation dialog is axe-clean', async () => {
    const { container } = renderPanel();
    expect(await screen.findByText('Summary')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /delete summary/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
});
