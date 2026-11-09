import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  IconButton,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  MenuItem,
  Select,
  SelectChangeEvent,
  Stack,
  Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { srOnlySx } from '../charts/a11y';
import { readCsvHeaders } from './csvHeaders';
import {
  ALLOWED_FIELDS,
  REQUIRED_FIELDS,
  ImportMapping,
  ImportReport,
  ImportPolicyError,
  ImportTargetField,
  previewImport,
  commitImport,
} from '../../api/importApi';

// Wave C-1 (Register A3) -- the CSV import UI for module 1 (Test Cases).
// The backend (WP-045) has existed since before this WP with no UI ever
// wired to it. See api/importApi.ts's header comment for the verified
// request shape.
//
// ALL-OR-NOTHING, stated to the user at every stage (mirrors
// Components/common/BulkActionBar.tsx's own explicit "all or nothing"
// wording for the other all-or-nothing endpoint pair in this app):
//   - while mapping/before a preview has run
//   - after a dirty preview (nothing written; fix and re-preview)
//   - after a clean preview (nothing written yet; commit will create
//     every row)
//   - after a 422 on commit -- the server re-validates the WHOLE file on
//     commit and never trusts a client-reported "preview was clean" flag
//     (importExport.js's own header comment), so a commit can still be
//     rejected even right after a clean preview (the file changed on
//     disk, a concurrent edit, ...). That case shows the server's actual
//     returned report, not a generic failure banner, and disables Commit
//     until a fresh Preview succeeds -- the whole point of the dry run is
//     that Commit only ever runs against a report the user has just seen.

const TARGET_LABELS: Record<ImportTargetField, string> = {
  TestCaseSummary: 'Summary (required)',
  TestCaseDescription: 'Description (required)',
  parentId: 'Parent folder ID',
};

export interface CsvImportDialogProps {
  open: boolean;
  onClose: () => void;
  /** Called once a commit actually creates rows, with the created count. */
  onImported: (imported: number) => void;
}

type CommitOutcome = { kind: 'success'; imported: number } | { kind: 'rejected'; report: ImportReport };

