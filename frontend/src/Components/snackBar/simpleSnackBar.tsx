import * as React from 'react';
import Stack from '@mui/material/Stack';

import Snackbar from '@mui/material/Snackbar';
import MuiAlert, { AlertProps } from '@mui/material/Alert';
import { useEffect } from "react";

const Alert = React.forwardRef<HTMLDivElement, AlertProps>(function Alert(
  props,
  ref,
) {
  return <MuiAlert elevation={6} ref={ref} variant="filled" {...props} />;
});

export default function CustomizedSnackbars(props:any) {
    
  const [open, setOpen] = React.useState(false);
  

  const handleClick = (isRefresh:boolean) => {
    if(isRefresh)
    {
        setOpen(true);
    }
  };

  const handleClose = (event?: React.SyntheticEvent | Event, reason?: string) => {
    if (reason === 'clickaway') {
      return;
    }
    setOpen(false);
  };

  useEffect(() => {
    handleClick(props.refresh);
  },[props.refresh]);
 

  return (
    <Stack spacing={2} sx={{ width: '100%' }}>
      
      <Snackbar open={open}  onClose={handleClose}>
        <Alert onClose={props.closeError} severity={props.severity} sx={{ width: '100%' }}>
          {props.errorMessage}
        </Alert>
      </Snackbar>
      
    </Stack>
  );
}
