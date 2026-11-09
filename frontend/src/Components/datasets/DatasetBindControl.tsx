import { useQuery } from '@tanstack/react-query';
import { Alert, FormControl, InputLabel, MenuItem, Select, SelectChangeEvent, Stack, Typography } from '@mui/material';
import { Dataset, getDataset, getTestCaseParameters, listDatasets } from '../../api/datasetApi';

// WP-F07a Task 4 -- lets a test-case author bind ONE Dataset to this case
// (so its {{placeholders}} resolve against that dataset's columns) and
// pick which row to preview. This control only READS the dataset library
// and this case's own placeholder report; it never creates, edits, or
// deletes a dataset (DatasetManagerDialog owns that) and it never
// substitutes anything itself -- selecting a row here only tells the
// PARENT which rowIndex to ask the backend to substitute against
// (`?substitute=<rowIndex>`, Task 3), via `onPreviewRowChange`. This
// component holds no substituted text at all.
//
// R3 (the whole task, per the brief): the value this control writes back
// through `onBind` is always a bare `datasetId` string (or null to
// unbind) -- never a step's text, substituted or otherwise. The preview
// row selection is even further removed from any write path: it is never
// passed to `onBind`, only to `onPreviewRowChange`, which the parent uses
// purely to decide what to fetch for display.
export interface DatasetBindControlProps {
    projectId: number;
    // The test case's mongo `_id` -- required to fetch its /parameters
    // report. A draft (not yet saved) has none yet, so this may be '' /
    // undefined, in which case the parameters lookup and (necessarily) the
    // bind control itself are both skipped: there is nothing to bind a
    // dataset to until the case exists.
    testCaseId?: string;
    datasetId?: string | null;
    canWrite: boolean;
    onBind: (datasetId: string | null) => void;
    previewRowIndex: number | null;
    onPreviewRowChange: (rowIndex: number | null) => void;
}

export function DatasetBindControl({
    projectId,
    testCaseId,
    datasetId,
    canWrite,
    onBind,
    previewRowIndex,
    onPreviewRowChange
}: DatasetBindControlProps) {
    const datasetsQuery = useQuery({
        // Same key DatasetManagerDialog.tsx reads/invalidates -- a
        // create/rename/delete made there is reflected here with no extra
        // fetch, same precedent as SharedStepPicker/SharedStepManagerDialog.
        queryKey: ['datasets', projectId] as const,
        queryFn: () => listDatasets()
    });
    const datasets = datasetsQuery.data ?? [];

    const boundDatasetQuery = useQuery({
        queryKey: ['dataset', projectId, datasetId] as const,
        queryFn: () => getDataset(datasetId as string),
        enabled: !!datasetId
    });
    const boundDataset: Dataset | undefined = boundDatasetQuery.data;

    const parametersQuery = useQuery({
        // `datasetId` is folded into the key (not just `testCaseId`) so a
        // fresh bind/unbind refetches this report once the parent's own
        // commit invalidates the entity and the new `datasetId` prop
        // flows back in -- a stale `missing` list from the PREVIOUS
        // binding is exactly the kind of silent wrong-info this task's own
        // brief calls out.
        queryKey: ['testcase-parameters', projectId, testCaseId, datasetId] as const,
        queryFn: () => getTestCaseParameters(testCaseId as string),
        enabled: !!testCaseId
    });
    const missing = parametersQuery.data?.missing ?? [];
    const unused = parametersQuery.data?.unused ?? [];

    if (!testCaseId) {
        return null;
    }

    const handleBindChange = (e: SelectChangeEvent) => {
        const value = e.target.value;
        onBind(value === '' ? null : value);
    };

    const handleRowChange = (e: SelectChangeEvent) => {
        const value = e.target.value;
        onPreviewRowChange(value === '' ? null : Number(value));
    };

    const rowCount = boundDataset?.rows.length ?? 0;

    return (
        <Stack spacing={1.5} data-testid="dataset-bind-control">
            <FormControl size="small" fullWidth disabled={!canWrite}>
                <InputLabel id="dataset-bind-label">Dataset</InputLabel>
                <Select
                    labelId="dataset-bind-label"
                    label="Dataset"
                    value={datasetId ?? ''}
                    onChange={handleBindChange}
                >
                    <MenuItem value="">
                        <em>No dataset bound</em>
                    </MenuItem>
                    {datasets.map((d) => (
                        <MenuItem key={d._id} value={d._id}>
                            {d.DatasetId} — {d.title}
                        </MenuItem>
                    ))}
                </Select>
            </FormControl>

            {datasetId ? (
                // WP-F07a Task 5 fix round 1 originally added this alert to
                // disclose that a run still executed a bound case ONCE, with
                // {{placeholders}} verbatim and no per-row results -- true at
                // the time (F07a was authoring-only by design). WP-F07b Task
                // 4 is the UI that makes that sentence false: a run now
                // creates one result row per dataset row (TestRunDetail.tsx
                // renders each, e.g. "TC-9 · role=admin"), so amended rather
                // than removed outright -- the row picker directly above
                // this alert is still genuinely preview-only (it only feeds
                // this control's OWN live preview text, never the parent's
                // `onBind`/execution path — see this file's header comment),
                // and an author could otherwise reasonably assume picking a
                // row here is what selects which row(s) actually run.
                <Alert severity="info" data-testid="dataset-execution-caveat">
                    The row selected above previews that row&apos;s substituted text only — it does not limit
                    execution. Running this case creates one result row per row in the bound dataset.
                </Alert>
            ) : null}

            {datasetId ? (
                <FormControl size="small" fullWidth disabled={rowCount === 0}>
                    <InputLabel id="dataset-preview-row-label">Preview row</InputLabel>
                    <Select
                        labelId="dataset-preview-row-label"
                        label="Preview row"
                        value={previewRowIndex === null ? '' : String(previewRowIndex)}
                        onChange={handleRowChange}
                    >
                        <MenuItem value="">
                            <em>No preview</em>
                        </MenuItem>
                        {(boundDataset?.rows ?? []).map((row, i) => (
                            <MenuItem key={i} value={String(i)}>
                                Row {i + 1}
                                {row.length > 0 ? `: ${row.join(', ')}` : ''}
                            </MenuItem>
                        ))}
                    </Select>
                </FormControl>
            ) : null}

            {missing.length > 0 ? (
                // Fix round 1 -- `role="alert"` carries no accessible NAME
                // from its own text content (per the accname spec, "alert"
                // is name-from-author only), and this can now share a
                // render with the execution-caveat disclosure above (also
                // `role="alert"`), so a bare role query can no longer tell
                // them apart. A stable `data-testid`, same convention as
                // this file's own "dataset-bind-control"/
                // "dataset-execution-caveat", disambiguates without relying
                // on name computation that was never available here.
                <Alert severity="error" data-testid="dataset-missing-placeholders-alert">
                    {missing.length} placeholder{missing.length === 1 ? '' : 's'} with no matching column: {missing.map((m) => `{{${m}}}`).join(', ')}
                </Alert>
            ) : null}
            {unused.length > 0 ? (
                <Alert severity="warning" data-testid="dataset-unused-columns-alert">
                    {unused.length} column{unused.length === 1 ? '' : 's'} unused by any placeholder: {unused.join(', ')}
                </Alert>
            ) : null}
            {datasetId && rowCount === 0 ? (
                <Typography variant="body2" color="text.secondary">
                    This dataset has no rows yet -- add rows in Manage datasets… to preview a substitution.
                </Typography>
            ) : null}
        </Stack>
    );
}

export default DatasetBindControl;
