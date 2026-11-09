import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { FieldsPanel } from '../FieldsPanel';
import { Field, listFields, createField, updateField, deleteField } from '../../../api/fieldsApi';
import usePermissions from '../../../Hooks/usePermissions';

// Wave D-1 — Settings > Fields. A project admin's only surface for
// managing the field definitions that drive every detail form's
// FieldGrid (workbench/detail/FieldGrid.tsx). Owner's decision (see
// AGENT_EXECUTION_PLAN.md Wave 6): "a plain CRUD table matching the
// existing Settings tabs -- not a form builder." No network: every API
// call is mocked, same convention as ProjectMembersPanel/ApiKeysPanel's
// own test siblings would use (see EntityList.a11y.test.tsx for the
// established mocking pattern this follows).

// fieldsApi.ts's own `import axiosPrivate from './axios'` (api/axios.tsx)
// pulls in src/keycloak.js -> the `keycloak-js` package, which is ESM-only
// (package.json: `"type": "module"`, no CJS build) and unparseable by
// Jest's default transform -- the identical failure
// SharedStepManagerDialog.test.tsx's own header comment documents for
// sharedStepApi.ts. `jest.requireActual` below only bypasses mocking for
// fieldsApi.ts itself, not what it imports, so mocking the axios module it
// actually calls through lets requireActual keep working -- preserving
// CREATABLE_FIELD_TYPES/DROPDOWN_FIELD_TYPE (real, non-function exports
// this component reads directly) without hand-duplicating their values --
// while never loading the real keycloak-js chain.
jest.mock('../../../api/axios', () => ({
    __esModule: true,
    default: { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() }
}));
jest.mock('../../../api/fieldsApi', () => {
    const actual = jest.requireActual('../../../api/fieldsApi');
    return {
        ...actual,
        listFields: jest.fn(),
        createField: jest.fn(),
        updateField: jest.fn(),
        deleteField: jest.fn()
    };
});
jest.mock('../../../Hooks/usePermissions', () => ({ __esModule: true, default: jest.fn() }));

const mockListFields = listFields as jest.Mock;
const mockCreateField = createField as jest.Mock;
const mockUpdateField = updateField as jest.Mock;
const mockDeleteField = deleteField as jest.Mock;
const mockUsePermissions = usePermissions as unknown as jest.Mock;

const PROJECT_ID = 7;

function field(overrides: Partial<Field> = {}): Field {
    return {
        _id: 'f1',
        id: 1,
        fieldName: 'summary',
        displayName: 'Summary',
        fieldType: 'Text',
        moduleId: 1,
        projectId: PROJECT_ID,
        isDisplayed: true,
        isEnabled: true,
        isMandatory: false,
        isDefault: false,
        defaultValue: [],
        ...overrides
    };
}

const MODULE_1_FIELDS: Field[] = [
    field({ _id: 'f1', id: 1, fieldName: 'summary', displayName: 'Summary' }),
    field({ _id: 'f2', id: 2, fieldName: 'priority', displayName: 'Priority', fieldType: 'DropDown', defaultValue: ['Low', 'High'] })
];
const MODULE_2_FIELDS: Field[] = [field({ _id: 'g1', id: 3, fieldName: 'reqSummary', displayName: 'Requirement Summary', moduleId: 2 })];

// MUI's Select renders a `role="combobox"` <div>, not a native <select> --
// fireEvent.change on it is a no-op. The established interaction pattern
// in this repo (ViewSwitcher.test.tsx) is mouseDown to open the listbox,
// then click the option by its accessible name.
function selectMuiOption(labelElement: HTMLElement, optionName: string | RegExp) {
    fireEvent.mouseDown(labelElement);
    fireEvent.click(screen.getByRole('option', { name: optionName }));
}

function renderPanel(client?: QueryClient) {
    const queryClient = client ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
        <QueryClientProvider client={queryClient}>
            <FieldsPanel projectId={PROJECT_ID} />
        </QueryClientProvider>
    );
    return queryClient;
}

// Mounts a second, independent consumer of the exact query key
// FieldGrid-based detail views use for a module's field definitions
// (['project', projectId, moduleId, 'fields'] -- see workbench/detail/
// modules/TestCaseDetail.tsx etc). Proves a mutation's invalidate reaches
// something that behaves exactly like a real detail form's own useQuery,
// without a reload, sharing nothing with FieldsPanel but the QueryClient.
function DetailFormFieldCountProbe({ moduleId }: { moduleId: number }) {
    const { data } = useQuery({
        queryKey: ['project', PROJECT_ID, moduleId, 'fields'] as const,
        queryFn: () => listFields(moduleId)
    });
    return <div data-testid="detail-form-probe">{(data ?? []).length}</div>;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockUsePermissions.mockReturnValue({ role: 'admin', isLoading: false, isError: false, can: () => true });
    mockListFields.mockImplementation(async (moduleId: number) => {
        if (moduleId === 1) return MODULE_1_FIELDS;
        if (moduleId === 2) return MODULE_2_FIELDS;
        return [];
    });
});

