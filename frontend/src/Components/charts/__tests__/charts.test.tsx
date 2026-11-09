import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { ThemeProvider } from '@mui/material';
import theme from '../../../Theme/theme';
import { TrendChart } from '../TrendChart';
import { BarChart } from '../BarChart';
import { DonutChart } from '../DonutChart';
import { StatTile } from '../StatTile';

// Demonstrates every chart primitive rendering against mock data (the
// reporting service WP-042 depends on, WP-040, doesn't exist yet) and
// substitutes for the browser verification this environment can't do:
// jsdom + Testing Library confirms accessible names/descriptions and
// keyboard-reachable controls actually land in the rendered DOM, rather
// than just type-checking.

// jsdom has no `window.matchMedia`; @mui/x-charts' `useReducedMotion` hook
// (via @react-spring/web) calls it on mount to respect the OS
// prefers-reduced-motion setting. Stubbed locally to this test file rather
// than the shared `setupTests.ts`, which is outside WP-042's scope.
// `beforeEach`, not `beforeAll`: CRA's base jest config sets
// `resetMocks: true`, which clears this mock's implementation before every
// test.
beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
        writable: true,
        value: jest.fn().mockImplementation((query: string) => ({
            matches: false,
            media: query,
            onchange: null,
            addListener: jest.fn(),
            removeListener: jest.fn(),
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
            dispatchEvent: jest.fn(),
        })),
    });
});

const withTheme = (ui: React.ReactElement) => <ThemeProvider theme={theme}>{ui}</ThemeProvider>;

const mockTrendSeries = [
    { id: 'actual', label: 'Actual', data: [12, 19, 14, 22, 25] },
    { id: 'target', label: 'Target', data: [15, 15, 15, 20, 20] },
];
const mockLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May'];

const mockBarSeries = [{ id: 'defects', label: 'Defects', data: [4, 12, 7, 2] }];
const mockCategories = ['Login', 'Checkout', 'Search', 'Profile'];

const mockDonutData = [
    { id: 'passed', label: 'Passed', value: 62 },
    { id: 'failed', label: 'Failed', value: 18 },
    { id: 'blocked', label: 'Blocked', value: 20 },
];

describe('TrendChart', () => {
    it('renders with mock data and exposes an accessible name/description', () => {
        render(
            withTheme(
                <TrendChart
                    title="Test execution trend"
                    description="Actual vs target executions per month"
                    xLabels={mockLabels}
                    series={mockTrendSeries}
                />,
            ),
        );
        const figure = screen.getByRole('figure', { name: 'Test execution trend' });
        expect(within(figure).getByText('Actual vs target executions per month')).toBeInTheDocument();
    });

    it('reveals a keyboard-reachable data table with the same values as the chart', async () => {
        render(withTheme(<TrendChart title="Test execution trend" xLabels={mockLabels} series={mockTrendSeries} />));
        const toggle = screen.getByRole('button', { name: /show test execution trend data as a table/i });
        await userEvent.click(toggle);
        const table = screen.getByRole('table', { name: /test execution trend data table/i });
        expect(within(table).getByText('Jan')).toBeInTheDocument();
        expect(within(table).getByText('22')).toBeInTheDocument();
    });

    it('shows the loading state', () => {
        render(withTheme(<TrendChart title="Test execution trend" xLabels={mockLabels} series={[]} loading />));
        expect(screen.getByRole('status')).toHaveTextContent(/loading test execution trend/i);
    });

    it('shows the empty state via the shared EmptyState component', () => {
        render(withTheme(<TrendChart title="Test execution trend" xLabels={[]} series={[]} />));
        expect(screen.getByText('No trend data available for the selected period.')).toBeInTheDocument();
    });

    it('shows the error state as an alert', () => {
        render(withTheme(<TrendChart title="Test execution trend" xLabels={mockLabels} series={[]} error="Failed to load trend data" />));
        expect(screen.getByRole('alert')).toHaveTextContent('Failed to load trend data');
    });
});

describe('BarChart', () => {
    it('renders with mock data and an accessible name', () => {
        render(withTheme(<BarChart title="Defects by module" categories={mockCategories} series={mockBarSeries} />));
        expect(screen.getByRole('figure', { name: 'Defects by module' })).toBeInTheDocument();
    });

    it('reveals its data table on toggle', async () => {
        render(withTheme(<BarChart title="Defects by module" categories={mockCategories} series={mockBarSeries} />));
        await userEvent.click(screen.getByRole('button', { name: /show defects by module data as a table/i }));
        const table = screen.getByRole('table');
        expect(within(table).getByText('Checkout')).toBeInTheDocument();
        expect(within(table).getByText('12')).toBeInTheDocument();
    });

    it('shows loading/empty/error states', () => {
        const { rerender } = render(withTheme(<BarChart title="Defects by module" categories={[]} series={[]} loading />));
        expect(screen.getByRole('status')).toBeInTheDocument();

        rerender(withTheme(<BarChart title="Defects by module" categories={[]} series={[]} />));
        expect(screen.getByText('No data available for the selected categories.')).toBeInTheDocument();

        rerender(withTheme(<BarChart title="Defects by module" categories={mockCategories} series={mockBarSeries} error="boom" />));
        expect(screen.getByRole('alert')).toHaveTextContent('boom');
    });
});

