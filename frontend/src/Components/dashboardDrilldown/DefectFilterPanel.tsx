import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Chip, Link as MuiLink, Paper, Skeleton, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { EmptyState } from '../common/EmptyState';
import { StatusChip } from '../common/StatusChip';
import { getDefectList } from '../../api/apiCalls';
import { getIssueStatuses, IssueStatus } from '../../api/defectStatusApi';

// WP-041 — the defects.tsx half of the drill-down proof (see
// TestExecutionFilterPanel.tsx's header comment for the full reasoning;
// this mirrors it). Renders nothing unless the URL carries `assignedTo` or
// `severity`. `open=1` (only meaningful alongside `assignedTo`, from
// dashboardLinks.ts's myOpenDefectsLink) is applied client-side, not as a
// server query filter -- defectService's `Status` field stores an
// istatusservice id/name ambiguously (same real-data ambiguity
// services/defectSummary.js's own resolveStatusName resolves server-side;
// copied here verbatim, no shared frontend/backend module exists for it),
// so "closed" can't be expressed as a single Mongo equality filter. This
// still fetches real, live, project-scoped data -- assignedTo/severity are
// real Mongo filters -- the open/closed split is just resolved after the
// fetch, against a live call to istatusservice (api/defectStatusApi.ts's
// getIssueStatuses, already used by the defect-status-transition UI).

export interface DefectFilterPanelProps {
    searchParams: URLSearchParams;
    /** When set (dashboard usage), shows an extra "Open full view" link to this same filtered URL on the real Defects page. */
    viewAllHref?: string;
    /** Overrides the panel's own title -- see TestExecutionFilterPanel's twin prop. */
    title?: string;
}

interface DefectRow {
    _id?: string;
    defectId: string;
    summary?: string;
    Severity?: string;
    Status?: string;
    assignedTo?: string;
}

// Copied from backend/reportingService/services/defectSummary.js's
// resolveStatusName verbatim (same dependency pair, same ambiguity, no
// shared library home for it on either side of the wire -- that file's own
// comment notes the same thing about its own copy from releaseService).
function resolveStatusName(rawStatus: string | undefined, statusList: IssueStatus[]): string {
    if (rawStatus === undefined || rawStatus === null || rawStatus === '') {
        return 'Unknown';
    }
    const asNumber = Number(rawStatus);
    if (Number.isInteger(asNumber)) {
        const byId = statusList.find((s) => s.id === asNumber);
        if (byId) {
            return byId.istatus;
        }
    }
    const byName = statusList.find((s) => (s.istatus || '').toLowerCase() === String(rawStatus).toLowerCase());
    return byName ? byName.istatus : 'Unknown';
}

export function DefectFilterPanel({ searchParams, viewAllHref, title }: DefectFilterPanelProps) {
    const assignedTo = searchParams.get('assignedTo') || undefined;
    const openOnly = searchParams.get('open') === '1';
    const severity = searchParams.get('severity') || undefined;
    const hasFilter = Boolean(assignedTo || severity);

    const queryString = useMemo(() => {
        const parts: string[] = ['limit=50'];
        if (assignedTo) {
            parts.push(`assignedTo=${encodeURIComponent(assignedTo)}`);
        }
        if (severity) {
            parts.push(`Severity=${encodeURIComponent(severity)}`);
        }
        return parts.join('&');
    }, [assignedTo, severity]);

    const defectsQuery = useQuery({
        queryKey: ['dashboardDrilldown', 'defects', queryString],
        queryFn: () => getDefectList(queryString) as Promise<DefectRow[]>,
        enabled: hasFilter,
    });

    // Fetched whenever the panel is active at all, not just for `open=1` --
    // the Status column below needs the same resolved name regardless of
    // whether the open/closed split is being applied.
    const statusesQuery = useQuery({
        queryKey: ['dashboardDrilldown', 'issuestatuses'],
        queryFn: getIssueStatuses,
        enabled: hasFilter,
        staleTime: 5 * 60_000,
    });

    const rows = useMemo(() => {
        const list = defectsQuery.data || [];
        if (!openOnly) {
            return list;
        }
        if (!statusesQuery.data) {
            return [];
        }
        return list.filter((d) => resolveStatusName(d.Status, statusesQuery.data).toLowerCase() !== 'closed');
    }, [defectsQuery.data, statusesQuery.data, openOnly]);

    if (!hasFilter) {
        return null;
    }

    const isLoading = defectsQuery.isLoading || statusesQuery.isLoading;
    const isError = defectsQuery.isError || statusesQuery.isError;

    const filterLabel = [
        assignedTo ? (openOnly ? 'open defects assigned to you' : 'assigned to you') : null,
        severity ? `severity: ${severity}` : null,
    ]
        .filter(Boolean)
        .join(', ');

    return (
        <Paper variant="outlined" sx={{ p: 2, mb: 2 }} data-testid="defect-filter-panel">
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }} flexWrap="wrap" gap={1}>
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                    {title || `Filtered from dashboard — ${filterLabel}`}
                </Typography>
                <Stack direction="row" spacing={1} alignItems="center">
                    {viewAllHref && (
                        <MuiLink component={RouterLink} to={viewAllHref} variant="body2">
                            Open in Defects ↗
                        </MuiLink>
                    )}
                    <Chip label="Clear filter" size="small" component={RouterLink} to="/defects" clickable />
                </Stack>
            </Stack>
            {isLoading ? (
                <Skeleton variant="rounded" height={120} />
            ) : isError ? (
                <Alert severity="error" role="alert">
                    Unable to load filtered defects.
                </Alert>
            ) : rows.length === 0 ? (
                <EmptyState message={openOnly ? 'No open defects match this filter — nice work.' : 'No defects match this filter.'} />
            ) : (
                <Table size="small" aria-label="Filtered defects">
                    <TableHead>
                        <TableRow>
                            <TableCell>Defect</TableCell>
                            <TableCell>Summary</TableCell>
                            <TableCell>Severity</TableCell>
                            <TableCell>Status</TableCell>
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {rows.map((row) => (
                            <TableRow key={row._id || row.defectId}>
                                <TableCell>{row.defectId}</TableCell>
                                <TableCell>{row.summary || '—'}</TableCell>
                                <TableCell>{row.Severity || '—'}</TableCell>
                                <TableCell>
                                    <StatusChip status={resolveStatusName(row.Status, statusesQuery.data || [])} />
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            )}
        </Paper>
    );
}

export default DefectFilterPanel;
