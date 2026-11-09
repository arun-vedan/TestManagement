import { useEffect, useMemo, useState } from 'react';
import { Box, Button, Grid, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { DataGrid, GridColDef } from '@mui/x-data-grid';
import DownloadIcon from '@mui/icons-material/Download';
import RefreshIcon from '@mui/icons-material/Refresh';
import MainLayout from '../Components/Layout/MainLayout';
import { EmptyState } from '../Components/common/EmptyState';
import { StatusChip, StatusChipColor } from '../Components/common/StatusChip';
import CustomizedSnackbars from '../Components/snackBar/simpleSnackBar';
import { AuditEvent, getAuditEvents } from '../api/auditApi';

// WP-024 — Audit log page. Plain, functional MUI per the owner's
// 2026-08-28 design direction (no bespoke visual work): MUI Material only,
// the shared StatusChip/EmptyState (WP-020/WP-025 precedent), and MUI X
// DataGrid (already a dependency, used elsewhere -- e.g.
// Components/Tabs/TestPlanContent.tsx). No new UI dependencies -- CSV
// export is a plain client-side Blob download over whatever rows are
// currently loaded, not a library.
//
// Read-only by construction: this page has no create/edit/delete affordance
// anywhere, matching the backend's append-only guarantee (GET is the only
// verb commentsService's /api/v1/audit route exposes at all -- see
// backend/commentsService/routes/audit.js). Accessible to every project
// role including viewer (backend authorize('read') gate) -- an Auditor
// persona with viewer-only membership can open this page and use it fully.

const ACTION_COLORS: Record<string, StatusChipColor> = {
    create: 'success',
    update: 'info',
    'status-change': 'warning',
    delete: 'error'
};

const ENTITY_TYPES = ['testcase', 'requirement', 'defect', 'testplan', 'testexecution'] as const;
const ACTIONS = ['create', 'update', 'status-change', 'delete'] as const;

function summaryText(evt: AuditEvent): string {
    if (!evt.summary || typeof evt.summary !== 'object') {
        return '';
    }
    try {
        return JSON.stringify(evt.summary);
    } catch {
        return '';
    }
}

function toCsv(rows: AuditEvent[]): string {
    const headers = ['ts', 'actor', 'actorName', 'entityType', 'entityId', 'action', 'projectId', 'correlationId', 'summary'];
    const escape = (value: unknown) => {
        const str = value === undefined || value === null ? '' : String(value);
        return `"${str.replace(/"/g, '""')}"`;
    };
    const lines = [headers.join(',')];
    rows.forEach((row) => {
        lines.push(
            [row.ts, row.actor, row.actorName, row.entityType, row.entityId, row.action, row.projectId, row.correlationId, summaryText(row)]
                .map(escape)
                .join(',')
        );
    });
    return lines.join('\n');
}

// WP-044: split into AuditLogPanel (bare content, no chrome) and the
// default-exported Audit page (AuditLogPanel wrapped in MainLayout).
// Pages/settings/AuditTab.tsx renders AuditLogPanel directly inside
// Pages/settings/index.tsx's own single MainLayout. Nothing in this app's
// route table points at the default export any more (see App.tsx's
// LegacyRedirect for /audit -> /projects/:projectId/settings/audit).
export function AuditLogPanel() {
    const [events, setEvents] = useState<AuditEvent[]>([]);
    const [loading, setLoading] = useState(false);
    const [errorMessage, setErrorMessage] = useState('');
    const [errorOpen, setErrorOpen] = useState(false);

    const [entityType, setEntityType] = useState('');
    const [entityId, setEntityId] = useState('');
    const [actor, setActor] = useState('');
    const [action, setAction] = useState('');
    const [dateFrom, setDateFrom] = useState('');
    const [dateTo, setDateTo] = useState('');

    const showError = (message: string) => {
        setErrorMessage(message);
        setErrorOpen(true);
    };

    const load = async () => {
        setLoading(true);
        try {
            const { data } = await getAuditEvents({
                entityType: entityType || undefined,
                entityId: entityId || undefined,
                actor: actor || undefined,
                action: action || undefined,
                dateFrom: dateFrom || undefined,
                dateTo: dateTo || undefined
            });
            setEvents(data);
        } catch (err: any) {
            showError(err?.response?.data?.error || 'Unable to load audit events');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        load();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleExportCsv = () => {
        if (events.length === 0) {
            showError('Nothing to export -- the current filter has no results');
            return;
        }
        const csv = toCsv(events);
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    const clearFilters = () => {
        setEntityType('');
        setEntityId('');
        setActor('');
        setAction('');
        setDateFrom('');
        setDateTo('');
    };

    const rows = useMemo(() => events.map((evt) => ({ id: evt._id, ...evt })), [events]);

    const columns: GridColDef[] = [
        {
            field: 'ts',
            headerName: 'Time',
            flex: 1.2,
            valueFormatter: (params) => (params.value ? new Date(params.value as string).toLocaleString() : '—')
        },
        { field: 'entityType', headerName: 'Entity type', flex: 0.8 },
        { field: 'entityId', headerName: 'Entity id', flex: 0.8 },
        {
            field: 'action',
            headerName: 'Action',
            flex: 0.8,
            renderCell: (params) => <StatusChip status={params.row.action} colorMap={ACTION_COLORS} />
        },
        { field: 'actorName', headerName: 'Actor', flex: 1, valueGetter: (params) => params.row.actorName || params.row.actor },
        { field: 'correlationId', headerName: 'Correlation id', flex: 1 },
        {
            field: 'summary',
            headerName: 'Summary',
            flex: 2,
            sortable: false,
            renderCell: (params) => (
                <Typography variant="body2" noWrap title={summaryText(params.row)}>
                    {summaryText(params.row)}
                </Typography>
            )
        }
    ];

    return (
        <>
            {errorOpen ? (
                <CustomizedSnackbars
                    errorMessage={errorMessage}
                    refresh={errorOpen}
                    closeError={() => setErrorOpen(false)}
                    severity={'error'}
                />
            ) : null}
            <Box mt={'8vh'}>
                <Stack spacing={3}>
                    <Stack direction={'row'} justifyContent={'space-between'} alignItems={'center'}>
                        <Typography variant="h5" color={'primary'}>
                            Audit Log
                        </Typography>
                        <Stack direction={'row'} spacing={1}>
                            <Button variant="outlined" startIcon={<RefreshIcon />} onClick={load}>
                                Refresh
                            </Button>
                            <Button variant="contained" startIcon={<DownloadIcon />} onClick={handleExportCsv}>
                                Export CSV
                            </Button>
                        </Stack>
                    </Stack>

                    <Grid container spacing={2}>
                        <Grid item xs={12} sm={6} md={2}>
                            <TextField
                                select
                                fullWidth
                                size="small"
                                label="Entity type"
                                value={entityType}
                                onChange={(e) => setEntityType(e.target.value)}
                            >
                                <MenuItem value="">All</MenuItem>
                                {ENTITY_TYPES.map((t) => (
                                    <MenuItem key={t} value={t}>
                                        {t}
                                    </MenuItem>
                                ))}
                            </TextField>
                        </Grid>
                        <Grid item xs={12} sm={6} md={2}>
                            <TextField fullWidth size="small" label="Entity id" value={entityId} onChange={(e) => setEntityId(e.target.value)} />
                        </Grid>
                        <Grid item xs={12} sm={6} md={2}>
                            <TextField fullWidth size="small" label="Actor" value={actor} onChange={(e) => setActor(e.target.value)} />
                        </Grid>
                        <Grid item xs={12} sm={6} md={2}>
                            <TextField select fullWidth size="small" label="Action" value={action} onChange={(e) => setAction(e.target.value)}>
                                <MenuItem value="">All</MenuItem>
                                {ACTIONS.map((a) => (
                                    <MenuItem key={a} value={a}>
                                        {a}
                                    </MenuItem>
                                ))}
                            </TextField>
                        </Grid>
                        <Grid item xs={12} sm={6} md={2}>
                            <TextField
                                fullWidth
                                size="small"
                                label="From"
                                type="date"
                                InputLabelProps={{ shrink: true }}
                                value={dateFrom}
                                onChange={(e) => setDateFrom(e.target.value)}
                            />
                        </Grid>
                        <Grid item xs={12} sm={6} md={2}>
                            <TextField
                                fullWidth
                                size="small"
                                label="To"
                                type="date"
                                InputLabelProps={{ shrink: true }}
                                value={dateTo}
                                onChange={(e) => setDateTo(e.target.value)}
                            />
                        </Grid>
                    </Grid>

                    <Stack direction={'row'} spacing={1}>
                        <Button variant="contained" size="small" onClick={load}>
                            Apply filters
                        </Button>
                        <Button variant="text" size="small" onClick={clearFilters}>
                            Clear
                        </Button>
                    </Stack>

                    {!loading && events.length === 0 ? (
                        <EmptyState message="No audit events match the current filter." />
                    ) : (
                        <Box sx={{ width: '100%' }}>
                            <DataGrid
                                autoHeight
                                loading={loading}
                                rows={rows}
                                columns={columns}
                                initialState={{
                                    pagination: {
                                        paginationModel: { page: 0, pageSize: 25 }
                                    },
                                    sorting: {
                                        sortModel: [{ field: 'ts', sort: 'desc' }]
                                    }
                                }}
                                pageSizeOptions={[25, 50, 100]}
                            />
                        </Box>
                    )}
                </Stack>
            </Box>
        </>
    );
}

export default function Audit() {
    return (
        <MainLayout>
            <AuditLogPanel />
        </MainLayout>
    );
}
