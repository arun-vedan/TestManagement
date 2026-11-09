import React, { useEffect } from 'react';
import { act, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { WorkbenchStoreProvider, useWorkbench } from '../WorkbenchStoreProvider';
import EntityDetail from '../EntityDetail';
import { qk } from '../../Hooks/queryKeys';
import { getFields, getTcList, getComments } from '../../api/apiCalls';

// D2 / WP-074c bug 3 -- EntityDetail.tsx renders `<TestCaseDetail
// key={entityId} .../>` (and the equivalent for every other module).
// Without that key, switching the active tab between two entities of the
// SAME module reuses the same component instance/subtree instead of
// discarding and remounting it.
//
// This only matters when TestCaseDetail's own "still loading" early return
// (`if (fieldsQuery.isLoading || (!isDraft && entityQuery.isLoading)) return
// <CircularProgress />`) does NOT fire for the new entity -- which happens
// whenever that entity's data is already sitting in the React Query cache
// (e.g. a record visited earlier in the session). In that case the whole
// subtree re-renders in place with new props rather than unmounting through
// the loading branch, so anything below it that fetches on mount with an
// EMPTY dependency array never re-fetches. `Comments`
// (Components/comments/displayComments.tsx) is exactly that:
// `useEffect(() => { getCommentsList(); }, [])`. Reproduced below by
// seeding entity B's query cache before switching to it, mirroring that
// exact "already visited" condition -- switching straight from a fresh A to
// a never-before-seen B would go through the loading branch regardless of
// the `key`, and the test would pass either way (a vacuous guard).
//
// The real bug, observed live: TC-1's header/comments stayed on screen next
// to TC-695's Description after switching tabs -- a save from that screen
// would have written to the wrong record. This was previously guarded only
// by a code comment and a browser check (EntityDetail.tsx's own WP-074c
// comment; EXECUTION_LOG.md, 2026-09-03); no jest regression test existed
// until now.
//
// Deliberately does NOT mock TestCaseDetail (unlike EntityDetail.test.tsx,
// which isolates EntityDetail's own dispatch logic and mocks every module
// component) -- this test needs the REAL TestCaseDetail/FieldGrid/
// CommentsSection/Comments chain mounted, because the bug lives several
// layers below EntityDetail itself. RequirementDetail/TestPlanDetail/
// TestRunDetail/DefectDetail are imported transitively by EntityDetail but
// never rendered here (this suite only ever activates module 1) --
// TestCaseDetail.test.tsx/DefectDetail.test.tsx already prove those import
// cleanly and behave on their own.
jest.mock('../../api/apiCalls', () => ({
  getFields: jest.fn(),
  getTcList: jest.fn(),
  updateTestCase: jest.fn(),
  saveTestCase: jest.fn(),
  getComments: jest.fn(),
}));

jest.mock('../../keycloak', () => ({
  __esModule: true,
  default: {
    tokenParsed: { sub: 'user-abc', preferred_username: 'alice', name: 'Alice' },
    authenticated: true,
  },
}));

const mockGetFields = getFields as jest.Mock;
const mockGetTcList = getTcList as jest.Mock;
const mockGetComments = getComments as jest.Mock;

const FIELDS = [
  { fieldName: 'TestCaseSummary', displayName: 'Summary', fieldType: 'TextArea', isDisplayed: true, isMandatory: true, isDefault: true },
  { fieldName: 'priority', displayName: 'Priority', fieldType: 'Text', isDisplayed: true, isMandatory: false, isDefault: false },
];

// Two distinct real entities. Deliberately no `status` field on either --
// that would mount LifecycleStatusSection, which needs its own API mocks
// and has nothing to do with what this test checks.
const ENTITY_A = {
  _id: 'mongo-a',
  TestCaseId: 'TC-1',
  TestCaseSummary: 'Entity A summary',
  dynamicFields: { priority: 'A-priority' },
};
const ENTITY_B = {
  _id: 'mongo-b',
  TestCaseId: 'TC-2',
  TestCaseSummary: 'Entity B summary',
  dynamicFields: { priority: 'B-priority' },
};

const COMMENTS_A = [{ _id: 'c-a', comments: 'Comment left on entity A', updatedByName: 'Alice', updatedAt: 'yesterday', createdBy: 'user-abc' }];
const COMMENTS_B = [{ _id: 'c-b', comments: 'Comment left on entity B', updatedByName: 'Bob', updatedAt: 'today', createdBy: 'user-xyz' }];

function renderHarness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let switchToB: () => void = () => {};

  function Harness() {
    const openTab = useWorkbench((s) => s.openTab);
    switchToB = () => openTab({ module: 1, entityId: 'TC-2', title: 'TC-2' });
    useEffect(() => {
      // Mount-only: open entity A's tab first, mirroring a real user
      // opening one record before switching to another.
      openTab({ module: 1, entityId: 'TC-1', title: 'TC-1' });
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return <EntityDetail moduleId={1} moduleSlug="testcases" />;
  }

  render(
    <MemoryRouter initialEntries={['/projects/1/workbench/testcases']}>
      <QueryClientProvider client={client}>
        <WorkbenchStoreProvider projectId={1}>
          <Harness />
        </WorkbenchStoreProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return {
    switchToTabB: () => act(() => switchToB()),
    // Pre-seeds react-query's cache for entity B, exactly as if it had
    // already been fetched once before (a record visited earlier in the
    // session). This is the scenario that actually exercises the `key` --
    // see this file's header comment.
    seedEntityBCache: (data: Record<string, unknown>) => {
      client.setQueryData(qk.entity(1, 1, 'TC-2'), data);
    },
  };
}

describe('EntityDetail -- keying the detail subtree by entityId (D2 / WP-074c bug 3)', () => {
  beforeEach(() => {
    // The store's zustand `persist` middleware writes to real localStorage
    // under `workbench:1` -- clear it so no tab from a previous test leaks
    // into this one (same reasoning as EntityDetail.test.tsx's own
    // beforeEach).
    localStorage.clear();
    jest.clearAllMocks();
    mockGetFields.mockResolvedValue(FIELDS);
    mockGetTcList.mockImplementation((query: string) =>
      Promise.resolve(query.includes('TC-1') ? [ENTITY_A] : [ENTITY_B]),
    );
    mockGetComments.mockImplementation((typeId: string) =>
      Promise.resolve(typeId === 'TC-1' ? COMMENTS_A : COMMENTS_B),
    );
  });

  it('shows only entity B after switching, with none of entity A left on screen', async () => {
    const { switchToTabB, seedEntityBCache } = renderHarness();

    // Entity A is fully loaded first, including its own comment.
    // DetailHeader renders `<b>{id}</b> : {summary}` as sibling text nodes
    // (DetailHeader.tsx), so the summary is matched as a substring, same
    // convention TestCaseDetail.test.tsx itself uses (`findByText(/TC-1/)`).
    expect(await screen.findByText(/Entity A summary/)).toBeInTheDocument();
    expect(screen.getByLabelText('Priority')).toHaveValue('A-priority');
    expect(await screen.findByText('Comment left on entity A')).toBeInTheDocument();

    // Entity B is already cached (as if visited earlier this session) --
    // see this file's header comment for why this is the condition that
    // actually exercises the `key`, rather than the loading branch masking
    // the bug.
    act(() => {
      seedEntityBCache({ ...ENTITY_B, priority: 'B-priority' });
    });

    // Switch the active tab to entity B (same module, different entityId) --
    // exactly what clicking a different tree row / tab does in the app.
    switchToTabB();

    // Entity B's own content must appear...
    expect(await screen.findByText(/Entity B summary/)).toBeInTheDocument();
    expect(screen.getByLabelText('Priority')).toHaveValue('B-priority');
    expect(await screen.findByText('Comment left on entity B')).toBeInTheDocument();

    // ...and NONE of entity A's must still be on screen. This is the
    // assertion that fails without `key={entityId}`: Comments' own
    // mount-only fetch effect never re-runs for entity B, so entity A's
    // comment would still be rendered here.
    expect(screen.queryByText(/Entity A summary/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Priority')).not.toHaveValue('A-priority');
    expect(screen.queryByText('Comment left on entity A')).not.toBeInTheDocument();
  });
});
