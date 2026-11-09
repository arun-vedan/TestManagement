import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SampleDataCard } from '../SampleDataCard';
import { seedSampleProject } from '../../../api/sampleProjectApi';

// WP-133 — the one click.
//
// api/axios mock for the reason FieldsPanel.test.tsx documents: the api modules
// import api/axios.tsx -> src/keycloak.js -> keycloak-js, which is ESM-only and
// unparseable by Jest's default transform.
jest.mock('../../../api/axios', () => ({
    __esModule: true,
    default: { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() }
}));
jest.mock('../../../api/sampleProjectApi', () => {
    const actual = jest.requireActual('../../../api/sampleProjectApi');
    return { ...actual, seedSampleProject: jest.fn() };
});
jest.mock('../../../currentProject', () => ({
    ...jest.requireActual('../../../currentProject'),
    getCurrentProjectId: () => 42
}));

const mockSeed = seedSampleProject as jest.Mock;

const RESULT = { requirements: 8, testCases: 13, links: 15, executed: 11, defects: 1, releases: 1 };

function renderCard(onSeeded?: (r: any) => void) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
        <QueryClientProvider client={client}>
            <SampleDataCard onSeeded={onSeeded} />
        </QueryClientProvider>
    );
}

beforeEach(() => jest.clearAllMocks());

describe('WP-133: SampleDataCard', () => {
    it('seeds the current project when clicked', async () => {
        mockSeed.mockResolvedValue(RESULT);
        renderCard();
        fireEvent.click(screen.getByTestId('load-sample-data'));
        await waitFor(() => expect(mockSeed).toHaveBeenCalled());
        // The project id comes from the route, not from props, so a mis-wired
        // card would quietly seed the wrong project.
        expect(mockSeed.mock.calls[0][0]).toBe(42);
    });

    it('reports what was created, in terms a reviewer can check against the dashboard', async () => {
        mockSeed.mockResolvedValue(RESULT);
        renderCard();
        fireEvent.click(screen.getByTestId('load-sample-data'));
        const done = await screen.findByTestId('sample-data-done');
        expect(done).toHaveTextContent('8 requirements');
        expect(done).toHaveTextContent('13 test cases');
        expect(done).toHaveTextContent('11 executed');
    });

    it('does not fire twice if the button is clicked again while running', async () => {
        // A double-seed would duplicate every requirement and case, and the
        // seeder has no rollback, so this guard matters more than it looks.
        let resolve: (v: unknown) => void = () => {};
        mockSeed.mockReturnValue(new Promise((r) => { resolve = r; }));
        renderCard();
        const button = screen.getByTestId('load-sample-data');
        fireEvent.click(button);
        await waitFor(() => expect(button).toBeDisabled());
        fireEvent.click(button);
        expect(mockSeed).toHaveBeenCalledTimes(1);
        resolve(RESULT);
    });

    it('shows progress while it runs', async () => {
        mockSeed.mockImplementation((_pid: number, onProgress: (p: any) => void) => {
            onProgress({ step: 'creating requirements', done: 2, total: 9 });
            return new Promise(() => {});
        });
        renderCard();
        fireEvent.click(screen.getByTestId('load-sample-data'));
        expect(await screen.findByText(/creating requirements/)).toBeInTheDocument();
    });

    it('surfaces the failing step and says that partial data remains', async () => {
        // The seeder deliberately does not roll back across seven services, so
        // the user must be told what state they are in rather than left to
        // guess from a generic failure toast.
        mockSeed.mockRejectedValue(new Error('Sample data failed while creating test cases: 503'));
        renderCard();
        fireEvent.click(screen.getByTestId('load-sample-data'));
        const err = await screen.findByTestId('sample-data-error');
        expect(err).toHaveTextContent('creating test cases');
        expect(err).toHaveTextContent(/still in the project/i);
    });

    it('calls onSeeded so the page can refetch', async () => {
        mockSeed.mockResolvedValue(RESULT);
        const onSeeded = jest.fn();
        renderCard(onSeeded);
        fireEvent.click(screen.getByTestId('load-sample-data'));
        await waitFor(() => expect(onSeeded).toHaveBeenCalledWith(RESULT));
    });
});
