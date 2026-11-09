import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
    Alert,
    Box,
    Button,
    Checkbox,
    Dialog,
    DialogActions,
    DialogContent,
    DialogContentText,
    DialogTitle,
    FormControl,
    FormControlLabel,
    IconButton,
    InputLabel,
    ListItemText,
    MenuItem,
    OutlinedInput,
    Select,
    SelectChangeEvent,
    Stack,
    TextField,
    Typography
} from '@mui/material';
import { DataGrid, GridColDef } from '@mui/x-data-grid';
import AddIcon from '@mui/icons-material/Add';
import BlockIcon from '@mui/icons-material/Block';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import VpnKeyIcon from '@mui/icons-material/VpnKey';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import MainLayout from '../Components/Layout/MainLayout';
import { EmptyState } from '../Components/common/EmptyState';
import { StatusChip, StatusChipColor } from '../Components/common/StatusChip';
import CustomizedSnackbars from '../Components/snackBar/simpleSnackBar';
import usePermissions from '../Hooks/usePermissions';
import { ApiKey, ApiKeyScope, API_KEY_SCOPES, CreatedApiKey, createApiKey, getApiKeys, revokeApiKey } from '../api/apiKeyApi';
import { getCurrentProjectId } from '../currentProject';

// WP-032 — API Keys settings UI. Plain, functional MUI per the owner's
// 2026-08-28 design direction: MUI Material only (no Joy, WP-016), MUI X
// DataGrid (already a dependency, same precedent as Pages/audit.tsx), the
// shared StatusChip/EmptyState (WP-020/WP-024/WP-025 precedent), no new UI
// dependencies. Uses TanStack Query (mounted app-wide since WP-015, see
// queryClient.ts and Hooks/usePermissions.tsx for the existing usage
// pattern this follows) rather than the older useEffect+useState fetch
// pattern in releases.tsx/audit.tsx -- this page is new, so it can start
// from the query-cache-backed pattern directly, with the loading/error
// states falling out of useQuery/useMutation instead of being hand-rolled.
//
// The backend (backend/userService/{routes,controllers}/apikeys.js,
// models/ApiKey.js) was built and orchestrator-verified end-to-end through
// Kong by the prior WP-032 agent -- see EXECUTION_LOG.md's WP-032 entry.
// This page is the missing frontend surface for it (GR-4): list, create
// (secret shown once), revoke (confirmed, immediate).
//
// The one deliberate exception to "no bespoke design" per the owner's
// note: the post-creation secret reveal below is a genuine usability
// cliff (miss it and the key is unusable, full stop), not decoration --
// see <SecretRevealDialog> for how it's made unmissable.

const KEY_STATUS_COLORS: Record<string, StatusChipColor> = {
    active: 'success',
    revoked: 'default'
};

const SCOPE_LABELS: Record<ApiKeyScope, string> = {
    'results:write': 'results:write',
    'results:read': 'results:read',
    'keys:admin': 'keys:admin'
};

function formatDate(value: string | null | undefined): string {
    if (!value) return '—';
    return new Date(value).toLocaleString();
}

// The credential a caller actually uses is `<keyId>.<secret>` (see
// backend/userService/controllers/apikeys.js's header comment and
// EXECUTION_LOG.md's WP-032 matrix-test entry for the verified format,
// e.g. "ak_eEoyWqRZgw4B.0ee555…") -- not the bare secret. Assembling it
// here, once, at display time avoids making the caller concatenate two
// separately-copied values correctly under pressure.
function credentialFor(created: CreatedApiKey): string {
    return `${created.keyId}.${created.secret}`;
}

interface SecretRevealDialogProps {
    created: CreatedApiKey | null;
    onClose: () => void;
}

