import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { getTestCaseVersions } from '../../../api/apiCalls';
import { LifecycleStatus } from '../LifecycleStatus';

jest.mock('../../../api/apiCalls', () => ({
    getTestCaseVersions: jest.fn(),
    getRequirementVersions: jest.fn(),
    updateTestCaseStatus: jest.fn(),
    updateRequirementStatus: jest.fn(),
}));

const mockGetVersions = getTestCaseVersions as jest.Mock;

function renderLifecycle() {
    return render(
        <LifecycleStatus
            entityId="mongo-1"
            entityIdLabel="TC-1"
            status="approved"
            entityType="testcase"
            onStatusChanged={jest.fn()}
            onError={jest.fn()}
        />,
    );
}

beforeEach(() => {
    jest.clearAllMocks();
});

// WP-F02 -- the dialog already listed "Version N" + a timestamp. What it
// never showed was what the version CONTAINED, which is the half an
// auditor needs: on the seeded TC-1 the step count drops from 3 to 1 at
// v4 and nothing in the UI could show it.
it('shows a version\'s summary and step count once it is expanded', async () => {
    mockGetVersions.mockResolvedValue([
        { _id: 'b', version: 4, createdAt: '2026-03-04T10:00:00.000Z', snapshot: { TestCaseSummary: 'test req2', status: 'approved', TestSteps: [{ testStep: 'only one' }] } },
        { _id: 'a', version: 1, createdAt: '2026-03-01T10:00:00.000Z', snapshot: { TestCaseSummary: 'test req2', status: 'approved', TestSteps: [{ testStep: 'a' }, { testStep: 'b' }, { testStep: 'c' }] } },
    ]);
    renderLifecycle();
    fireEvent.click(screen.getByRole('button', { name: /history/i }));

    const v4 = await screen.findByRole('button', { name: /Version 4/ });
    // Content is behind the expander, exactly as the version rows were before.
    expect(screen.queryByText('3 steps')).not.toBeInTheDocument();

    fireEvent.click(v4);
    expect(await screen.findByText('1 step')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Version 1/ }));
    expect(await screen.findByText('3 steps')).toBeInTheDocument();
});

it('never renders the raw updatedBy UUID', async () => {
    // updatedBy is a Keycloak subject id, not a name -- the same trap
    // assignedTo hit in WP-F01. Showing it would be a readability
    // regression, not a feature.
    mockGetVersions.mockResolvedValue([
        { _id: 'a', version: 2, createdAt: '2026-03-01T10:00:00.000Z', snapshot: { TestCaseSummary: 'shown', updatedBy: 'c16a3041-919f-482f-a027-0b18060aa536' } },
    ]);
    renderLifecycle();
    fireEvent.click(screen.getByRole('button', { name: /history/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Version 2/ }));

    expect(await screen.findByText('shown')).toBeInTheDocument();
    expect(screen.queryByText(/c16a3041/)).not.toBeInTheDocument();
});

it('never renders Mongo plumbing from the snapshot', async () => {
    mockGetVersions.mockResolvedValue([
        { _id: 'a', version: 2, createdAt: '2026-03-01T10:00:00.000Z', snapshot: { TestCaseSummary: 'shown', __v: 7, parentId: 42, _id: 'inner-id', dynamicFields: { x: 1 } } },
    ]);
    renderLifecycle();
    fireEvent.click(screen.getByRole('button', { name: /history/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Version 2/ }));

    expect(await screen.findByText('shown')).toBeInTheDocument();
    expect(screen.queryByText('inner-id')).not.toBeInTheDocument();
    expect(screen.queryByText('42')).not.toBeInTheDocument();
});

it('still shows the empty state when there is no history', async () => {
    mockGetVersions.mockResolvedValue([]);
    renderLifecycle();
    fireEvent.click(screen.getByRole('button', { name: /history/i }));
    expect(await screen.findByText(/no prior versions/i)).toBeInTheDocument();
});

it('works for a requirement, using its own summary field', async () => {
    const { getRequirementVersions } = jest.requireMock('../../../api/apiCalls');
    (getRequirementVersions as jest.Mock).mockResolvedValue([
        { _id: 'r', version: 3, createdAt: '2026-03-01T10:00:00.000Z', snapshot: { requirementSummary: 'the requirement text' } },
    ]);
    render(
        <LifecycleStatus entityId="mongo-2" entityIdLabel="Req-5" status="approved" entityType="requirement" onStatusChanged={jest.fn()} onError={jest.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /history/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Version 3/ }));
    expect(await screen.findByText('the requirement text')).toBeInTheDocument();
});
