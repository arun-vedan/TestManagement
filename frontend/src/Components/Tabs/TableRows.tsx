// File: TableRow.tsx
import React from 'react';
import { TableRow as MuiTableRow, TableCell, TextField, IconButton, Typography, Select, MenuItem, Box, Chip, Stack } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import LinkIcon from '@mui/icons-material/Link';
// WP-F07a Task 4 -- `previewRow` (when present) is the SUBSTITUTED text
// for this same step, resolved by the backend against one row of the test
// case's bound Dataset (`?substitute=<rowIndex>`, Task 3's contract). It
// is rendered here in its own read-only column, never merged into the
// `row.testStep`/`row.Expected` values the TextFields above stay bound
// to. Those TextFields are the ONLY thing `handleChange` ever touches,
// and `handleChange`'s output is exactly what flows back through
// setTcSteps -> the PUT payload -- so `previewRow` being wired in as a
// separate, sibling prop is what makes it structurally impossible for a
// substituted value to reach that payload (R3, the rule this whole task
// exists to uphold): there is no code path from `previewRow` into
// `row.testStep`/`row.Expected` at all.
function TableRow({ row, index, handleChange, deleteTableRows, addTableRows, editable, module, stepDropDown, previewActive, previewRow }) {
    // WP-F06 Task 4 -- a row whose `sharedStepId` is set is a REFERENCE to a
    // step authored once in the shared-step library, not a step of its own.
    // The Steps tab editor (module 1) never expands references (no
    // ?expand=steps on its read), so testStep/Expected on such a row are
    // whatever happened to be stored and must never be shown as editable
    // text -- editing them here would do nothing to the shared step and
    // would look like it did. Rendering this branch is not gated on
    // `module` because it doesn't need to be: a real module 4 (Test Run)
    // row never carries `sharedStepId` in the first place -- the execution
    // snapshot schema (testPlanExecutionService's ExecutionTestStepSchema)
    // only declares testStep/Expected/status and drops unrecognized fields
    // on save -- so this branch is inert for every row Test Runs actually
    // renders. Removing the row entirely (deleteTableRows) is still a
    // legitimate action on a reference, so the existing add/delete cell is
    // preserved for module 1.
    if (row.sharedStepId) {
        // WP-F07a Task 4 -- a shared-step reference expands into a variable
        // number of backend rows on substitution (expandSteps() flattens
        // ONE reference into N plain rows before substituteSteps() ever
        // runs), so there is no single "this row's substituted text" to
        // show here the way a plain row has -- the preview column, when
        // active, just extends this same merged cell across it rather than
        // showing misleading per-row content.
        const contentColSpan = (module === 4 ? 3 : 2) + (previewActive && module === 1 ? 1 : 0);
        return (
            <MuiTableRow>
                <TableCell colSpan={contentColSpan}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                        <LinkIcon fontSize="small" color="action" />
                        <Typography>{row.sharedStepTitle}</Typography>
                        <Chip label="Shared" size="small" color="primary" variant="outlined" />
                    </Box>
                </TableCell>
                {editable && module === 1 && <TableCell size='small' align='right'>
                    <IconButton aria-label="Add step" onClick={() => addTableRows(index + 1)}><AddIcon color='primary'></AddIcon></IconButton>
                    <IconButton aria-label="Delete step" onClick={() => deleteTableRows(index)}><DeleteIcon color={'error'}></DeleteIcon></IconButton>
                </TableCell>}
            </MuiTableRow>
        );
    }
    return (
        <MuiTableRow>
            {module === 1 &&
                <>
                    <TableCell >
                        {editable ? <TextField
                            fullWidth
                            multiline
                            size='small'
                            name="testStep"
                            value={row.testStep}
                            onChange={(e) => handleChange(index, 'testStep', e.target.value)}
                        /> : <TextField
                        fullWidth
                        multiline
                        size='small'
                        name="testStep"
                        value={row.testStep}
                        disabled
                        sx={{
                            'bgcolor': '#f2f4f4', "& .MuiInputBase-input.Mui-disabled": {
                                WebkitTextFillColor: "#616a6b",
                            },
                        }}
                        
                    />}
                    </TableCell>

                    <TableCell>
                        {editable ? <TextField
                            fullWidth
                            multiline
                            size='small'
                            name="Expected"
                            value={row.Expected}
                            onChange={(e) => handleChange(index, 'Expected', e.target.value)}
                        /> : <TextField
                            fullWidth
                            multiline
                            disabled
                            size='small'
                            name="Expected"
                            value={row.Expected}
                            sx={{
                                'bgcolor': '#f2f4f4', "& .MuiInputBase-input.Mui-disabled": {
                                    WebkitTextFillColor: "#616a6b",
                                },
                            }}
                        />}
                    </TableCell>
                    {previewActive && (
                        // Read-only, visually distinct preview of the SUBSTITUTED
                        // text (Task 3's `authoredTestStep`/`authoredExpected` vs
                        // substituted `testStep`/`Expected` contract) -- shaded
                        // background + italics so it reads as "computed", never
                        // as another editable field, and there is no onChange
                        // handler here at all: nothing in this cell can ever
                        // write back.
                        <TableCell data-testid={`preview-cell-${index}`}>
                            {previewRow ? (
                                <Stack spacing={0.5} sx={{ bgcolor: '#eef6ff', p: 1, borderRadius: 1, fontStyle: 'italic' }}>
                                    <Typography variant="caption" color="text.secondary">Preview</Typography>
                                    <Typography variant="body2">{previewRow.testStep}</Typography>
                                    <Typography variant="caption" color="text.secondary">Expected</Typography>
                                    <Typography variant="body2">{previewRow.Expected}</Typography>
                                </Stack>
                            ) : (
                                <Typography variant="body2" color="text.secondary">—</Typography>
                            )}
                        </TableCell>
                    )}</>}
            {module === 4 &&
                <>
                    <TableCell size={'medium'}>
                        <Typography>{row.testStep}</Typography>
                    </TableCell>

                    <TableCell size={'medium'}>
                        <Typography>{row.Expected}</Typography>
                    </TableCell></>}
            {module === 4 && <TableCell align={!editable ? 'center' : 'right'} size={'small'}>
                {editable ?
                    // WP-046: this Select is the actual "record a result"
                    // control (module 4 = Test Execution) -- it had no
                    // label/name at all, so axe's aria-input-field-name
                    // rule flagged it and a screen reader user landing on
                    // it would hear only "combobox". A bare `aria-label`
                    // prop on MUI's <Select> lands on the outer wrapper
                    // div rather than the inner role="combobox" element
                    // that needs the name -- the same lesson OutlinedInput
                    // and the Issue/Link-type Selects taught earlier in
                    // this WP (see linkissue.tsx) -- so it goes through
                    // `inputProps` instead, which targets the real input.
                    <Select
                        sx={{ width: '10vw' }}
                        size="small"
                        onChange={(e) => handleChange(index, 'status', e.target.value)}
                        value={row.status}
                        inputProps={{ 'aria-label': `Status for step ${index + 1}` }}
                    >
                        {stepDropDown.map((dropDownValue, index) => (
                            <MenuItem value={dropDownValue}>{dropDownValue}</MenuItem>
                        ))}
                    </Select> : <Typography>{row.status}</Typography>}
            </TableCell>}
            {editable && module === 1 && <TableCell size='small' align='right'>
                <IconButton aria-label="Add step" onClick={() => addTableRows(index + 1)}><AddIcon color='primary'></AddIcon></IconButton>
                <IconButton aria-label="Delete step" onClick={() => deleteTableRows(index)}><DeleteIcon color={'error'}></DeleteIcon></IconButton>
            </TableCell>}


        </MuiTableRow>
    );
}

export default TableRow;
