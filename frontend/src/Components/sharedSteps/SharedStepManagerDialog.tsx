import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    Alert,
    Box,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogContentText,
    DialogTitle,
    IconButton,
    List,
    ListItem,
    ListItemText,
    Skeleton,
    Stack,
    TextField,
    Typography
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import RemoveCircleOutlineIcon from '@mui/icons-material/RemoveCircleOutline';
import { EmptyState } from '../common/EmptyState';
import usePermissions from '../../Hooks/usePermissions';
import {
    SharedStep,
    SharedStepEntry,
    SharedStepPayload,
    SharedStepUsage,
    createSharedStep,
    deleteSharedStep,
    listSharedSteps,
    updateSharedStep
} from '../../api/sharedStepApi';

// WP-F06 Task 5 -- the library's own CRUD surface, the other half of what
// makes the feature usable (SharedStepPicker.tsx is the insert side).
// Structure, query-key, and error-handling conventions deliberately mirror
// FieldsPanel.tsx (Settings > Fields, the closest existing admin CRUD
// surface built on react-query) rather than inventing a second style:
// same create/edit dialog + separate delete-confirmation dialog split,
// same `invalidate()` after every mutation, same
// `err?.response?.data?.error` read for a mutation's error text.
//
// One thing FieldsPanel's delete flow does NOT need and this one does: a
// shared step still referenced by a test case is refused with HTTP 409
// and a `{ error, data: { count, testCases } }` body
// (api/sharedStepApi.ts's deleteSharedStep header comment,
// controllers/sharedStep.js's deleteSharedStep). Swallowing that down to
// a generic "delete failed" would throw away the one thing the backend
// went out of its way to compute -- WHICH test cases are in the way -- so
// the delete-confirmation dialog renders `data.testCases` on a 409
// instead of just the error string.
export interface SharedStepManagerDialogProps {
    projectId: number;
    open: boolean;
    onClose: () => void;
}

interface FormState {
    title: string;
    description: string;
    steps: SharedStepEntry[];
}

const EMPTY_FORM: FormState = { title: '', description: '', steps: [{ testStep: '', Expected: '' }] };

function formFromStep(s: SharedStep): FormState {
    return {
        title: s.title,
        description: s.description ?? '',
        steps: s.steps.length > 0 ? s.steps.map((e) => ({ ...e })) : [{ testStep: '', Expected: '' }]
    };
}