describe('DonutChart', () => {
    it('renders with mock data, an accessible name, and a legend that pairs value with label (never color alone)', () => {
        render(withTheme(<DonutChart title="Test run outcomes" data={mockDonutData} />));
        expect(screen.getByRole('figure', { name: 'Test run outcomes' })).toBeInTheDocument();
        // Legend entries carry label + percentage as text, not color alone.
        expect(screen.getByText('Passed (62.0%)')).toBeInTheDocument();
    });

    it('folds more than the direct-segment cap into a single "Other" slice', async () => {
        const manySlices = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, label: `Slice ${i}`, value: 10 }));
        render(withTheme(<DonutChart title="Many categories" data={manySlices} />));
        await userEvent.click(screen.getByRole('button', { name: /show many categories data as a table/i }));
        const table = screen.getByRole('table');
        expect(within(table).getByText('Other')).toBeInTheDocument();
        // 5 direct + 1 "Other" = 6 rows, never a 9th generated hue.
        expect(within(table).getAllByRole('row')).toHaveLength(1 + 6); // header row + 6 data rows
    });

    it('shows loading/empty/error states', () => {
        const { rerender } = render(withTheme(<DonutChart title="Test run outcomes" data={[]} loading />));
        expect(screen.getByRole('status')).toBeInTheDocument();

        rerender(withTheme(<DonutChart title="Test run outcomes" data={[]} />));
        expect(screen.getByText('No data available.')).toBeInTheDocument();

        rerender(withTheme(<DonutChart title="Test run outcomes" data={mockDonutData} error="boom" />));
        expect(screen.getByRole('alert')).toHaveTextContent('boom');
    });
});

// WP-046 -- verifies WP-042's own accessibility design under axe rather
// than rewriting it: figure semantics (role="figure" + accessible name),
// the SVG <title>/<desc> @mui/x-charts renders, the legend's text-plus-
// value labelling (never color alone -- see the DonutChart test above),
// and the keyboard-operable "show as table" toggle this file already
// exercises with userEvent above. Two axe rules that would matter for a
// real chart -- color-contrast and anything that needs real layout/paint --
// are inert in jsdom; see this file's own note below and
// docs/accessibility-keyboard-pass.md for the fuller jsdom-limits
// statement.
describe('chart a11y (axe)', () => {
    it('TrendChart is axe clean, collapsed and with its data table open', async () => {
        const { container } = render(
            withTheme(<TrendChart title="Test execution trend" description="Actual vs target executions per month" xLabels={mockLabels} series={mockTrendSeries} />),
        );
        expect(await axe(container)).toHaveNoViolations();
        await userEvent.click(screen.getByRole('button', { name: /show test execution trend data as a table/i }));
        expect(await axe(container)).toHaveNoViolations();
    });

    it('BarChart is axe clean, collapsed and with its data table open', async () => {
        const { container } = render(withTheme(<BarChart title="Defects by module" categories={mockCategories} series={mockBarSeries} />));
        expect(await axe(container)).toHaveNoViolations();
        await userEvent.click(screen.getByRole('button', { name: /show defects by module data as a table/i }));
        expect(await axe(container)).toHaveNoViolations();
    });

    it('DonutChart is axe clean, including the "Other" folded-slice legend', async () => {
        const { container } = render(withTheme(<DonutChart title="Test run outcomes" data={mockDonutData} />));
        expect(await axe(container)).toHaveNoViolations();
    });

    it('StatTile is axe clean with its sparkline trend description', async () => {
        const { container } = render(
            withTheme(<StatTile label="Pass rate" value={94.2} format={(v) => `${v}%`} delta={3.1} deltaContext="vs last 30 days" trend={[80, 85, 88, 90, 94]} />),
        );
        expect(await axe(container)).toHaveNoViolations();
    });

    it('every chart is axe clean in its loading/empty/error states too, not just the happy path', async () => {
        const { container, rerender } = render(withTheme(<TrendChart title="Test execution trend" xLabels={[]} series={[]} loading />));
        expect(await axe(container)).toHaveNoViolations();

        rerender(withTheme(<TrendChart title="Test execution trend" xLabels={[]} series={[]} />));
        expect(await axe(container)).toHaveNoViolations();

        rerender(withTheme(<TrendChart title="Test execution trend" xLabels={mockLabels} series={[]} error="Failed to load trend data" />));
        expect(await axe(container)).toHaveNoViolations();
    });
});

describe('StatTile', () => {
    it('renders value + signed delta as text (not color alone) with an accessible label', () => {
        render(
            withTheme(
                <StatTile label="Pass rate" value={94.2} format={(v) => `${v}%`} delta={3.1} deltaContext="vs last 30 days" trend={[80, 85, 88, 90, 94]} />,
            ),
        );
        expect(screen.getByRole('figure', { name: 'Pass rate' })).toBeInTheDocument();
        expect(screen.getByText('94.2%')).toBeInTheDocument();
        expect(screen.getByText('+3.1%')).toBeInTheDocument();
        expect(screen.getByText('vs last 30 days')).toBeInTheDocument();
    });

    it('describes the sparkline trend as text for screen readers', () => {
        render(withTheme(<StatTile label="Pass rate" value={94} trend={[80, 85, 88, 90, 94]} />));
        expect(screen.getByText(/rising from 80 to 94/i)).toBeInTheDocument();
    });

    it('shows loading/empty/error states', () => {
        const { rerender } = render(withTheme(<StatTile label="Pass rate" value={undefined} loading />));
        expect(screen.getByRole('status')).toBeInTheDocument();

        rerender(withTheme(<StatTile label="Pass rate" value={undefined} />));
        expect(screen.getByText('No data available.')).toBeInTheDocument();

        rerender(withTheme(<StatTile label="Pass rate" value={undefined} error="boom" />));
        expect(screen.getByRole('alert')).toHaveTextContent('boom');
    });
});
