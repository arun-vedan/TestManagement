import React, { useEffect, useState } from 'react';
import {
    Box,
    Button,
    CircularProgress,
    Menu,
    MenuItem,
    Tooltip
} from '@mui/material';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import { getIssueStatuses, updateDefectStatus, IssueStatus } from '../../api/defectStatusApi';
import { StatusChip } from '../common/StatusChip';

// WP-010 (Sprint 2.4) governance UI. Sibling to LifecycleStatus.tsx, not a
// reuse of it: LifecycleStatus's vocabulary is a hardcoded 5-state list;
// this one is dynamic, loaded from istatusservice's real IssueStatus
// documents (New/Open/Fixed/Rejected/Deffered/Retest/Re-open/Closed today,
// but not hardcoded here). Reuses the same shared StatusChip and the same
// "backend is the source of truth, surface whatever error it returns"
// pattern as LifecycleStatus, plus one addition: since the graph is known
// client-side too, the menu only offers transitions that are actually valid
// from the current status (computed from parentId), rather than offering
// every other status and relying entirely on the 400. The backend
// (defectService's PUT /:id/status) still re-validates independently -- this
// is a UX improvement, not a trust boundary.

interface DefectStatusProps {
    defectId: string; // Mongo _id
    status: string;
    onStatusChanged: (newStatus: string) => void;
    onError: (message: string, severity: string) => void;
}

export const DefectStatus = ({ defectId, status, onStatusChanged, onError }: DefectStatusProps) => {
    const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);
    const [updating, setUpdating] = useState(false);
    const [loadingVocab, setLoadingVocab] = useState(true);
    const [vocabError, setVocabError] = useState(false);
    const [allStatuses, setAllStatuses] = useState<IssueStatus[]>([]);

    useEffect(() => {
        let cancelled = false;
        const loadVocabulary = async () => {
            setLoadingVocab(true);
            setVocabError(false);
            try {
                const statuses = await getIssueStatuses();
                if (!cancelled) {
                    setAllStatuses(statuses);
                }
            } catch (err: any) {
                if (!cancelled) {
                    setVocabError(true);
                }
            } finally {
                if (!cancelled) {
                    setLoadingVocab(false);
                }
            }
        };
        loadVocabulary();
        return () => {
            cancelled = true;
        };
        // Re-fetch is not tied to `status` on purpose -- the vocabulary/graph
        // itself doesn't change when the defect's own status changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [defectId]);

    // WP-F04 -- three real defects (Bug-1/2/3) stored `Status` as the
    // istatusservice id ('8', 1, 2) rather than the name every other defect
    // document stores. Matching by name alone left those unresolved, so
    // `unrecognizedStatus` below disabled the control and the chip fell
    // back to rendering the raw code. DefectFilterPanel.tsx's
    // resolveStatusName already resolves this exact ambiguity id-then-name
    // ("the same real-data ambiguity", per its own header comment) --
    // mirrored here rather than inventing a second approach to one problem.
    // Both sides go through String(...): real data mixes a numeric-looking
    // STRING ('8', Bug-1) with actual NUMBERS (1/2, Bug-2/3).
    const currentEntry =
        allStatuses.find((s) => String(s.id) === String(status)) ||
        allStatuses.find((s) => s.istatus.toLowerCase() === (status || '').toLowerCase());

    // The chip must show the resolved NAME, not the raw stored value --
    // otherwise a legacy id would still render as "2" even once the
    // control above correctly recognizes it and re-enables.
    const displayStatus = currentEntry ? currentEntry.istatus : status || '';

    // A defect created from the workbench draft flow has no Status at all.
    // The graph marks its start state(s) with parentId [0] ("reachable from
    // nothing"), so an empty status offers those rather than nothing --
    // otherwise such a defect could never enter the workflow.
    // defectService's updateDefectStatus applies the same rule.
    const hasNoStatus = status === undefined || status === null || String(status).trim() === '';
    const currentId = currentEntry ? currentEntry.id : hasNoStatus ? 0 : null;
    const validNextStatuses =
        currentId === null ? [] : allStatuses.filter((s) => s.parentId.includes(currentId));

    const unrecognizedStatus = !loadingVocab && !vocabError && status && !currentEntry;

    const handleStatusChange = async (nextStatus: string) => {
        setMenuAnchor(null);
        setUpdating(true);
        try {
            const result = await updateDefectStatus(defectId, nextStatus);
            onStatusChanged(result.data.Status);
        } catch (err: any) {
            onError(err?.response?.data?.error || 'Unable to change status', 'error');
        } finally {
            setUpdating(false);
        }
    };

    const controlDisabled =
        updating || loadingVocab || vocabError || unrecognizedStatus || validNextStatuses.length === 0;

    let disabledReason = '';
    if (vocabError) {
        disabledReason = 'Unable to load defect status options right now.';
    } else if (unrecognizedStatus) {
        disabledReason = `'${status}' is not part of the recognized status workflow.`;
    } else if (!loadingVocab && validNextStatuses.length === 0 && (currentEntry || hasNoStatus)) {
        disabledReason = `No valid next status from '${status}'.`;
    }

    return (
        <Box display="flex" alignItems="center" gap={1}>
            <StatusChip status={displayStatus} />

            <Tooltip title={disabledReason} disableHoverListener={!disabledReason}>
                <span>
                    <Button
                        size="small"
                        variant="outlined"
                        disabled={controlDisabled}
                        endIcon={updating || loadingVocab ? <CircularProgress size={14} /> : <ArrowDropDownIcon />}
                        onClick={(e) => setMenuAnchor(e.currentTarget)}
                    >
                        Change status
                    </Button>
                </span>
            </Tooltip>
            <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={() => setMenuAnchor(null)}>
                {validNextStatuses.map((s) => (
                    <MenuItem key={s.id} onClick={() => handleStatusChange(s.istatus)}>
                        {s.istatus}
                    </MenuItem>
                ))}
            </Menu>
        </Box>
    );
};

export default DefectStatus;
