import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    List,
    ListItem,
    ListItemText,
    Skeleton,
    TextField
} from '@mui/material';
import { EmptyState } from '../common/EmptyState';
import usePermissions from '../../Hooks/usePermissions';
import { SharedStep, listSharedSteps } from '../../api/sharedStepApi';

// WP-F06 Task 5 -- lets a test-case author insert a REFERENCE to a shared
// step (the library Task 4's Steps tab already renders and preserves)
// instead of retyping the same steps into every test case that needs
// them. This dialog only reads the library; it never creates, edits, or
// deletes a shared step (that is SharedStepManagerDialog's job).
//
// The row handed back to `onInsert` is intentionally minimal --
// `{ sharedStepId, sharedStepTitle }`, nothing else -- because storing a
// reference instead of the shared step's expanded text is the entire
// point of the feature (see TableRows.tsx's `row.sharedStepId` branch,
// which renders exactly this shape and ignores testStep/Expected on such
// a row). `sharedStepId` is the shared step's Mongo `_id`, not its
// human-facing `SharedStepId` (SS-n) -- that is the id every
// /api/v1/sharedstep/:id route reads (controllers/sharedStep.js), and the
// id findUsage() matches TestSteps.sharedStepId against, so inserting any
// other value here would silently break both lookup and usage tracking.
//
// Query key ['sharedsteps', projectId] -- shared steps aren't scoped to a
// module the way Fields are (FieldsPanel.tsx's own key includes
// moduleId), so there is no module segment here. SharedStepManagerDialog
// reads/invalidates the exact same key, so a create/edit/delete made
// there is reflected here without a reload the next time this picker
// opens. `enabled: open` keeps this from firing while the dialog is
// closed, matching FieldsPanel's own query lifecycle.
export interface SharedStepPickerProps {
    projectId: number;
    open: boolean;
    onClose: () => void;
    onInsert: (row: { sharedStepId: string; sharedStepTitle: string }) => void;
}

export function SharedStepPicker({ projectId, open, onClose, onInsert }: SharedStepPickerProps) {
    const { can } = usePermissions(projectId);
    const canWrite = can('write');

    const [search, setSearch] = useState('');

    const stepsQuery = useQuery({
        queryKey: ['sharedsteps', projectId] as const,
        queryFn: () => listSharedSteps(),
        enabled: open
    });
    const steps = stepsQuery.data ?? [];

    const filtered = useMemo(() => {
        const all = stepsQuery.data ?? [];
        const q = search.trim().toLowerCase();
        if (!q) return all;
        return all.filter((s) => s.title.toLowerCase().includes(q));
    }, [stepsQuery.data, search]);

    const handleInsert = (step: SharedStep) => {
        onInsert({ sharedStepId: step._id, sharedStepTitle: step.title });
        onClose();
    };

    return (
        <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
            <DialogTitle>Insert shared step</DialogTitle>
            <DialogContent>
                <TextField
                    label="Search shared steps"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    fullWidth
                    autoFocus
                    size="small"
                    sx={{ mb: 2 }}
                />
                {stepsQuery.isLoading ? (
                    <Skeleton variant="rounded" height={120} data-testid="shared-step-picker-loading" />
                ) : stepsQuery.isError ? (
                    <EmptyState message="Unable to load shared steps. Try refreshing the page." />
                ) : filtered.length === 0 ? (
                    <EmptyState message={steps.length === 0 ? 'No shared steps exist yet.' : 'No shared steps match your search.'} />
                ) : (
                    <List>
                        {filtered.map((step) => (
                            <ListItem
                                key={step._id}
                                divider
                                secondaryAction={
                                    canWrite ? (
                                        <Button size="small" variant="outlined" onClick={() => handleInsert(step)}>
                                            Insert
                                        </Button>
                                    ) : null
                                }
                            >
                                <ListItemText
                                    primary={step.title}
                                    secondary={
                                        step.description
                                            ? step.description
                                            : `${step.steps.length} step${step.steps.length === 1 ? '' : 's'}`
                                    }
                                />
                            </ListItem>
                        ))}
                    </List>
                )}
            </DialogContent>
            <DialogActions>
                <Button onClick={onClose}>Close</Button>
            </DialogActions>
        </Dialog>
    );
}

export default SharedStepPicker;