export function CsvImportDialog({ open, onClose, onImported }: CsvImportDialogProps): JSX.Element {
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[] | null>(null);
  const [headerError, setHeaderError] = useState('');
  const [mapping, setMapping] = useState<ImportMapping>({});
  const [previewReport, setPreviewReport] = useState<ImportReport | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitOutcome, setCommitOutcome] = useState<CommitOutcome | null>(null);

  const resetForNewFile = () => {
    setHeaders(null);
    setHeaderError('');
    setMapping({});
    setPreviewReport(null);
    setPreviewError('');
    setCommitOutcome(null);
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0] ?? null;
    resetForNewFile();
    setFile(picked);
    if (!picked) return;
    try {
      const detected = await readCsvHeaders(picked);
      if (detected.length === 0) {
        setHeaderError('This file has no header row.');
        return;
      }
      setHeaders(detected);
    } catch {
      setHeaderError('Could not read that file. Choose a CSV file and try again.');
    }
  };

  const handleMappingChange = (header: string, target: ImportTargetField | '') => {
    setMapping((prev) => ({ ...prev, [header]: target }));
    // The mapping changed -- any earlier preview/commit result no longer
    // describes what would actually be imported.
    setPreviewReport(null);
    setPreviewError('');
    setCommitOutcome(null);
  };

  const mappedTargets = new Set(Object.values(mapping).filter(Boolean));
  const hasRequiredMapping = REQUIRED_FIELDS.every((f) => mappedTargets.has(f));
  const canPreview = Boolean(file) && Boolean(headers) && hasRequiredMapping && !previewing;

  const handlePreview = async () => {
    if (!file) return;
    setPreviewing(true);
    setPreviewError('');
    setCommitOutcome(null);
    try {
      const report = await previewImport(file, mapping);
      setPreviewReport(report);
    } catch (err) {
      setPreviewError((err as Error)?.message || 'Could not preview this file right now. Please try again.');
    } finally {
      setPreviewing(false);
    }
  };

  // Commit is only ever enabled directly after a preview this same file +
  // mapping produced with zero invalid rows -- never against a stale
  // report the user hasn't re-run since the mapping or file changed
  // (handleMappingChange/handleFileChange both clear previewReport).
  const cleanPreview = previewReport !== null && previewReport.summary.invalidRows === 0;
  const canCommit = cleanPreview && !committing && commitOutcome === null;

  const handleCommit = async () => {
    if (!file) return;
    setCommitting(true);
    try {
      const result = await commitImport(file, mapping);
      setCommitOutcome({ kind: 'success', imported: result.imported });
      onImported(result.imported);
    } catch (err) {
      if (err instanceof ImportPolicyError) {
        setCommitOutcome({ kind: 'rejected', report: err.report });
      } else {
        setPreviewError((err as Error)?.message || 'Commit failed. Nothing was imported.');
      }
    } finally {
      setCommitting(false);
    }
  };

  // What per-row report to show: the commit-time rejection report (the
  // server's own re-validation) takes precedence over the stale preview
  // it followed, since it is the more recent, more authoritative answer.
  const displayedReport = commitOutcome?.kind === 'rejected' ? commitOutcome.report : previewReport;

  const handleClose = () => {
    setFile(null);
    resetForNewFile();
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="sm">
      <DialogTitle>
        <Stack direction="row" alignItems="center" justifyContent="space-between">
          <span>Import test cases from CSV</span>
          <IconButton aria-label="Close" onClick={handleClose} size="small">
            <CloseIcon fontSize="small" />
          </IconButton>
        </Stack>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} mt={1}>
          <Alert severity="info">
            Import policy: <strong>all or nothing</strong>. Preview never writes anything. Commit creates every row in
            the file, or -- if even one row is invalid -- creates none of them.
          </Alert>

          <Box>
            <Button variant="contained" component="label" role={undefined} tabIndex={-1} startIcon={<UploadFileIcon />}>
              Choose CSV file
              <Box component="input" type="file" accept=".csv,text/csv" onChange={handleFileChange} sx={srOnlySx} />
            </Button>
            {file && (
              <Typography variant="body2" sx={{ mt: 1 }}>
                Selected file: {file.name}
              </Typography>
            )}
            {headerError && (
              <Alert severity="error" sx={{ mt: 1 }}>
                {headerError}
              </Alert>
            )}
          </Box>

          {headers && (
            <Box>
              <Typography variant="subtitle2" gutterBottom>
                Map columns
              </Typography>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
                Required: {REQUIRED_FIELDS.map((f) => TARGET_LABELS[f]).join(', ')}
              </Typography>
              <Stack spacing={1.5}>
                {headers.map((header) => (
                  <Stack key={header} direction="row" spacing={1.5} alignItems="center">
                    <Typography variant="body2" sx={{ minWidth: 120, flexShrink: 0 }} noWrap title={header}>
                      {header}
                    </Typography>
                    <FormControl size="small" fullWidth>
                      {/* aria-label alone, deliberately not an
                          InputLabel+labelId pair -- when both are present
                          the accessible-name algorithm prefers
                          aria-labelledby, which would silently discard
                          this control's real name ('Map "<header>" to')
                          in favour of just the bare header text. The
                          header itself is still shown to sighted users via
                          the plain Typography above. */}
                      <Select
                        value={mapping[header] ?? ''}
                        displayEmpty
                        inputProps={{ 'aria-label': `Map "${header}" to` }}
                        onChange={(e: SelectChangeEvent) => handleMappingChange(header, e.target.value as ImportTargetField | '')}
                      >
                        <MenuItem value="">Don&apos;t import this column</MenuItem>
                        {ALLOWED_FIELDS.map((target) => (
                          <MenuItem key={target} value={target}>
                            {TARGET_LABELS[target]}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  </Stack>
                ))}
              </Stack>
            </Box>
          )}

          {previewError && <Alert severity="error">{previewError}</Alert>}

          {displayedReport && (
            <Box>
              {commitOutcome?.kind === 'rejected' ? (
                <Alert severity="error">
                  The server re-checked this file when Commit was clicked and rejected it -- nothing was imported
                  (all-or-nothing). {displayedReport.summary.invalidRows} of {displayedReport.summary.totalRows} row(s)
                  are invalid. Fix them and run Preview again before committing.
                </Alert>
              ) : displayedReport.summary.invalidRows > 0 ? (
                <Alert severity="warning">
                  {displayedReport.summary.invalidRows} of {displayedReport.summary.totalRows} row(s) are invalid.
                  Nothing has been imported -- nothing will be until every row passes (all-or-nothing). Fix the file
                  or the mapping and run Preview again.
                </Alert>
              ) : (
                <Alert severity="success">
                  Preview is clean. Nothing has been written yet -- Commit will import all{' '}
                  {displayedReport.summary.validRows} row(s).
                </Alert>
              )}

              <Typography variant="body2" sx={{ mt: 1 }}>
                {displayedReport.summary.validRows} of {displayedReport.summary.totalRows} row(s) valid
              </Typography>

              <List dense>
                {displayedReport.rows.map((row) => (
                  <ListItem key={row.line} disableGutters>
                    <ListItemIcon sx={{ minWidth: 32 }}>
                      {row.valid ? (
                        <CheckCircleIcon fontSize="small" color="success" />
                      ) : (
                        <ErrorOutlineIcon fontSize="small" color="error" />
                      )}
                    </ListItemIcon>
                    <ListItemText
                      primary={`Line ${row.line}`}
                      secondary={row.valid ? 'Valid' : row.errors.join('; ')}
                    />
                  </ListItem>
                ))}
              </List>
            </Box>
          )}

          {commitOutcome?.kind === 'success' && (
            <Alert severity="success">Imported {commitOutcome.imported} test case(s).</Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose}>Cancel</Button>
        <Button variant="outlined" onClick={handlePreview} disabled={!canPreview}>
          Preview
        </Button>
        <Button variant="contained" onClick={handleCommit} disabled={!canCommit}>
          Commit import
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default CsvImportDialog;
