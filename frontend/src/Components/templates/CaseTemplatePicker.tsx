import { useMemo, useState } from 'react';
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
  List,
  ListItem,
  ListItemText,
  Skeleton,
  TextField,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/Delete';
import { EmptyState } from '../common/EmptyState';
import { usePermissions } from '../../Hooks/usePermissions';
import { ModuleId } from '../../workbench/modules';
import { CaseTemplate, deleteCaseTemplate, listCaseTemplates } from '../../api/caseTemplateApi';
import { useStartFromTemplate } from '../../Hooks/mutations/useStartFromTemplate';

// WP-F08 Task 2 -- lets an author start a new draft from a previously
// saved CaseTemplate instead of the usual blank "New ..." form
// (SourcePanel.tsx's NewEntityButton). This dialog only reads the
// library and, as of the delete affordance below, removes entries from
// it; it never creates or edits a template (that is SaveAsTemplateDialog's
// job, opened from the source record itself, not from here).
//
// Modelled directly on SharedStepPicker.tsx -- same search-a-list-then-act
// shape, same `enabled: open` query lifecycle, same canWrite re-check on
// the action button even though the caller (SourcePanel's CreateActions)
// already gates the whole control on can('write') before this ever opens,
// matching SharedStepPicker's own belt-and-braces reasoning.
//
// The delete control and its confirmation dialog follow
// SharedStepManagerDialog.tsx's own delete flow (can('delete') gate,
// confirm-then-mutate, invalidate() on success). One deliberate
// difference: there is no usage-guard/409 path here. A CaseTemplate is
// COPIED into a draft's prefill at "Use" time (useStartFromTemplate.ts)
// rather than referenced by id, so nothing in the system points back at a
// template after it is created -- unlike SharedStep and Dataset, which
// refuse deletion while a test case still references them. The
// confirmation dialog is therefore the only safeguard against permanent
// loss.
export interface CaseTemplatePickerProps {
  projectId: number;
  module: ModuleId;
  open: boolean;
  onClose: () => void;
}

export function CaseTemplatePicker({ projectId, module, open, onClose }: CaseTemplatePickerProps) {
  const queryClient = useQueryClient();
  const { can } = usePermissions(projectId);
  const canWrite = can('write');
  const canDelete = can('delete');
  const startFromTemplate = useStartFromTemplate(module);

  const [search, setSearch] = useState('');

  const queryKey = ['casetemplates', projectId, module] as const;
  const templatesQuery = useQuery({
    queryKey,
    queryFn: () => listCaseTemplates(module),
    enabled: open,
  });
  const templates = templatesQuery.data ?? [];
  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const filtered = useMemo(() => {
    const all = templatesQuery.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((t) => t.name.toLowerCase().includes(q));
  }, [templatesQuery.data, search]);

  const handleUse = (template: CaseTemplate): void => {
    startFromTemplate(template);
    onClose();
  };

  const [deleteTarget, setDeleteTarget] = useState<CaseTemplate | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const openDelete = (template: CaseTemplate) => {
    setDeleteTarget(template);
    setDeleteError('');
  };
  const closeDelete = () => setDeleteTarget(null);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteCaseTemplate(id),
    onSuccess: () => {
      invalidate();
      closeDelete();
    },
    onError: (err: any) => setDeleteError(err?.response?.data?.error || 'Unable to delete this template'),
  });

  return (
    <>
      <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
        <DialogTitle>Start from template</DialogTitle>
        <DialogContent>
          <TextField
            label="Search templates"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            fullWidth
            autoFocus
            size="small"
            sx={{ mb: 2 }}
          />
          {templatesQuery.isLoading ? (
            <Skeleton variant="rounded" height={120} data-testid="case-template-picker-loading" />
          ) : templatesQuery.isError ? (
            <EmptyState message="Unable to load templates. Try refreshing the page." />
          ) : filtered.length === 0 ? (
            <EmptyState
              message={templates.length === 0 ? 'No templates exist yet.' : 'No templates match your search.'}
            />
          ) : (
            <List>
              {filtered.map((template) => (
                <ListItem
                  key={template._id}
                  divider
                  secondaryAction={
                    canWrite || canDelete ? (
                      <>
                        {canWrite ? (
                          <Button size="small" variant="outlined" onClick={() => handleUse(template)}>
                            Use
                          </Button>
                        ) : null}
                        {canDelete ? (
                          <IconButton
                            size="small"
                            aria-label={`Delete ${template.name}`}
                            onClick={() => openDelete(template)}
                          >
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        ) : null}
                      </>
                    ) : null
                  }
                >
                  <ListItemText
                    primary={template.name}
                    secondary={template.description || template.CaseTemplateId}
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

      <Dialog open={!!deleteTarget} onClose={closeDelete} fullWidth maxWidth="sm">
        <DialogTitle>Delete {deleteTarget?.name}?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This permanently deletes the template “{deleteTarget?.name}”. This cannot be undone.
          </DialogContentText>
          {deleteError ? (
            <Alert severity="error" sx={{ mt: 2 }}>
              {deleteError}
            </Alert>
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

export default CaseTemplatePicker;
