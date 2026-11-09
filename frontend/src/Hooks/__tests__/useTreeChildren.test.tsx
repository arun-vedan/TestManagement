/* eslint-disable testing-library/no-node-access -- `qk.children(...)` is
   Hooks/queryKeys.ts's key-builder function, not DOM node traversal;
   eslint-plugin-testing-library's no-node-access rule pattern-matches on
   the property name alone and false-positives here. */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useTreeChildren } from '../queries/useTreeChildren';
import { qk } from '../queryKeys';
import * as api from '../../api/apiCalls';
import { getReleases } from '../../api/releaseApi';

jest.mock('../../api/apiCalls');
jest.mock('../../api/releaseApi', () => ({ getReleases: jest.fn() }));

const wrapper = (client: QueryClient) =>
  ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

describe('useTreeChildren', () => {
  it('caches each parent under its own key', () => {
    expect(qk.children(1, 1, 0)).toEqual(['project', 1, 1, 'children', 0]);
    expect(qk.children(1, 1, 8)).toEqual(['project', 1, 1, 'children', 8]);
  });

  it('returns folders and leaves merged for one parent', async () => {
    (api.getFolderList as jest.Mock).mockResolvedValue([
      { id: 8, parentFolder: 0, folderName: 'Auth' },
    ]);
    (api.getTcList as jest.Mock).mockResolvedValue([
      { TestCaseId: 'TC-104', parentId: 0 },
    ]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useTreeChildren(1, 0), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([
      { id: '8',      parent: '0', droppable: true,  text: 'Auth'   },
      { id: 'TC-104', parent: '0', droppable: false, text: 'TC-104' },
    ]);
  });

  it('does not fetch a parent until it is requested', async () => {
    (api.getFolderList as jest.Mock).mockResolvedValue([]);
    (api.getTcList as jest.Mock).mockResolvedValue([]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useTreeChildren(1, 0), { wrapper: wrapper(client) });
    await waitFor(() => expect(api.getFolderList).toHaveBeenCalledTimes(1));
    expect(api.getFolderList).not.toHaveBeenCalledWith(8, 1);
  });

  // Owner report 2026-11-06: releases showed in list view but never in the
  // tree -- fetchLeaves had no module-6 case. Releases carry no parentId, so
  // like runs/defects they live at the root only. The node id is the Mongo
  // _id (what ReleaseDetail/EntityDetail dispatch on, and what the list
  // view's ReleaseIdCell opens), labelled with the human REL-n.
  it('lists releases at the root of module 6, keyed by _id and labelled REL-n', async () => {
    (api.getFolderList as jest.Mock).mockResolvedValue([{ id: 3, parentFolder: 0, folderName: 'Q4' }]);
    (getReleases as jest.Mock).mockResolvedValue([
      { _id: 'mongo-9', releaseId: 'REL-9', name: 'Autumn Launch', status: 'planned' },
      { _id: 'mongo-4', releaseId: 'REL-4', name: 'Spring', status: 'released' },
    ]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useTreeChildren(6, 0), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // No folder nodes: releases have no folders (owner decision 2026-11-06).
    expect(result.current.data).toEqual([
      { id: 'mongo-9', parent: '0', droppable: false, text: 'REL-9' },
      { id: 'mongo-4', parent: '0', droppable: false, text: 'REL-4' },
    ]);
  });

  it('does not repeat releases inside module-6 folders', async () => {
    (api.getFolderList as jest.Mock).mockResolvedValue([]);
    (getReleases as jest.Mock).mockResolvedValue([{ _id: 'mongo-9', releaseId: 'REL-9' }]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useTreeChildren(6, 3), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
    expect(getReleases).not.toHaveBeenCalled();
  });

  // Owner decision 2026-11-06: folders exist only in Test Cases (1) and
  // Requirements (2). Elsewhere the tree loads no folder nodes at all --
  // even if stale Folder records exist for those modules -- and lists every
  // item flat at the root.
  it.each([3, 4, 5, 6] as const)('module %i loads no folders', async (module) => {
    (api.getFolderList as jest.Mock).mockResolvedValue([{ id: 9, parentFolder: 0, folderName: 'Stale' }]);
    (api.getTestPlanList as jest.Mock).mockResolvedValue([]);
    (api.getTestExecutionList as jest.Mock).mockResolvedValue([]);
    (api.getDefectList as jest.Mock).mockResolvedValue([]);
    (getReleases as jest.Mock).mockResolvedValue([]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useTreeChildren(module, 0), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
    expect(api.getFolderList).not.toHaveBeenCalled();
  });

  // Plans already filed under a (now hidden) folder must not vanish: the
  // root lists every plan regardless of its stored parentId.
  it('lists every test plan flat at the root, whatever folder it was filed in', async () => {
    (api.getTestPlanList as jest.Mock).mockResolvedValue([
      { TestPlanId: 'PLN-1', parentId: 0 },
      { TestPlanId: 'PLN-7', parentId: 12 },
    ]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useTreeChildren(3, 0), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([
      { id: 'PLN-1', parent: '0', droppable: false, text: 'PLN-1' },
      { id: 'PLN-7', parent: '0', droppable: false, text: 'PLN-7' },
    ]);
    expect((api.getTestPlanList as jest.Mock).mock.calls[0][0]).not.toMatch(/parentId=/);
  });

  it('still loads folders for test cases and requirements', async () => {
    (api.getFolderList as jest.Mock).mockResolvedValue([{ id: 8, parentFolder: 0, folderName: 'Auth' }]);
    (api.getReqList as jest.Mock).mockResolvedValue([]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useTreeChildren(2, 0), { wrapper: wrapper(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([{ id: '8', parent: '0', droppable: true, text: 'Auth' }]);
  });
});
