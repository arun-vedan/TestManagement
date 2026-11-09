import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Stack,
  TextField,
} from '@mui/material';
import { ModuleId } from '../../workbench/modules';
import { buildEntityPrefill, RawRecord } from '../../workbench/entityPrefill';
import { CaseTemplatePayload, createCaseTemplate } from '../../api/caseTemplateApi';

// WP-F08 Task 2 -- "Save as template" (the other half of the feature from
// CaseTemplatePicker, which starts a draft FROM one of these). Structure,
// query-key, and error-handling conventions deliberately mirror
// SharedStepManagerDialog.tsx's own create form rather than inventing a
// second style: same `err?.response?.data?.error` read, same close-on-
// success, same disabled-while-pending buttons.
//
// R4 -- a template captures `record` as it is RIGHT NOW and never updates
// afterward: it is a snapshot, not a live link back to the record it came
// from (that is what WP-F06's SharedStep steps already do, deliberately,
// for the one thing in this product that DOES want live propagation). The
// dialog copy below says so explicitly so a user coming from that other
// feature doesn't assume the same behaviour here.
export interface SaveAsTemplateDialogProps {
  projectId: number;
  module: ModuleId;
  open: boolean;
  onClose: () => void;
  /** The record to snapshot -- the calling detail component's own
   *  already-loaded, flattened `values` object (the exact shape
   *  useCloneEntity would otherwise re-fetch and flatten itself; see
   *  workbench/entityPrefill.ts's header comment on why reusing what's
   *  already on screen is safe here, and cheaper than a second fetch). */
  record: RawRecord;
}

export function SaveAsTemplateDialog({ projectId, module, open, onClose, record }: SaveAsTemplateDialogProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [formError, setFormError] = useState('');

  const reset = (): void => {
    setName('');
    setDescription('');
    setFormError('');
  };

  const handleClose = (): void => {
    reset();
    onClose();
  };

  const createMutation = useMutation({
    mutationFn: (payload: CaseTemplatePayload) => createCaseTemplate(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['casetemplates', projectId, module] });
      handleClose();
    },
    onError: (err: { response?: { data?: { error?: string } } }) =>
      setFormError(err?.response?.data?.error || 'Unable to save this template'),
  });

  const handleSave = (): void => {
    const trimmed = name.trim();
    if (!trimmed) {
      setFormError('Name is required');
      return;
    }
    // The SAME per-module flatten useCloneEntity.ts uses (buildEntityPrefill,
    // workbench/entityPrefill.ts) -- a template's captured prefill can
    // never diverge from what cloning this same record would have
    // produced, including fields like datasetId that are easy to drop
    // silently (useCloneEntity's own header comment records exactly that
    // regression, fixed by WP-F07a).
    const { prefill } = buildEntityPrefill(module, record);
    createMutation.mutate({
      moduleId: module,
      name: trimmed,
      description: description.trim() || undefined,
      prefill,
    });
  };

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="sm">
      <DialogTitle>Save as template</DialogTitle>
      <DialogContent>
        <Stack spacing={2} mt={1}>
          <DialogContentText>
            Captures this record&apos;s current fields as a reusable starting point for new work.
            Later edits to this record or the template stay independent of one another.
          </DialogContentText>
          {formError ? <Alert severity="error">{formError}</Alert> : null}
          <TextField
            label="Template name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            fullWidth
            autoFocus
          />
          <TextField
            label="Description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            fullWidth
            multiline
            minRows={2}
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={createMutation.isPending}>
          Cancel
        </Button>
        <Button variant="contained" onClick={handleSave} disabled={createMutation.isPending}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default SaveAsTemplateDialog;
