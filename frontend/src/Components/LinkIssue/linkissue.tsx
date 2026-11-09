import { Box, Button, Grid, IconButton, MenuItem, Select, Stack, TextField, Typography } from "@mui/material"
import { useEffect, useState } from "react"
import IssueSearch from "../Lists/issueSearch"
import LinkIcon from '@mui/icons-material/Link';
import { createLink, deleteLinkcAPI, getLinkedIssuesApi } from "../../api/apiCalls";
import { DataGrid, GridColDef, GridRowSelectionModel } from "@mui/x-data-grid";
import LinkOffIcon from '@mui/icons-material/LinkOff';
import CustomizedSnackbars from "../snackBar/simpleSnackBar";
import { LINK_TYPES, LinkType } from "../../api/linkApi";
import { LinkTypeBadge } from "./LinkTypeBadge";
import { useCoverage } from "../../Hooks/queries/useCoverage";
import { getCurrentProjectId } from "../../currentProject";

// WP-141 -- an external (Jira) issue. The backend stores it as ONE row,
// entity -> `jira:<KEY>`, under this reserved module number, and derives the
// stored id itself (linkIssueService/utils/externalLink.js). The key pattern
// mirrors the server's, so the button can say no before the request does.
const EXTERNAL_MODULE = 100;
const JIRA_KEY = /^[A-Z][A-Z0-9_]{1,9}-[1-9][0-9]{0,9}$/;

const isExternalRow = (row) => Boolean(row?.external) || String(row?.destinationId ?? '').startsWith('jira:');

