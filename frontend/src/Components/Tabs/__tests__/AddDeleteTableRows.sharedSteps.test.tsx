import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ThemeProvider } from '@mui/material';
import theme from '../../../Theme/theme';
import AddDeleteTableRows from '../AddDeleteTableRows';
import { TCStepsContext } from '../../../Context/testSteps';
import { getFields } from '../../../api/apiCalls';

// WP-F06 Task 4 -- the Steps tab must RENDER a reference row (one whose
// `sharedStepId` is set, pointing at a step authored once in the
// shared-step library) as a single read-only row, and must never let an
// unrelated edit on a plain row silently turn that reference into a
// flattened copy. Losing `sharedStepId` anywhere in the
// handleChange/addTableRows/deleteTableRows path would make the whole
// shared-step feature dead while looking like it still works -- no error,
// nothing to notice. `AddDeleteTableRows`/`TableRows` are also the exact
// components module 4 (Test Runs) renders its own Steps table with (see
// AddDeleteTableRows.a11y.test.tsx), so every assertion here either exercises
// module 1 only or checks module 4's own rows are untouched -- never both
// at once, so a regression in one module can't hide behind a passing
// assertion about the other.

jest.mock('../../../api/apiCalls', () => ({
    getFields: jest.fn()
}));

const mockGetFields = getFields as jest.Mock;

// The exact reference-row shape Task 2's schema and this editor's own read
// path produce: the editor never passes ?expand=steps, so a reference row
// it reads back carries `sharedStepId`/`sharedStepTitle` plus whatever
// testStep/Expected happen to be stored on the document -- ignored by
// design, and deliberately left populated with stale-looking text here so
// a test asserting "not shown as editable text" is actually proving
// something, not passing because the fields were empty anyway.
const REFERENCE_ROW = {
    sharedStepId: 'abc',
    sharedStepTitle: 'Log in as admin',
    testStep: 'stale text nobody should see rendered as editable',
    Expected: 'stale expected text',
};

const PLAIN_ROW = { testStep: 'Click submit', Expected: 'Dashboard loads' };

function renderSteps(rows: any[], { module = 1, editable = true, setTcSteps = jest.fn() } = {}) {
    const utils = render(
        <ThemeProvider theme={theme}>
            <TCStepsContext.Provider value={{ tcSteps: rows, setTcSteps }}>
                <AddDeleteTableRows rows={rows} editable={editable} module={module} />
            </TCStepsContext.Provider>
        </ThemeProvider>
    );
    return { ...utils, setTcSteps };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetFields.mockResolvedValue([{ defaultValue: ['No Run', 'Pass', 'Fail'] }]);
});

describe('AddDeleteTableRows / TableRows -- shared-step reference rows (WP-F06 Task 4)', () => {
    it('renders a reference row as one read-only shared-step row, not an editable pair', () => {
        renderSteps([REFERENCE_ROW], { module: 1, editable: true });

        expect(screen.getByText(/Log in as admin/)).toBeInTheDocument();
        // Neither the stale testStep nor Expected text is shown as content --
        // proves the row branches on sharedStepId before ever reading them.
        expect(screen.queryByText(/stale text nobody should see/)).not.toBeInTheDocument();
        expect(screen.queryByText(/stale expected text/)).not.toBeInTheDocument();
        expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    });

    /* eslint-disable testing-library/no-node-access -- `.closest('tr')` is
       the only way to scope a textbox query to one specific table row when
       several rows share the same table (same pattern and justification as
       EntityTree.dnd.dom.test.tsx's `.closest('[draggable]')`). Re-enabled
       below, once both tests that need it are done. */
    it('does not let a shared row be edited in place, even with a plain row alongside it', () => {
        renderSteps([REFERENCE_ROW, PLAIN_ROW], { module: 1, editable: true });

        const referenceRowEl = screen.getByText(/Log in as admin/).closest('tr');
        expect(referenceRowEl).not.toBeNull();
        expect(within(referenceRowEl as HTMLElement).queryByRole('textbox')).not.toBeInTheDocument();
    });

    it('still allows a plain row beside a reference row to be edited', () => {
        renderSteps([REFERENCE_ROW, PLAIN_ROW], { module: 1, editable: true });

        const plainRowEl = screen.getByDisplayValue('Click submit').closest('tr');
        expect(plainRowEl).not.toBeNull();
        // testStep + Expected: two editable textboxes on the plain row.
        expect(within(plainRowEl as HTMLElement).getAllByRole('textbox')).toHaveLength(2);
    });
    /* eslint-enable testing-library/no-node-access */

    // THE round-trip guard: this is the single most important test in this
    // file. Editing the plain row must not touch the reference row's
    // object identity/content in the array `setTcSteps` is called with --
    // if `sharedStepId` were ever dropped here, every reference would
    // silently flatten into a copy the instant an unrelated step on the
    // same test case was edited.
    it('preserves the reference when an unrelated plain row is edited', () => {
        const setTcSteps = jest.fn();
        renderSteps([REFERENCE_ROW, PLAIN_ROW], { module: 1, editable: true, setTcSteps });

        const plainTestStepBox = screen.getByDisplayValue('Click submit');
        fireEvent.change(plainTestStepBox, { target: { value: 'Click submit twice' } });

        expect(setTcSteps).toHaveBeenCalledTimes(1);
        const updatedRows = setTcSteps.mock.calls[0][0];
        expect(updatedRows).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ sharedStepId: 'abc', sharedStepTitle: 'Log in as admin' }),
            ])
        );
        // And the edit itself actually landed on the plain row, not the
        // reference -- otherwise this test would pass even if handleChange
        // were broken in some other way that happened to leave the
        // reference row alone.
        expect(updatedRows).toEqual(
            expect.arrayContaining([expect.objectContaining({ testStep: 'Click submit twice' })])
        );
    });

    it('leaves module 4 (Test Run) rows exactly as they were -- Status column intact, no shared-step UI', async () => {
        const moduleFourRows = [
            { testStep: 'Enter valid credentials', Expected: 'User is logged in', status: 'No Run' },
        ];
        renderSteps(moduleFourRows, { module: 4, editable: false });
        // module 4 fetches the Status dropdown's values (getFields) in a
        // mount effect (see AddDeleteTableRows.a11y.test.tsx's own note on
        // this); awaiting it here just settles that state update before the
        // test ends, so it doesn't leak an act() warning -- this view-mode
        // assertion doesn't otherwise depend on stepDropDown at all.
        await act(async () => {
            await mockGetFields.mock.results[0].value;
        });

        // The plain module-4 rendering (Typography, not TextField) is
        // untouched: content shows, and the Status column still renders its
        // value as plain text in view mode.
        expect(screen.getByText('Enter valid credentials')).toBeInTheDocument();
        expect(screen.getByText('User is logged in')).toBeInTheDocument();
        expect(screen.getByText('No Run')).toBeInTheDocument();
        // No shared-step chip/link leaked into a module-4 row that never
        // had a sharedStepId.
        expect(screen.queryByText('Shared')).not.toBeInTheDocument();
    });
});
