// src/Hooks/__tests__/useMoveNode.test.tsx
/* eslint-disable testing-library/no-node-access -- `qk.children(...)` is
   Hooks/queryKeys.ts's key-builder function, not DOM node traversal;
   eslint-plugin-testing-library's no-node-access rule pattern-matches on
   the property name alone and false-positives here. */
/* eslint-disable testing-library/no-wait-for-multiple-assertions -- the two
   assertions below both read from the same rollback and must be observed
   together as one waitFor's condition; splitting them into separate
   waitFor calls would not change what is being proved. */
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { useMoveNode } from '../mutations/useMoveNode';
import { qk } from '../queryKeys';
import * as api from '../../api/apiCalls';

jest.mock('../../api/apiCalls');

describe('useMoveNode', () => {
  const node = { id: 'TC-104', parent: '0', droppable: false, text: 'TC-104' };

  const setup = () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData(qk.children(1, 1, '0'), [node]);
    client.setQueryData(qk.children(1, 1, '8'), []);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    return { client, wrapper };
  };

  it('moves the node between cached parents optimistically', async () => {
    (api.updateTestCaseByParam as jest.Mock).mockResolvedValue({ status: 200 });
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useMoveNode(1), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ id: 'TC-104', fromParentId: '0', toParentId: '8', droppable: false });
    });

    expect(client.getQueryData(qk.children(1, 1, '8'))).toEqual([{ ...node, parent: '8' }]);
    expect(client.getQueryData(qk.children(1, 1, '0'))).toEqual([]);
  });

  it('rolls both parents back when the API rejects', async () => {
    (api.updateTestCaseByParam as jest.Mock).mockRejectedValue(new Error('boom'));
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useMoveNode(1), { wrapper });

    await act(async () => {
      await result.current
        .mutateAsync({ id: 'TC-104', fromParentId: '0', toParentId: '8', droppable: false })
        .catch(() => undefined);
    });

    await waitFor(() => {
      expect(client.getQueryData(qk.children(1, 1, '0'))).toEqual([node]);
      expect(client.getQueryData(qk.children(1, 1, '8'))).toEqual([]);
    });
  });
});
