import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Box, Button, LinearProgress, Paper, Stack, Typography } from '@mui/material';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { seedSampleProject, SeedProgress, SeedResult } from '../../api/sampleProjectApi';
import { getCurrentProjectId } from '../../currentProject';
import { SAMPLE_PROJECT_NAME } from '../../data/sampleBankingProject';

// WP-133 — the one click.
//
// A fresh project has no requirements, cases, runs or links, so coverage, the
// traceability matrix, plan progress and release readiness all render empty.
// That is the entire differentiator showing nothing on the day somebody is
// deciding whether to adopt this, and an empty chart teaches a viewer nothing
// about what the chart is for.
//
// This card appears only while the project genuinely has no requirements, and
// disappears for good once it has any -- the caller gates on
// coverage.total === 0 rather than on a flag, so it cannot get stuck visible on
// a project someone has already filled in, and there is no state to reset.
//
// It is NOT shown while coverage is still loading or unavailable: offering to
// fill a project because a report timed out would be the wrong inference, and
// could put sample data into a project that already has real content.

export interface SampleDataCardProps {
    // Called after a successful seed so the page can refetch. Optional: the
    // card already invalidates the report queries itself.
    onSeeded?: (result: SeedResult) => void;
}

export function SampleDataCard({ onSeeded }: SampleDataCardProps) {
    const queryClient = useQueryClient();
    const [progress, setProgress] = useState<SeedProgress | null>(null);
    const [result, setResult] = useState<SeedResult | null>(null);

    const mutation = useMutation({
        mutationFn: () => seedSampleProject(getCurrentProjectId(), setProgress),
        onSuccess: (seeded) => {
            setResult(seeded);
            // Every report is keyed ['report', <name>, projectId]; invalidating
            // the prefix refetches all of them, which is what makes the
            // dashboard fill in without a page reload.
            queryClient.invalidateQueries({ queryKey: ['report'] });
            onSeeded?.(seeded);
        }
    });

    if (result) {
        return (
            <Alert severity="success" data-testid="sample-data-done">
                Sample data loaded: {result.requirements} requirements, {result.testCases} test cases,{' '}
                {result.executed} executed, {result.defects} open defect and {result.releases} release
                with quality gates. The dashboard below now reflects it.
            </Alert>
        );
    }

    const pct = progress && progress.total > 0 ? (progress.done / progress.total) * 100 : 0;

    return (
        <Paper variant="outlined" sx={{ p: 3 }} data-testid="sample-data-card">
            <Stack spacing={2}>
                <Stack direction="row" spacing={1.5} alignItems="center">
                    <AutoAwesomeIcon color="primary" />
                    <Typography variant="h6" component="h2">
                        This project is empty
                    </Typography>
                </Stack>

                <Typography variant="body2" color="text.secondary">
                    Coverage, traceability, plan progress and release readiness all need requirements,
                    test cases and a run before they can show anything. Load a worked example —{' '}
                    <strong>{SAMPLE_PROJECT_NAME}</strong> — to see them populated with realistic data,
                    including a failing test, a blocked test, an uncovered requirement and an open
                    defect, so each report has something real to show.
                </Typography>

                <Typography variant="caption" color="text.secondary">
                    Everything is created as ordinary project data under your own account, so you can
                    edit or delete any of it afterwards.
                </Typography>

                {mutation.isError ? (
                    <Alert severity="error" data-testid="sample-data-error">
                        {(mutation.error as Error).message}
                        {/* The seeder does not roll back -- unwinding writes across
                            seven services would be a distributed transaction, and a
                            half-built rollback could delete real data. So the user is
                            told what exists rather than left guessing. */}
                        <Box component="span" sx={{ display: 'block', mt: 1 }}>
                            Anything created before the failure is still in the project. You can delete
                            the project and start again, or keep what loaded.
                        </Box>
                    </Alert>
                ) : null}

                {mutation.isPending ? (
                    <Box>
                        <LinearProgress variant="determinate" value={pct} />
                        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
                            {progress ? `${progress.step}…` : 'starting…'}
                        </Typography>
                    </Box>
                ) : null}

                <Box>
                    <Button
                        variant="contained"
                        onClick={() => mutation.mutate()}
                        disabled={mutation.isPending}
                        data-testid="load-sample-data"
                    >
                        {mutation.isPending ? 'Loading sample data…' : 'Load sample data'}
                    </Button>
                </Box>
            </Stack>
        </Paper>
    );
}

export default SampleDataCard;
