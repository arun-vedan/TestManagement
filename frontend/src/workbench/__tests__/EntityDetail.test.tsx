import React from 'react';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { WorkbenchStoreProvider, useWorkbench } from '../WorkbenchStoreProvider';
import EntityDetail from '../EntityDetail';

// WP-074 Step 6 -- EntityDetail is the shell's default DetailComponent,
// dispatching on the active tab for the current module. TestCaseDetail
// itself is fully covered by detail/__tests__/TestCaseDetail.test.tsx, so
// it is mocked here to isolate EntityDetail's own dispatch logic (module 1
// with an active tab -> TestCaseDetail; any other module, or no active
// tab, -> a placeholder; unknown module -> the "unknown module" alert).
jest.mock('../detail/modules/TestCaseDetail', () => ({
  __esModule: true,
  default: ({ entityId }: { entityId: string }) => <div data-testid="test-case-detail">TestCaseDetail: {entityId}</div>,
}));
// WP-075a Part 2b -- RequirementDetail is fully covered by its own
// detail/__tests__/RequirementDetail.test.tsx; mocked here for the same
// reason TestCaseDetail is: isolate EntityDetail's dispatch logic only.
jest.mock('../detail/modules/RequirementDetail', () => ({
  __esModule: true,
  default: ({ entityId }: { entityId: string }) => <div data-testid="requirement-detail">RequirementDetail: {entityId}</div>,
}));
// WP-076 Part A -- TestPlanDetail/TestRunDetail are fully covered by their
// own detail/__tests__/TestPlanDetail.test.tsx and TestRunDetail.test.tsx;
// mocked here for the same reason TestCaseDetail/RequirementDetail are.
jest.mock('../detail/modules/TestPlanDetail', () => ({
  __esModule: true,
  default: ({ entityId }: { entityId: string }) => <div data-testid="test-plan-detail">TestPlanDetail: {entityId}</div>,
}));
jest.mock('../detail/modules/TestRunDetail', () => ({
  __esModule: true,
  default: ({ entityId }: { entityId: string }) => <div data-testid="test-run-detail">TestRunDetail: {entityId}</div>,
}));
// WP-077 Part A -- DefectDetail is fully covered by its own
// detail/__tests__/DefectDetail.test.tsx; mocked here for the same reason
// TestCaseDetail/RequirementDetail/TestPlanDetail/TestRunDetail are:
// isolate EntityDetail's dispatch logic only.
jest.mock('../detail/modules/DefectDetail', () => ({
  __esModule: true,
  default: ({ entityId }: { entityId: string }) => <div data-testid="defect-detail">DefectDetail: {entityId}</div>,
}));
// WP-F15/F18 Task 2 -- ReleaseDetail is fully covered by its own
// detail/__tests__/ReleaseDetail.test.tsx; mocked here for the same reason
// every other module's own detail component is: isolate EntityDetail's
// dispatch logic only.
jest.mock('../detail/modules/ReleaseDetail', () => ({
  __esModule: true,
  default: ({ entityId }: { entityId: string }) => <div data-testid="release-detail">ReleaseDetail: {entityId}</div>,
}));

