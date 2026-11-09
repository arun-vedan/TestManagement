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
import { Environment, createEnvironment, deleteEnvironment, getEnvironments, updateEnvironment } from '../../api/releaseApi';

// WP-F18b Task 1 — Settings > Environments. R1 of this WP's plan: an
// environment is project-scoped configuration of the same shape as
// Fields, not a test asset, and only ever lived on the old standalone nav
// page (Pages/releases.tsx) because releases were the first thing that
// needed it. Structure and react-query conventions deliberately mirror
// FieldsPanel.tsx, the proven Settings-panel analogue in this codebase
// (list + create + edit + delete + permission gating).
//
// WP-F18b Task 4 removed that nav page's own (create-only) environments
// section along with the page itself -- see this WP's plan, ruling R5.
// This panel is the only home now, and it does strictly more than that
// section ever did (create/edit/delete vs. create-only).
//
// CACHE KEY: ['project', projectId, 'environments'] -- scoped by project
// only (environments have no per-module split the way Fields does).

interface EnvironmentFormState {
    name: string;
    description: string;
    url: string;
}

const EMPTY_FORM: EnvironmentFormState = { name: '', description: '', url: '' };

function formFromEnvironment(e: Environment): EnvironmentFormState {
    return { name: e.name, description: e.description ?? '', url: e.url ?? '' };
}

export interface EnvironmentsPanelProps {
    projectId: number;
}

