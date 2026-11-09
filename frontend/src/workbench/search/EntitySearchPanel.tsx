import React, { useState } from 'react';
import { Alert, Box, Button, CircularProgress, InputAdornment, List, ListItemButton, ListItemText, OutlinedInput, Typography } from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import { useWorkbench } from '../WorkbenchStoreProvider';
import { ModuleId, MODULE_LABELS } from '../modules';
import { EmptyState } from '../../Components/common/EmptyState';
import { useDebouncedValue } from '../../Hooks/useDebouncedValue';
import { useEntitySearch } from '../../Hooks/queries/useEntitySearch';
import { moduleSearchConfigs } from './entitySearchConfigs';

// Wave B-2 — the workbench's `search` panel mode, replacing the literal
// "Search coming soon" placeholder SourcePanel.tsx used to render
// (PRODUCT_GAP_REGISTER.md A2). Mirrors <EntityList>'s registry pattern
// (entityListConfigs.tsx): `moduleSearchConfigs[module]` decides whether
// this module has a real backend wildcard-search route at all (modules 1,
// 2, 3, 4, 5) or not (6) -- the "not available" branch below renders
// before any hook that could fire a request even has a chance to, and
// (per useEntitySearch's own `enabled` gate) no network call is ever
// issued for that module.
//
// No `useState` holds server results here: `searchText` is the raw
// controlled-input value (a UI concern), `useDebouncedValue` derives a
// settled copy of it, and `useEntitySearch` (react-query) is the only
// source of the results themselves, read via `query.data`.
const DEBOUNCE_MS = 300;

export interface EntitySearchPanelProps {
    module: ModuleId;
}

export default function EntitySearchPanel({ module }: EntitySearchPanelProps): JSX.Element {
    const config = moduleSearchConfigs[module];
    const [searchText, setSearchText] = useState('');
    const debouncedText = useDebouncedValue(searchText, DEBOUNCE_MS);
    const setSelection = useWorkbench((s) => s.setSelection);
    const openTab = useWorkbench((s) => s.openTab);

    // Called unconditionally (rules of hooks) but harmless for a
    // config-less module: useEntitySearch's own `enabled` is false
    // whenever `moduleSearchConfigs[module]` is undefined, so this never
    // fires a request for module 6 regardless of what's typed.
    const query = useEntitySearch(module, debouncedText);

    if (!config) {
        return (
            <Box sx={{ p: 2 }}>
                <EmptyState message={`Search is not available for ${MODULE_LABELS[module]} yet.`} />
            </Box>
        );
    }

    const trimmed = debouncedText.trim();
    const results = query.data ?? [];
    const searchLabel = `Search ${config.entityLabelPlural}`;

    const handleSelect = (id: string, title: string) => {
        // Exactly EntityTree's handleSelect path (setSelection then
        // openTab) -- a search result opens the same way a tree node does,
        // not through a parallel selection mechanism.
        setSelection(module, id);
        openTab({ module, entityId: id, title });
    };

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
            <Box sx={{ p: 1 }}>
                <OutlinedInput
                    size="small"
                    fullWidth
                    placeholder={searchLabel}
                    // `role="searchbox"` (rather than `type="search"`) --
                    // jsdom doesn't implement selectionStart/End for
                    // type="search" inputs, which breaks
                    // @testing-library/user-event's typing simulation in
                    // tests. An explicit ARIA role override gives the same
                    // accessible semantics without that native input type.
                    inputProps={{ 'aria-label': searchLabel, role: 'searchbox' }}
                    value={searchText}
                    onChange={(e) => setSearchText(e.target.value)}
                    startAdornment={
                        <InputAdornment position="start">
                            <SearchIcon fontSize="small" />
                        </InputAdornment>
                    }
                />
            </Box>
            <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 1 }}>
                {trimmed === '' && (
                    <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
                        {`Type to search across ${config.entityLabelPlural}.`}
                    </Typography>
                )}
                {trimmed !== '' && query.isLoading && (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: 1 }}>
                        <CircularProgress size={16} />
                        <Typography variant="body2" color="text.secondary">Searching…</Typography>
                    </Box>
                )}
                {trimmed !== '' && !query.isLoading && query.isError && (
                    <Box role="alert" sx={{ display: 'flex', flexDirection: 'column', gap: 1, p: 1 }}>
                        <Alert severity="error">{`Unable to search ${config.entityLabelPlural}.`}</Alert>
                        <Button
                            size="small"
                            variant="outlined"
                            onClick={() => query.refetch()}
                            sx={{ alignSelf: 'flex-start' }}
                        >
                            Retry
                        </Button>
                    </Box>
                )}
                {trimmed !== '' && !query.isLoading && !query.isError && results.length === 0 && (
                    <Typography variant="body2" color="text.secondary" sx={{ p: 1 }}>
                        {`No matches for “${trimmed}”.`}
                    </Typography>
                )}
                {trimmed !== '' && !query.isLoading && !query.isError && results.length > 0 && (
                    <List dense aria-label={`Search results for ${trimmed}`}>
                        {results.map((item) => (
                            <ListItemButton key={item.id} onClick={() => handleSelect(item.id, item.title)}>
                                <ListItemText primary={item.id} secondary={item.summary || undefined} />
                            </ListItemButton>
                        ))}
                    </List>
                )}
            </Box>
        </Box>
    );
}
