import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { WorkbenchStoreProvider, useWorkbench } from '../../WorkbenchStoreProvider';
import { makeDraftEntityId } from '../../store/workbenchStore';
import TestCaseDetail from '../modules/TestCaseDetail';
import * as api from '../../../api/apiCalls';

jest.mock('../../../api/apiCalls');

// WP-079 regression guard. FieldGrid's controls only call onFieldCommit on
// BLUR. A user who typed a value and clicked Create straight away -- without
// moving focus first -- had that field dropped, so the backend either
// rejected the record for a missing mandatory field or saved it incomplete.
// The E2E spec originally hid this by clicking another field before Create.
// Draft mode now writes through on change, so no blur is required.
const draftId = makeDraftEntityId();

function Harness() {
  const openTab = useWorkbench((s) => s.openTab);
  React.useEffect(() => {
    openTab({ module: 1, entityId: draftId, title: 'New Test Case' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <TestCaseDetail entityId={draftId} />;
}

describe('draft creation without blurring the last edited field', () => {
  beforeEach(() => {
    localStorage.clear();
    (api.getFields as jest.Mock).mockResolvedValue([
      { fieldName: 'TestScenario', displayName: 'Scenario', fieldType: 'Text', isDisplayed: true, isMandatory: true, isDefault: true },
    ]);
    (api.saveTestCase as jest.Mock).mockResolvedValue({ TestCaseId: 'TC-900', id: 900 });
  });

  it('sends a value typed into a field that was never blurred', async () => {
    render(
      <MemoryRouter initialEntries={['/projects/1/workbench/testcases']}>
        <DndProvider backend={HTML5Backend}>
          <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <WorkbenchStoreProvider projectId={1}>
              <Harness />
            </WorkbenchStoreProvider>
          </QueryClientProvider>
        </DndProvider>
      </MemoryRouter>,
    );

    const scenario = await screen.findByLabelText(/Scenario/i);
    // Type, then go STRAIGHT to Create -- no blur, no clicking elsewhere.
    fireEvent.change(scenario, { target: { value: 'typed but never blurred' } });
    fireEvent.click(screen.getByRole('button', { name: /create/i }));

    await waitFor(() => expect(api.saveTestCase).toHaveBeenCalled());
    const payload = (api.saveTestCase as jest.Mock).mock.calls[0][0];
    expect(JSON.stringify(payload)).toContain('typed but never blurred');
  });
});
