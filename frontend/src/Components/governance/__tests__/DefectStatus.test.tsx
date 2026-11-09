import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { getIssueStatuses } from '../../../api/defectStatusApi';
import { DefectStatus } from '../DefectStatus';

// Mocked because DefectStatus.tsx pulls in ../../api/defectStatusApi, which
// transitively reaches api/axios and therefore src/keycloak.js -- leaving
// it unmocked would put this suite among the 35 that fail to run (per
// WP-F04's task brief), the same reason DefectFilterPanel's own tests (if
// any existed) would need it.
jest.mock('../../../api/defectStatusApi', () => ({
    getIssueStatuses: jest.fn(),
    updateDefectStatus: jest.fn(),
}));

const mockGet = getIssueStatuses as jest.Mock;

// A small, self-consistent slice of the real graph -- not the full
// New/Open/Fixed/Rejected/Deffered/Retest/Re-open/Closed vocabulary, just
// enough that "Open" (id 2) has both a valid predecessor (New) and a valid
// next status (Closed), so the "control stays usable" assertion exercises
// a real non-empty `validNextStatuses`, not an accidentally-empty one.
const STATUSES = [
    { id: 1, istatus: 'New', parentId: [] as number[] },
    { id: 2, istatus: 'Open', parentId: [1] },
    { id: 8, istatus: 'Closed', parentId: [2] },
];

beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue(STATUSES);
});

// WP-F04 -- three real defects stored `Status` as an istatusservice id
// rather than a name. This resolver matched on name only, so those
// rendered a raw number with the control disabled.
// DefectFilterPanel.tsx's resolveStatusName already resolves id-then-name;
// this brings the two in line so the class cannot recur from a restore or
// an import.
it('resolves a numeric status id (string shape) to its name', async () => {
    render(<DefectStatus defectId="Bug-3" status={'2' as string} onStatusChanged={jest.fn()} onError={jest.fn()} />);
    expect(await screen.findByText('Open')).toBeInTheDocument();
    expect(screen.queryByText('2')).not.toBeInTheDocument();
});

it('resolves a numeric status stored as a JS number, not just a string', async () => {
    // Bug-2 and Bug-3 stored numbers; Bug-1 stored a string. Both shapes
    // exist in real data.
    render(<DefectStatus defectId="Bug-2" status={1 as unknown as string} onStatusChanged={jest.fn()} onError={jest.fn()} />);
    expect(await screen.findByText('New')).toBeInTheDocument();
});

it('still resolves a status stored as a name', async () => {
    render(<DefectStatus defectId="Bug-9" status="Closed" onStatusChanged={jest.fn()} onError={jest.fn()} />);
    expect(await screen.findByText('Closed')).toBeInTheDocument();
});

it('leaves the control usable for a legacy-code defect', async () => {
    // The reported symptom was not only the raw number -- the control was
    // disabled too, because nothing resolved (unrecognizedStatus == true).
    render(<DefectStatus defectId="Bug-3" status={'2' as string} onStatusChanged={jest.fn()} onError={jest.fn()} />);
    await screen.findByText('Open');
    await waitFor(() => expect(screen.getByRole('button', { name: /change status/i })).not.toBeDisabled());
});

// A defect created from the workbench draft flow is saved with no Status at
// all (the draft can't run the workflow before the record exists). The
// real istatusservice graph marks its start state with parentId [0] --
// "reachable from nothing" -- so an empty status must offer that state
// instead of leaving the control permanently disabled.
it('offers the workflow start state for a defect with no status yet', async () => {
    mockGet.mockResolvedValue([
        { id: 1, istatus: 'New', parentId: [0] },
        { id: 2, istatus: 'Open', parentId: [1] },
    ]);
    render(<DefectStatus defectId="Bug-1252" status="" onStatusChanged={jest.fn()} onError={jest.fn()} />);
    const button = await screen.findByRole('button', { name: /change status/i });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    expect(await screen.findByRole('menuitem', { name: 'New' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Open' })).not.toBeInTheDocument();
});
