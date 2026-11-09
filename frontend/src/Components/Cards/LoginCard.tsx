// ** MUI Imports
import {  Stack, ThemeProvider } from '@mui/material'

import theme from '../../Theme/theme'

interface LayoutProps {
  children: React.ReactNode;
}
const LoginCard = ({children}:LayoutProps) => {
  return (
    <ThemeProvider theme={theme}>
      <Stack>
       
          <Stack sx={{ width: { md: '35vw', xs: '90vw' }, height: { md: '75vh', xs: '90vh' } }} alignItems={'center'}>
            {children}
           
          </Stack>

        
        <Stack direction={'row-reverse'}  mt='10px' spacing={1}>
        
         


        </Stack>
      </Stack>

    </ThemeProvider>
  )
}

export default LoginCard
