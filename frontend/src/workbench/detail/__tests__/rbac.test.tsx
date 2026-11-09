import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { WorkbenchStoreProvider } from '../../WorkbenchStoreProvider';
import TestCaseDetail from '../modules/TestCaseDetail';
import * as api from '../../../api/apiCalls';

jest.mock('../../../api/apiCalls');

// WP-077 RBAC regression guard.
//
// The legacy page gated its Edit affordance on can('write')
// (TabContent.tsx:631). Per-field inline edit removed that single button and
// nothing replaced it, so from WP-074 onward a read-only user was shown a
// fully editable form whose writes the backend then rejected
// (authorize('write') is mounted on every write route). Not a data hole --
// a broken, misleading experience, and a regression from the RBAC model
// WP-022 established.
// Prefixed "mock" deliberately: jest hoists jest.mock() factories above
// this file's other declarations and refuses out-of-scope references
// unless the name starts with "mock" -- the same trap appRouting.test.tsx
// documents.
let mockCanWrite = true;
jest.mock('../../../Hooks/usePermissions', () => ({
  __esModule: true,
  usePermissions: () => ({ can: () => mockCanWrite, role: 'viewer', isLoading: false, isError: false }),
  default: () => ({ can: () => mockCanWrite, role: 'viewer', isLoading: false, isError: false }),
}));

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/projects/1/workbench/testcases']}>
      <DndProvider backend={HTML5Backend}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <WorkbenchStoreProvider projectId={1}>
            <TestCaseDetail entityId="TC-1" />
          </WorkbenchStoreProvider>
        </QueryClientProvider>
      </DndProvider>
    </MemoryRouter>,
  );
}

describe('detail views respect write permission', () => {
  beforeEach(() => {
    localStorage.clear();
    (api.getFields as jest.Mock).mockResolvedValue([
      { fieldName: 'TestScenario', displayName: 'Scenario', fieldType: 'Text', isDisplayed: true, isMandatory: false, isDefault: true },
    ]);
    (api.getTcList as jest.Mock).mockResolvedValue([
      { TestCaseId: 'TC-1', _id: 'm1', TestCaseSummary: 'Login', TestScenario: 'happy path', status: 'draft' },
    ]);
  });

  it('a contributor can edit a field', async () => {
    mockCanWrite = true;
    renderDetail();
    const field = await screen.findByLabelText(/Scenario/i);
    await waitFor(() => expect(field).not.toBeDisabled());
  });

  it('a viewer gets the same field read-only, not an editable control', async () => {
    mockCanWrite = false;
    renderDetail();
    const field = await screen.findByLabelText(/Scenario/i);
    await waitFor(() => expect(field).toBeDisabled());
  });
});
