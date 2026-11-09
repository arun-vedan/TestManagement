import { useId } from 'react';
import { Alert, Box, Skeleton, Typography, useTheme } from '@mui/material';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import RemoveIcon from '@mui/icons-material/Remove';
import { SparkLineChart } from '@mui/x-charts/SparkLineChart';
import { EmptyState } from '../common/EmptyState';
import { describeTrend, srOnlySx } from './a11y';
import { CATEGORICAL_PALETTE, STATUS_COLORS } from './chartPalette';

// A single headline number. Per the `dataviz` skill: "The one number a
// dashboard leads with" is a stat tile, not a one-bar bar chart -- and the
// skill's figure contract is followed directly: `label` (sentence case, no
// trailing colon) + `value` (semibold, proportional figures -- deliberately
// NOT `tabular-nums`, which loosens a large standalone number) + optional
// signed `delta` (color = direction x whether up is good, and NEVER color
// alone -- an arrow icon and the signed text both carry the same
// information as the color) + optional `trend` sparkline.
//
// A stat tile with no sparkline is the one chart form the skill exempts
// from the hover/tooltip layer ("a bare stat tile with no plot"). Once a
// sparkline is present it *is* a plot, so this component turns the
// sparkline's own tooltip on and adds a visually-hidden text summary of
// the trend (`describeTrend`) as its accessible text alternative -- a full
// per-point data table would be disproportionate to a tile this small.
export interface StatTileProps {
    label: string;
    value: number | string | null | undefined;
    /** Formats a numeric `value` for display, e.g. compact "12.9K". Ignored if `value` is already a string. */
    format?: (value: number) => string;
    /** Signed change, e.g. 4.2 for "+4.2%". */
    delta?: number;
    /** What the delta is measured against, e.g. "vs last 30 days". */
    deltaContext?: string;
    /** Whether an increase counts as good news (default true). Drives the delta's color, never its arrow direction. */
    positiveIsGood?: boolean;
    /** Optional sparkline series, oldest to newest. */
    trend?: number[];
    loading?: boolean;
    error?: string | null;
    emptyMessage?: string;
}

export const StatTile = ({
    label,
    value,
    format,
    delta,
    deltaContext,
    positiveIsGood = true,
    trend,
    loading = false,
    error = null,
    emptyMessage = 'No data available.',
}: StatTileProps) => {
    const theme = useTheme();
    const labelId = useId();
    const isEmpty = !loading && !error && (value === null || value === undefined || value === '');

    const displayValue = typeof value === 'number' && format ? format(value) : value;

    const hasDelta = typeof delta === 'number' && !Number.isNaN(delta);
    const deltaIsUp = hasDelta && (delta as number) > 0;
    const deltaIsDown = hasDelta && (delta as number) < 0;
    const deltaIsGoodDirection = hasDelta && ((deltaIsUp && positiveIsGood) || (deltaIsDown && !positiveIsGood));
    const deltaColor = !hasDelta || delta === 0 ? theme.palette.text.secondary : deltaIsGoodDirection ? STATUS_COLORS.good : STATUS_COLORS.critical;
    const deltaText = hasDelta ? `${delta! > 0 ? '+' : ''}${delta}%` : undefined;
    const deltaSuffix = deltaContext ? ` ${deltaContext}` : '';

    return (
        <Box
            component="figure"
            aria-labelledby={labelId}
            sx={{ m: 0, p: 2, border: '1px solid', borderColor: 'divider', borderRadius: 2, bgcolor: 'background.paper', minHeight: 96 }}
        >
            <Typography id={labelId} variant="body2" color="text.secondary">
                {label}
            </Typography>

            {error ? (
                <Alert severity="error" role="alert" sx={{ mt: 1 }}>
                    {error}
                </Alert>
            ) : loading ? (
                <Box sx={{ mt: 1 }}>
                    <Skeleton variant="text" width="60%" height={40} />
                    <Typography sx={srOnlySx} role="status">
                        Loading {label}
                    </Typography>
                </Box>
            ) : isEmpty ? (
                <EmptyState message={emptyMessage} />
            ) : (
                <Box sx={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 2, mt: 0.5 }}>
                    <Box>
                        <Typography
                            variant="h4"
                            component="p"
                            sx={{ fontWeight: 600, fontVariantNumeric: 'normal', lineHeight: 1.2 }}
                        >
                            {displayValue}
                        </Typography>
                        {hasDelta && (
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.5 }}>
                                {deltaIsUp && <ArrowUpwardIcon aria-hidden fontSize="inherit" sx={{ color: deltaColor, fontSize: 16 }} />}
                                {deltaIsDown && <ArrowDownwardIcon aria-hidden fontSize="inherit" sx={{ color: deltaColor, fontSize: 16 }} />}
                                {!deltaIsUp && !deltaIsDown && <RemoveIcon aria-hidden fontSize="inherit" sx={{ color: deltaColor, fontSize: 16 }} />}
                                <Typography variant="body2" sx={{ color: deltaColor, fontWeight: 600 }}>
                                    {deltaText}
                                    <Typography component="span" variant="body2" color="text.secondary">
                                        {deltaSuffix}
                                    </Typography>
                                </Typography>
                            </Box>
                        )}
                    </Box>
                    {trend && trend.length > 0 && (
                        <Box sx={{ minWidth: 72 }}>
                            <SparkLineChart
                                data={trend}
                                height={40}
                                width={72}
                                area
                                showTooltip
                                showHighlight
                                curve="monotoneX"
                                colors={[CATEGORICAL_PALETTE[0]]}
                            />
                            <Typography sx={srOnlySx}>Trend: {describeTrend(trend)}</Typography>
                        </Box>
                    )}
                </Box>
            )}
        </Box>
    );
};

export default StatTile;