test('lists the selected module\'s fields, and switching module refetches', async () => {
    renderPanel();

    expect(await screen.findByText('Summary')).toBeInTheDocument();
    expect(screen.getByText('Priority')).toBeInTheDocument();
    expect(mockListFields).toHaveBeenCalledWith(1);

    selectMuiOption(screen.getByLabelText(/module/i), 'Requirements');

    expect(await screen.findByText('Requirement Summary')).toBeInTheDocument();
    expect(screen.queryByText('Summary')).not.toBeInTheDocument();
    expect(mockListFields).toHaveBeenCalledWith(2);
});

test('module 6 (Releases) renders an honest empty state, not a spinner or error', async () => {
    // Every project but one has zero module-6 field documents (WP-F24 Task
    // 2 brief) -- this is Releases' NORMAL case, not an edge case, so this
    // mock leaves it at the `beforeEach` default of `[]` rather than
    // special-casing it, then asserts on that exact module.
    renderPanel();

    selectMuiOption(screen.getByLabelText(/module/i), 'Releases');

    expect(await screen.findByText(/no fields defined for releases/i)).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByText(/unable to load/i)).not.toBeInTheDocument();
});

test('selecting Releases lists its own module-6 field definitions when some exist', async () => {
    const MODULE_6_FIELDS: Field[] = [field({ _id: 'r1', id: 9, fieldName: 'sprintTag', displayName: 'Sprint Tag', moduleId: 6 })];
    mockListFields.mockImplementation(async (moduleId: number) => (moduleId === 6 ? MODULE_6_FIELDS : []));
    renderPanel();

    selectMuiOption(screen.getByLabelText(/module/i), 'Releases');

    expect(await screen.findByText('Sprint Tag')).toBeInTheDocument();
    expect(mockListFields).toHaveBeenCalledWith(6);
});

// R3 -- the panel must not offer what the product ignores. This assertion
// is deliberately built to fail if Test Plans or Test Runs came back: it
// opens the real listbox (proving the control isn't just closed/empty --
// see this file's own selectMuiOption helper) and asserts the FULL set of
// rendered option names by exact array equality, not merely
// `.not.toContain(...)`. `toEqual` on the complete list means adding
// EITHER name back changes the array and fails this test; an
// absence-only check (queryByRole('option', {name: 'Test Plans'})) could
// pass even if the dropdown silently rendered zero options at all, which
// this does not risk since the same assertion also requires the four
// modules that DO belong here to be present, in order.
test('the module selector offers exactly Test Cases, Requirements, Defects, Releases -- not Test Plans or Test Runs', async () => {
    renderPanel();
    expect(await screen.findByText('Summary')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByLabelText(/module/i));
    const listbox = screen.getByRole('listbox');
    const options = within(listbox).getAllByRole('option').map((o) => o.textContent);

    expect(options).toEqual(['Test Cases', 'Requirements', 'Defects', 'Releases']);
    expect(options).not.toContain('Test Plans');
    expect(options).not.toContain('Test Runs');
});

test('the panel explains, in the UI, why Test Plans and Test Runs are absent', async () => {
    renderPanel();
    expect(await screen.findByText('Summary')).toBeInTheDocument();

    expect(screen.getByTestId('fields-panel-scope-note')).toHaveTextContent(/test plans and test runs/i);
    expect(screen.getByTestId('fields-panel-scope-note')).toHaveTextContent(/purpose-built forms/i);
});

test('creating a field against Releases posts moduleId 6', async () => {
    mockCreateField.mockResolvedValue(field({ _id: 'r2', id: 10, fieldName: 'sprintTag', displayName: 'Sprint Tag', moduleId: 6 }));
    renderPanel();
    expect(await screen.findByText('Summary')).toBeInTheDocument();

    selectMuiOption(screen.getByLabelText(/module/i), 'Releases');
    expect(await screen.findByText(/no fields defined for releases/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /new field/i }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/display name/i), { target: { value: 'Sprint Tag' } });
    fireEvent.change(within(dialog).getByLabelText(/field name/i), { target: { value: 'sprintTag' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /create/i }));

    await waitFor(() => expect(mockCreateField).toHaveBeenCalled());
    expect(mockCreateField.mock.calls[0][0]).toEqual(expect.objectContaining({ moduleId: 6, fieldName: 'sprintTag' }));
});

