import React from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { WorkbenchStoreProvider, useWorkbench } from '../WorkbenchStoreProvider';
import TabStrip from '../TabStrip';
import { WorkbenchState } from '../store/workbenchStore';

// Exposes the store's actions to the test via a harness component, so
// tests can seed tab state through the SAME actions the real UI uses
// (openTab/closeTab/activateTab/setTabDirty) instead of poking at
// internals.
let actions: Pick<WorkbenchState, 'openTab' | 'closeTab' | 'activateTab' | 'setTabDirty'>;

function Harness() {
  // Each selector picked individually -- store action references are
  // stable across renders, but bundling them into a fresh object literal
  // every render (as one selector) makes useSyncExternalStore see a "new"
  // snapshot every time and loop forever.
  const openTab = useWorkbench((s) => s.openTab);
  const closeTab = useWorkbench((s) => s.closeTab);
  const activateTab = useWorkbench((s) => s.activateTab);
  const setTabDirty = useWorkbench((s) => s.setTabDirty);
  actions = { openTab, closeTab, activateTab, setTabDirty };
  return <TabStrip />;
}

function renderTabStrip() {
  return render(
    <WorkbenchStoreProvider projectId={1}>
      <Harness />
    </WorkbenchStoreProvider>,
  );
}

describe('TabStrip', () => {
  it('renders one tab per store tab', () => {
    renderTabStrip();
    act(() => {
      actions.openTab({ module: 1, entityId: 'TC-104', title: 'Login' });
      actions.openTab({ module: 2, entityId: 'REQ-8', title: 'Auth' });
    });
    expect(screen.getAllByRole('tab')).toHaveLength(2);
  });

  it('the per-tab close affordance removes that tab', () => {
    renderTabStrip();
    act(() => {
      actions.openTab({ module: 1, entityId: 'TC-104', title: 'Login' });
      actions.openTab({ module: 1, entityId: 'TC-200', title: 'Signup' });
    });
    expect(screen.getAllByRole('tab')).toHaveLength(2);

      fireEvent.click(screen.getByTestId('tab-close-1:TC-104'));

    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(screen.queryByRole('tab', { name: /Login/ })).not.toBeInTheDocument();
  });

  it('closing a tab uses the store closeTab neighbour logic, not ad hoc component state', () => {
    renderTabStrip();
    act(() => {
      actions.openTab({ module: 1, entityId: 'A', title: 'A' });
      actions.openTab({ module: 1, entityId: 'B', title: 'B' });
      actions.openTab({ module: 1, entityId: 'C', title: 'C' });
      actions.activateTab('1:B');
    });
    expect(screen.getByRole('tab', { name: 'B' })).toHaveAttribute('aria-selected', 'true');

      fireEvent.click(screen.getByTestId('tab-close-1:B'));

    // Nearest surviving neighbour (right, else left) per the store contract.
    expect(screen.getByRole('tab', { name: 'C' })).toHaveAttribute('aria-selected', 'true');
  });

  it('a dirty tab exposes an "unsaved changes" marker in its accessible name', () => {
    renderTabStrip();
    act(() => {
      actions.openTab({ module: 1, entityId: 'TC-104', title: 'Login' });
      actions.setTabDirty('1:TC-104', true);
    });
    expect(screen.getByRole('tab', { name: /Login/i })).toHaveAccessibleName(/unsaved/i);
  });

  it('a clean tab has no "unsaved" marker in its accessible name', () => {
    renderTabStrip();
    act(() => {
      actions.openTab({ module: 1, entityId: 'TC-104', title: 'Login' });
    });
    expect(screen.getByRole('tab', { name: /Login/i })).not.toHaveAccessibleName(/unsaved/i);
  });

  it('aria-selected tracks the active tab', () => {
    renderTabStrip();
    act(() => {
      actions.openTab({ module: 1, entityId: 'TC-104', title: 'Login' });
      actions.openTab({ module: 2, entityId: 'REQ-8', title: 'Auth' });
    });
    // openTab activates whichever tab it just opened -- Auth (opened
    // second) is active, not Login.
    expect(screen.getByRole('tab', { name: /Login/ })).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByRole('tab', { name: /Auth/ })).toHaveAttribute('aria-selected', 'true');

    act(() => {
      actions.activateTab('1:TC-104');
    });
    expect(screen.getByRole('tab', { name: /Login/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Auth/ })).toHaveAttribute('aria-selected', 'false');
  });

  it('tabs from different modules render together, each with its own module icon', () => {
    renderTabStrip();
    act(() => {
      actions.openTab({ module: 1, entityId: 'TC-104', title: 'Login' });
      actions.openTab({ module: 5, entityId: 'DEF-3', title: 'Crash on save' });
    });
    expect(screen.getByTestId('tab-icon-1:TC-104')).toBeInTheDocument();
    expect(screen.getByTestId('tab-icon-5:DEF-3')).toBeInTheDocument();
  });

  // WP-073 review fix. The close "x" is a non-interactive aria-hidden span
  // (a real <button> inside role="tab" trips axe's nested-interactive), so
  // Delete/Backspace on the focused tab is the ONLY keyboard path to close
  // one. If this test goes, keyboard users lose the ability entirely.
  it('Delete on the focused tab closes it', () => {
    renderTabStrip();
    act(() => {
      actions.openTab({ module: 1, entityId: 'A', title: 'A' });
      actions.openTab({ module: 1, entityId: 'B', title: 'B' });
    });

      fireEvent.keyDown(screen.getByRole('tab', { name: 'B' }), { key: 'Delete' });

    expect(screen.queryByRole('tab', { name: 'B' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'A' })).toBeInTheDocument();
  });

  it('Backspace on the focused tab closes it too', () => {
    renderTabStrip();
    act(() => {
      actions.openTab({ module: 1, entityId: 'A', title: 'A' });
      actions.openTab({ module: 1, entityId: 'B', title: 'B' });
    });

      fireEvent.keyDown(screen.getByRole('tab', { name: 'A' }), { key: 'Backspace' });

    expect(screen.queryByRole('tab', { name: 'A' })).not.toBeInTheDocument();
  });

  it('clicking the close affordance does not also activate the tab it closed', () => {
    renderTabStrip();
    act(() => {
      actions.openTab({ module: 1, entityId: 'A', title: 'A' });
      actions.openTab({ module: 1, entityId: 'B', title: 'B' });
      actions.activateTab('1:B');
    });

      fireEvent.click(screen.getByTestId('tab-close-1:A'));

    // A is gone and B stayed active -- the click never reached A's <Tab>.
    expect(screen.queryByRole('tab', { name: 'A' })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'B' })).toHaveAttribute('aria-selected', 'true');
  });

  it('the close affordance is hidden from assistive tech, so it cannot pollute the tab name', () => {
    renderTabStrip();
    act(() => {
      actions.openTab({ module: 1, entityId: 'TC-104', title: 'Login' });
    });
    expect(screen.getByTestId('tab-close-1:TC-104')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('tab', { name: 'Login' })).toHaveAccessibleName('Login');
  });
});
