import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { axe } from 'jest-axe';
import Workbench from '../Workbench';
import { expectNoUnexpectedAxeViolations } from '../../testUtils/a11y';
import { useTreeChildren } from '../../Hooks/queries/useTreeChildren';

// WP-074 Step 8 — ported from the deleted Pages/__tests__/testcases.a11y.test.tsx
// ("Pages/testcases.tsx (WP-046) — the test repo list target page,
// composed"), now that Pages/testcases.tsx itself is retired in favour of
// the workbench. That test's whole point (see its own now-deleted header
// comment, carried forward here) was a COMPOSITION-level check: neither the
// tree's own a11y suite (EntityTree.a11y.test.tsx) nor any single region's
// own suite catches a violation that only exists once real sections are
// mounted side by side (its own motivating example: a heading-order
// violation that only existed once the page's real sections were
// composed). The equivalent composition in the workbench is this shell --
// TabStrip + ModuleRail + SourcePanel (tree, module 1's default panel
// mode) + the detail region -- all mounted together, exactly as a real
// deep link to /projects/:id/workbench/testcases renders it.
//
// Tree data is mocked (useTreeChildren), same as Workbench.test.tsx and
// EntityTree.a11y.test.tsx -- this suite must not hit the network any more
// than those do. `expectNoUnexpectedAxeViolations` (rather than jest-axe's
// own `toHaveNoViolations`) is carried forward from the deleted test too:
// it accepts the one documented, pre-existing @mui/x-data-grid footer
// exception (see testUtils/a11y.ts's header comment) should a DataGrid ever
// end up composed into this same shell render (e.g. list panel mode) --
// harmless here since tree mode renders no DataGrid at all, but keeping the
// same helper means this test doesn't have to change if that composition
// grows to include one later.

jest.mock('../../Hooks/queries/useTreeChildren');

const ROUTE_PATH = '/projects/:projectId/workbench/:module/:entityId?';

// WP-077b -- see Workbench.test.tsx's matching comment: EntityTree's nodes
// now need a <DndProvider> ancestor.
function renderWorkbenchAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <DndProvider backend={HTML5Backend}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path={ROUTE_PATH} element={<Workbench />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </DndProvider>,
  );
}

beforeEach(() => {
  // Populated root, not empty -- the deleted test mounted its tree with a
  // real fetched test case ("Login works") visible, not a bare/empty tree.
  (useTreeChildren as jest.Mock).mockReturnValue({
    data: [
      { id: '8', parent: '0', droppable: true, text: 'Auth' },
      { id: 'TC-104', parent: '0', droppable: false, text: 'Login works' },
    ],
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  });
});

describe('Workbench shell (WP-046, ported) — module 1, composed', () => {
  it('is axe clean (beyond the documented DataGrid exception) with the tab strip, rail, and populated tree all mounted together', async () => {
    const { container } = renderWorkbenchAt('/projects/1/workbench/testcases');
    await screen.findByText('Login works');
    expectNoUnexpectedAxeViolations(await axe(container));
  });
});