// WP-076 -- EntityDetail reads the URL query string to restore the
// dashboard drill-down, so every render needs a router. `initialUrl` lets a
// test supply the drill-down params.
function renderWithStore(
  ui: React.ReactElement,
  openTabFirst?: { module: 1 | 2 | 3 | 4 | 5 | 6; entityId: string; title: string },
  initialUrl = '/projects/1/workbench/testcases',
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Harness() {
    const openTab = useWorkbench((s) => s.openTab);
    React.useEffect(() => {
      if (openTabFirst) openTab(openTabFirst);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return ui;
  }
  return render(
    <MemoryRouter initialEntries={[initialUrl]}>
      <QueryClientProvider client={client}>
        <WorkbenchStoreProvider projectId={1}>
          <Harness />
        </WorkbenchStoreProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('EntityDetail', () => {
  // The store's zustand `persist` middleware writes to real localStorage
  // under `workbench:1` -- every test in this file provisions a project-1
  // store, so a tab opened in one test would otherwise leak into the next.
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders the unknown-module alert when moduleId is null', () => {
    renderWithStore(<EntityDetail moduleId={null} moduleSlug="bogus-module" />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/unknown module/i);
    expect(alert).toHaveTextContent('bogus-module');
  });

  it('renders a "select an item" placeholder for module 1 with no active tab', () => {
    renderWithStore(<EntityDetail moduleId={1} moduleSlug="testcases" />);
    expect(screen.getByText(/select an item/i)).toBeInTheDocument();
    expect(screen.queryByTestId('test-case-detail')).not.toBeInTheDocument();
  });

  it('dispatches module 1 to TestCaseDetail once a tab is open', async () => {
    renderWithStore(
      <EntityDetail moduleId={1} moduleSlug="testcases" />,
      { module: 1, entityId: 'TC-104', title: 'TC-104' },
    );
    expect(await screen.findByTestId('test-case-detail')).toHaveTextContent('TC-104');
  });

  // WP-F15/F18 Task 2 -- Releases (module 6) is now a real dispatch target
  // too, the last of the six modules to get one (this file's own header
  // comment on EntityDetail.tsx records that the "not migrated" fallback
  // this suite used to exercise here is gone).
  it('renders a "select an item" placeholder for module 6 with no active tab', () => {
    renderWithStore(<EntityDetail moduleId={6} moduleSlug="releases" />);
    expect(screen.getByText(/select an item/i)).toBeInTheDocument();
    expect(screen.queryByTestId('release-detail')).not.toBeInTheDocument();
  });

  it('dispatches module 6 to ReleaseDetail once a tab is open', async () => {
    renderWithStore(
      <EntityDetail moduleId={6} moduleSlug="releases" />,
      { module: 6, entityId: 'REL-1', title: 'REL-1' },
    );
    expect(await screen.findByTestId('release-detail')).toHaveTextContent('REL-1');
  });

  it('does not show module 1\'s tab as the active entity for a different module', async () => {
    // A test case tab is open and active, but the CURRENT module is
    // Releases (module 6) -- EntityDetail must not leak module 1's entity
    // into module 6's detail region.
    renderWithStore(
      <EntityDetail moduleId={6} moduleSlug="releases" />,
      { module: 1, entityId: 'TC-104', title: 'TC-104' },
    );
    expect(screen.getByText(/select an item/i)).toBeInTheDocument();
    expect(screen.queryByTestId('test-case-detail')).not.toBeInTheDocument();
    expect(screen.queryByTestId('release-detail')).not.toBeInTheDocument();
  });

  // WP-077 Part A -- Defects (module 5) joins Test Cases/Requirements/Test
  // Plans/Test Runs as a real dispatch target.
  it('renders a "select an item" placeholder for module 5 with no active tab', () => {
    renderWithStore(<EntityDetail moduleId={5} moduleSlug="defects" />);
    expect(screen.getByText(/select an item/i)).toBeInTheDocument();
    expect(screen.queryByTestId('defect-detail')).not.toBeInTheDocument();
  });

  it('dispatches module 5 to DefectDetail once a tab is open', async () => {
    renderWithStore(
      <EntityDetail moduleId={5} moduleSlug="defects" />,
      { module: 5, entityId: 'DEF-1', title: 'DEF-1' },
    );
    expect(await screen.findByTestId('defect-detail')).toHaveTextContent('DEF-1');
  });

  it('does not show module 5\'s tab as the active entity for a different module', async () => {
    renderWithStore(
      <EntityDetail moduleId={1} moduleSlug="testcases" />,
      { module: 5, entityId: 'DEF-1', title: 'DEF-1' },
    );
    expect(screen.getByText(/select an item/i)).toBeInTheDocument();
    expect(screen.queryByTestId('defect-detail')).not.toBeInTheDocument();
  });

  // WP-076 Part A -- Test Plans (module 3) and Test Runs (module 4) join
  // Test Cases/Requirements as real dispatch targets.
  it('renders a "select an item" placeholder for module 3 with no active tab', () => {
    renderWithStore(<EntityDetail moduleId={3} moduleSlug="testplans" />);
    expect(screen.getByText(/select an item/i)).toBeInTheDocument();
    expect(screen.queryByTestId('test-plan-detail')).not.toBeInTheDocument();
  });

  it('dispatches module 3 to TestPlanDetail once a tab is open', async () => {
    renderWithStore(
      <EntityDetail moduleId={3} moduleSlug="testplans" />,
      { module: 3, entityId: 'PLN-1', title: 'PLN-1' },
    );
    expect(await screen.findByTestId('test-plan-detail')).toHaveTextContent('PLN-1');
  });

  it('renders a "select an item" placeholder for module 4 with no active tab', () => {
    renderWithStore(<EntityDetail moduleId={4} moduleSlug="testruns" />);
    expect(screen.getByText(/select an item/i)).toBeInTheDocument();
    expect(screen.queryByTestId('test-run-detail')).not.toBeInTheDocument();
  });

  it('dispatches module 4 to TestRunDetail once a tab is open', async () => {
    renderWithStore(
      <EntityDetail moduleId={4} moduleSlug="testruns" />,
      { module: 4, entityId: 'Run-1', title: 'Run-1' },
    );
    expect(await screen.findByTestId('test-run-detail')).toHaveTextContent('Run-1');
  });

  // WP-075a Part 2b -- Requirements (module 2) is now migrated too.
  it('renders a "select an item" placeholder for module 2 with no active tab', () => {
    renderWithStore(<EntityDetail moduleId={2} moduleSlug="requirements" />);
    expect(screen.getByText(/select an item/i)).toBeInTheDocument();
    expect(screen.queryByTestId('requirement-detail')).not.toBeInTheDocument();
  });

  it('dispatches module 2 to RequirementDetail once a tab is open', async () => {
    renderWithStore(
      <EntityDetail moduleId={2} moduleSlug="requirements" />,
      { module: 2, entityId: 'Req-4', title: 'Req-4' },
    );
    expect(await screen.findByTestId('requirement-detail')).toHaveTextContent('Req-4');
  });

  it('does not show module 2\'s tab as the active entity for module 1', async () => {
    renderWithStore(
      <EntityDetail moduleId={1} moduleSlug="testcases" />,
      { module: 2, entityId: 'Req-4', title: 'Req-4' },
    );
    expect(screen.getByText(/select an item/i)).toBeInTheDocument();
    expect(screen.queryByTestId('requirement-detail')).not.toBeInTheDocument();
  });

  // WP-076 -- the dashboard's "View all" drill-downs. Deleting
  // Pages/testExecution.tsx removed the only consumer of these params, so
  // the links silently landed on an unfiltered tree. Regression guard.
  describe('dashboard drill-down', () => {
    it('renders the test-execution filter panel for module 4 when the URL carries a status filter', () => {
      renderWithStore(
        <EntityDetail moduleId={4} moduleSlug="testruns" />,
        undefined,
        '/projects/1/workbench/testruns?status=fail',
      );
      expect(screen.queryByText(/select an item from the source panel/i)).not.toBeInTheDocument();
    });

    // WP-077 -- Defects (module 5) now has a real detail component
    // (DefectDetail), so this also proves the drill-down still wins over
    // it whenever no tab is open (the "don't regress the drill-down"
    // requirement) -- not just that a not-migrated placeholder is avoided.
    it('renders the defect filter panel for module 5 when no tab is open, even though the detail view is migrated', () => {
      renderWithStore(
        <EntityDetail moduleId={5} moduleSlug="defects" />,
        undefined,
        '/projects/1/workbench/defects?assignedTo=someone',
      );
      expect(screen.queryByText(/not migrated into the workbench yet/i)).not.toBeInTheDocument();
      expect(screen.queryByTestId('defect-detail')).not.toBeInTheDocument();
      expect(screen.queryByText(/select an item from the source panel/i)).not.toBeInTheDocument();
    });

    // An open tab must still win over the drill-down once the user has
    // navigated past it -- EntityDetail's own comment documents this
    // ordering; this proves it for the newly-migrated module 5 specifically.
    it('lets an open module-5 tab win over the drill-down params', async () => {
      renderWithStore(
        <EntityDetail moduleId={5} moduleSlug="defects" />,
        { module: 5, entityId: 'DEF-1', title: 'DEF-1' },
        '/projects/1/workbench/defects?assignedTo=someone',
      );
      expect(await screen.findByTestId('defect-detail')).toHaveTextContent('DEF-1');
    });

    it('leaves a plain visit untouched, with no filter params', () => {
      renderWithStore(
        <EntityDetail moduleId={4} moduleSlug="testruns" />,
        undefined,
        '/projects/1/workbench/testruns',
      );
      expect(screen.getByText(/select an item from the source panel/i)).toBeInTheDocument();
    });
  });
});
