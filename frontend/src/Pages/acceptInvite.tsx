import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Box, Button, CircularProgress, Paper, Stack, Typography } from '@mui/material';
import { acceptInvite } from '../api/projectApi';

// WP-132 — the page an invitation link lands on.
//
// WHY THIS NEEDS NO "LOG IN OR REGISTER" UI OF ITS OWN. index.tsx initialises
// Keycloak with { onLoad: 'login-required' }, so the whole application forces
// authentication before this component ever renders. Someone opening an invite
// link with no account is therefore sent to Keycloak's own login page -- which
// carries the "Register" link that WP-130 turned on -- and Keycloak returns
// them to this exact URL, query string intact, once they are signed in. That is
// the "accept-on-first-login" behaviour the WP asks for, and it comes from the
// existing auth setup rather than from a parallel sign-in flow built here.
//
// The accept call is deliberately fired once and only once. React 18's
// StrictMode double-invokes effects in development, and the second call would
// hit an invite that the first had already consumed -- reporting "already
// used" for an acceptance that had in fact just succeeded.
export function AcceptInvite() {
    const [params] = useSearchParams();
    const navigate = useNavigate();
    const token = params.get('token');
    const attempted = useRef(false);

    const [state, setState] = useState<'working' | 'done' | 'error'>('working');
    const [message, setMessage] = useState('');
    const [landed, setLanded] = useState<{ projectId: number; projectName: string; role: string } | null>(null);

    useEffect(() => {
        if (attempted.current) return;
        attempted.current = true;

        if (!token) {
            setState('error');
            setMessage('This invitation link is missing its token.');
            return;
        }

        acceptInvite(token)
            .then((result) => {
                setLanded(result);
                setState('done');
            })
            .catch((err) => {
                setState('error');
                // The server's message is the useful one here: it distinguishes
                // expired from revoked from already-used from wrong-address,
                // and each tells the recipient something different about what
                // to do next.
                setMessage(err?.response?.data?.error || 'This invitation could not be accepted.');
            });
    }, [token]);

    return (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 8, px: 2 }}>
            <Paper sx={{ p: 4, maxWidth: 520, width: '100%' }}>
                <Stack spacing={2}>
                    <Typography variant="h6">Project invitation</Typography>

                    {state === 'working' ? (
                        <Stack direction="row" spacing={2} alignItems="center">
                            <CircularProgress size={20} />
                            <Typography variant="body2">Accepting your invitation…</Typography>
                        </Stack>
                    ) : null}

                    {state === 'done' && landed ? (
                        <>
                            <Alert severity="success">
                                You have joined <strong>{landed.projectName}</strong> as{' '}
                                <strong>{landed.role}</strong>.
                            </Alert>
                            <Button
                                variant="contained"
                                onClick={() => navigate(`/projects/${landed.projectId}/dashboard`)}
                            >
                                Go to {landed.projectName}
                            </Button>
                        </>
                    ) : null}

                    {state === 'error' ? (
                        <>
                            <Alert severity="error" data-testid="accept-invite-error">
                                {message}
                            </Alert>
                            <Typography variant="body2" color="text.secondary">
                                If you believe this is a mistake, ask whoever invited you to send a
                                new invitation. Invitations are tied to the email address they were
                                sent to, so you must be signed in with that address.
                            </Typography>
                            <Button variant="outlined" onClick={() => navigate('/projects')}>
                                Go to my projects
                            </Button>
                        </>
                    ) : null}
                </Stack>
            </Paper>
        </Box>
    );
}

export default AcceptInvite;
