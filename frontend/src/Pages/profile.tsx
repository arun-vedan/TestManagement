import { Typography, ThemeProvider, Box, CardMedia, Grid,Button } from "@mui/material";
import { Stack } from "@mui/system";
import MainLayout from "../Components/Layout/MainLayout";
import theme from '../Theme/theme'
import ModeEditOutlineOutlinedIcon from '@mui/icons-material/ModeEditOutlineOutlined';
const Profile = () => {
    return (
        <ThemeProvider theme={theme}>
            <MainLayout>

                <Stack mt={'10vh'} spacing={2}>
                    <Typography variant="h3" color={'primary.dark'}> Profile Management</Typography>
                    <Typography variant="h6" color={'secondary.dark'}> Update your profile details</Typography>
                    <Box justifySelf={"center"} alignSelf={"center"} sx={{ border: 1, borderColor: 'secondary.main', borderRadius: '10px' }} width={'50vw'} height={'60vh'}>
                        <Grid container ml={5} mt={5} mb={5}>
                            <Grid item xs={12} md={6}>
                        <CardMedia
                            image="/images/profileIcon.png"
                            sx={{ width: 100, height: 120 }}
                        />
                        </Grid>
                        <Grid item xs={12} md={5} mt={5} >
                            <Stack direction={'row-reverse'}>
                        <Button variant="contained" ><ModeEditOutlineOutlinedIcon  sx={{color:'#fff'}} ></ModeEditOutlineOutlinedIcon></Button>
                        </Stack>
                        </Grid>
                        
                        </Grid>
                        <Grid container spacing={4} alignSelf={'center'} justifySelf={'center'} ml={2}>
                            <Grid item xs={12} md={4} alignSelf={'left'}>
                                <Typography variant="subtitle2">Full Name :</Typography>
                            </Grid>
                            <Grid item xs={12} md={8}>
                                <Typography>Full Name</Typography>
                            </Grid>
                            <Grid item xs={12} md={4}>
                                <Typography variant="subtitle2">Email ID :</Typography>
                            </Grid>
                            <Grid item xs={12} md={8}>
                                <Typography>Full Name</Typography>
                            </Grid>
                            <Grid item xs={12} md={4}>
                                <Typography variant="subtitle2">Mobile Number :</Typography>
                            </Grid>
                            <Grid item xs={12} md={8}>
                                <Typography>Full Name</Typography>
                            </Grid>
                            <Grid item xs={12} md={4}>
                                <Typography variant="subtitle2">Organisation Name :</Typography>
                            </Grid>
                            <Grid item xs={12} md={8}>
                                <Typography>Full Name</Typography>
                            </Grid>

                        </Grid>

                    </Box>

                </Stack>
            </MainLayout>
        </ThemeProvider>
    );

}
export default Profile