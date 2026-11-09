import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AcceptInvite from '../acceptInvite';
import { acceptInvite } from '../../api/projectApi';

// WP-132 — the invitation landing page.
//
// Same api/axios mock the Settings panel tests use: projectApi.ts ->
// api/axios.tsx -> src/keycloak.js pulls in keycloak-js, which is ESM-only and
// unparseable by Jest's default transform.
jest.mock('../../api/axios', () => ({
    __esModule: true,
    default: { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn() }
}));
jest.mock('../../api/projectApi', () => {
    const actual = jest.requireActual('../../api/projectApi');
    return { ...actual, acceptInvite: jest.fn() };
});

const mockAccept = acceptInvite as jest.Mock;

function renderAt(search: string) {
    return render(
        <MemoryRouter initialEntries={[`/accept-invite${search}`]}>
            <AcceptInvite />
        </MemoryRouter>
    );
}

beforeEach(() => jest.clearAllMocks());

describe('WP-132: AcceptInvite', () => {
    it('accepts the token from the query string and reports where the user landed', async () => {
        mockAccept.mockResolvedValue({ projectId: 42, projectName: 'Apollo', role: 'contributor' });
        renderAt('?token=TOK123');
        await waitFor(() => expect(mockAccept).toHaveBeenCalledWith('TOK123'));
        expect(await screen.findByText(/You have joined/)).toBeInTheDocument();
        expect(screen.getByText('Apollo')).toBeInTheDocument();
        expect(screen.getByText('contributor')).toBeInTheDocument();
    });

    it('calls accept exactly once, even though StrictMode double-invokes effects', async () => {
        mockAccept.mockResolvedValue({ projectId: 1, projectName: 'P', role: 'viewer' });
        renderAt('?token=ONCE');
        await waitFor(() => expect(mockAccept).toHaveBeenCalled());
        // A second call would consume-then-report-used on an invite the first
        // call had just successfully accepted, showing an error for a success.
        expect(mockAccept).toHaveBeenCalledTimes(1);
    });

    it('shows the server reason when the invitation is refused', async () => {
        // Expired, revoked, already-used and wrong-address each tell the
        // recipient something different, so the server message is surfaced
        // rather than a generic failure.
        mockAccept.mockRejectedValue({ response: { data: { error: 'That invitation has expired' } } });
        renderAt('?token=OLD');
        expect(await screen.findByTestId('accept-invite-error')).toHaveTextContent(
            'That invitation has expired'
        );
    });

    it('handles a link with no token at all without calling the API', async () => {
        renderAt('');
        expect(await screen.findByTestId('accept-invite-error')).toHaveTextContent(/missing its token/i);
        expect(mockAccept).not.toHaveBeenCalled();
    });
});
