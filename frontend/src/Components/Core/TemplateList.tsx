import { Stack, Typography } from "@mui/material";

import ItemsList from "../Lists/mainList"
import { Grid, Box } from '@mui/material'
import useAxiosPrivate from "../../Hooks/useAxiosPrivate";
import { useContext, useEffect, useState } from "react";
import { WSContext } from "../../Context/workSpaceContext";

const getFrameworkURL = '/api/v1/framework/';



const TemplateList = () => {
    useContext(WSContext);

    const axiosPrivate = useAxiosPrivate();
    const [frameworklist, setFrameworklist] = useState([]);
    useEffect(() => {
        let getWorkspace = async () => {
            await axiosPrivate
                .get(getFrameworkURL)
                .then((res) => {
                    setFrameworklist(res.data.data)
                })
        }
        getWorkspace();
    }, [axiosPrivate])

    return (


        <Box mt={4}>
            <Stack spacing={5}>
                <Stack direction={'row'} spacing={2}>
                    <Typography variant="h5" color={'primary'}>
                        Select Template
                    </Typography>
                    
                </Stack>
                <Box display="flex"
                    justifyContent="center"
                    alignItems="center" height={'65vh'} overflow={'auto'} >

                    <Grid margin={'auto'} >
                        <ItemsList renderList={frameworklist} name='frameworkName' description='frameworkDescription'></ItemsList>
                    </Grid>

                </Box>

            </Stack>
        </Box>


    );

}
export default TemplateList