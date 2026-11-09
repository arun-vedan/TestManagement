// ** MUI Imports

import { ThemeProvider } from '@mui/material'
import Box from '@mui/material/Box'
import theme from '../Theme/theme'

interface LayoutProps {
  children: React.ReactNode;
}
const BlankLayout = ({ children }: LayoutProps) => {
  return (
    <ThemeProvider theme={theme}>
      <Box bgcolor={'#1E1E1E'}>

        {children}

      </Box>
    </ThemeProvider>
  )
}

export default BlankLayout
