import * as React from 'react';
import Box from '@mui/material/Box';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import theme1 from '../../Theme/theme';
import { styled, ThemeProvider } from '@mui/material/styles';
import { Stack } from '@mui/material';
import { useContext } from 'react';
import { WSObject } from '../../model/workSpaceContext';
import { WSContext } from '../../Context/workSpaceContext';
import { PObject } from '../../model/ProjectContext';
import { TemplateObject } from '../../model/TemplateModel';
import { TemplateContext } from '../../Context/TemplateContext';
import { PContext } from '../../Context/ProjectContext';

export default function SelectedListItem(props:any) { 
    const CustomListItemButton = styled(ListItemButton)`
    background-color: #fff;
    color: ${theme1.palette.primary.main};
    &&.Mui-selected {
      background-color: ${theme1.palette.secondary.main};
      color: ${theme1.palette.secondary.dark};
    }`
    const [selectedIndex, setSelectedIndex] = React.useState(-1);
    const { setWsObject } = useContext(WSContext);
    const {setTemplateObject} = useContext(TemplateContext)
    const {setpObject} = useContext(PContext)
    const handlewsListItemClick = (event: React.MouseEvent<HTMLDivElement, MouseEvent>,
        index: number,imageName: string, workspaceId: string,workspaceName: string ) => {           
            setSelectedIndex(index);
            const newObject: WSObject = { imageName, workspaceId, workspaceName };
            setWsObject(newObject);
            //alert(JSON.stringify(wsObject))
            
       
      };
      const handleTemplateListItemClick = (event: React.MouseEvent<HTMLDivElement, MouseEvent>,
        index: number,TemplateName: string, templateId: string,gitURL: string ) => {
            setSelectedIndex(index);
            const newObject: TemplateObject = {  templateId, gitURL, TemplateName };
            setTemplateObject(newObject);
            //alert(JSON.stringify(templateObject))
      };

      const handleProjectListItemClick = (event: React.MouseEvent<HTMLDivElement, MouseEvent>,
        index: number,projectName: string, projectUrl: string,projectDescription: string, projectId: string ) => { 
            let createdBy = localStorage.getItem('_id')
            let updatedBy = localStorage.getItem('_id')
            setSelectedIndex(index);
            const newObject: PObject = { projectName, projectUrl, projectDescription,projectId,createdBy,updatedBy};
            setpObject(newObject);
            
       
      };

    return (
        <ThemeProvider theme={theme1}>
            <Box>

                <List component="nav" aria-label="main mailbox folders" sx={{ width: '70vw' }}>
                    <Stack spacing={1}>
                        {props.renderList.map((item:any, index:any) => (
                            <CustomListItemButton sx={{ 'border': 'solid grey','borderRadius':'10px' }} selected={selectedIndex === index}
                                onClick={(event) => (props.name === 'workspaceName')?handlewsListItemClick(event, index, item["imageName"],item["_id"],item[props.name]):(props.name ==='frameworkName')?handleTemplateListItemClick(event, index, item["frameworkName"],item["_id"],item["frameworkURL"]):handleProjectListItemClick(event, index, item[props.name],item['projectURL'],item['projectDescription'],item['_id'])}>
                                <ListItemText primary={item[props.name]} secondary={item[props.description] } />
                            </CustomListItemButton>
                        ))}
                    </Stack>
                </List>
            </Box>
        </ThemeProvider>
    );
}