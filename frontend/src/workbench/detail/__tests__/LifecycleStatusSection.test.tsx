import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { qk } from '../../../Hooks/queryKeys';
import { LifecycleStatusSection } from '../LifecycleStatusSection';
import { updateTestCaseStatus, updateRequirementStatus } from '../../../api/apiCalls';

// WP-074e Part 1a -- Components/governance/LifecycleStatus.tsx (Sprint 2.1
// governance) was rendered by TabContent.tsx:637-650 for modules 1 AND 2,
// but the workbench's TestCaseDetail (WP-074) never ported it, making it
// unreachable once Pages/testcases.tsx was deleted. This kit wrapper is
// what makes it reachable again from BOTH modules, and is the piece that
// enforces this sub-project's central rule: a status change goes through
// React Query cache (qk.entity), never a useState copy of server data.
jest.mock('../../../api/apiCalls', () => ({
  updateTestCaseStatus: jest.fn(),
  getTestCaseVersions: jest.fn(),
  updateRequirementStatus: jest.fn(),
  getRequirementVersions: jest.fn(),
}));

const mockUpdateTestCaseStatus = updateTestCaseStatus as jest.Mock;
const mockUpdateRequirementStatus = updateRequirementStatus as jest.Mock;

function renderSection(overrides: Partial<React.ComponentProps<typeof LifecycleStatusSection>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Seed the entity cache the way TestCaseDetail/RequirementDetail's own
  // entityQuery would -- this section must react through THAT cache entry,
  // not a state variable of its own.
  client.setQueryData(qk.entity(1, 1, 'TC-1'), { _id: 'abc123', TestCaseId: 'TC-1', status: 'draft' });

  render(
    <QueryClientProvider client={client}>
      <LifecycleStatusSection
        projectId={1}
        module={1}
        entityId="TC-1"
        mongoId="abc123"
        entityIdLabel="TC-1"
        status="draft"
        entityType="testcase"
        onError={jest.fn()}
        {...overrides}
      />
    </QueryClientProvider>,
  );
  return { client };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('LifecycleStatusSection', () => {
  it('renders the underlying LifecycleStatus control with the given status', () => {
    renderSection();
    expect(screen.getByText('draft')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /change status/i })).toBeInTheDocument();
  });

  it('a status change patches the qk.entity cache and invalidates it, not local state', async () => {
    mockUpdateTestCaseStatus.mockResolvedValue({ data: { status: 'review' } });
    const { client } = renderSection();

    fireEvent.click(screen.getByRole('button', { name: /change status/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'review' }));

    await waitFor(() => {
      expect(client.getQueryData(qk.entity(1, 1, 'TC-1'))).toMatchObject({ status: 'review' });
    });
    expect(mockUpdateTestCaseStatus).toHaveBeenCalledWith('abc123', 'review');
  });

  it('uses the requirement status API for entityType requirement', async () => {
    mockUpdateRequirementStatus.mockResolvedValue({ data: { status: 'approved' } });
    renderSection({
      module: 2,
      entityId: 'Req-1',
      mongoId: 'req-mongo-1',
      entityType: 'requirement',
    });

    fireEvent.click(screen.getByRole('button', { name: /change status/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'approved' }));

    await waitFor(() => {
      expect(mockUpdateRequirementStatus).toHaveBeenCalledWith('req-mongo-1', 'approved');
    });
    expect(mockUpdateTestCaseStatus).not.toHaveBeenCalled();
  });
});
