import React from 'react';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import Workbench from '../Workbench';
import MainLayout from '../../Components/Layout/MainLayout';
import { useTreeChildren } from '../../Hooks/queries/useTreeChildren';

// WP-078 Part A — Task 2: "the workbench is currently a dead end"
// (Workbench.tsx rendered directly by App.tsx's route with no MainLayout,
// so there was no way out to Home/Projects/Reports/Settings). App.tsx now
// wraps that one route in <MainLayout fillHeight><Workbench /></MainLayout>
// (Workbench.tsx itself is untouched -- Workbench.test.tsx and
// Workbench.a11y.test.tsx still mount it bare, on purpose, so this is the
// one place that proves the two compose correctly). This file mirrors that
// exact composition rather than App.tsx's full route table (which mocks
// Workbench away in appRouting.test.tsx) -- it is the only place the REAL
// chrome and the REAL workbench regions are asserted present together.
jest.mock('../../Hooks/queries/useTreeChildren');

const ROUTE_PATH = '/projects/:projectId/workbench/:module/:entityId?';

function renderWithChrome(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <DndProvider backend={HTML5Backend}>
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path={ROUTE_PATH} element={<MainLayout fillHeight><Workbench /></MainLayout>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </DndProvider>,
  );
}

beforeEach(() => {
  (useTreeChildren as jest.Mock).mockReturnValue({
    data: [],
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
  });
});

describe('Workbench route composed with the app chrome (WP-078 Part A)', () => {
  it('renders the drawer (Home/Projects/Reports/Settings) AND the workbench regions together', () => {
    renderWithChrome('/projects/1/workbench/testcases');

    // The chrome: MainDrawer's retained nav links, per WP-078's drawer/rail
    // split -- proves the workbench is no longer a dead end. 'Releases'
    // dropped off this list along with its own drawer entry (WP-F18b Task
    // 4 -- MainDrawer.tsx) once Pages/releases.tsx was retired.
    ['Home', 'Projects', 'Reports', 'Settings'].forEach((label) => {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    });

    // The workbench itself, unchanged: tab strip, module rail, source panel,
    // detail region all still mount exactly as Workbench.test.tsx expects.
    expect(screen.getByTestId('workbench-tab-strip')).toBeInTheDocument();
    expect(screen.getByTestId('workbench-module-rail')).toBeInTheDocument();
    expect(screen.getByTestId('workbench-source-panel')).toBeInTheDocument();
    expect(screen.getByTestId('workbench-detail')).toBeInTheDocument();
  });
});
