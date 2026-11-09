import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { useTheme } from '@mui/material';
import Workbench from '../Workbench';
import { MODULE_LABELS } from '../modules';
import { useTreeChildren } from '../../Hooks/queries/useTreeChildren';

// WP-073 — SourcePanel now renders the real <EntityTree>, which needs a
// QueryClient in context (App.tsx provides one in production; this file
// renders <Workbench> standalone) and must not hit the network. Mocked the
// same way EntityTree's own tests mock it -- deterministic, empty result,
// so these shell-level tests aren't asserting anything about tree content.
jest.mock('../../Hooks/queries/useTreeChildren');

const ROUTE_PATH = '/projects/:projectId/workbench/:module/:entityId?';

// WP-077b -- EntityTree's nodes now call react-dnd's useDrag/useDrop
// unconditionally, which throws without a <DndProvider> ancestor. App.tsx
// provides one in production; this file renders <Workbench> standalone, so
// it needs its own (same real HTML5Backend App.tsx will use post-WP-078).
function renderWithProviders(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <DndProvider backend={HTML5Backend}>
      <QueryClientProvider client={client}>{ui}</QueryClientProvider>
    </DndProvider>,
  );
}

function renderWorkbenchAt(path: string) {
  return renderWithProviders(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={ROUTE_PATH} element={<Workbench />} />
      </Routes>
    </MemoryRouter>,
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

describe('Workbench shell', () => {
  it('renders all six modules in the rail', () => {
    renderWorkbenchAt('/projects/1/workbench/testcases');

    Object.values(MODULE_LABELS).forEach((label) => {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    });
  });

  it('switching module does not unmount the tab strip', () => {
    renderWorkbenchAt('/projects/1/workbench/testcases');

    const tabStripBefore = screen.getByTestId('workbench-tab-strip');

    fireEvent.click(screen.getByRole('button', { name: MODULE_LABELS[2] })); // Requirements

    const tabStripAfter = screen.getByTestId('workbench-tab-strip');
    expect(tabStripAfter).toBe(tabStripBefore); // same DOM node, not merely "present again"
  });

  // WP-076 -- the rail shipped label-only in WP-072 and lost the per-module
  // iconography the legacy MainDrawer nav had; nothing caught it because the
  // accessible name (the label) was unchanged. Spotted by the owner in a
  // screenshot, so this pins it.
  it('shows a module icon for every rail entry', () => {
    renderWorkbenchAt('/projects/1/workbench/testcases');
    ([1, 2, 3, 4, 5, 6] as const).forEach((moduleId) => {
      expect(screen.getByTestId(`module-icon-${moduleId}`)).toBeInTheDocument();
    });
  });

  it('keeps the module label as the accessible name, so the icon is decorative', () => {
    renderWorkbenchAt('/projects/1/workbench/testcases');
    expect(screen.getByRole('button', { name: MODULE_LABELS[1] })).toHaveAccessibleName(MODULE_LABELS[1]);
  });

  it('marks the active module with aria-current="page"', () => {
    renderWorkbenchAt('/projects/1/workbench/testcases');
    expect(screen.getByRole('button', { name: MODULE_LABELS[1] })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: MODULE_LABELS[2] })).not.toHaveAttribute('aria-current');
  });

  it('an unknown module slug renders a not-found state, not a crash', () => {
    renderWorkbenchAt('/projects/1/workbench/bogus-module');

    const message = screen.getByRole('alert');
    expect(message).toHaveTextContent(/unknown module/i);
    expect(message).toHaveTextContent('bogus-module');
    // The rest of the shell keeps rendering -- this is a message, not a crash/redirect.
    expect(screen.getByTestId('workbench-module-rail')).toBeInTheDocument();
  });

  describe('a crashing detail region', () => {
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
      errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
      errorSpy.mockRestore();
    });

    it('leaves the rail and source panel mounted', () => {
      const ThrowingDetail = (): JSX.Element => {
        throw new Error('boom');
      };

      renderWithProviders(
        <MemoryRouter initialEntries={['/projects/1/workbench/testcases']}>
          <Routes>
            <Route path={ROUTE_PATH} element={<Workbench DetailComponent={ThrowingDetail} />} />
          </Routes>
        </MemoryRouter>,
      );

      // The detail region shows its own error fallback...
      expect(screen.getByRole('alert')).toHaveTextContent(/detail area/i);
      // ...while the rail and source panel, each in their own boundary, are untouched.
      expect(screen.getByTestId('workbench-module-rail')).toBeInTheDocument();
      expect(screen.getByTestId('workbench-source-panel')).toBeInTheDocument();
      Object.values(MODULE_LABELS).forEach((label) => {
        expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
      });
    });
  });

  // WP-073 review fix. App.tsx mounts no app-wide ThemeProvider, so before
  // this the whole workbench rendered under MUI's DEFAULT theme and none of
  // WP-070's tokens reached it. Asserted through the DetailComponent seam,
  // which sits at the bottom of the shell -- if the theme reaches there, it
  // reaches every region above it.
  it('renders under the app theme, so WP-070 tokens reach the workbench', () => {
    const themeValues: { fontSize?: number; spacing?: string; pass?: string; primary?: string } = {};
    function ThemeProbe(): JSX.Element {
      const t = useTheme();
      themeValues.fontSize = t.typography.fontSize;
      themeValues.spacing = t.spacing(2);
      themeValues.pass = t.palette.status?.pass;
      themeValues.primary = t.palette.primary.main;
      return <div data-testid="theme-probe" />;
    }

    renderWorkbenchAt('/projects/1/workbench/testcases');
    expect(screen.getByTestId('workbench-detail')).toBeInTheDocument();

    renderWithProviders(
      <MemoryRouter initialEntries={['/projects/1/workbench/testcases']}>
        <Routes>
          <Route path={ROUTE_PATH} element={<Workbench DetailComponent={ThemeProbe} />} />
        </Routes>
      </MemoryRouter>,
    );

    // MUI's defaults are fontSize 14 and spacing(2) === '16px'; the tokens
    // are 13 and 8px. Seeing the token values proves the custom theme, not
    // the default one, is in scope.
    expect(themeValues.fontSize).toBe(13);
    expect(themeValues.spacing).toBe('8px');
    expect(themeValues.pass).toBe('#2e7d32');
    expect(themeValues.primary).toBe('#084C32');
  });
});
