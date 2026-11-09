import { UseQueryResult } from '@tanstack/react-query';
import { isReportUnavailable, reportErrorMessage, ReportEnvelope } from '../../api/reportApi';

// WP-041 — normalizes a useQuery<ReportEnvelope<T>> result into the three
// states every report-backed widget needs to distinguish (acceptance:
// "Surface staleness... Handle 503 distinctly from an error"):
//   - unavailable: the 503 fail-closed case (no cache, live compute
//     failed) -- "nothing to show yet", not a real error. Widgets render
//     this through their EmptyState path, not their error/Alert path, so
//     it reads as calm guidance rather than a red failure banner.
//   - errorMessage: any other failure (network, 401 fallen through, 500,
//     etc.) -- a genuine problem, rendered through the widget's normal
//     error Alert.
//   - stale/staleReason/computedAt: a cache entry WAS served but a live
//     refresh attempt failed just now (getOrCompute's serve-stale branch).
//     Surfaced regardless of whether data is otherwise present.
export interface ReportState<T> {
  data?: T;
  isLoading: boolean;
  isUnavailable: boolean;
  errorMessage: string | null;
  stale: boolean;
  staleReason?: string;
  computedAt?: string;
}

export function useReportState<T>(query: UseQueryResult<ReportEnvelope<T>>): ReportState<T> {
  const { data: envelope, isLoading, isError, error } = query;
  const unavailable = isError && isReportUnavailable(error);
  return {
    data: envelope?.data,
    isLoading,
    isUnavailable: unavailable,
    errorMessage: isError && !unavailable ? reportErrorMessage(error) : null,
    stale: envelope?.stale ?? false,
    staleReason: envelope?.staleReason,
    computedAt: envelope?.computedAt,
  };
}
