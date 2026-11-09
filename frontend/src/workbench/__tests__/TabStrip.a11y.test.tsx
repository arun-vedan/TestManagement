import React from 'react';
import { render, act } from '@testing-library/react';
import { axe } from 'jest-axe';
import { WorkbenchStoreProvider, useWorkbench } from '../WorkbenchStoreProvider';
import TabStrip from '../TabStrip';
import { WorkbenchState } from '../store/workbenchStore';

let openTab: WorkbenchState['openTab'];
let setTabDirty: WorkbenchState['setTabDirty'];

function Harness() {
  openTab = useWorkbench((s) => s.openTab);
  setTabDirty = useWorkbench((s) => s.setTabDirty);
  return <TabStrip />;
}

describe('TabStrip accessibility', () => {
  it('has no axe violations with several open tabs, including a dirty one', async () => {
    const { container } = render(
      <WorkbenchStoreProvider projectId={1}>
        <Harness />
      </WorkbenchStoreProvider>,
    );
    act(() => {
      openTab({ module: 1, entityId: 'TC-104', title: 'Login' });
      openTab({ module: 2, entityId: 'REQ-8', title: 'Auth' });
      openTab({ module: 5, entityId: 'DEF-3', title: 'Crash on save' });
      setTabDirty('1:TC-104', true);
    });

    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no axe violations with zero open tabs', async () => {
    const { container } = render(
      <WorkbenchStoreProvider projectId={1}>
        <Harness />
      </WorkbenchStoreProvider>,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