export function EnvironmentsPanel({ projectId }: EnvironmentsPanelProps) {
    const queryClient = useQueryClient();
    const { can } = usePermissions(projectId);
    const canWrite = can('write');
    const canDelete = can('delete');

    const [errorMessage, setErrorMessage] = useState('');
    const [errorOpen, setErrorOpen] = useState(false);
    const showError = (message: string) => {
        setErrorMessage(message);
        setErrorOpen(true);
    };

    const environmentsQuery = useQuery({
        queryKey: ['project', projectId, 'environments'] as const,
        queryFn: () => getEnvironments()
    });
    const environments = environmentsQuery.data ?? [];

    const invalidate = () => queryClient.invalidateQueries({ queryKey: ['project', projectId, 'environments'] });

    const [dialogOpen, setDialogOpen] = useState(false);
    const [editingEnvironment, setEditingEnvironment] = useState<Environment | null>(null);
    const [form, setForm] = useState<EnvironmentFormState>(EMPTY_FORM);
    const [formError, setFormError] = useState('');

    const openCreate = () => {
        setEditingEnvironment(null);
        setForm(EMPTY_FORM);
        setFormError('');
        setDialogOpen(true);
    };

    const openEdit = (env: Environment) => {
        setEditingEnvironment(env);
        setForm(formFromEnvironment(env));
        setFormError('');
        setDialogOpen(true);
    };

    const closeDialog = () => setDialogOpen(false);

    const createMutation = useMutation({
        mutationFn: createEnvironment,
        onSuccess: () => {
            invalidate();
            closeDialog();
        },
        onError: (err: any) => showError(err?.response?.data?.error || 'Unable to create this environment')
    });

    const updateMutation = useMutation({
        mutationFn: (vars: { id: string; payload: Partial<Pick<Environment, 'name' | 'description' | 'url'>> }) =>
            updateEnvironment(vars.id, vars.payload),
        onSuccess: () => {
            invalidate();
            closeDialog();
        },
        onError: (err: any) => showError(err?.response?.data?.error || 'Unable to update this environment')
    });

    const deleteMutation = useMutation({
        mutationFn: deleteEnvironment,
        onSuccess: () => {
            invalidate();
            setDeleteTarget(null);
        },
        onError: (err: any) => showError(err?.response?.data?.error || 'Unable to delete this environment')
    });

    const handleSave = () => {
        if (!form.name.trim()) {
            setFormError('Name is required');
            return;
        }
        const payload = {
            name: form.name.trim(),
            description: form.description.trim() || undefined,
            url: form.url.trim() || undefined
        };
        if (editingEnvironment) {
            updateMutation.mutate({ id: editingEnvironment._id, payload });
        } else {
            createMutation.mutate(payload);
        }
    };

    const [deleteTarget, setDeleteTarget] = useState<Environment | null>(null);

    const saving = createMutation.isPending || updateMutation.isPending;

    return (
        <Box>
            {errorOpen ? (
                <CustomizedSnackbars errorMessage={errorMessage} refresh={errorOpen} closeError={() => setErrorOpen(false)} severity={'error'} />
            ) : null}
            <Stack spacing={2}>
                <Typography variant="body2" color="text.secondary">
                    Environments describe where a release's test plans and runs target -- staging, production, and the like.
                    They are shared across every release in this project.
                </Typography>

                <Stack direction="row" spacing={2} alignItems="center" justifyContent="flex-end">
                    {canWrite ? (
                        <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
                            New Environment
                        </Button>
                    ) : null}
                </Stack>

                {environmentsQuery.isLoading ? (
                    <Skeleton variant="rounded" height={160} data-testid="environments-panel-loading" />
                ) : environmentsQuery.isError ? (
                    <EmptyState message="Unable to load environments. Try refreshing the page." />
                ) : environments.length === 0 ? (
                    <EmptyState message="No environments yet. Create one so plans/executions can target it." />
                ) : (
                    <TableContainer>
                        <Table size="small">
                            <TableHead>
                                <TableRow>
                                    <TableCell>Name</TableCell>
                                    <TableCell>Description</TableCell>
                                    <TableCell>URL</TableCell>
                                    {canWrite || canDelete ? <TableCell align="right">Actions</TableCell> : null}
                                </TableRow>
                            </TableHead>
                            <TableBody>
                                {environments.map((env) => (
                                    <TableRow key={env._id}>
                                        <TableCell>{env.name}</TableCell>
                                        <TableCell>{env.description || '—'}</TableCell>
                                        <TableCell>{env.url || '—'}</TableCell>
                                        {canWrite || canDelete ? (
                                            <TableCell align="right">
                                                {canWrite ? (
                                                    <IconButton size="small" aria-label={`Edit ${env.name}`} onClick={() => openEdit(env)}>
                                                        <EditIcon fontSize="small" />
                                                    </IconButton>
                                                ) : null}
                                                {canDelete ? (
                                                    <IconButton
                                                        size="small"
                                                        aria-label={`Delete ${env.name}`}
                                                        onClick={() => setDeleteTarget(env)}
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
                <DialogTitle>{editingEnvironment ? 'Edit Environment' : 'New Environment'}</DialogTitle>
                <DialogContent>
                    <Stack spacing={2} mt={1}>
                        {formError ? <Alert severity="error">{formError}</Alert> : null}
                        <TextField
                            label="Name"
                            value={form.name}
                            onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                            fullWidth
                            autoFocus
                        />
                        <TextField
                            label="Description"
                            value={form.description}
                            onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                            fullWidth
                        />
                        <TextField
                            label="URL"
                            value={form.url}
                            onChange={(e) => setForm((prev) => ({ ...prev, url: e.target.value }))}
                            fullWidth
                        />
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={closeDialog} disabled={saving}>
                        Cancel
                    </Button>
                    <Button variant="contained" onClick={handleSave} disabled={saving}>
                        {editingEnvironment ? 'Save' : 'Create'}
                    </Button>
                </DialogActions>
            </Dialog>

            <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} fullWidth maxWidth="sm">
                <DialogTitle>Delete {deleteTarget?.name}?</DialogTitle>
                <DialogContent>
                    <DialogContentText>
                        This permanently deletes the “{deleteTarget?.name}” environment. Any release, plan or run that
                        targets it keeps its recorded results, but will no longer be able to select it going forward. This
                        cannot be undone.
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

export default EnvironmentsPanel;