// Shown exactly once, immediately after creation. Deliberately hard to
// dismiss by accident:
//   - no backdrop-click / Escape close (onClose is a no-op unless the
//     explicit acknowledgement path is used)
//   - a persistent warning banner, not a toast that can be missed
//   - the "Close" action is disabled until the operator checks "I have
//     copied this secret"
// The plaintext secret lives only in the parent's React state
// (Pages/apiKeys.tsx's `createdKey`), set once on the mutation's onSuccess
// and cleared (setCreatedKey(null)) the moment this dialog closes -- never
// written to localStorage/sessionStorage, never logged (no console.* call
// anywhere in this file references `.secret` or the assembled credential),
// never put in a URL.
function SecretRevealDialog({ created, onClose }: SecretRevealDialogProps) {
    const [acknowledged, setAcknowledged] = useState(false);
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        if (!created) return;
        try {
            await navigator.clipboard.writeText(credentialFor(created));
            setCopied(true);
        } catch {
            // Clipboard API unavailable/denied -- the value is still
            // selectable/readable in the TextField below, so this is a
            // convenience failure, not a blocker.
            setCopied(false);
        }
    };

    const handleClose = () => {
        setAcknowledged(false);
        setCopied(false);
        onClose();
    };

    return (
        <Dialog open={!!created} onClose={() => undefined} disableEscapeKeyDown fullWidth maxWidth="sm">
            <DialogTitle>
                <Stack direction="row" spacing={1} alignItems="center">
                    <WarningAmberIcon color="warning" />
                    <Typography variant="h6">Save this API key now</Typography>
                </Stack>
            </DialogTitle>
            <DialogContent>
                <Stack spacing={2} mt={1}>
                    <Alert severity="warning" variant="filled">
                        This secret will not be shown again. Copy it now — it cannot be retrieved later. If you lose it,
                        revoke this key and create a new one.
                    </Alert>
                    {created ? (
                        <>
                            <TextField
                                label="API key (keyId.secret)"
                                value={credentialFor(created)}
                                InputProps={{
                                    readOnly: true,
                                    sx: { fontFamily: 'monospace', fontSize: '0.85rem' }
                                }}
                                fullWidth
                                multiline
                                onFocus={(e) => e.target.select()}
                            />
                            <Button startIcon={<ContentCopyIcon />} variant="outlined" onClick={handleCopy} sx={{ alignSelf: 'flex-start' }}>
                                {copied ? 'Copied!' : 'Copy to clipboard'}
                            </Button>
                            <Stack spacing={0.5}>
                                <Typography variant="body2" color="text.secondary">
                                    Key ID: {created.keyId}
                                </Typography>
                                <Typography variant="body2" color="text.secondary">
                                    Scopes: {created.scopes.join(', ')}
                                </Typography>
                            </Stack>
                        </>
                    ) : null}
                    <FormControlLabel
                        control={<Checkbox checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />}
                        label="I have copied this secret. I understand it will not be shown again."
                    />
                </Stack>
            </DialogContent>
            <DialogActions>
                <Button variant="contained" disabled={!acknowledged} onClick={handleClose}>
                    Close
                </Button>
            </DialogActions>
        </Dialog>
    );
}

