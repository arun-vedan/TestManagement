import { useTheme } from '@mui/material/styles';
import { PieChart } from '@mui/x-charts/PieChart';
import { ChartCard, ChartTableColumn } from './ChartCard';
import { CATEGORICAL_PALETTE, DONUT_MAX_DIRECT_SEGMENTS, MUTED_SERIES_COLOR } from './chartPalette';

// Part-to-whole chart. The `dataviz` skill's own component inventory notes
// "donut stays deprioritized" and its choosing-a-form table routes
// part-to-whole to a stacked bar by default -- a donut is easy to misuse
// for comparing close-valued slices (an anti-pattern the skill calls out
// explicitly). WP-042 asks for a DonutChart as one of the four shared
// primitives regardless, so this wrapper leans into what a donut is
// actually good for -- a handful (<=6) of shares of one whole -- and bakes
// in the skill's guardrails rather than leaving them to callers:
//   - hard segment cap: more than DONUT_MAX_DIRECT_SEGMENTS slices fold
//     into a single "Other" wedge in a neutral gray (never a generated
//     9th hue);
//   - categorical hues assigned in fixed order (never re-sorted by value);
//   - a legend is always shown (2+ segments always are identity-bearing)
//     and each slice also carries a direct percentage label so identity
//     and magnitude are never color-only;
//   - callers comparing close values or needing >6 categories should
//     reach for BarChart instead -- that guidance is enforced here only
//     by the segment cap, not by rejecting the data.
export interface DonutSlice {
    id: string;
    label: string;
    value: number;
}

export interface DonutChartProps {
    title: string;
    description?: string;
    data: DonutSlice[];
    loading?: boolean;
    error?: string | null;
    height?: number;
    valueFormatter?: (value: number) => string;
    emptyMessage?: string;
}

export const DonutChart = ({
    title,
    description,
    data,
    loading = false,
    error = null,
    height = 280,
    valueFormatter,
    emptyMessage = 'No data available.',
}: DonutChartProps) => {
    const theme = useTheme();
    const total = data.reduce((sum, d) => sum + d.value, 0);
    const isEmpty = !loading && !error && (data.length === 0 || total <= 0);

    const displaySlices: Array<DonutSlice & { color: string }> =
        data.length > DONUT_MAX_DIRECT_SEGMENTS
            ? [
                  ...data.slice(0, DONUT_MAX_DIRECT_SEGMENTS).map((d, i) => ({ ...d, color: CATEGORICAL_PALETTE[i] })),
                  {
                      id: '__other__',
                      label: 'Other',
                      value: data.slice(DONUT_MAX_DIRECT_SEGMENTS).reduce((sum, d) => sum + d.value, 0),
                      color: MUTED_SERIES_COLOR,
                  },
              ]
            : data.map((d, i) => ({ ...d, color: CATEGORICAL_PALETTE[i] }));

    const fmt = (v: number) => (valueFormatter ? valueFormatter(v) : String(v));
    const pct = (v: number) => (total > 0 ? `${((v / total) * 100).toFixed(1)}%` : '0%');

    const tableColumns: ChartTableColumn[] = [
        { key: 'label', label: 'Category' },
        { key: 'value', label: 'Value', numeric: true },
        { key: 'share', label: 'Share', numeric: true },
    ];
    const tableRows = displaySlices.map((s) => ({
        label: s.label,
        value: fmt(s.value),
        share: pct(s.value),
    }));

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
            <PieChart
                height={height}
                title={title}
                desc={description ?? `Donut chart: ${title}, ${displaySlices.length} categories`}
                series={[
                    {
                        id: 'primary',
                        data: displaySlices.map((s) => ({
                            id: s.id,
                            // The percentage rides the legend label (a text
                            // token, always legible) rather than an in-arc
                            // label -- an in-arc label would need per-slice
                            // ink-vs-fill contrast to stay readable across
                            // every categorical hue (see marks-and-anatomy.md's
                            // "text inside a colored fill" exception), which
                            // needs custom per-arc contrast logic this
                            // wrapper doesn't implement. The legend keeps the
                            // value/identity pairing direct without that risk.
                            label: `${s.label} (${pct(s.value)})`,
                            value: s.value,
                            color: s.color,
                        })),
                        innerRadius: '55%',
                        outerRadius: '90%',
                        paddingAngle: 2,
                        cornerRadius: 2,
                        valueFormatter: (item) => `${fmt(item.value)} (${pct(item.value)})`,
                    },
                ]}
                slotProps={{
                    legend: { hidden: false, labelStyle: { fill: theme.palette.text.primary, fontSize: 12 } },
                }}
                margin={{ top: 16, right: 16, bottom: 16, left: 16 }}
            />
        </ChartCard>
    );
};

export default DonutChart;
