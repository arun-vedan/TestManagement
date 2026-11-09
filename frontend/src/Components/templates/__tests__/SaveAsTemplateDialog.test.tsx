import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SaveAsTemplateDialog } from '../SaveAsTemplateDialog';
import { createCaseTemplate } from '../../../api/caseTemplateApi';

// WP-F08 Task 2 -- "Save as template" captures the CURRENT record's
// fields (R1: the same flattened shape useCloneEntity builds) as a named,
// stored prefill. This suite proves the capture directly against the
// dialog, independent of which of the four detail components opened it
// (each hands it its own already-loaded `record`, per that module's own
// shape -- see TestCaseDetail.tsx/RequirementDetail.tsx/etc.'s own
// wiring).
jest.mock('../../../api/caseTemplateApi', () => ({
  createCaseTemplate: jest.fn(),
}));

const mockCreateCaseTemplate = createCaseTemplate as jest.Mock;

function renderDialog(record: Record<string, unknown>, open = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = jest.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <SaveAsTemplateDialog projectId={1} module={1} open={open} onClose={onClose} record={record} />
    </QueryClientProvider>,
  );
  return { ...view, onClose };
}

// A parameterised test case's full shape -- the exact one
// useCloneEntity.ts's flatten() and this dialog's own buildEntityPrefill
// call both read, INCLUDING `datasetId`, the exact field the clone path
// silently dropped once (WP-F07a Task 5's regression, guarded on the
// consuming side by TestCaseDetail.parameterised.test.tsx).
const PARAMETERISED_TEST_CASE = {
  _id: 'abc123',
  TestCaseId: 'TC-1',
  TestCaseSummary: 'Login should work',
  TestSteps: [{ testStep: 'Log in as {{role}}', Expected: 'Dashboard for {{role}}' }],
  datasetId: 'ds1',
  dynamicFields: { Priority: 'High' },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateCaseTemplate.mockResolvedValue({ _id: 'ct1', CaseTemplateId: 'CT-1' });
});

describe('SaveAsTemplateDialog', () => {
  it('captures the current record\'s fields into the template prefill on Save', async () => {
    renderDialog(PARAMETERISED_TEST_CASE);

    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'Regression — login' } });
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Standard login regression' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockCreateCaseTemplate).toHaveBeenCalledTimes(1));
    const payload = mockCreateCaseTemplate.mock.calls[0][0];

    expect(payload.moduleId).toBe(1);
    expect(payload.name).toBe('Regression — login');
    expect(payload.description).toBe('Standard login regression');
    // The single-line break this catches: passing an empty object (or
    // only `{ TestCaseSummary }`) instead of the full flattened record to
    // buildEntityPrefill makes every assertion below fail.
    expect(payload.prefill.TestCaseSummary).toBe('Login should work');
    expect(payload.prefill.TestSteps).toEqual(PARAMETERISED_TEST_CASE.TestSteps);
    expect(payload.prefill.Priority).toBe('High');
  });

  // Test #4 (task brief) -- the exact regression the clone path had once
  // (WP-F07a Task 5): asserted here on the CAPTURE side, not just the
  // consuming side TestCaseDetail.parameterised.test.tsx already covers.
  it('carries datasetId into the prefill when saving a template from a parameterised test case', async () => {
    renderDialog(PARAMETERISED_TEST_CASE);

    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'Parameterised login' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(mockCreateCaseTemplate).toHaveBeenCalledTimes(1));
    const payload = mockCreateCaseTemplate.mock.calls[0][0];
    // The single-line break this catches: adding a `delete prefill.datasetId`
    // to entityPrefill.ts's module-1 branch (the same kind of line case 5
    // uses, deliberately, to strip `attachment`) makes this fail.
    expect(payload.prefill.datasetId).toBe('ds1');
  });

  it('does not call createCaseTemplate when the name is blank', () => {
    renderDialog(PARAMETERISED_TEST_CASE);
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    expect(mockCreateCaseTemplate).not.toHaveBeenCalled();
    expect(screen.getByText(/name is required/i)).toBeInTheDocument();
  });

  it('surfaces the server error message and does not close on a failed save', async () => {
    mockCreateCaseTemplate.mockRejectedValueOnce({ response: { data: { error: 'moduleId must be one of 1, 2, 3, 5' } } });
    const { onClose } = renderDialog(PARAMETERISED_TEST_CASE);

    fireEvent.change(screen.getByLabelText('Template name'), { target: { value: 'Bad module' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    expect(await screen.findByText('moduleId must be one of 1, 2, 3, 5')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes without saving when Cancel is clicked', () => {
    const { onClose } = renderDialog(PARAMETERISED_TEST_CASE);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mockCreateCaseTemplate).not.toHaveBeenCalled();
  });
});
