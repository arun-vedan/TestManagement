import { Stack, Typography } from "@mui/material";
import MainLayout from "../Components/Layout/MainLayout";
import ItemsList from "../Components/Lists/mainList"
import { Grid, Button, Box } from '@mui/material'
import AddIcon from '@mui/icons-material/Add';
import useAxiosPrivate from "../Hooks/useAxiosPrivate";
import { useContext, useEffect, useState } from "react";
import { WSContext } from "../Context/workSpaceContext";

const getWorkspaceURL = '/api/v1/workspace/';



const WorkspaceList = () => {
    useContext(WSContext);

    const axiosPrivate = useAxiosPrivate();
    const [workSpaceList, setWorkSpaceList] = useState([]);
    useEffect(() => {
        let getWorkspace = async () =>{
        await axiosPrivate
          .get(getWorkspaceURL)
          .then((res) => {
            setWorkSpaceList(res.data.data)
          })
        }
        getWorkspace();
      },[axiosPrivate])

    return (
        
        <MainLayout>
            <Box mt={'8vh'}>
                <Stack spacing={5}>
                    <Stack direction={'row'} spacing={2}>
                        <Typography variant="h5" color={'primary'}>
                             Workspaces / 
                        </Typography>
                        <Button variant="contained" sx={{ 'width': { 'md': '15vw', 'sx': '20vw' } }}>
                            <AddIcon></AddIcon>
                            Add New Workspace
                        </Button>
                    </Stack>
                    <Box display="flex"
                        justifyContent="center"
                        alignItems="center"  height={'65vh'} overflow={'auto'} >

                        <Grid margin={'auto'} >
                           
                            
                            <ItemsList renderList={workSpaceList} name='workspaceName' description='workspaceDescription'></ItemsList>
                           
                            
                        </Grid>

                    </Box>
                    
                </Stack>
            </Box>
        </MainLayout>
        
    );

}
export default WorkspaceList