export function SharedStepManagerDialog({ projectId, open, onClose }: SharedStepManagerDialogProps) {
    const queryClient = useQueryClient();
    const { can } = usePermissions(projectId);
    const canWrite = can('write');
    const canDelete = can('delete');

    // Same key SharedStepPicker.tsx queries -- see that file's header
    // comment for why there is no per-module segment here.
    const queryKey = ['sharedsteps', projectId] as const;
    const stepsQuery = useQuery({ queryKey, queryFn: () => listSharedSteps(), enabled: open });
    const steps = stepsQuery.data ?? [];
    const invalidate = () => queryClient.invalidateQueries({ queryKey });

    const [formOpen, setFormOpen] = useState(false);
    const [editingStep, setEditingStep] = useState<SharedStep | null>(null);
    const [form, setForm] = useState<FormState>(EMPTY_FORM);
    const [formError, setFormError] = useState('');

    const openCreate = () => {
        setEditingStep(null);
        setForm(EMPTY_FORM);
        setFormError('');
        setFormOpen(true);
    };
    const openEdit = (s: SharedStep) => {
        setEditingStep(s);
        setForm(formFromStep(s));
        setFormError('');
        setFormOpen(true);
    };
    const closeForm = () => setFormOpen(false);

    const createMutation = useMutation({
        mutationFn: (payload: SharedStepPayload) => createSharedStep(payload),
        onSuccess: () => {
            invalidate();
            closeForm();
        },
        onError: (err: any) => setFormError(err?.response?.data?.error || 'Unable to create this shared step')
    });
    const updateMutation = useMutation({
        mutationFn: (vars: { id: string; payload: SharedStepPayload }) => updateSharedStep(vars.id, vars.payload),
        onSuccess: () => {
            invalidate();
            closeForm();
        },
        onError: (err: any) => setFormError(err?.response?.data?.error || 'Unable to update this shared step')
    });
    const saving = createMutation.isPending || updateMutation.isPending;

    const handleSave = () => {
        if (!form.title.trim()) {
            setFormError('Title is required');
            return;
        }
        const payload: SharedStepPayload = {
            title: form.title.trim(),
            description: form.description.trim() || undefined,
            steps: form.steps
        };
        if (editingStep) {
            updateMutation.mutate({ id: editingStep._id, payload });
        } else {
            createMutation.mutate(payload);
        }
    };

    const setStepField = (index: number, field: 'testStep' | 'Expected', value: string) => {
        setForm((prev) => {
            const nextSteps = [...prev.steps];
            nextSteps[index] = { ...nextSteps[index], [field]: value };
            return { ...prev, steps: nextSteps };
        });
    };
    const addStepRow = () => setForm((prev) => ({ ...prev, steps: [...prev.steps, { testStep: '', Expected: '' }] }));
    const removeStepRow = (index: number) =>
        setForm((prev) => ({ ...prev, steps: prev.steps.filter((_, i) => i !== index) }));

    const [deleteTarget, setDeleteTarget] = useState<SharedStep | null>(null);
    const [deleteError, setDeleteError] = useState('');
    const [deleteUsage, setDeleteUsage] = useState<SharedStepUsage | null>(null);

    const openDelete = (s: SharedStep) => {
        setDeleteTarget(s);
        setDeleteError('');
        setDeleteUsage(null);
    };
    const closeDelete = () => setDeleteTarget(null);

    const deleteMutation = useMutation({
        mutationFn: (id: string) => deleteSharedStep(id),
        onSuccess: () => {
            invalidate();
            closeDelete();
        },
        // A 409's body is `{ error, data: { count, testCases } }` -- see
        // this file's header comment. Any other failure (network error, a
        // plain 500) won't carry a `data.testCases` array, so `deleteUsage`
        // stays null and only the message renders.
        onError: (err: any) => {
            const body = err?.response?.data;
            setDeleteError(body?.error || 'Unable to delete this shared step');
            setDeleteUsage(body?.data && Array.isArray(body.data.testCases) ? (body.data as SharedStepUsage) : null);
        }
    });

    return (
        <>
            <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
                <DialogTitle>Manage shared steps</DialogTitle>
                <DialogContent>
                    <Stack spacing={2}>
                        <Box display="flex" justifyContent="flex-end">
                            {canWrite ? (
                                <Button variant="contained" size="small" startIcon={<AddIcon />} onClick={openCreate}>
                                    New shared step
                                </Button>
                            ) : null}
                        </Box>
                        {stepsQuery.isLoading ? (
                            <Skeleton variant="rounded" height={160} data-testid="shared-step-manager-loading" />
                        ) : stepsQuery.isError ? (
                            <EmptyState message="Unable to load shared steps. Try refreshing the page." />
                        ) : steps.length === 0 ? (
                            <EmptyState message="No shared steps defined yet." />
                        ) : (
                            <List>
                                {steps.map((s) => (
                                    <ListItem
                                        key={s._id}
                                        divider
                                        secondaryAction={
                                            canWrite || canDelete ? (
                                                <>
                                                    {canWrite ? (
                                                        <IconButton size="small" aria-label={`Edit ${s.title}`} onClick={() => openEdit(s)}>
                                                            <EditIcon fontSize="small" />
                                                        </IconButton>
                                                    ) : null}
                                                    {canDelete ? (
                                                        <IconButton size="small" aria-label={`Delete ${s.title}`} onClick={() => openDelete(s)}>
                                                            <DeleteIcon fontSize="small" />
                                                        </IconButton>
                                                    ) : null}
                                                </>
                                            ) : null
                                        }
                                    >
                                        <ListItemText
                                            primary={`${s.SharedStepId} — ${s.title}`}
                                            secondary={`${s.steps.length} step${s.steps.length === 1 ? '' : 's'}`}
                                        />
                                    </ListItem>
                                ))}
                            </List>
                        )}
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={onClose}>Close</Button>
                </DialogActions>
            </Dialog>

            <Dialog open={formOpen} onClose={closeForm} fullWidth maxWidth="sm">
                <DialogTitle>{editingStep ? 'Edit shared step' : 'New shared step'}</DialogTitle>
                <DialogContent>
                    <Stack spacing={2} mt={1}>
                        {formError ? <Alert severity="error">{formError}</Alert> : null}
                        <TextField
                            label="Title"
                            value={form.title}
                            onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
                            fullWidth
                            autoFocus
                        />
                        <TextField
                            label="Description"
                            value={form.description}
                            onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                            fullWidth
                            multiline
                            minRows={2}
                        />
                        <Typography variant="subtitle2">Steps</Typography>
                        <Stack spacing={1}>
                            {form.steps.map((s, i) => (
                                <Stack key={i} direction="row" spacing={1} alignItems="flex-start">
                                    <TextField
                                        label={`Step ${i + 1}`}
                                        value={s.testStep}
                                        onChange={(e) => setStepField(i, 'testStep', e.target.value)}
                                        fullWidth
                                        multiline
                                        size="small"
                                    />
                                    <TextField
                                        label={`Expected ${i + 1}`}
                                        value={s.Expected}
                                        onChange={(e) => setStepField(i, 'Expected', e.target.value)}
                                        fullWidth
                                        multiline
                                        size="small"
                                    />
                                    <IconButton
                                        size="small"
                                        aria-label={`Remove step ${i + 1}`}
                                        onClick={() => removeStepRow(i)}
                                        disabled={form.steps.length <= 1}
                                    >
                                        <RemoveCircleOutlineIcon fontSize="small" />
                                    </IconButton>
                                </Stack>
                            ))}
                        </Stack>
                        <Button size="small" startIcon={<AddIcon />} onClick={addStepRow} sx={{ alignSelf: 'flex-start' }}>
                            Add step
                        </Button>
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={closeForm} disabled={saving}>
                        Cancel
                    </Button>
                    <Button variant="contained" onClick={handleSave} disabled={saving}>
                        {editingStep ? 'Save' : 'Create'}
                    </Button>
                </DialogActions>
            </Dialog>

            <Dialog open={!!deleteTarget} onClose={closeDelete} fullWidth maxWidth="sm">
                <DialogTitle>Delete {deleteTarget?.title}?</DialogTitle>
                <DialogContent>
                    <DialogContentText>
                        This permanently deletes the shared step “{deleteTarget?.title}”. This cannot be undone.
                    </DialogContentText>
                    {deleteError ? (
                        <Alert severity="error" sx={{ mt: 2 }}>
                            {deleteError}
                        </Alert>
                    ) : null}
                    {deleteUsage ? (
                        <Box mt={2}>
                            <Typography variant="body2">Referenced by:</Typography>
                            <List dense>
                                {deleteUsage.testCases.map((tc) => (
                                    <ListItem key={tc.TestCaseId}>
                                        <ListItemText primary={tc.TestCaseSummary ? `${tc.TestCaseId} — ${tc.TestCaseSummary}` : tc.TestCaseId} />
                                    </ListItem>
                                ))}
                            </List>
                        </Box>
                    ) : null}
                </DialogContent>
                <DialogActions>
                    <Button onClick={closeDelete} disabled={deleteMutation.isPending}>
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
        </>
    );
}

export default SharedStepManagerDialog;
