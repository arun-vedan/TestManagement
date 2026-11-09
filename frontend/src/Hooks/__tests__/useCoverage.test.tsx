/* eslint-disable testing-library/no-node-access -- `qk.coverage(...)` is
   Hooks/queryKeys.ts's key-builder function, not DOM node traversal;
   eslint-plugin-testing-library's no-node-access rule pattern-matches on
   the property name alone and false-positives here (same reasoning as
   useTreeChildren.test.tsx). */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useCoverage } from '../queries/useCoverage';
import { qk } from '../queryKeys';
import * as linkApi from '../../api/linkApi';

// WP-075a -- src/Hooks/queries/useCoverage.ts did NOT exist: the plan's
// Task 2 file list named it but no step implemented it, and WP-071 shipped
// without it. Modeled on Context/CoverageContext.tsx's existing value shape
// (untestedReqIds/loading/refreshUntested) so consumers map over cleanly --
// the query read replaces untestedReqIds/loading, and refreshUntested
// becomes a cache invalidation. CoverageContext itself is NOT deleted or
// modified by this WP (TabContent.tsx, LinkTypeBadge.tsx, CoveragePanel.tsx
// still consume it for the legacy pages); WP-078 deletes it once nothing
// legacy is left.
jest.mock('../../api/linkApi');
const mockGetUntested = linkApi.getUntestedRequirements as jest.Mock;
const mockGetOrphans = linkApi.getOrphanTestCases as jest.Mock;

const wrapper = (client: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

beforeEach(() => {
  jest.clearAllMocks();
});

describe('useCoverage', () => {
  it('is keyed by qk.coverage(projectId)', () => {
    expect(qk.coverage(1)).toEqual(['project', 1, 'coverage', 'untested']);
  });

  it('returns untested requirement ids from the real coverage endpoint', async () => {
    mockGetUntested.mockResolvedValue([{ reqId: 'Req-1' }, { reqId: 'Req-2' }]);
    mockGetOrphans.mockResolvedValue([]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useCoverage(1), { wrapper: wrapper(client) });

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.untestedReqIds).toEqual(new Set(['Req-1', 'Req-2']));
  });

  it('also surfaces orphan test case ids from the sibling endpoint', async () => {
    mockGetUntested.mockResolvedValue([]);
    mockGetOrphans.mockResolvedValue([{ TestCaseId: 'TC-9' }]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useCoverage(1), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.orphanTestCaseIds).toEqual(new Set(['TC-9']));
  });

  it('defaults to empty sets before the query resolves, matching CoverageContext', () => {
    mockGetUntested.mockResolvedValue([]);
    mockGetOrphans.mockResolvedValue([]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useCoverage(1), { wrapper: wrapper(client) });

    expect(result.current.untestedReqIds).toEqual(new Set());
    expect(result.current.orphanTestCaseIds).toEqual(new Set());
  });

  it('invalidate() refetches -- the replacement for refreshUntested()', async () => {
    mockGetUntested.mockResolvedValueOnce([{ reqId: 'Req-1' }]).mockResolvedValueOnce([{ reqId: 'Req-1' }, { reqId: 'Req-2' }]);
    mockGetOrphans.mockResolvedValue([]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useCoverage(1), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.untestedReqIds).toEqual(new Set(['Req-1'])));

    await result.current.invalidate();

    await waitFor(() => expect(result.current.untestedReqIds).toEqual(new Set(['Req-1', 'Req-2'])));
    expect(mockGetUntested).toHaveBeenCalledTimes(2);
  });
});
