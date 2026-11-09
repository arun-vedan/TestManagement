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
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableRow,
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
    Dataset,
    DatasetPayload,
    DatasetUsage,
    createDataset,
    deleteDataset,
    listDatasets,
    updateDataset
} from '../../api/datasetApi';

// WP-F07a Task 4 -- the dataset library's own CRUD surface, following
// SharedStepManagerDialog.tsx's (WP-F06 Task 5) structure, query-key, and
// error-handling conventions closely rather than inventing a second style:
// same create/edit dialog + separate delete-confirmation dialog split,
// same `invalidate()` after every mutation, same
// `err?.response?.data?.error` read for a mutation's error text.
//
// One thing that IS different from a shared step's flat `steps` array: a
// dataset is a small spreadsheet (columns + rows), and the two must stay
// rectangular -- Dataset.js's own ragged-row guard rejects a PUT/POST
// where any row's length disagrees with the column count. Every column
// add/remove below keeps every row in lockstep (append/splice the same
// index into every row at the same time a column is appended/removed) so
// the payload this dialog sends can never itself be ragged.
//
// Same thing FieldsPanel's delete flow does NOT need and this one does: a
// dataset still bound to a test case is refused with HTTP 409 and a
// `{ error, data: { count, testCases } }` body (api/datasetApi.ts's
// deleteDataset header comment, controllers/dataset.js's deleteDataset).
// Swallowing that down to a generic "delete failed" would throw away the
// one thing the backend went out of its way to compute -- WHICH test
// cases are in the way -- so the delete-confirmation dialog renders
// `data.testCases` on a 409 instead of just the error string.
export interface DatasetManagerDialogProps {
    projectId: number;
    open: boolean;
    onClose: () => void;
}

interface FormState {
    title: string;
    description: string;
    columns: string[];
    rows: string[][];
}

const EMPTY_FORM: FormState = { title: '', description: '', columns: [''], rows: [] };

function formFromDataset(d: Dataset): FormState {
    return {
        title: d.title,
        description: d.description ?? '',
        columns: d.columns.length > 0 ? [...d.columns] : [''],
        rows: d.rows.map((r) => [...r])
    };
}