export let LinkIssues = (props) => {
    let [selectedIssueType, setSelectedIssueType] = useState<any>('')
    let [selectedDestIssue, setSelectedDestIssue] = useState<any>('')
    let [selectedDestSummary, setSelectedDestSummary] = useState<any>('')
    // WP-011: no default -- the user must explicitly pick a type. Sprint 2.2
    // added a real linkType enum on the backend (see
    // backend/linkIssueService/models/linkIssue.js) but this form never sent
    // it, so every link silently landed on the schema default ('relates-to').
    // Leaving this '' (rather than pre-selecting 'relates-to') plus the
    // disabled-button guard below is what actually closes that gap, since a
    // selector that *looks* required but defaults to a value reproduces the
    // exact bug this closes.
    let [selectedLinkType, setSelectedLinkType] = useState<LinkType | ''>('')
    let [linkeIssues, setLinkedIssues] = useState<any>([])
    let [jiraKey, setJiraKey] = useState('')
    let [jiraSummary, setJiraSummary] = useState('')
    const [errorState, setErrorState] = useState(false);
    const [errorMessage, setErrorMessage] = useState('');
    const [severity, setSeverity] = useState('error')
    const [rowSelectionModel, setRowSelectionModel] =
        useState<GridRowSelectionModel>([]);
    // WP-078 -- migrated off Context/CoverageContext.tsx to the
    // react-query replacement (Hooks/queries/useCoverage.ts): this
    // component's own untestedReqIds/loading are unused (it only needs the
    // refresh side effect), so `invalidate` is the direct swap-in for the
    // old `refreshUntested`.
    const { invalidate: invalidateCoverage } = useCoverage(getCurrentProjectId());

    let [issueTypes] = useState<any>([{ "name": 'TestCase', "id": 1 }, { "name": 'Requirements', "id": 2 }, { "name": 'Defects', "id": 5 }, { "name": 'Jira issue', "id": EXTERNAL_MODULE }])
    const isExternal = selectedIssueType === EXTERNAL_MODULE
    const normalizedJiraKey = jiraKey.trim().toUpperCase()
    const jiraKeyValid = JIRA_KEY.test(normalizedJiraKey)
    // The grid's Type column: external links read as their provider.
    const typeLabel = (row) => isExternalRow(row) ? 'Jira' : (issueTypes.find(type => type.id === row.destinationModule)?.name || row.destinationModule)
    let handleFieldChange = (nValue) => {
        setSelectedIssueType(nValue)

    }
    let linkIssuesHandle = async () => {
        // Defense in depth: the Link button is already disabled unless a
        // type is chosen (see the Button below), but this guard means the
        // handler itself can never fire a create without an explicit type
        // even if that disabled state were ever bypassed.
        if (!selectedLinkType) {
            return
        }
        try
        {
        if (isExternal) {
            // One write only: there is no Jira-side record for the mirrored
            // reverse row internal links get.
            const created = await createLink({
                sourceId: props.issueId,
                srcSummary: props.summary,
                srcModule: props.srcModule,
                destinationModule: EXTERNAL_MODULE,
                external: { provider: 'jira', key: normalizedJiraKey },
                summary: jiraSummary.trim() || undefined,
                linkType: selectedLinkType
            })
            setLinkedIssues([...linkeIssues, { ...created, destinationModule: typeLabel(created) }])
            setJiraKey('')
            setJiraSummary('')
            setSelectedLinkType('')
            return
        }
        let srcModule = props.srcModule
        let destModule = selectedIssueType
        let srcIssue = props.issueId
        let destIssue = selectedDestIssue
        let payLoad = { "srcSummary": props.summary,"sourceId": srcIssue, "destinationId": destIssue, "srcModule": srcModule, "destinationModule": destModule, "summary": selectedDestSummary, "linkType": selectedLinkType }
        let linkDets =  await createLink(payLoad)
        linkDets['destinationModule'] = issueTypes.find(mod=>mod.id === linkDets['destinationModule'])['name']
        let nLinkis = [...linkeIssues]
        nLinkis.push(linkDets)
        setLinkedIssues(nLinkis)
        payLoad = { "srcSummary": selectedDestSummary,"sourceId": destIssue, "destinationId":srcIssue , "srcModule": destModule, "destinationModule":  srcModule, "summary":props.summary, "linkType": selectedLinkType }
        linkDets =  await createLink(payLoad)
        setSelectedDestIssue('')
        setSelectedDestSummary('')
        setSelectedLinkType('')
        if (srcModule === 2 || destModule === 2) {
            // Either end of this pair could be a requirement (see the
            // untested-requirements query's srcModule:2 filter in
            // backend/linkIssueService/controllers/linkIssue.js) -- refresh
            // regardless of which side, rather than trying to duplicate
            // that filter logic here.
            await invalidateCoverage()
        }
        }
        catch(err)
        {
            setErrorState(true)
            setSeverity('error')
            setErrorMessage(err.response.data.error)
        }
    }
    let setDestIssue = (issueId) => {
        setSelectedDestIssue(issueId.value)
        setSelectedDestSummary(issueId?.label?.split(":")[1]?.trim())
    }
    let unLinkIssue = async(issueId,destId,srcId) =>{
        let qryParms = `srcId=${srcId}&destId=${destId}`
        await deleteLinkcAPI(qryParms)
        let nLinkis = [...linkeIssues]
        nLinkis = nLinkis.filter(link => link['_id'] !== issueId)
        setLinkedIssues(nLinkis)
    }
    let handleLinkTypeChanged = (linkMongoId, newType: LinkType) => {
        let nLinkis = linkeIssues.map((link) =>
            link['_id'] === linkMongoId ? { ...link, linkType: newType } : link
        )
        setLinkedIssues(nLinkis)
    }
    let handleLinkTypeError = (message: string) => {
        setErrorState(true)
        setSeverity('error')
        setErrorMessage(message)
    }
    const columns1: GridColDef[] = [
        {
            field: 'id', headerName: 'S.No', flex: 1,
        },
        {
            field: 'destinationId', headerName: 'Id/Summary', flex: 1, renderCell: (params) => (
                <Typography  variant="subtitle1">
                    {`${isExternalRow(params.row) ? (params.row.external?.key ?? String(params.row.destinationId).replace(/^jira:/, '')) : params.row.destinationId}${params.row?.summary ? ' : ' + params.row.summary : ''}`}
                </Typography>
            ),
        },
        {
            field: 'destinationModule', headerName: 'Type', flex: 0.3, renderCell: (params) => (
                <Typography  variant="subtitle1">{params.row.destinationModule}</Typography>
            ),
        },
        {
            // WP-011: shows the real linkType (defaulting the display only,
            // never a write, to 'relates-to' for pre-Sprint-2.2 rows that
            // predate the field -- the backfill script already wrote an
            // explicit value onto every stored row, so this fallback exists
            // purely for defensive rendering) and lets the user change it.
            field: 'linkType', headerName: 'Link Type', flex: 0.6, renderCell: (params) => (
                <LinkTypeBadge
                    linkMongoId={params.row._id}
                    linkType={params.row.linkType || 'relates-to'}
                    sourceId={params.row.sourceId}
                    destinationId={params.row.destinationId}
                    onChanged={(newType) => handleLinkTypeChanged(params.row._id, newType)}
                    onError={handleLinkTypeError}
                />
            ),
        },
        {
            // WP-046: a fixed width, not flex: 0.1 -- a fractional flex this
            // small can round down toward zero on a narrow viewport (found
            // while testing this fix: it also collapsed away entirely
            // under jsdom's zero-width default layout, taking the only
            // Unlink affordance in the row out of the accessible-name tree
            // along with it). A fixed width sized for one icon button can't
            // disappear the same way.
            field: 'Unlink', headerName: '', width: 60, sortable: false, filterable: false, renderCell: (params) => (
                <IconButton aria-label="Unlink issue" onClick={(e) => unLinkIssue(params.row._id,params.row.destinationId,params.row.sourceId)}><LinkOffIcon sx={{'color':'red'}}></LinkOffIcon></IconButton>
            ),
        }
    ];
    let getLinkedIssue = async () => {
        try{
        let linkedIssueList = await getLinkedIssuesApi(`sourceId=${props.issueId}`)
        linkedIssueList = [...linkedIssueList]
        const updatedData = linkedIssueList.map(item => ({
              ...item,
              destinationModule: typeLabel(item) // Replace or keep the original if no match
            }));
       
        setLinkedIssues(updatedData)
        }catch(err)
        {
            setErrorState(true)
            setSeverity('error')
            setErrorMessage(err.response.data.error)
        }

    }
    const setFalseMessage = async () => {
        setErrorState(false);
        setErrorMessage('');
    }

    useEffect(() => {
        getLinkedIssue();
        // getLinkedIssue is redefined every render; adding it here would run the
        // effect on every render instead of only when props.issueId changes. It
        // only closes over props.issueId (already a dep) and the never-mutated
        // issueTypes state.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.issueId])

    return (
        <Box>
            {errorState && <CustomizedSnackbars errorMessage={errorMessage} refresh={errorState} closeError={setFalseMessage} severity={severity} />}
            <Typography variant="h6" ml={1}>Linked Issues</Typography>
            <Grid container spacing={1}>

                <Grid item xs={2}>
                    {/* WP-046: a bare aria-label on <Select> lands on its
                        outer wrapper div (no ARIA role -- axe
                        aria-prohibited-attr), not the inner role=combobox
                        element that actually needs the accessible name
                        (axe aria-input-field-name). inputProps is what MUI's
                        own docs use for an unlabeled Select, and the form
                        that actually lands on the right element (confirmed
                        empirically here, same lesson as OutlinedInput and
                        the search TextField above). */}
                    <Select inputProps={{ 'aria-label': 'Issue type' }} placeholder="Issue Type" fullWidth size="small" onChange={(e) => handleFieldChange(e.target.value)} value={selectedIssueType}>
                        {issueTypes.map((dropDownValue, index) => (
                            <MenuItem value={dropDownValue.id} key={dropDownValue.id}>{dropDownValue.name}</MenuItem>
                        ))}
                    </Select>
                </Grid>
                <Grid item xs={6}>
                    {isExternal ? (
                        <Stack direction="row" spacing={1}>
                            <TextField
                                size="small"
                                placeholder="ACME-123"
                                value={jiraKey}
                                onChange={(e) => setJiraKey(e.target.value)}
                                inputProps={{ 'aria-label': 'Jira issue key' }}
                                error={Boolean(jiraKey.trim()) && !jiraKeyValid}
                                helperText={Boolean(jiraKey.trim()) && !jiraKeyValid ? 'Enter a key like ACME-123' : undefined}
                                sx={{ width: '40%' }}
                            />
                            <TextField
                                size="small"
                                fullWidth
                                placeholder="Summary (optional)"
                                value={jiraSummary}
                                onChange={(e) => setJiraSummary(e.target.value)}
                                inputProps={{ 'aria-label': 'Jira issue summary' }}
                            />
                        </Stack>
                    ) : (
                        <IssueSearch setDestIssue={setDestIssue} selectedIssueType={selectedIssueType}></IssueSearch>
                    )}
                </Grid>
                <Grid item xs={2}>
                    <Select
                        inputProps={{ 'aria-label': 'Link type' }}
                        displayEmpty
                        fullWidth
                        size="small"
                        onChange={(e) => setSelectedLinkType(e.target.value as LinkType)}
                        value={selectedLinkType}
                        renderValue={(value) => (value ? value : <em>Link Type</em>)}
                    >
                        <MenuItem value="" disabled><em>Link Type</em></MenuItem>
                        {LINK_TYPES.map((type) => (
                            <MenuItem key={type} value={type}>{type}</MenuItem>
                        ))}
                    </Select>
                </Grid>
                <Grid item xs={2} >
                    <Button fullWidth variant="contained" disabled={!selectedIssueType || !selectedLinkType || (isExternal ? !jiraKeyValid : !selectedDestIssue)} onClick={linkIssuesHandle}><LinkIcon></LinkIcon>Link</Button>
                </Grid>
                {<Grid item xs={12}>

                    <DataGrid
                        // WP-046: every other DataGrid in this codebase
                        // (workbench/list/EntityList, audit.tsx, apiKeys.tsx)
                        // sets autoHeight; this one didn't. Without it (and
                        // without a parent that
                        // constrains height, which nothing here does),
                        // DataGrid falls back to sizing its virtualized
                        // viewport from the container's real layout height
                        // -- which jsdom, having no layout engine, reports
                        // as 0. The result (found while testing this WP's
                        // Unlink-button fix): the grid silently virtualizes
                        // away trailing columns, including the one carrying
                        // the Unlink action, with no error. autoHeight
                        // makes it size to its actual content instead,
                        // matching this codebase's own established
                        // convention for every other DataGrid.
                        autoHeight
                        columnVisibilityModel={{
                            id: false,
                        }}
                        rows={linkeIssues}
                        columns={columns1}

                        onRowSelectionModelChange={(newRowSelectionModel) => {
                            setRowSelectionModel(newRowSelectionModel);
                        }}
                        rowSelectionModel={rowSelectionModel}
                        initialState={{
                            pagination: {
                                paginationModel: { page: 0, pageSize: 10 },
                            },
                        }}
                        pageSizeOptions={[10, 20]}
                    />
                </Grid>}
            </Grid>

        </Box>
    )

}

