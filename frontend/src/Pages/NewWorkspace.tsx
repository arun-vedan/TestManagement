import { Typography } from "@mui/material";
import MainLayout from "../Components/Layout/MainLayout";
import { Box } from '@mui/material'

const NewWorkspace = () => {
    return(
        <MainLayout>
            <Box marginTop={'30vh'}>
                <Typography>
                New Workspace
                </Typography>
            </Box>
        </MainLayout>
    );

}
export default NewWorkspace