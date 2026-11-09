import { useTheme } from '@mui/material/styles';
import { LineChart } from '@mui/x-charts/LineChart';
import { ChartCard, ChartTableColumn } from './ChartCard';
import { CATEGORICAL_PALETTE } from './chartPalette';

// Trend-over-time chart (line, optional area fill). Per the `dataviz` skill's
// choosing-a-form guidance: "Trend over time -> line; area for a single
// series", color job "sequential or 1 categorical" -- a single series gets
// one hue and no legend box (the title already names it); 2+ series get
// categorical hues assigned in fixed order via `colors={CATEGORICAL_PALETTE}`
// (never per-series hand-picked), with the legend shown (never rely on
// color-matching alone for identity).
export interface TrendSeries {
    id: string;
    label: string;
    data: (number | null)[];
    /** Fill the area under the line (only sensible for a single series). */
    area?: boolean;
}

export interface TrendChartProps {
    title: string;
    description?: string;
    /** Category/period labels, same length as each series' `data`. */
    xLabels: string[];
    series: TrendSeries[];
    loading?: boolean;
    error?: string | null;
    height?: number;
    valueFormatter?: (value: number) => string;
    emptyMessage?: string;
}

export const TrendChart = ({
    title,
    description,
    xLabels,
    series,
    loading = false,
    error = null,
    height = 300,
    valueFormatter,
    emptyMessage = 'No trend data available for the selected period.',
}: TrendChartProps) => {
    const theme = useTheme();
    const isEmpty =
        !loading && !error && (series.length === 0 || series.every((s) => s.data.every((v) => v === null || v === undefined)));

    const tableColumns: ChartTableColumn[] = [
        { key: 'x', label: 'Period' },
        ...series.map((s) => ({ key: s.id, label: s.label, numeric: true })),
    ];
    const tableRows = xLabels.map((x, i) => {
        const row: Record<string, string | number> = { x };
        series.forEach((s) => {
            const v = s.data[i];
            row[s.id] = v === null || v === undefined ? '—' : valueFormatter ? valueFormatter(v) : v;
        });
        return row;
    });

    return (
        <ChartCard
            title={title}
            description={description}
            height={height}
            loading={loading}
            error={error}
            isEmpty={isEmpty}
            emptyMessage={emptyMessage}
            tableColumns={tableColumns}
            tableRows={tableRows}
        >
            <LineChart
                height={height}
                title={title}
                desc={description ?? `Line chart: ${title}`}
                xAxis={[
                    {
                        scaleType: 'point',
                        data: xLabels,
                        tickLabelStyle: { fill: theme.palette.text.secondary, fontSize: 11 },
                        stroke: theme.palette.divider,
                    },
                ]}
                yAxis={[
                    {
                        tickLabelStyle: { fill: theme.palette.text.secondary, fontSize: 11 },
                        stroke: theme.palette.divider,
                    },
                ]}
                series={series.map((s) => ({
                    id: s.id,
                    label: s.label,
                    data: s.data,
                    area: s.area,
                    type: 'line' as const,
                    curve: 'monotoneX' as const,
                    showMark: series.length <= 1,
                    valueFormatter: (v: number | null) => (v === null ? '—' : valueFormatter ? valueFormatter(v) : String(v)),
                }))}
                colors={CATEGORICAL_PALETTE}
                slotProps={{ legend: { hidden: series.length < 2 } }}
                margin={{ top: 16, right: 16, bottom: 32, left: 48 }}
            />
        </ChartCard>
    );
};

export default TrendChart;
