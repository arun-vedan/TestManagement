import { useTheme } from '@mui/material/styles';
import { BarChart as MuiBarChart } from '@mui/x-charts/BarChart';
import { ChartCard, ChartTableColumn } from './ChartCard';
import { CATEGORICAL_PALETTE } from './chartPalette';

// Magnitude-comparison chart (bar/column, grouped or stacked). Per the
// `dataviz` skill's choosing-a-form guidance: "Compare magnitude, low ->
// high -> bar/column", color job "sequential (one hue)" for a single
// series (every bar the same slot-1 hue -- never a value-ramp on nominal
// categories, per the anti-patterns list) and categorical hues, assigned
// in fixed order, once there's more than one series (the series ARE the
// subject then). `categoryGapRatio` is raised above the library default so
// bars read as thin marks with air around them rather than filling the
// whole category band, per the skill's mark spec.
export interface BarSeries {
    id: string;
    label: string;
    data: number[];
    /** Series sharing a `stack` id render as one stacked bar per category. */
    stack?: string;
}

export interface BarChartProps {
    title: string;
    description?: string;
    categories: string[];
    series: BarSeries[];
    /** Horizontal reads better with many categories or long category names. */
    layout?: 'vertical' | 'horizontal';
    loading?: boolean;
    error?: string | null;
    height?: number;
    valueFormatter?: (value: number) => string;
    emptyMessage?: string;
}

export const BarChart = ({
    title,
    description,
    categories,
    series,
    layout = 'vertical',
    loading = false,
    error = null,
    height = 300,
    valueFormatter,
    emptyMessage = 'No data available for the selected categories.',
}: BarChartProps) => {
    const theme = useTheme();
    const isEmpty = !loading && !error && (series.length === 0 || categories.length === 0);

    const tableColumns: ChartTableColumn[] = [
        { key: 'category', label: 'Category' },
        ...series.map((s) => ({ key: s.id, label: s.label, numeric: true })),
    ];
    const tableRows = categories.map((category, i) => {
        const row: Record<string, string | number> = { category };
        series.forEach((s) => {
            const v = s.data[i];
            row[s.id] = v === null || v === undefined ? '—' : valueFormatter ? valueFormatter(v) : v;
        });
        return row;
    });

    const categoryAxis = {
        scaleType: 'band' as const,
        data: categories,
        categoryGapRatio: 0.4,
        tickLabelStyle: { fill: theme.palette.text.secondary, fontSize: 11 },
        stroke: theme.palette.divider,
    };
    const valueAxis = {
        tickLabelStyle: { fill: theme.palette.text.secondary, fontSize: 11 },
        stroke: theme.palette.divider,
    };

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
            <MuiBarChart
                height={height}
                title={title}
                desc={description ?? `Bar chart: ${title}`}
                layout={layout}
                xAxis={[layout === 'vertical' ? categoryAxis : valueAxis]}
                yAxis={[layout === 'vertical' ? valueAxis : categoryAxis]}
                series={series.map((s) => ({
                    id: s.id,
                    label: s.label,
                    data: s.data,
                    stack: s.stack,
                    type: 'bar' as const,
                    valueFormatter: (v: number | null) => (v === null ? '—' : valueFormatter ? valueFormatter(v) : String(v)),
                }))}
                colors={CATEGORICAL_PALETTE}
                slotProps={{ legend: { hidden: series.length < 2 } }}
                margin={{ top: 16, right: 16, bottom: 32, left: 48 }}
            />
        </ChartCard>
    );
};

export default BarChart;
