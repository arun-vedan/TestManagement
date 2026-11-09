import { ReactNode, useId, useState } from 'react';
import {
    Alert,
    Box,
    IconButton,
    Skeleton,
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableRow,
    Tooltip,
    Typography,
} from '@mui/material';
import TableChartOutlinedIcon from '@mui/icons-material/TableChartOutlined';
import ShowChartOutlinedIcon from '@mui/icons-material/ShowChartOutlined';
import { EmptyState } from '../common/EmptyState';
import { srOnlySx } from './a11y';

// Shared frame for every chart primitive in this folder (TrendChart,
// DonutChart, BarChart). Centralizes the four things the `dataviz` skill
// and WP-042's acceptance criteria both require on every chart:
//
//  1. Loading / empty / error states, rendered consistently (loading via
//     Skeleton + an `aria-live` "status" region; empty via the shared
//     `EmptyState`; error via a `role="alert"` Alert).
//  2. An accessible name + text description: the card is a native
//     <figure>, `aria-labelledby` the visible title and, when provided,
//     `aria-describedby` a visible one-sentence description -- so the
//     figure's accessible name/description match what a sighted reader
//     sees, per the skill's "text description of what it shows" rule.
//  3. A table-view toggle -- the skill's accessibility-pass requirement
//     ("a table view exists" / anti-pattern: "No table view / color-only
///    encoding on a continuous scale"). It's a real <button> (via
//     IconButton), reachable and operable by keyboard with no extra work,
//     and swaps the chart for a plain semantic <table> built from the same
//     data the chart renders -- so every value is reachable without
//     hovering or perceiving color.
//  4. Chart chrome (border, spacing) that matches the app's existing
//     card/table conventions (theme.tsx's `divider`/table styles) rather
//     than inventing new visual language.
export interface ChartTableColumn {
    key: string;
    label: string;
    numeric?: boolean;
}

export interface ChartCardProps {
    title: string;
    description?: string;
    /** Heading level for the title -- default `h3` assumes the card sits inside a page section (`h2`). */
    titleComponent?: 'h2' | 'h3' | 'h4';
    height?: number;
    loading?: boolean;
    error?: string | null;
    isEmpty?: boolean;
    emptyMessage?: string;
    /** When provided together with `tableRows`, a table-view toggle is shown. */
    tableColumns?: ChartTableColumn[];
    tableRows?: Array<Record<string, string | number>>;
    children: ReactNode;
}

export const ChartCard = ({
    title,
    description,
    titleComponent = 'h3',
    height = 300,
    loading = false,
    error = null,
    isEmpty = false,
    emptyMessage = 'No data available.',
    tableColumns,
    tableRows,
    children,
}: ChartCardProps) => {
    const [showTable, setShowTable] = useState(false);
    const titleId = useId();
    const descId = useId();
    const canToggleTable = !loading && !error && !isEmpty && !!tableColumns && !!tableRows && tableRows.length > 0;

    return (
        <Box
            component="figure"
            aria-labelledby={titleId}
            aria-describedby={description ? descId : undefined}
            sx={{ m: 0, p: 2, border: '1px solid', borderColor: 'divider', borderRadius: 2, bgcolor: 'background.paper' }}
        >
            <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1, mb: 1 }}>
                <Box>
                    <Typography id={titleId} variant="subtitle1" component={titleComponent} sx={{ fontWeight: 600 }}>
                        {title}
                    </Typography>
                    {description && (
                        <Typography id={descId} variant="body2" color="text.secondary">
                            {description}
                        </Typography>
                    )}
                </Box>
                {canToggleTable && (
                    <Tooltip title={showTable ? 'Show chart' : 'Show data as table'}>
                        <IconButton
                            size="small"
                            aria-pressed={showTable}
                            aria-label={showTable ? `Show ${title} as a chart` : `Show ${title} data as a table`}
                            onClick={() => setShowTable((v) => !v)}
                        >
                            {showTable ? <ShowChartOutlinedIcon fontSize="small" /> : <TableChartOutlinedIcon fontSize="small" />}
                        </IconButton>
                    </Tooltip>
                )}
            </Box>

            {error ? (
                <Alert severity="error" role="alert" sx={{ minHeight: height / 3, alignItems: 'center' }}>
                    {error}
                </Alert>
            ) : loading ? (
                <Box sx={{ position: 'relative' }}>
                    <Skeleton variant="rounded" height={height} animation="wave" />
                    <Typography sx={srOnlySx} role="status">
                        Loading {title}
                    </Typography>
                </Box>
            ) : isEmpty ? (
                <EmptyState message={emptyMessage} />
            ) : showTable && tableColumns && tableRows ? (
                <Table size="small" aria-label={`${title} data table`}>
                    <TableHead>
                        <TableRow>
                            {tableColumns.map((col) => (
                                <TableCell key={col.key} component="th" scope="col" align={col.numeric ? 'right' : 'left'}>
                                    {col.label}
                                </TableCell>
                            ))}
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {tableRows.map((row, i) => (
                            <TableRow key={i}>
                                {tableColumns.map((col) => (
                                    <TableCell key={col.key} align={col.numeric ? 'right' : 'left'}>
                                        {row[col.key]}
                                    </TableCell>
                                ))}
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            ) : (
                children
            )}
        </Box>
    );
};

export default ChartCard;