// WP-044: split into ApiKeysPanel (bare content, no chrome) and the
// default-exported ApiKeysPage (ApiKeysPanel wrapped in MainLayout).
// Pages/settings/ApiKeysTab.tsx renders ApiKeysPanel directly inside
// Pages/settings/index.tsx's own single MainLayout -- wrapping again here
// would nest a second AppBar/Drawer. ApiKeysPage is kept as the plain,
// standalone page in case anything still wants one; nothing in this app's
// route table points at it any more (see App.tsx's LegacyRedirect for
// /apikeys -> /projects/:projectId/settings/apikeys).
export function ApiKeysPanel() {
    const queryClient = useQueryClient();
    const { can } = usePermissions();
    const canManage = can('manage_project');

    const [errorMessage, setErrorMessage] = useState('');
    const [errorOpen, setErrorOpen] = useState(false);
    const showError = (message: string) => {
        setErrorMessage(message);
        setErrorOpen(true);
    };

    const { data: keys, isLoading, isError } = useQuery({
        // WP-044: scoped by project so a project switch (Layouts/
        // ProjectRouteLayout.tsx's remount) is a cache miss, not a stale
        // hit -- same reasoning as usePersonaReports.ts's queryKeys.
        queryKey: ['apiKeys', getCurrentProjectId()],
        queryFn: getApiKeys
    });

    const [createOpen, setCreateOpen] = useState(false);
    const [newName, setNewName] = useState('');
    const [newScopes, setNewScopes] = useState<ApiKeyScope[]>([]);
    const [createdKey, setCreatedKey] = useState<CreatedApiKey | null>(null);

    const createMutation = useMutation({
        mutationFn: createApiKey,
        onSuccess: (created) => {
            queryClient.invalidateQueries({ queryKey: ['apiKeys'] });
            setCreateOpen(false);
            setCreatedKey(created);
        },
        onError: (err: any) => {
            showError(err?.response?.data?.error || 'Unable to create API key');
        }
    });

    const revokeMutation = useMutation({
        mutationFn: revokeApiKey,
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ['apiKeys'] });
        },
        onError: (err: any) => {
            showError(err?.response?.data?.error || 'Unable to revoke API key');
        }
    });

    const openCreate = () => {
        setNewName('');
        setNewScopes([]);
        setCreateOpen(true);
    };

    const handleScopeChange = (event: SelectChangeEvent<ApiKeyScope[]>) => {
        const value = event.target.value;
        setNewScopes(typeof value === 'string' ? (value.split(',') as ApiKeyScope[]) : value);
    };

    const handleCreate = () => {
        if (newScopes.length === 0) {
            showError('Select at least one scope');
            return;
        }
        createMutation.mutate({ name: newName || undefined, scopes: newScopes });
    };

    const handleRevoke = (key: ApiKey) => {
        const label = key.name ? `"${key.name}" (${key.keyId})` : key.keyId;
        if (!window.confirm(`Revoke API key ${label}? This is immediate and cannot be undone -- any caller using it fails right away.`)) {
            return;
        }
        revokeMutation.mutate(key.keyId);
    };

    const rows = useMemo(() => (keys ?? []).map((k) => ({ id: k.keyId, ...k })), [keys]);

    const columns: GridColDef[] = [
        { field: 'keyId', headerName: 'Key ID', flex: 1.1, sortable: false },
        { field: 'name', headerName: 'Name', flex: 1, valueGetter: (params) => params.row.name || '—' },
        {
            field: 'scopes',
            headerName: 'Scopes',
            flex: 1.3,
            sortable: false,
            renderCell: (params) => (
                <Stack direction="row" spacing={0.5} flexWrap="wrap">
                    {(params.row.scopes as ApiKeyScope[]).map((s) => (
                        <StatusChip key={s} status={s} label={SCOPE_LABELS[s]} size="small" />
                    ))}
                </Stack>
            )
        },
        {
            field: 'status',
            headerName: 'Status',
            flex: 0.7,
            sortable: false,
            renderCell: (params) => (
                <StatusChip status={params.row.revoked ? 'revoked' : 'active'} colorMap={KEY_STATUS_COLORS} />
            )
        },
        { field: 'createdBy', headerName: 'Created by', flex: 1 },
        { field: 'createdAt', headerName: 'Created', flex: 1, valueFormatter: (params) => formatDate(params.value as string) },
        { field: 'lastUsed', headerName: 'Last used', flex: 1, valueFormatter: (params) => formatDate(params.value as string) },
        {
            field: 'actions',
            headerName: 'Actions',
            flex: 0.7,
            sortable: false,
            renderCell: (params) =>
                !params.row.revoked && canManage ? (
                    <IconButton
                        size="small"
                        title="Revoke"
                        disabled={revokeMutation.isPending}
                        onClick={() => handleRevoke(params.row as ApiKey)}
                    >
                        <BlockIcon fontSize="small" />
                    </IconButton>
                ) : null
        }
    ];

    return (
        <>
            {errorOpen ? (
                <CustomizedSnackbars errorMessage={errorMessage} refresh={errorOpen} closeError={() => setErrorOpen(false)} severity={'error'} />
            ) : null}
            <Box mt={'8vh'}>
                <Stack spacing={3}>
                    <Stack direction={'row'} justifyContent={'space-between'} alignItems={'center'}>
                        <Stack direction="row" spacing={1} alignItems="center">
                            <VpnKeyIcon color="primary" />
                            <Typography variant="h5" color={'primary'}>
                                API Keys
                            </Typography>
                        </Stack>
                        {canManage ? (
                            <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
                                New API Key
                            </Button>
                        ) : null}
                    </Stack>

                    <Typography variant="body2" color="text.secondary">
                        Per-project machine credentials for CI/results ingestion. Keys are shown once at creation and cannot be
                        retrieved again -- revoke and reissue if one is lost.
                    </Typography>

                    {isError ? (
                        <EmptyState message="Unable to load API keys. Try refreshing the page." />
                    ) : !isLoading && rows.length === 0 ? (
                        <EmptyState
                            message="No API keys yet."
                            action={
                                canManage ? (
                                    <Button variant="outlined" startIcon={<AddIcon />} onClick={openCreate}>
                                        Create your first API key
                                    </Button>
                                ) : undefined
                            }
                        />
                    ) : (
                        <Box sx={{ width: '100%' }}>
                            <DataGrid
                                autoHeight
                                loading={isLoading}
                                rows={rows}
                                columns={columns}
                                getRowId={(row) => row.keyId}
                                initialState={{
                                    pagination: { paginationModel: { page: 0, pageSize: 25 } },
                                    sorting: { sortModel: [{ field: 'createdAt', sort: 'desc' }] }
                                }}
                                pageSizeOptions={[25, 50, 100]}
                            />
                        </Box>
                    )}
                </Stack>
            </Box>

            {/* Create dialog */}
            <Dialog open={createOpen} onClose={() => setCreateOpen(false)} fullWidth maxWidth="sm">
                <DialogTitle>New API Key</DialogTitle>
                <DialogContent>
                    <DialogContentText sx={{ mb: 2 }}>
                        The secret is generated server-side and shown to you exactly once, immediately after creation.
                    </DialogContentText>
                    <Stack spacing={2}>
                        <TextField label="Name (optional)" value={newName} onChange={(e) => setNewName(e.target.value)} fullWidth />
                        <FormControl fullWidth>
                            <InputLabel id="api-key-scopes-label">Scopes</InputLabel>
                            <Select
                                labelId="api-key-scopes-label"
                                multiple
                                value={newScopes}
                                onChange={handleScopeChange}
                                input={<OutlinedInput label="Scopes" />}
                                renderValue={(selected) => (selected as ApiKeyScope[]).join(', ')}
                            >
                                {API_KEY_SCOPES.map((scope) => (
                                    <MenuItem key={scope} value={scope}>
                                        <Checkbox checked={newScopes.includes(scope)} />
                                        <ListItemText primary={SCOPE_LABELS[scope]} />
                                    </MenuItem>
                                ))}
                            </Select>
                        </FormControl>
                    </Stack>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setCreateOpen(false)}>Cancel</Button>
                    <Button variant="contained" disabled={createMutation.isPending} onClick={handleCreate}>
                        Create
                    </Button>
                </DialogActions>
            </Dialog>

            <SecretRevealDialog created={createdKey} onClose={() => setCreatedKey(null)} />
        </>
    );
}

export default function ApiKeysPage() {
    return (
        <MainLayout>
            <ApiKeysPanel />
        </MainLayout>
    );
}
