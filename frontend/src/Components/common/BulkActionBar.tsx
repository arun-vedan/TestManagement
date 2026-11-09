import { useState } from 'react';
import {
    Alert,
    Button,
    Checkbox,
    Dialog,
    DialogActions,
    DialogContent,
    DialogContentText,
    DialogTitle,
    FormControlLabel,
    Paper,
    Stack,
    TextField,
    Typography
} from '@mui/material';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { BulkPolicyError, BulkResponse } from '../../api/bulkApi';

// WP-043 — bulk-action confirmation. Per the owner's 2026-08-28 design
// direction, this is the ONE deliberate exception to "no bespoke design"
// in this WP: a bulk action commits an irreversible change to potentially
// many records in one click, so what is about to happen (how many items,
// which action, whether it's all-or-nothing) must be unmistakable before
// the user commits — same class of exception as WP-032's show-secret-once
// dialog and WP-045's import preview.
//
// The dialog's own text states "all or nothing" EXPLICITLY, matching
// bulkApi.ts's BulkResponse.policy verbatim — the promise made here and
// the backend's actual behavior can never diverge (see bulkApi.ts's header
// comment).

export type BulkActionKind = 'assign' | 'status' | 'delete';

export interface BulkActionConfig {
    kind: BulkActionKind;
    label: string;
    /** For 'assign'/'status': prompts for a free-text value (assignee id, or a status name). */
    valueLabel?: string;
    /** For 'status': constrains the free-text value to this set, rendered as a hint. */
    allowedValues?: string[];
    run: (ids: string[], value?: string) => Promise<BulkResponse<unknown>>;
}

export interface BulkActionBarProps {
    selectedIds: string[];
    actions: BulkActionConfig[];
    onCleared: () => void;
    onSuccess: (kind: BulkActionKind, response: BulkResponse<unknown>) => void;
}

export function BulkActionBar({ selectedIds, actions, onCleared, onSuccess }: BulkActionBarProps) {
    const [pendingAction, setPendingAction] = useState<BulkActionConfig | null>(null);
    const [value, setValue] = useState('');
    const [running, setRunning] = useState(false);
    const [error, setError] = useState('');

    if (selectedIds.length === 0 || actions.length === 0) {
        return null;
    }

    const openConfirm = (action: BulkActionConfig) => {
        setPendingAction(action);
        setValue('');
        setError('');
    };

    const closeConfirm = () => {
        if (running) return;
        setPendingAction(null);
        setValue('');
        setError('');
    };

    const handleConfirm = async () => {
        if (!pendingAction) return;
        if (pendingAction.kind !== 'delete' && !value.trim()) {
            setError(`${pendingAction.valueLabel || 'A value'} is required`);
            return;
        }
        setRunning(true);
        setError('');
        try {
            const resp = await pendingAction.run(selectedIds, value.trim() || undefined);
            onSuccess(pendingAction.kind, resp);
            setPendingAction(null);
            setValue('');
            onCleared();
        } catch (err) {
            if (err instanceof BulkPolicyError) {
                setError(err.message);
            } else {
                setError((err as Error)?.message || 'Bulk operation failed');
            }
        } finally {
            setRunning(false);
        }
    };

    return (
        <>
            <Paper
                variant="outlined"
                sx={{ p: 1.5, mb: 1, display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}
                data-testid="bulk-action-bar"
            >
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                    {selectedIds.length} selected
                </Typography>
                {actions.map((action) => (
                    <Button key={action.kind} size="small" variant="outlined" color={action.kind === 'delete' ? 'error' : 'primary'} onClick={() => openConfirm(action)}>
                        {action.label}
                    </Button>
                ))}
                <Button size="small" onClick={onCleared}>
                    Clear selection
                </Button>
            </Paper>

            <Dialog open={Boolean(pendingAction)} onClose={closeConfirm} fullWidth maxWidth="sm">
                <DialogTitle>
                    <Stack direction="row" spacing={1} alignItems="center">
                        <WarningAmberIcon color="warning" />
                        <span>Confirm bulk {pendingAction?.label.toLowerCase()}</span>
                    </Stack>
                </DialogTitle>
                <DialogContent>
                    <Stack spacing={2} mt={1}>
                        <Alert severity="warning" variant="filled">
                            This will {pendingAction?.label.toLowerCase()} {selectedIds.length} item{selectedIds.length === 1 ? '' : 's'} in
                            one action. Policy: <strong>all or nothing</strong> — if any item can't be changed, NONE of them will be, and
                            nothing partial is applied.
                        </Alert>
                        {error ? <Alert severity="error">{error}</Alert> : null}
                        {pendingAction && pendingAction.kind !== 'delete' ? (
                            <TextField
                                autoFocus
                                fullWidth
                                label={pendingAction.valueLabel || 'Value'}
                                value={value}
                                onChange={(e) => setValue(e.target.value)}
                                helperText={pendingAction.allowedValues ? `One of: ${pendingAction.allowedValues.join(', ')}` : undefined}
                            />
                        ) : (
                            <FormControlLabel
                                control={<Checkbox checked disabled />}
                                label={`I understand this permanently deletes ${selectedIds.length} item${selectedIds.length === 1 ? '' : 's'}.`}
                            />
                        )}
                        <DialogContentText variant="caption">
                            Every item changed by this action is recorded individually in the audit log (one event per item), with you as
                            the actor.
                        </DialogContentText>
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={closeConfirm} disabled={running}>
                        Cancel
                    </Button>
                    <Button variant="contained" color={pendingAction?.kind === 'delete' ? 'error' : 'primary'} onClick={handleConfirm} disabled={running}>
                        {running ? 'Applying…' : `Confirm ${pendingAction?.label.toLowerCase()}`}
                    </Button>
                </DialogActions>
            </Dialog>
        </>
    );
}

export default BulkActionBar;
