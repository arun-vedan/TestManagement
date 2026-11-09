import { Stack } from "@mui/material";

import { Box, TextField } from '@mui/material'

import useAxiosPrivate from "../../Hooks/useAxiosPrivate";
import { useContext, useEffect, useState } from "react";
import { PContext } from "../../Context/ProjectContext";
import { PObject } from "../../model/ProjectContext";

const NewProjectDetails = () => {
    const {setpObject} = useContext(PContext)
    useAxiosPrivate();
    let [projectName, setProjectName] = useState('')
    let [projectDescription, setDescription] = useState('')
    useEffect(() => {
        const newObject: PObject = { projectName, projectDescription, projectId:"",projectUrl:"",createdBy:localStorage.getItem('_id'),updatedBy:localStorage.getItem('_id') };
        setpObject(newObject);
    }, [projectName,projectDescription,setpObject])
    return (
        <Box mt={4}>
            <Stack spacing={5}>
              
                <Stack spacing={2} m={2}>
                <TextField onChange={(e) => setProjectName(e.target.value)} label="Project Name:" fullWidth variant="outlined" />
                <TextField
                    onChange={(e) => setDescription(e.target.value)}
                    label="Project Description:"
                    multiline
                    rows={4}
                    maxRows={4}
                />
                </Stack>     
            </Stack>
        </Box>
    );
}
export default NewProjectDetails