export function DatasetManagerDialog({ projectId, open, onClose }: DatasetManagerDialogProps) {
    const queryClient = useQueryClient();
    const { can } = usePermissions(projectId);
    const canWrite = can('write');
    const canDelete = can('delete');

    // Same key shape as sharedsteps' own ['sharedsteps', projectId] --
    // datasets aren't scoped to a module either, so there is no module
    // segment here. DatasetBindControl.tsx queries this identical key, so a
    // create/edit/delete made here is reflected there with no reload the
    // next time its picker opens.
    const queryKey = ['datasets', projectId] as const;
    const datasetsQuery = useQuery({ queryKey, queryFn: () => listDatasets(), enabled: open });
    const datasets = datasetsQuery.data ?? [];
    const invalidate = () => queryClient.invalidateQueries({ queryKey });

    const [formOpen, setFormOpen] = useState(false);
    const [editingDataset, setEditingDataset] = useState<Dataset | null>(null);
    const [form, setForm] = useState<FormState>(EMPTY_FORM);
    const [formError, setFormError] = useState('');

    const openCreate = () => {
        setEditingDataset(null);
        setForm(EMPTY_FORM);
        setFormError('');
        setFormOpen(true);
    };
    const openEdit = (d: Dataset) => {
        setEditingDataset(d);
        setForm(formFromDataset(d));
        setFormError('');
        setFormOpen(true);
    };
    const closeForm = () => setFormOpen(false);

    const createMutation = useMutation({
        mutationFn: (payload: DatasetPayload) => createDataset(payload),
        onSuccess: () => {
            invalidate();
            closeForm();
        },
        onError: (err: any) => setFormError(err?.response?.data?.error || 'Unable to create this dataset')
    });
    const updateMutation = useMutation({
        mutationFn: (vars: { id: string; payload: DatasetPayload }) => updateDataset(vars.id, vars.payload),
        onSuccess: () => {
            invalidate();
            closeForm();
        },
        onError: (err: any) => setFormError(err?.response?.data?.error || 'Unable to update this dataset')
    });
    const saving = createMutation.isPending || updateMutation.isPending;

    const handleSave = () => {
        if (!form.title.trim()) {
            setFormError('Title is required');
            return;
        }
        const payload: DatasetPayload = {
            title: form.title.trim(),
            description: form.description.trim() || undefined,
            columns: form.columns.map((c) => c.trim()),
            rows: form.rows.map((r) => [...r])
        };
        if (editingDataset) {
            updateMutation.mutate({ id: editingDataset._id, payload });
        } else {
            createMutation.mutate(payload);
        }
    };

    const setColumnName = (index: number, value: string) =>
        setForm((prev) => {
            const nextColumns = [...prev.columns];
            nextColumns[index] = value;
            return { ...prev, columns: nextColumns };
        });
    // Keeps every row rectangular: a new column gets an empty value slot in
    // every existing row at the exact index it was inserted, the same
    // instant the column itself is added -- there is no intermediate state
    // where columns and rows disagree in length.
    const addColumn = () =>
        setForm((prev) => ({
            ...prev,
            columns: [...prev.columns, ''],
            rows: prev.rows.map((r) => [...r, ''])
        }));
    const removeColumn = (index: number) =>
        setForm((prev) => ({
            ...prev,
            columns: prev.columns.filter((_, i) => i !== index),
            rows: prev.rows.map((r) => r.filter((_, i) => i !== index))
        }));

    const addRow = () => setForm((prev) => ({ ...prev, rows: [...prev.rows, prev.columns.map(() => '')] }));
    const removeRow = (index: number) => setForm((prev) => ({ ...prev, rows: prev.rows.filter((_, i) => i !== index) }));
    const setCellValue = (rowIndex: number, colIndex: number, value: string) =>
        setForm((prev) => {
            const nextRows = prev.rows.map((r) => [...r]);
            nextRows[rowIndex][colIndex] = value;
            return { ...prev, rows: nextRows };
        });

    const [deleteTarget, setDeleteTarget] = useState<Dataset | null>(null);
    const [deleteError, setDeleteError] = useState('');
    const [deleteUsage, setDeleteUsage] = useState<DatasetUsage | null>(null);

    const openDelete = (d: Dataset) => {
        setDeleteTarget(d);
        setDeleteError('');
        setDeleteUsage(null);
    };
    const closeDelete = () => setDeleteTarget(null);

    const deleteMutation = useMutation({
        mutationFn: (id: string) => deleteDataset(id),
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
            setDeleteError(body?.error || 'Unable to delete this dataset');
            setDeleteUsage(body?.data && Array.isArray(body.data.testCases) ? (body.data as DatasetUsage) : null);
        }
    });

    return (
        <>
            <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
                <DialogTitle>Manage datasets</DialogTitle>
                <DialogContent>
                    <Stack spacing={2}>
                        <Box display="flex" justifyContent="flex-end">
                            {canWrite ? (
                                <Button variant="contained" size="small" startIcon={<AddIcon />} onClick={openCreate}>
                                    New dataset
                                </Button>
                            ) : null}
                        </Box>
                        {datasetsQuery.isLoading ? (
                            <Skeleton variant="rounded" height={160} data-testid="dataset-manager-loading" />
                        ) : datasetsQuery.isError ? (
                            <EmptyState message="Unable to load datasets. Try refreshing the page." />
                        ) : datasets.length === 0 ? (
                            <EmptyState message="No datasets defined yet." />
                        ) : (
                            <List>
                                {datasets.map((d) => (
                                    <ListItem
                                        key={d._id}
                                        divider
                                        secondaryAction={
                                            canWrite || canDelete ? (
                                                <>
                                                    {canWrite ? (
                                                        <IconButton size="small" aria-label={`Edit ${d.title}`} onClick={() => openEdit(d)}>
                                                            <EditIcon fontSize="small" />
                                                        </IconButton>
                                                    ) : null}
                                                    {canDelete ? (
                                                        <IconButton size="small" aria-label={`Delete ${d.title}`} onClick={() => openDelete(d)}>
                                                            <DeleteIcon fontSize="small" />
                                                        </IconButton>
                                                    ) : null}
                                                </>
                                            ) : null
                                        }
                                    >
                                        <ListItemText
                                            primary={`${d.DatasetId} — ${d.title}`}
                                            secondary={`${d.columns.length} column${d.columns.length === 1 ? '' : 's'}, ${d.rows.length} row${d.rows.length === 1 ? '' : 's'}`}
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

            <Dialog open={formOpen} onClose={closeForm} fullWidth maxWidth="md">
                <DialogTitle>{editingDataset ? 'Edit dataset' : 'New dataset'}</DialogTitle>
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
                        <Typography variant="subtitle2">Columns</Typography>
                        <Stack spacing={1}>
                            {form.columns.map((c, i) => (
                                <Stack key={i} direction="row" spacing={1} alignItems="center">
                                    <TextField
                                        label={`Column ${i + 1}`}
                                        value={c}
                                        onChange={(e) => setColumnName(i, e.target.value)}
                                        size="small"
                                        fullWidth
                                    />
                                    <IconButton
                                        size="small"
                                        aria-label={`Remove column ${i + 1}`}
                                        onClick={() => removeColumn(i)}
                                        disabled={form.columns.length <= 1}
                                    >
                                        <RemoveCircleOutlineIcon fontSize="small" />
                                    </IconButton>
                                </Stack>
                            ))}
                        </Stack>
                        <Button size="small" startIcon={<AddIcon />} onClick={addColumn} sx={{ alignSelf: 'flex-start' }}>
                            Add column
                        </Button>

                        <Typography variant="subtitle2">Rows</Typography>
                        {form.rows.length === 0 ? (
                            <Typography variant="body2" color="text.secondary">
                                No rows yet.
                            </Typography>
                        ) : (
                            <Table size="small">
                                <TableHead>
                                    <TableRow>
                                        {form.columns.map((c, i) => (
                                            <TableCell key={i}>{c || `Column ${i + 1}`}</TableCell>
                                        ))}
                                        <TableCell align="right" />
                                    </TableRow>
                                </TableHead>
                                <TableBody>
                                    {form.rows.map((row, rowIndex) => (
                                        <TableRow key={rowIndex}>
                                            {row.map((value, colIndex) => (
                                                <TableCell key={colIndex}>
                                                    <TextField
                                                        size="small"
                                                        fullWidth
                                                        value={value}
                                                        inputProps={{ 'aria-label': `Row ${rowIndex + 1}, ${form.columns[colIndex] || `column ${colIndex + 1}`}` }}
                                                        onChange={(e) => setCellValue(rowIndex, colIndex, e.target.value)}
                                                    />
                                                </TableCell>
                                            ))}
                                            <TableCell align="right">
                                                <IconButton size="small" aria-label={`Remove row ${rowIndex + 1}`} onClick={() => removeRow(rowIndex)}>
                                                    <RemoveCircleOutlineIcon fontSize="small" />
                                                </IconButton>
                                            </TableCell>
                                        </TableRow>
                                    ))}
                                </TableBody>
                            </Table>
                        )}
                        <Button size="small" startIcon={<AddIcon />} onClick={addRow} sx={{ alignSelf: 'flex-start' }}>
                            Add row
                        </Button>
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={closeForm} disabled={saving}>
                        Cancel
                    </Button>
                    <Button variant="contained" onClick={handleSave} disabled={saving}>
                        {editingDataset ? 'Save' : 'Create'}
                    </Button>
                </DialogActions>
            </Dialog>

            <Dialog open={!!deleteTarget} onClose={closeDelete} fullWidth maxWidth="sm">
                <DialogTitle>Delete {deleteTarget?.title}?</DialogTitle>
                <DialogContent>
                    <DialogContentText>
                        This permanently deletes the dataset “{deleteTarget?.title}”. This cannot be undone.
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

export default DatasetManagerDialog;
