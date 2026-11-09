import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    Alert,
    Box,
    Button,
    Checkbox,
    Dialog,
    DialogActions,
    DialogContent,
    DialogContentText,
    DialogTitle,
    FormControl,
    FormControlLabel,
    IconButton,
    InputLabel,
    MenuItem,
    Select,
    SelectChangeEvent,
    Skeleton,
    Stack,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    TextField,
    Typography
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import { EmptyState } from '../common/EmptyState';
import CustomizedSnackbars from '../snackBar/simpleSnackBar';
import usePermissions from '../../Hooks/usePermissions';
import { MODULE_LABELS, ModuleId } from '../../workbench/modules';
import {
    CREATABLE_FIELD_TYPES,
    CreatableFieldType,
    DROPDOWN_FIELD_TYPE,
    Field,
    FieldPayload,
    createField,
    deleteField,
    listFields,
    updateField
} from '../../api/fieldsApi';

// Wave D-1 — Settings > Fields. The owner's decision on this WP
// (AGENT_EXECUTION_PLAN.md Wave 6) is explicit: "Fields configuration is a
// plain CRUD table matching the existing Settings tabs -- not a form
// builder." No drag-to-reorder, no live preview, no designer -- pick a
// module, see its fields in a table, create/edit/delete them in a plain
// dialog. Structure/table style/loading/error handling deliberately mirror
// ProjectMembersPanel.tsx and Pages/apiKeys.tsx's ApiKeysPanel (the two
// closest sibling Settings tabs) rather than inventing a new visual
// language.
//
// MODULES OFFERED: 1, 2, 5, 6 (Test Cases/Requirements/Defects/Releases) --
// WP-F24 Task 2 correction of a false claim this comment used to make.
// It used to say grep confirmed FieldGrid/getFields wired into "exactly"
// modules 1-5; that was never true for 3 or 4. Module 3 (Test Plans):
// TestPlanDetail.tsx mentions getFields(3) only in a comment explaining why
// it does NOT call it, and hand-rolls its own controls instead -- zero
// module-3 field documents exist anywhere. Module 4 (Test Runs):
// TestRunDetail.tsx has no FieldGrid for the run's own record at all (its
// one getFields call is getFields(1), for the test-case rows nested inside
// a run) -- one module-4 document exists ('Step Status', created
// 2024-08-13) and nothing has ever rendered it. Offering either module here
// let an admin save a field successfully that changed nothing anywhere --
// R3 (WP-F24 plan) removes both for exactly that reason; the false comment
// this replaces was itself the sixth recorded stale-claim incident in this
// programme. Module 6 (Releases) is added: WP-F24 Task 1 gave
// ReleaseDetail.tsx a real getFields(6) call (mergeConfiguredReleaseFields,
// supplementing the fixed name/status/notes built-ins per R1) -- verified
// by reading that file, not assumed. R4: the UI itself says why Test Plans
// and Test Runs are missing (see the Typography below the module select),
// not only this comment.
//
// FIELD TYPES OFFERED: CREATABLE_FIELD_TYPES (api/fieldsApi.ts) -- the
// intersection of "FieldGrid has a rendering branch for it" and "the
// backend model's Mongoose enum actually allows creating it". See that
// file's header comment for the full reasoning, in particular why
// IssueDropDown and Date are both excluded despite each satisfying only
// one of the two constraints. An existing field whose fieldType falls
// outside this set (module 5's seeded Status field is exactly this: live
// fieldType 'IssueDropDown', which the backend enum doesn't even accept
// for a fresh POST) is still listed and still editable here -- its flags
// and text fields can be changed -- but its TYPE is shown read-only rather
// than offered on a Select whose valid values don't include it. Changing
// an in-use field's rendering type after the fact is a bigger, riskier
// operation than this plain-CRUD WP's scope, so it's simply not offered
// for ANY field, existing or new, once created -- type is set once, at
// creation.
//
// `isDefault` -- required by the schema (models/field.js: no default
// value, no route derives it) but never named in this WP's field-shape
// brief. Every field this UI creates sends `isDefault: false`: a field an
// admin creates through this CRUD tab is never one of the product's own
// built-in/default fields. Editing never touches it (omitted from the
// update payload; Mongoose's update validators only check paths being
// written, so the field's original isDefault survives untouched).
//
// CACHE KEY: ['project', projectId, moduleId, 'fields'] -- the exact key
// every FieldGrid-consuming detail view already queries under (see e.g.
// TestCaseDetail.tsx/RequirementDetail.tsx/DefectDetail.tsx/
// TestPlanDetail.tsx, and TestRunDetail.tsx's own nested module-1 read).
// This table queries that SAME key for the selected module (not a
// separate 'fieldsAdmin' key), so mounting this tab doesn't cost a second
// network round trip beyond what a detail view already caches, and
// invalidating it after every mutation is exactly what makes an admin's
// edit show up in every open detail form without a reload.

