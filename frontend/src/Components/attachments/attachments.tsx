import { Box, Button, Grid, IconButton, Link, List, ListItem, ListItemText, Typography } from "@mui/material"
import DeleteIcon from '@mui/icons-material/Delete'
import { BASE_URL } from "../../api/axios";
import UploadFileIcon from '@mui/icons-material/UploadFile'
import CircularProgress from '@mui/material/CircularProgress';
import { srOnlySx } from '../charts/a11y';
export let AttachemntListComp = (props) => {
    let handleDelete = (itemId) => {
        props.handleItemDelete(itemId);
    }
    

    return (
        <>
            <Grid container>
                <Grid item xs={2}>
                    <Typography variant="subtitle1">Attachments</Typography>
                </Grid>
                <Grid item xs={10} justifyContent="flex-end">
                    <Box display="flex" justifyContent="flex-end">
                        {props.file && !props.loading && <Typography variant="body1" p={1}> {props.fileName}</Typography>}
                        {props.loading &&  <CircularProgress sx={{mr:2}} />}
                        {/* WP-046: previously a <label> wrapping a
                            component="span" Button, with the actual
                            <input type="file"> a display:none sibling.
                            display:none removes an element from the tab
                            order entirely, and neither the <label> nor a
                            component="span" Button is keyboard-focusable
                            on its own -- a mouse click worked (label-click
                            delegates to its input even when hidden), but a
                            keyboard-only user had no way to reach this
                            control at all.
                            First attempt: Button component="label" with a
                            `hidden` (still display:none-equivalent) nested
                            input, relying on ButtonBase's role="button" for
                            keyboard access -- axe correctly rejected this
                            (aria-allowed-role: role="button" isn't a
                            permitted ARIA role override for a <label>
                            element). Landed instead: the real <input
                            type="file"> stays genuinely focusable and in
                            the tab order (srOnlySx -- the same
                            visually-hidden-but-reachable pattern
                            Components/charts/a11y.ts already established
                            for WP-042 -- not `hidden`/display:none, which
                            removes a focusable element from the
                            accessibility tree same as before), with the
                            Button giving it a role={undefined}/tabIndex={-1}
                            (it's purely the visible label wrapping the real
                            control now, not a second focus stop). */}
                        <Button
                            variant="outlined"
                            color="primary"
                            size="small"
                            component="label"
                            role={undefined}
                            tabIndex={-1}
                            startIcon={<UploadFileIcon />}
                        >
                            Choose file
                            <Box
                                component="input"
                                accept="*"
                                id="file-input"
                                type="file"
                                onChange={(e) => props.handleFileChange(e)}
                                sx={srOnlySx}
                            />
                        </Button>

                        {props.file && <Button
                            variant="contained"
                            color="primary"
                            size="small"
                            onClick={props.handleUpload}
                            style={{ marginLeft: '10px' }}
                        >
                            Upload file
                        </Button>}

                    </Box>
                </Grid>
                <Grid item xs={12} mt={2}>
                    {props.attachmentList && <List>
                        {/* WP-046: was a separate <Divider> (an <hr>, or
                            even with component="li" an <li role="separator">
                            -- axe's "list" rule still rejects role=separator
                            content inside <ul>, since it no longer presents
                            as a listitem) rendered as a sibling <>...</>
                            fragment after every <ListItem>. ListItem's own
                            `divider` prop draws the same visual rule via
                            CSS border on the <li> itself -- no extra list
                            child at all, so there's nothing for the "list"
                            rule to object to. */}
                        {props.attachmentList.map((item) => (
                            <ListItem
                                key={item.attachmentId}
                                divider
                                secondaryAction={
                                    <IconButton edge="end" aria-label="delete" onClick={() => handleDelete(item.attachmentId)}>
                                        <DeleteIcon />
                                    </IconButton>
                                }
                            >
                                <ListItemText primary={<Link href={`${BASE_URL}/api/v1/attachment/download/file/${item.attachmentId}`} >{item.name}</Link>} />
                            </ListItem>
                        ))}
                    </List>}</Grid>
            </Grid></>)

}