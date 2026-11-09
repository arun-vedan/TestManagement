import { Typography } from "@mui/material";
import MainLayout from "../Components/Layout/MainLayout";
import { Stack, Box, Grid } from '@mui/material'
import ItemsList from "../Components/Lists/mainList"
import { useContext, useEffect, useState } from "react";
import useAxiosPrivate from "../Hooks/useAxiosPrivate";
import { WSContext } from "../Context/workSpaceContext";

const getFrameworkURL = '/api/v1/framework/';
const Templates = () => {
    useContext(WSContext);
    const [frameworklist, setFrameworklist] = useState([]);
    const axiosPrivate = useAxiosPrivate();
    useEffect(() => {

        let getFrameworks = async () =>{
        await axiosPrivate
          .get(getFrameworkURL)
          .then((res) => {
            setFrameworklist(res.data.data)
          })
        }
        getFrameworks();
      },[axiosPrivate])
 
    return(
        <MainLayout>
        <Box mt={'8vh'}>
            <Stack spacing={5}>
                <Stack direction={'row'} spacing={2}>
                    <Typography variant="h5" color={'primary'}>
                         Templates
                    </Typography>
                    
                </Stack>
                <Box display="flex"
                    justifyContent="center"
                    alignItems="center"  height={'65vh'} overflow={'auto'} >
                    <Grid margin={'auto'} >
                        <ItemsList renderList={frameworklist} name='frameworkName' description='frameworkDescription'></ItemsList>
                    </Grid>

                </Box>
                
            </Stack>
        </Box>
    </MainLayout>
    );

}
export default Templates