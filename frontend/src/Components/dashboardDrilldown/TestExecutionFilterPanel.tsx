import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Chip, Link as MuiLink, Paper, Skeleton, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { EmptyState } from '../common/EmptyState';
import { StatusChip, StatusChipColor } from '../common/StatusChip';
import { getTestExecutionList } from '../../api/apiCalls';
import { EXECUTION_STATUS_FILTER_VALUES } from '../../Pages/dashboard/dashboardLinks';

// WP-041 — proves the dashboard's "my assigned tests" / "my failed tests" /
// "blocked tests" drill-down links actually land somewhere filtered and
// correct, not just that an anchor exists (see EXECUTION_LOG.md's WP-041
// report). Originally purely additive to Pages/testExecution.tsx: rendered
// nothing at all (`null`) unless the URL carried `assignedTo` or `status`,
// so a plain visit to /testexecution was byte-for-byte the same page as
// before WP-041 -- zero regression risk to the existing folder-tree UI,
// which it deliberately did not touch (see dashboardLinks.ts's header
// comment for why testExecution.tsx/defects.tsx's tree architecture wasn't
// retrofitted with full query-param filtering in that WP).
//
// WP-076: Pages/testExecution.tsx is retired; /testexecution now redirects
// into the workbench Test Runs module, which does not read these query
// params at all (see dashboardLinks.ts's header comment -- a reported,
// unfixed gap in the "View all" deep link). This component itself still
// has a real, live mount: Pages/dashboard/sections/TesterSection.tsx
// renders it directly with hand-built URLSearchParams (not derived from
// this page's own URL) for the "My failed tests" mini-panel, which is
// unaffected by any of the above.
//
// Fetches directly against testPlanExecutionService's plain list route
// (api/apiCalls.tsx's getTestExecutionList, already used elsewhere in the
// app) with a real Mongo filter built from the URL -- `assignedTo=<sub>`
// is a top-level field; `TestCases.TestStatus=<value>` is dot-path
// filtering into the embedded array, which advancedResults' passthrough
// `Model.find(reqQuery)` supports natively (matches if ANY TestCases[]
// entry has that TestStatus). Not reportingService (WP-040) data: no
// WP-040 endpoint returns a per-user or per-status *list* of executions
// (only aggregates) -- see EXECUTION_LOG.md's WP-041 report for why this
// is a deliberate, stated exception to "every widget bound to a live
// WP-040 endpoint."

export interface TestExecutionFilterPanelProps {
    searchParams: URLSearchParams;
    /** When set (dashboard usage), shows an extra "Open full view" link to this same filtered URL on the real Test Execution page. */
    viewAllHref?: string;
    /** Overrides the panel's own title -- lets a dashboard widget give this a persona-specific heading instead of the generic "Filtered from dashboard" one. */
    title?: string;
}

interface ExecutionTestCaseRow {
    TestStatus?: string;
}

interface ExecutionRow {
    _id?: string;
    TestExecutionId: string;
    assignedTo?: string;
    TestCases?: ExecutionTestCaseRow[];
}

const EXECUTION_STATUS_COLORS: Record<string, StatusChipColor> = {
    Fail: 'error',
    Blocked: 'warning',
    Pass: 'success',
    'No Run': 'default',
    'In progress': 'info',
};

// Derives one headline status for a row that can carry many TestCases[]
// entries, worst-first (a single failed case makes the whole execution a
// "Fail" from a triage point of view) -- mirrors the ordering
// services/planProgress.js and services/defectSummary.js already use
// case-insensitively for the exact same TestStatus vocabulary.
function worstStatus(cases: ExecutionTestCaseRow[] = []): string {
    const statuses = cases.map((c) => (c.TestStatus || '').trim()).filter(Boolean);
    if (statuses.length === 0) {
        return 'No Run';
    }
    if (statuses.some((s) => s.toLowerCase() === 'fail')) {
        return 'Fail';
    }
    if (statuses.some((s) => s.toLowerCase() === 'blocked')) {
        return 'Blocked';
    }
    if (statuses.every((s) => s.toLowerCase() === 'pass')) {
        return 'Pass';
    }
    if (statuses.some((s) => s.toLowerCase() === 'pass')) {
        return 'In progress';
    }
    return 'No Run';
}

export function TestExecutionFilterPanel({ searchParams, viewAllHref, title }: TestExecutionFilterPanelProps) {
    const assignedTo = searchParams.get('assignedTo') || undefined;
    const statusKey = searchParams.get('status') || undefined;
    const hasFilter = Boolean(assignedTo || statusKey);

    const queryString = useMemo(() => {
        const parts: string[] = ['limit=50'];
        if (assignedTo) {
            parts.push(`assignedTo=${encodeURIComponent(assignedTo)}`);
        }
        if (statusKey && EXECUTION_STATUS_FILTER_VALUES[statusKey]) {
            parts.push(`TestCases.TestStatus=${encodeURIComponent(EXECUTION_STATUS_FILTER_VALUES[statusKey])}`);
        }
        return parts.join('&');
    }, [assignedTo, statusKey]);

    const { data, isLoading, isError } = useQuery({
        queryKey: ['dashboardDrilldown', 'testexecution', queryString],
        queryFn: () => getTestExecutionList(queryString) as Promise<ExecutionRow[]>,
        enabled: hasFilter,
    });

    if (!hasFilter) {
        return null;
    }

    const filterLabel = [
        assignedTo ? 'assigned to you' : null,
        statusKey ? `status: ${EXECUTION_STATUS_FILTER_VALUES[statusKey] || statusKey}` : null,
    ]
        .filter(Boolean)
        .join(', ');

    return (
        <Paper variant="outlined" sx={{ p: 2, mb: 2 }} data-testid="test-execution-filter-panel">
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }} flexWrap="wrap" gap={1}>
                <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                    {title || `Filtered from dashboard — ${filterLabel}`}
                </Typography>
                <Stack direction="row" spacing={1} alignItems="center">
                    {viewAllHref && (
                        <MuiLink component={RouterLink} to={viewAllHref} variant="body2">
                            Open in Test Execution ↗
                        </MuiLink>
                    )}
                    <Chip label="Clear filter" size="small" component={RouterLink} to="/testexecution" clickable />
                </Stack>
            </Stack>
            {isLoading ? (
                <Skeleton variant="rounded" height={120} />
            ) : isError ? (
                <Alert severity="error" role="alert">
                    Unable to load filtered test executions.
                </Alert>
            ) : !data || data.length === 0 ? (
                <EmptyState message="No test executions match this filter yet." />
            ) : (
                <Table size="small" aria-label="Filtered test executions">
                    <TableHead>
                        <TableRow>
                            <TableCell>Execution</TableCell>
                            <TableCell>Assigned to</TableCell>
                            <TableCell>Worst status</TableCell>
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {data.map((row) => (
                            <TableRow key={row._id || row.TestExecutionId}>
                                <TableCell>{row.TestExecutionId}</TableCell>
                                <TableCell>{row.assignedTo || '—'}</TableCell>
                                <TableCell>
                                    <StatusChip status={worstStatus(row.TestCases)} colorMap={EXECUTION_STATUS_COLORS} />
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            )}
        </Paper>
    );
}

export default TestExecutionFilterPanel;
