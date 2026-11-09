import React, { useEffect, useState } from 'react';
import {
    Badge,
    Box,
    Button,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    List,
    ListItem,
    ListItemText,
    Tab,
    Tabs,
} from '@mui/material';
import AssignmentLateIcon from '@mui/icons-material/AssignmentLate';
import { useCoverage } from '../../Hooks/queries/useCoverage';
import { getCurrentProjectId } from '../../currentProject';
import { EmptyState } from '../common/EmptyState';

// WP-011: a plain, functional coverage panel per the owner's 2026-08-28
// design direction -- no bespoke visual work, MUI Material only, EmptyState
// reused for the empty-list case. A simple list view (this) is deliberately
// all that's built now; a dashboard treatment is WP-041's job.
//
// WP-078 -- migrated off Context/CoverageContext.tsx to the react-query
// replacement (Hooks/queries/useCoverage.ts), which already fetches BOTH
// the untested-requirements set and the orphan-test-cases set together
// (api/linkApi.ts's getOrphanTestCases), so the separate manual
// getOrphanTestCases() call this component used to make on open is gone --
// `invalidate()` now refreshes both lists in one round trip.

export const CoveragePanel: React.FC = () => {
    const { untestedReqIds, orphanTestCaseIds, loading, invalidate } = useCoverage(getCurrentProjectId());
    const [open, setOpen] = useState(false);
    const [tab, setTab] = useState(0);

    useEffect(() => {
        if (!open) {
            return;
        }
        invalidate();
        // Deliberately re-fetches both lists every time the panel opens, so
        // a link-type change made just before opening it is reflected
        // rather than shown stale.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const untestedList = Array.from(untestedReqIds).sort();
    const orphanList = Array.from(orphanTestCaseIds).sort();

    return (
        <>
            <Button
                size="small"
                variant="outlined"
                startIcon={
                    <Badge badgeContent={untestedReqIds.size} color="warning" max={999}>
                        <AssignmentLateIcon fontSize="small" />
                    </Badge>
                }
                onClick={() => setOpen(true)}
            >
                Coverage
            </Button>
            <Dialog open={open} onClose={() => setOpen(false)} maxWidth="sm" fullWidth>
                <DialogTitle>Traceability coverage</DialogTitle>
                <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ px: 3 }}>
                    <Tab label={`Untested requirements (${untestedReqIds.size})`} />
                    <Tab label={`Orphan test cases (${orphanTestCaseIds.size})`} />
                </Tabs>
                <DialogContent>
                    {tab === 0 && (
                        loading ? (
                            <Box display="flex" justifyContent="center" p={3}>
                                <CircularProgress size={28} />
                            </Box>
                        ) : untestedList.length === 0 ? (
                            <EmptyState message="Every requirement has at least one linked test case." />
                        ) : (
                            <List dense>
                                {untestedList.map((reqId) => (
                                    <ListItem key={reqId} divider>
                                        <ListItemText primary={reqId} />
                                    </ListItem>
                                ))}
                            </List>
                        )
                    )}
                    {tab === 1 && (
                        loading ? (
                            <Box display="flex" justifyContent="center" p={3}>
                                <CircularProgress size={28} />
                            </Box>
                        ) : orphanList.length === 0 ? (
                            <EmptyState message="Every test case has at least one linked requirement." />
                        ) : (
                            // WP-078 -- useCoverage's orphanTestCaseIds is a Set<string> of
                            // TestCaseIds only (api/linkApi.ts's getOrphanTestCases result
                            // collapsed to ids, same shape CoverageContext never exposed
                            // either); the old TestCaseSummary secondary line is dropped
                            // rather than faked. This component has no route/consumer
                            // today (see this WP's report), so there is no live surface
                            // this visibly regresses.
                            <List dense>
                                {orphanList.map((tcId) => (
                                    <ListItem key={tcId} divider>
                                        <ListItemText primary={tcId} />
                                    </ListItem>
                                ))}
                            </List>
                        )
                    )}
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setOpen(false)}>Close</Button>
                </DialogActions>
            </Dialog>
        </>
    );
};

export default CoveragePanel;
