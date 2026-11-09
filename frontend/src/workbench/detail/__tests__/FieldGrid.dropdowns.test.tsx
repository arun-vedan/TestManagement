import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { FieldGrid, FieldDefinition } from '../FieldGrid';

// WP-077 Part A -- the real gap flagged by the dispatch: FieldGrid only knew
// Text/TextArea/Editor/DropDown, so module 5's `Status` (IssueDropDown) and
// `assignedTo` (UserDropDown) fields would have silently not rendered.
// DefectStatus and DynamicAutocomplete are mocked here to isolate FieldGrid's
// OWN wiring (which props they're given, whether the callback chain reaches
// onFieldChange/onFieldCommit) -- both already have their own test coverage
// elsewhere for their internal behaviour.
jest.mock('../../../Components/governance/DefectStatus', () => ({
  __esModule: true,
  DefectStatus: ({ status, defectId, onStatusChanged }: any) => (
    <div data-testid="defect-status">
      status={String(status)} defectId={String(defectId)}
      <button onClick={() => onStatusChanged('Fixed')}>advance</button>
    </div>
  ),
}));

jest.mock('../../../Components/Lists/dropDownList', () => ({
  __esModule: true,
  default: ({ moduleId, defectId, defecnId, userName, updateUser }: any) => (
    <div data-testid="user-dropdown">
      moduleId={String(moduleId)} defectId={String(defectId)} defecnId={String(defecnId)} userName={String(userName)}
      <button onClick={() => updateUser({ label: 'bob', value: 'user-2' })}>pick bob</button>
    </div>
  ),
}));

const DEFECT_FIELDS: FieldDefinition[] = [
  { fieldName: 'summary', displayName: 'Summary', fieldType: 'TextArea', isDisplayed: true, isMandatory: true, isDefault: true },
  { fieldName: 'Status', displayName: 'Status', fieldType: 'IssueDropDown', isDisplayed: true, isMandatory: false, isDefault: true },
  { fieldName: 'assignedTo', displayName: 'Assigned To', fieldType: 'UserDropDown', isDisplayed: true, isMandatory: false, isDefault: true },
];

// A module whose fields never use IssueDropDown/UserDropDown at all
// (mirrors TestCaseDetail's real field set) -- proves the two new branches
// are inert/absent rather than always mounting something.
const NON_DEFECT_FIELDS: FieldDefinition[] = [
  { fieldName: 'priority', displayName: 'Priority', fieldType: 'Text', isDisplayed: true, isMandatory: false, isDefault: false },
];

describe('FieldGrid -- IssueDropDown / UserDropDown (WP-077)', () => {
  it('renders an IssueDropDown field through the defect status control once the record is saved', () => {
    const onFieldCommit = jest.fn();
    const onFieldChange = jest.fn();
    render(
      <FieldGrid
        fields={DEFECT_FIELDS}
        values={{ _id: 'defect-mongo-1', Status: 'Open', assignedTo: 'alice' }}
        moduleId={5}
        entityId="DEF-1"
        onFieldChange={onFieldChange}
        onFieldCommit={onFieldCommit}
      />,
    );
    const control = screen.getByTestId('defect-status');
    expect(control).toHaveTextContent('status=Open');
    expect(control).toHaveTextContent('defectId=defect-mongo-1');

    fireEvent.click(screen.getByRole('button', { name: 'advance' }));
    expect(onFieldChange).toHaveBeenCalledWith('Status', 'Fixed');
    expect(onFieldCommit).toHaveBeenCalledWith('Status', 'Fixed');
  });

  it('shows a disabled "save the defect" placeholder for IssueDropDown when the record has no Mongo id yet', () => {
    render(
      <FieldGrid
        fields={DEFECT_FIELDS}
        values={{ Status: 'Open' }}
        moduleId={5}
        entityId="newDefect"
        onFieldCommit={jest.fn()}
      />,
    );
    expect(screen.queryByTestId('defect-status')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('Save the defect to set its status')).toBeInTheDocument();
  });

  it('renders status history entries when the record carries them', () => {
    render(
      <FieldGrid
        fields={DEFECT_FIELDS}
        values={{
          _id: 'defect-mongo-1',
          Status: 'Fixed',
          statusHistory: [
            { from: 'Open', to: 'Fixed', changedBy: 'alice' },
            { from: 'New', to: 'Open', changedBy: 'bob' },
          ],
        }}
        moduleId={5}
        entityId="DEF-1"
        onFieldCommit={jest.fn()}
      />,
    );
    const history = screen.getByRole('list', { name: /status history/i });
    expect(history).toHaveTextContent('Open → Fixed');
    expect(history).toHaveTextContent('by alice');
    expect(history).toHaveTextContent('New → Open');
    expect(history).toHaveTextContent('by bob');
  });

  it('renders no status history list when the record has none', () => {
    render(
      <FieldGrid
        fields={DEFECT_FIELDS}
        values={{ _id: 'defect-mongo-1', Status: 'Open' }}
        moduleId={5}
        entityId="DEF-1"
        onFieldCommit={jest.fn()}
      />,
    );
    expect(screen.queryByRole('list', { name: /status history/i })).not.toBeInTheDocument();
  });

  it('renders a UserDropDown field through the user picker and routes the selected label through onFieldChange/onFieldCommit', () => {
    const onFieldCommit = jest.fn();
    const onFieldChange = jest.fn();
    render(
      <FieldGrid
        fields={DEFECT_FIELDS}
        values={{ _id: 'defect-mongo-1', assignedTo: 'alice' }}
        moduleId={5}
        entityId="DEF-1"
        onFieldChange={onFieldChange}
        onFieldCommit={onFieldCommit}
      />,
    );
    const control = screen.getByTestId('user-dropdown');
    expect(control).toHaveTextContent('moduleId=5');
    expect(control).toHaveTextContent('defectId=defect-mongo-1');
    expect(control).toHaveTextContent('defecnId=DEF-1');
    expect(control).toHaveTextContent('userName=alice');

    fireEvent.click(screen.getByRole('button', { name: 'pick bob' }));
    expect(onFieldChange).toHaveBeenCalledWith('assignedTo', 'bob');
    expect(onFieldCommit).toHaveBeenCalledWith('assignedTo', 'bob');
  });

  it('is inert/absent for a module whose fields never use IssueDropDown or UserDropDown', () => {
    render(
      <FieldGrid
        fields={NON_DEFECT_FIELDS}
        values={{ priority: 'High' }}
        onFieldCommit={jest.fn()}
      />,
    );
    expect(screen.queryByTestId('defect-status')).not.toBeInTheDocument();
    expect(screen.queryByTestId('user-dropdown')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('Save the defect to set its status')).not.toBeInTheDocument();
  });
});