test('create posts the right payload and invalidates both the table and the module field-definition query', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
        <QueryClientProvider client={queryClient}>
            <FieldsPanel projectId={PROJECT_ID} />
            <DetailFormFieldCountProbe moduleId={1} />
        </QueryClientProvider>
    );

    expect(await screen.findByText('Summary')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('detail-form-probe')).toHaveTextContent('2'));

    const created = field({ _id: 'f3', id: 4, fieldName: 'severity', displayName: 'Severity', fieldType: 'DropDown', defaultValue: ['Low', 'High'] });
    mockCreateField.mockResolvedValue(created);
    mockListFields.mockImplementation(async () => [...MODULE_1_FIELDS, created]);

    fireEvent.click(screen.getByRole('button', { name: /new field/i }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/display name/i), { target: { value: 'Severity' } });
    fireEvent.change(within(dialog).getByLabelText(/field name/i), { target: { value: 'severity' } });
    selectMuiOption(within(dialog).getByLabelText(/^type$/i), 'DropDown');
    fireEvent.change(within(dialog).getByLabelText(/dropdown options/i), { target: { value: 'Low\nHigh' } });
    fireEvent.click(within(dialog).getByLabelText(/mandatory/i));

    fireEvent.click(within(dialog).getByRole('button', { name: /create/i }));

    // TanStack Query's mutate() calls mutationFn with a second, internal
    // context argument the real createField(payload) never reads --
    // asserting on mock.calls[0][0] (the actual payload) rather than
    // toHaveBeenCalledWith(payload) (exact arity) avoids coupling this test
    // to that internal (same reasoning as ViewSwitcher.test.tsx's own note).
    await waitFor(() => expect(mockCreateField).toHaveBeenCalled());
    expect(mockCreateField.mock.calls[0][0]).toEqual(
        expect.objectContaining({
            displayName: 'Severity',
            fieldName: 'severity',
            fieldType: 'DropDown',
            moduleId: 1,
            isMandatory: true,
            isDisplayed: true,
            isEnabled: true,
            isDefault: false,
            defaultValue: ['Low', 'High']
        })
    );

    // Table (FieldsPanel's own query) picks up the new field.
    expect(await screen.findByText('Severity')).toBeInTheDocument();
    // A completely separate consumer of the detail-view field-definition
    // cache key sees the new count too, with no reload of its own.
    await waitFor(() => expect(screen.getByTestId('detail-form-probe')).toHaveTextContent('3'));
});

test('edit calls updateField with the field id and delete asks for confirmation naming the field first', async () => {
    mockUpdateField.mockResolvedValue(field({ displayName: 'Summary line' }));
    mockDeleteField.mockResolvedValue(undefined);
    renderPanel();

    expect(await screen.findByText('Summary')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /edit summary/i }));
    const editDialog = screen.getByRole('dialog');
    fireEvent.change(within(editDialog).getByLabelText(/display name/i), { target: { value: 'Summary line' } });
    fireEvent.click(within(editDialog).getByRole('button', { name: /save/i }));

    await waitFor(() => expect(mockUpdateField).toHaveBeenCalledWith('f1', expect.objectContaining({ displayName: 'Summary line' })));
    // The edit dialog closes on a successful mutation (FieldsPanel's
    // onSuccess) -- wait for that before interacting with the table again,
    // otherwise the still-open modal overlay swallows the next click.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // Delete: confirmation dialog names the field and warns before any
    // network call happens.
    fireEvent.click(screen.getByRole('button', { name: /delete priority/i }));
    const confirmDialog = await screen.findByRole('dialog');
    expect(within(confirmDialog).getAllByText(/priority/i).length).toBeGreaterThan(0);
    expect(within(confirmDialog).getByText(/every record/i)).toBeInTheDocument();
    expect(mockDeleteField).not.toHaveBeenCalled();

    fireEvent.click(within(confirmDialog).getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(mockDeleteField).toHaveBeenCalled());
    expect(mockDeleteField.mock.calls[0][0]).toBe('f2');
});

test('create/edit controls are hidden without can(\'write\')', async () => {
    mockUsePermissions.mockReturnValue({ role: 'viewer', isLoading: false, isError: false, can: (a: string) => a === 'read' });
    renderPanel();

    expect(await screen.findByText('Summary')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new field/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit summary/i })).not.toBeInTheDocument();
});

test('delete control is hidden without can(\'delete\') even when write is allowed', async () => {
    mockUsePermissions.mockReturnValue({
        role: 'contributor',
        isLoading: false,
        isError: false,
        can: (a: string) => a === 'read' || a === 'write'
    });
    renderPanel();

    expect(await screen.findByText('Summary')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /edit summary/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete summary/i })).not.toBeInTheDocument();
});

test('the type selector offers only the field types FieldGrid can actually render', async () => {
    renderPanel();
    expect(await screen.findByText('Summary')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /new field/i }));
    const dialog = screen.getByRole('dialog');
    fireEvent.mouseDown(within(dialog).getByLabelText(/^type$/i));

    const listbox = screen.getByRole('listbox');
    const options = within(listbox).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Text', 'TextArea', 'Editor', 'DropDown', 'UserDropDown']);
    expect(options).not.toContain('IssueDropDown');
    expect(options).not.toContain('Date');
});

test('dropdown options editor only appears for dropdown types', async () => {
    renderPanel();
    expect(await screen.findByText('Summary')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /new field/i }));
    const dialog = screen.getByRole('dialog');

    expect(within(dialog).queryByLabelText(/dropdown options/i)).not.toBeInTheDocument();

    selectMuiOption(within(dialog).getByLabelText(/^type$/i), 'DropDown');
    expect(within(dialog).getByLabelText(/dropdown options/i)).toBeInTheDocument();

    selectMuiOption(within(dialog).getByLabelText(/^type$/i), 'Text');
    expect(within(dialog).queryByLabelText(/dropdown options/i)).not.toBeInTheDocument();
});
