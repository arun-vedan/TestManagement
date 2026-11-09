// File: AddDeleteTableRows.tsx
import React, { useContext, useEffect, useState } from 'react';
import TableRow from './TableRows';
import { Table, TableBody, TableCell, TableRow as MuiTableRow } from '@mui/material';
import { TCStepsContext } from "../../Context/testSteps";
import { getFields } from '../../api/apiCalls';
function AddDeleteTableRows(props) {
    let {setTcSteps} = useContext(TCStepsContext);
    const [rowsData, setRowsData] = useState(props.rows);
    let [stepDropDown,setStepDropDown] = useState<any>();
    useEffect(() => {
        getExeFields()
        setRowsData([...props.rows]);
        // getExeFields is redefined every render (closes over props.module); adding
        // it as a dep would run this effect on every render instead of only when
        // props.rows changes. Behavior is unchanged from before this fix.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.rows]);
    
    const addTableRows = (index) => {
        const newRow = { testStep: '', Expected: ''};
        const updatedRows = [...rowsData];
        updatedRows.splice(index, 0, newRow);
        setRowsData(updatedRows);
        setTcSteps(updatedRows)
    };

    const deleteTableRows = (index) => {
        const updatedRows = [...rowsData];
        updatedRows.splice(index, 1);
        setRowsData(updatedRows);
        setTcSteps(updatedRows)
    };

    const handleChange = (index, field, value) => {
        const updatedRows = [...rowsData];
        updatedRows[index][field] = value;
        setRowsData(updatedRows);
        setTcSteps(updatedRows)
    };

    let getExeFields = async () => {
        if(props.module === 4)
        {
            let reqFields = await getFields(4)
            setStepDropDown(reqFields[0]['defaultValue'])
        }
       
    }

    // WP-F07a Task 4 -- `previewRows`, when supplied, is a PARALLEL array
    // (same index as `props.rows`/`rowsData`), never merged into the row
    // objects themselves. That separation is what makes it structurally
    // impossible for a substituted value to ride along inside
    // `handleChange`'s `updatedRows` -- `handleChange` only ever reads and
    // writes `rowsData`, and `previewRows` is passed straight through to
    // TableRow as its own sibling prop, read fresh from `props` on every
    // render rather than copied into `rowsData` state.
    const previewActive = props.module === 1 && Array.isArray(props.previewRows);

    return (
        <div>
            <Table>
                <TableBody>
                    <MuiTableRow>
                        <TableCell align={!props.editable?'center':'left'}  variant='head' >Steps</TableCell>
                        <TableCell align={!props.editable?'center':'left'} variant='head'>Expected</TableCell>
                        {previewActive && <TableCell variant='head'>Preview</TableCell>}
                        {props.editable && props.module === 1 && <TableCell  align= {'right'} size='small' ></TableCell>}
                        {props.module === 4 && <TableCell variant='head' align={'center'}>Status</TableCell>}
                    </MuiTableRow>
                </TableBody>
                <TableBody>
                    {rowsData.map((row, index) => (
                        <TableRow
                            module={props.module}
                            key={index}
                            row={row}
                            index={index}
                            handleChange={handleChange}
                            deleteTableRows={deleteTableRows}
                            addTableRows={addTableRows}
                            editable={props.editable}
                            stepDropDown = {stepDropDown}
                            previewActive={previewActive}
                            previewRow={previewActive ? props.previewRows[index] : undefined}
                        />
                    ))}
                </TableBody>
            </Table>
        </div>
    );
}

export default AddDeleteTableRows;


