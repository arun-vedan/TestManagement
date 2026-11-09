import React from 'react';
import { Alert } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { getAiAvailability } from '../../api/aiApi';
import { getCurrentProjectId } from '../../currentProject';

// WP-166 follow-up -- AI is off for the closed beta, so every /ai/* call
// 403s; until this existed every AI entry point still rendered and then
// failed. One answer per project, cached for a few minutes: the deployment
// switch changes about once a quarter, not once a session.
export type AiAvailabilityState = 'available' | 'explain' | 'hidden';

export function useAiAvailability(): { state: AiAvailabilityState; message: string | null } {
  const projectId = getCurrentProjectId();
  const { data } = useQuery({
    queryKey: ['project', projectId, 'aiAvailability'],
    queryFn: getAiAvailability,
    staleTime: 5 * 60_000,
    retry: false,
  });
  // Fail closed: while loading, or if the probe itself fails, offer nothing
  // rather than flash a control that would only 403.
  if (!data) return { state: 'hidden', message: null };
  if (data.available) return { state: 'available', message: null };
  // Unavailable. Only worth explaining if someone here can act on it (a
  // project admin re-enabling it); a deployment-level switch is not.
  return data.actionableByProjectAdmin
    ? { state: 'explain', message: data.message }
    : { state: 'hidden', message: null };
}

/** Renders `children` only when AI is available; see useAiAvailability. */
export function AiAvailable({ children }: { children: React.ReactNode }): JSX.Element | null {
  const { state, message } = useAiAvailability();
  if (state === 'available') return <>{children}</>;
  if (state === 'explain' && message) {
    return (
      <Alert severity="info" variant="outlined" sx={{ py: 0 }}>
        {message}
      </Alert>
    );
  }
  return null;
}
