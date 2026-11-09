import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    Alert,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogContentText,
    DialogTitle,
    IconButton,
    MenuItem,
    Select,
    SelectChangeEvent,
    Stack,
    TextField,
    Tooltip,
    Typography
} from '@mui/material';
import SaveIcon from '@mui/icons-material/Save';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import {
    SavedView,
    SavedViewEntityType,
    CreateSavedViewPayload,
    getSavedViews,
    createSavedView,
    deleteSavedView
} from '../../api/savedViewApi';

// WP-043 — the view-switcher UI for SavedView (backend/fieldsService's new
// /api/v1/savedviews CRUD). A single reusable component mounted on both the
// Test Cases and Defects DataGrid sections (see Components/common/
// BulkEntityGrid.tsx) rather than duplicated per page.
//
// "ALL" (no id) is always the first option: the unfiltered, plain
// paginated/sorted list -- switching back to it clears whatever saved
// view's queryParams were applied. System (seeded default) views are
// listed above personal ones and cannot be deleted here (the trash icon
// only renders for the caller's own personal views -- matches the backend:
// system views 403 on DELETE, see controllers/savedView.js).
//
// PERSISTENCE ACROSS SESSIONS: "Save current view" persists via a real
// POST to the backend (not localStorage) -- reopening the page (or a whole
// new browser session, i.e. a fresh token) re-fetches it from
// GET /api/v1/savedviews, proven end-to-end in
// backend/fieldsService/__tests__/savedView.test.js's "persistence
// survives a fresh token" case.

export interface ViewSwitcherProps {
    entityType: SavedViewEntityType;
    selectedViewId: string;
    onSelect: (view: SavedView | null) => void;
    /** Current grid state to persist when the user names+saves a new view. */
    getCurrentViewState: () => Pick<CreateSavedViewPayload, 'filterModel' | 'sortModel' | 'columnVisibilityModel' | 'queryParams'>;
    canSave: boolean;
}

const ALL_VIEW_VALUE = '__all__';

export function ViewSwitcher({ entityType, selectedViewId, onSelect, getCurrentViewState, canSave }: ViewSwitcherProps) {
    const queryClient = useQueryClient();
    const queryKey = ['savedViews', entityType];

    const { data: views, isLoading, isError } = useQuery({
        queryKey,
        queryFn: () => getSavedViews(entityType)
    });

    const [saveOpen, setSaveOpen] = useState(false);
    const [newName, setNewName] = useState('');
    const [saveError, setSaveError] = useState('');

    const createMutation = useMutation({
        mutationFn: createSavedView,
        onSuccess: (created) => {
            queryClient.invalidateQueries({ queryKey });
            setSaveOpen(false);
            setNewName('');
            setSaveError('');
            onSelect(created);
        },
        onError: (err: any) => {
            setSaveError(err?.response?.data?.error || 'Unable to save this view');
        }
    });

    const deleteMutation = useMutation({
        mutationFn: deleteSavedView,
        onSuccess: (_data, deletedId) => {
            queryClient.invalidateQueries({ queryKey });
            if (deletedId === selectedViewId) {
                onSelect(null);
            }
        }
    });

    const handleChange = (event: SelectChangeEvent<string>) => {
        const value = event.target.value;
        if (value === ALL_VIEW_VALUE) {
            onSelect(null);
            return;
        }
        const view = (views || []).find((v) => v._id === value) || null;
        onSelect(view);
    };

    const handleSave = () => {
        if (!newName.trim()) {
            setSaveError('Name is required');
            return;
        }
        createMutation.mutate({ entityType, name: newName.trim(), ...getCurrentViewState() });
    };

    const handleDelete = (view: SavedView) => {
        if (!window.confirm(`Delete saved view "${view.name}"? This only removes it for you.`)) return;
        deleteMutation.mutate(view._id);
    };

    const systemViews = (views || []).filter((v) => v.isSystem);
    const personalViews = (views || []).filter((v) => !v.isSystem);
    const selectedView = (views || []).find((v) => v._id === selectedViewId);

    return (
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
            <Select
                size="small"
                value={selectedViewId || ALL_VIEW_VALUE}
                onChange={handleChange}
                displayEmpty
                disabled={isLoading}
                sx={{ minWidth: 220 }}
                inputProps={{ 'aria-label': 'Saved view' }}
            >
                <MenuItem value={ALL_VIEW_VALUE}>All (no saved view)</MenuItem>
                {systemViews.map((v) => (
                    <MenuItem key={v._id} value={v._id}>
                        {v.name}
                    </MenuItem>
                ))}
                {personalViews.map((v) => (
                    <MenuItem key={v._id} value={v._id}>
                        {v.name} (mine)
                    </MenuItem>
                ))}
            </Select>

            {selectedView && !selectedView.isSystem && canSave ? (
                <Tooltip title="Delete this saved view">
                    <IconButton
                        size="small"
                        aria-label="Delete this saved view"
                        onClick={() => handleDelete(selectedView)}
                        disabled={deleteMutation.isPending}
                    >
                        <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                </Tooltip>
            ) : null}

            {canSave ? (
                <Button size="small" startIcon={<SaveIcon />} onClick={() => setSaveOpen(true)}>
                    Save current view
                </Button>
            ) : null}

            {isError ? (
                <Typography variant="caption" color="error">
                    Unable to load saved views.
                </Typography>
            ) : null}

            <Dialog open={saveOpen} onClose={() => setSaveOpen(false)} fullWidth maxWidth="xs">
                <DialogTitle>Save current view</DialogTitle>
                <DialogContent>
                    <DialogContentText sx={{ mb: 2 }}>
                        Saves the current sort and filter as a personal view, visible only to you on this project. It persists
                        across sessions.
                    </DialogContentText>
                    {saveError ? (
                        <Alert severity="error" sx={{ mb: 2 }}>
                            {saveError}
                        </Alert>
                    ) : null}
                    <TextField
                        autoFocus
                        fullWidth
                        label="View name"
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                    />
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setSaveOpen(false)}>Cancel</Button>
                    <Button variant="contained" onClick={handleSave} disabled={createMutation.isPending}>
                        Save
                    </Button>
                </DialogActions>
            </Dialog>
        </Stack>
    );
}

export default ViewSwitcher;