const MODULES_WITH_FIELDS: ModuleId[] = [1, 2, 5, 6];

interface FieldFormState {
    displayName: string;
    fieldName: string;
    fieldType: string;
    isDisplayed: boolean;
    isMandatory: boolean;
    isEnabled: boolean;
    defaultValueText: string;
}

const EMPTY_FORM: FieldFormState = {
    displayName: '',
    fieldName: '',
    fieldType: CREATABLE_FIELD_TYPES[0],
    isDisplayed: true,
    isMandatory: false,
    isEnabled: true,
    defaultValueText: ''
};

function formFromField(f: Field): FieldFormState {
    return {
        displayName: f.displayName,
        fieldName: f.fieldName,
        fieldType: f.fieldType,
        isDisplayed: f.isDisplayed,
        isMandatory: f.isMandatory,
        isEnabled: f.isEnabled,
        defaultValueText: (f.defaultValue ?? []).join('\n')
    };
}

function parseDropdownOptions(text: string): string[] {
    return text
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

function isCreatableType(fieldType: string): fieldType is CreatableFieldType {
    return (CREATABLE_FIELD_TYPES as readonly string[]).includes(fieldType);
}

export interface FieldsPanelProps {
    projectId: number;
}

export function FieldsPanel({ projectId }: FieldsPanelProps) {
    const queryClient = useQueryClient();
    const { can } = usePermissions(projectId);
    const canWrite = can('write');
    const canDelete = can('delete');

    const [moduleId, setModuleId] = useState<ModuleId>(1);

    const [errorMessage, setErrorMessage] = useState('');
    const [errorOpen, setErrorOpen] = useState(false);
    const showError = (message: string) => {
        setErrorMessage(message);
        setErrorOpen(true);
    };

    const fieldsQuery = useQuery({
        queryKey: ['project', projectId, moduleId, 'fields'] as const,
        queryFn: () => listFields(moduleId)
    });
    const fields = fieldsQuery.data ?? [];

    const invalidate = () => queryClient.invalidateQueries({ queryKey: ['project', projectId, moduleId, 'fields'] });

    const [dialogOpen, setDialogOpen] = useState(false);
    const [editingField, setEditingField] = useState<Field | null>(null);
    const [form, setForm] = useState<FieldFormState>(EMPTY_FORM);
    const [formError, setFormError] = useState('');

    const openCreate = () => {
        setEditingField(null);
        setForm(EMPTY_FORM);
        setFormError('');
        setDialogOpen(true);
    };

    const openEdit = (f: Field) => {
        setEditingField(f);
        setForm(formFromField(f));
        setFormError('');
        setDialogOpen(true);
    };

    const closeDialog = () => setDialogOpen(false);

    const createMutation = useMutation({
        mutationFn: createField,
        onSuccess: () => {
            invalidate();
            closeDialog();
        },
        onError: (err: any) => showError(err?.response?.data?.error || 'Unable to create this field')
    });

    const updateMutation = useMutation({
        mutationFn: (vars: { id: string; payload: FieldPayload }) => updateField(vars.id, vars.payload),
        onSuccess: () => {
            invalidate();
            closeDialog();
        },
        onError: (err: any) => showError(err?.response?.data?.error || 'Unable to update this field')
    });

    const deleteMutation = useMutation({
        mutationFn: deleteField,
        onSuccess: () => {
            invalidate();
            setDeleteTarget(null);
        },
        onError: (err: any) => showError(err?.response?.data?.error || 'Unable to delete this field')
    });

    const handleSave = () => {
        if (!form.displayName.trim() || !form.fieldName.trim()) {
            setFormError('Display name and field name are required');
            return;
        }
        const payload: FieldPayload = {
            displayName: form.displayName.trim(),
            fieldName: form.fieldName.trim(),
            fieldType: form.fieldType,
            isDisplayed: form.isDisplayed,
            isMandatory: form.isMandatory,
            isEnabled: form.isEnabled,
            defaultValue: form.fieldType === DROPDOWN_FIELD_TYPE ? parseDropdownOptions(form.defaultValueText) : undefined
        };
        if (editingField) {
            updateMutation.mutate({ id: editingField._id, payload });
        } else {
            createMutation.mutate({ ...payload, moduleId, isDefault: false });
        }
    };

    const [deleteTarget, setDeleteTarget] = useState<Field | null>(null);

    const saving = createMutation.isPending || updateMutation.isPending;

    // Once a field exists, its type is fixed -- see this file's header
    // comment. The Select's own options are always exactly
    // CREATABLE_FIELD_TYPES; when editing a field whose current type falls
    // outside that set (e.g. a seeded IssueDropDown), an extra, disabled
    // option is added so the control still displays the real value instead
    // of showing nothing selected.
    const typeSelectOptions: { value: string; label: string; disabled: boolean }[] = [
        ...CREATABLE_FIELD_TYPES.map((t) => ({ value: t, label: t, disabled: false })),
        ...(editingField && !isCreatableType(editingField.fieldType)
            ? [{ value: editingField.fieldType, label: `${editingField.fieldType} (existing)`, disabled: true }]
            : [])
    ];

    return (
        <Box>
            {errorOpen ? (
                <CustomizedSnackbars errorMessage={errorMessage} refresh={errorOpen} closeError={() => setErrorOpen(false)} severity={'error'} />
            ) : null}
            <Stack spacing={2}>
                <Typography variant="body2" color="text.secondary">
                    Field definitions drive every detail form for a module. Changing or removing one changes that form for
                    every record in the project.
                </Typography>
                <Typography variant="body2" color="text.secondary" data-testid="fields-panel-scope-note">
                    Test Plans and Test Runs aren&apos;t listed here: they use purpose-built forms rather than configurable
                    attributes.
                </Typography>

                <Stack direction="row" spacing={2} alignItems="center" justifyContent="space-between" flexWrap="wrap">
                    <FormControl size="small" sx={{ minWidth: 220 }}>
                        <InputLabel id="fields-module-label">Module</InputLabel>
                        <Select
                            labelId="fields-module-label"
                            label="Module"
                            value={String(moduleId)}
                            onChange={(e: SelectChangeEvent) => setModuleId(Number(e.target.value) as ModuleId)}
                            inputProps={{ 'aria-label': 'Module' }}
                        >
                            {MODULES_WITH_FIELDS.map((id) => (
                                <MenuItem key={id} value={String(id)}>
                                    {MODULE_LABELS[id]}
                                </MenuItem>
                            ))}
                        </Select>
                    </FormControl>

                    {canWrite ? (
                        <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
                            New Field
                        </Button>
                    ) : null}
                </Stack>

                {fieldsQuery.isLoading ? (
                    <Skeleton variant="rounded" height={160} data-testid="fields-panel-loading" />
                ) : fieldsQuery.isError ? (
                    <EmptyState message="Unable to load fields. Try refreshing the page." />
                ) : fields.length === 0 ? (
                    <EmptyState message={`No fields defined for ${MODULE_LABELS[moduleId]} yet.`} />
                ) : (
                    <TableContainer>
                        <Table size="small">
                            <TableHead>
                                <TableRow>
                                    <TableCell>Display name</TableCell>
                                    <TableCell>Field name</TableCell>
                                    <TableCell>Type</TableCell>
                                    <TableCell align="center">Displayed</TableCell>
                                    <TableCell align="center">Mandatory</TableCell>
                                    <TableCell align="center">Enabled</TableCell>
                                    {canWrite || canDelete ? <TableCell align="right">Actions</TableCell> : null}
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {fields.map((f) => (
                                    <TableRow key={f._id}>
                                        <TableCell>{f.displayName}</TableCell>
                                        <TableCell>{f.fieldName}</TableCell>
                                        <TableCell>{f.fieldType}</TableCell>
                                        <TableCell align="center">
                                            <Checkbox checked={f.isDisplayed} disabled inputProps={{ 'aria-label': `${f.displayName} displayed` }} />
                                        </TableCell>
                                        <TableCell align="center">
                                            <Checkbox checked={f.isMandatory} disabled inputProps={{ 'aria-label': `${f.displayName} mandatory` }} />
                                        </TableCell>
                                        <TableCell align="center">
                                            <Checkbox checked={f.isEnabled} disabled inputProps={{ 'aria-label': `${f.displayName} enabled` }} />
                                        </TableCell>
                                        {canWrite || canDelete ? (
                                            <TableCell align="right">
                                                {canWrite ? (
                                                    <IconButton size="small" aria-label={`Edit ${f.displayName}`} onClick={() => openEdit(f)}>
                                                        <EditIcon fontSize="small" />
                                                    </IconButton>
                                                ) : null}
                                                {canDelete ? (
                                                    <IconButton
                                                        size="small"
                                                        aria-label={`Delete ${f.displayName}`}
                                                        onClick={() => setDeleteTarget(f)}
                                                    >
                                                        <DeleteIcon fontSize="small" />
                                                    </IconButton>
                                                ) : null}
                                            </TableCell>
                                        ) : null}
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </TableContainer>
                )}
            </Stack>

            <Dialog open={dialogOpen} onClose={closeDialog} fullWidth maxWidth="sm">
                <DialogTitle>{editingField ? 'Edit Field' : 'New Field'}</DialogTitle>
                <DialogContent>
                    <Stack spacing={2} mt={1}>
                        {formError ? <Alert severity="error">{formError}</Alert> : null}
                        <TextField
                            label="Display name"
                            value={form.displayName}
                            onChange={(e) => setForm((prev) => ({ ...prev, displayName: e.target.value }))}
                            fullWidth
                            autoFocus
                        />
                        <TextField
                            label="Field name"
                            value={form.fieldName}
                            onChange={(e) => setForm((prev) => ({ ...prev, fieldName: e.target.value }))}
                            fullWidth
                            helperText="The internal key stored on every record's dynamic fields."
                        />
                        <FormControl fullWidth>
                            <InputLabel id="field-type-label">Type</InputLabel>
                            <Select
                                labelId="field-type-label"
                                label="Type"
                                value={form.fieldType}
                                onChange={(e: SelectChangeEvent) => setForm((prev) => ({ ...prev, fieldType: e.target.value }))}
                                inputProps={{ 'aria-label': 'Type' }}
                            >
                                {typeSelectOptions.map((opt) => (
                                    <MenuItem key={opt.value} value={opt.value} disabled={opt.disabled}>
                                        {opt.label}
                                    </MenuItem>
                                ))}
                            </Select>
                        </FormControl>
                        {form.fieldType === DROPDOWN_FIELD_TYPE ? (
                            <TextField
                                label="Dropdown options"
                                value={form.defaultValueText}
                                onChange={(e) => setForm((prev) => ({ ...prev, defaultValueText: e.target.value }))}
                                fullWidth
                                multiline
                                minRows={3}
                                helperText="One option per line."
                            />
                        ) : null}
                        <Stack direction="row" spacing={2} flexWrap="wrap">
                            <FormControlLabel
                                control={
                                    <Checkbox
                                        checked={form.isDisplayed}
                                        onChange={(e) => setForm((prev) => ({ ...prev, isDisplayed: e.target.checked }))}
                                    />
                                }
                                label="Displayed"
                            />
                            <FormControlLabel
                                control={
                                    <Checkbox
                                        checked={form.isMandatory}
                                        onChange={(e) => setForm((prev) => ({ ...prev, isMandatory: e.target.checked }))}
                                    />
                                }
                                label="Mandatory"
                            />
                            <FormControlLabel
                                control={
                                    <Checkbox
                                        checked={form.isEnabled}
                                        onChange={(e) => setForm((prev) => ({ ...prev, isEnabled: e.target.checked }))}
                                    />
                                }
                                label="Enabled"
                            />
                        </Stack>
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={closeDialog} disabled={saving}>
                        Cancel
                    </Button>
                    <Button variant="contained" onClick={handleSave} disabled={saving}>
                        {editingField ? 'Save' : 'Create'}
                    </Button>
                </DialogActions>
            </Dialog>

            <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} fullWidth maxWidth="sm">
                <DialogTitle>Delete {deleteTarget?.displayName}?</DialogTitle>
                <DialogContent>
                    <DialogContentText>
                        This permanently deletes the “{deleteTarget?.displayName}” field. It affects every record's form in{' '}
                        {MODULE_LABELS[moduleId]} -- any record still holding a value for it keeps that data, but the field
                        itself will no longer appear on the form. This cannot be undone.
                    </DialogContentText>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setDeleteTarget(null)} disabled={deleteMutation.isPending}>
                        Cancel
                    </Button>
                    <Button
                        color="error"
                        variant="contained"
                        disabled={deleteMutation.isPending}
                        onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget._id)}
                    >
                        Delete
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}

export default FieldsPanel;
