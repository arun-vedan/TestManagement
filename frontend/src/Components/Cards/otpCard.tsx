// ** MUI Imports


import * as React from 'react';
import { InputLabel, Stack, ThemeProvider, Button } from '@mui/material'
import theme from '../../Theme/theme'
import { MuiOtpInput } from 'mui-one-time-password-input'
import axios from '../../api/axios';
import otpModel from '../../model/otpModel'
import { useNavigate } from 'react-router-dom';
const otpSubmitURL = '/admin/user-profile/signup-verification'


const OTPCard = (props: any) => {
    const navigate = useNavigate();

    const [code, setmOtp] = React.useState('')
    const [name, seteOtp] = React.useState('')
    const [, setMessage] = React.useState('')

    const [jwtVal, setJwtVal] = React.useState('')
    React.useEffect(() => {
        setJwtVal(props.jwtVal);
    }, [props.jwtVal]);

    
    function timeout(delay: number) {
        return new Promise( res => setTimeout(res, delay) );
    }

    const submitOTP = async () => {
        const response = await axios.post<otpModel>(otpSubmitURL,
            JSON.stringify({ code, name }),
            {
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwtVal}` }

            }
        );
        let responseData = response?.data.message.message;
        console.log(responseData);
        setMessage(responseData)
        props.showMessage(responseData, 'success');
        await timeout(10000);
        navigate('/login');


    }
    return (
        <ThemeProvider theme={theme}>
            
            <Stack direction={{ md: 'row', xs: 'column' }} spacing={{ md: 10, xs: 1 }} >
            
            <InputLabel sx={{ mt: 2 }}>Mobile OTP</InputLabel>
            <MuiOtpInput width={'20vw'} value={code} onChange={setmOtp} />    
            
            </Stack>
            <Stack direction={{ md: 'row', xs: 'column' }} spacing={{ md: 11, xs: 1 }}>
                <InputLabel sx={{ mt: 2 }}>Email OTP</InputLabel>
                <MuiOtpInput width={'20vw'} value={name} onChange={seteOtp} />
               
            </Stack>
            <Stack direction='row' spacing={10} alignSelf='center'>
                <Button variant="contained" onClick={submitOTP}>Sign Up</Button>
                <Button variant="contained" color='secondary'>Cancel</Button>
            </Stack>
        </ThemeProvider>
    )
}

export default OTPCard