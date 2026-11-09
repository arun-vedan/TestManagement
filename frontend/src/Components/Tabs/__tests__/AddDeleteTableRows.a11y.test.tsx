import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import { ThemeProvider } from '@mui/material';
import theme from '../../../Theme/theme';
import AddDeleteTableRows from '../AddDeleteTableRows';
import { TCStepsContext } from '../../../Context/testSteps';
import { getFields } from '../../../api/apiCalls';

// WP-046 — this is the actual "record a result" control on the execution
// screen: TestExecutionContent.tsx renders
// <AddDeleteTableRows rows={...} editable={edit} module={4}> for its Steps
// table, and each step's Status <Select> (TableRows.tsx) is where a
// keyboard/screen-reader user marks a step Pass/Fail/Blocked/etc. Before
// this WP that <Select> had no accessible name or label at all -- axe's
// aria-input-field-name rule flags it, and a screen reader user landing on
// it heard only "combobox". Fixed via `inputProps={{ 'aria-label': ... }}`
// (a bare `aria-label` prop on MUI's <Select> lands on the outer wrapper
// div, not the inner role="combobox" that needs the name -- the same
// lesson OutlinedInput and the Issue/Link-type Selects taught earlier in
// this WP; see linkissue.tsx).
//
// TestExecutionContent.a11y.test.tsx covers the surrounding page (tree,
// counts, layout) with the real <Tree> mocked out (DnD/ESM constraint,
// see that file); this file exercises the Steps table directly, unmocked,
// in both view and edit mode.

jest.mock('../../../api/apiCalls', () => ({
    getFields: jest.fn()
}));

const mockGetFields = getFields as jest.Mock;

const STEP_ROWS = [
    { testStep: 'Enter valid credentials', Expected: 'User is logged in', status: 'No Run' },
    { testStep: 'Click submit', Expected: 'Dashboard loads', status: 'Pass' }
];

const Steps = ({ editable }: { editable: boolean }) => (
    <ThemeProvider theme={theme}>
        <TCStepsContext.Provider value={{ tcSteps: STEP_ROWS, setTcSteps: jest.fn() }}>
            <AddDeleteTableRows rows={STEP_ROWS} editable={editable} module={4} />
        </TCStepsContext.Provider>
    </ThemeProvider>
);

// AddDeleteTableRows fetches the step-status dropdown values (getFields)
// in a useEffect on mount; `stepDropDown` is undefined until that promise
// resolves. Real usage never hits this gap -- TestExecutionContent always
// mounts the Steps table in view mode first (edit starts false) and only
// flips to editable after a user clicks Play, well after mount's effects
// have settled. Mounting directly in edit mode here would race the same
// gap, so every editable-mode assertion below mounts in view mode first,
// waits for the fetch to settle, then rerenders into edit mode --
// preserving the same real ordering rather than asserting around the bug.
async function renderStepsEditable() {
    const utils = render(<Steps editable={false} />);
    // getExeFields() is invoked synchronously inside the mount effect, so
    // by the time render() returns, mockGetFields has already been called
    // once and its pending promise is available here -- awaiting it inside
    // act() flushes the setStepDropDown() update it triggers before this
    // function returns, closing the exact gap described above.
    await act(async () => {
        await mockGetFields.mock.results[0].value;
    });
    utils.rerender(<Steps editable />);
    return utils;
}

beforeEach(() => {
    jest.clearAllMocks();
    mockGetFields.mockResolvedValue([{ defaultValue: ['No Run', 'InProgress', 'Pass', 'Fail', 'Blocked'] }]);
});

describe('AddDeleteTableRows -- execution screen Steps table (WP-046)', () => {
    it('axe clean in read-only (view) mode', async () => {
        const { container } = render(<Steps editable={false} />);
        await screen.findByText('No Run');
        expect(await axe(container)).toHaveNoViolations();
    });

    it('axe clean in edit mode, with the Status <Select> for each step rendered', async () => {
        const { container } = await renderStepsEditable();
        await screen.findAllByRole('combobox');
        expect(await axe(container)).toHaveNoViolations();
    });

    it('each step\'s Status <Select> carries a distinct, real accessible name (axe-catchable fix)', async () => {
        await renderStepsEditable();
        expect(await screen.findByRole('combobox', { name: 'Status for step 1' })).toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: 'Status for step 2' })).toBeInTheDocument();
    });

    it('in view mode, status is shown as plain text -- no interactive control needed', async () => {
        render(<Steps editable={false} />);
        await screen.findByText('No Run');
        expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
        expect(screen.getByText('Pass')).toBeInTheDocument();
    });

    // WP-046 — a genuine jsdom-verifiable focus-order assertion (see
    // docs/accessibility-keyboard-pass.md's own note on what jsdom actually
    // proves vs. what still needs a human/real-browser pass). Tab order
    // through a real DOM in jsdom is real and checkable with userEvent.tab()
    // + jest-dom's toHaveFocus(); this is NOT a substitute for the full
    // keyboard-only script in that doc, just the one slice of it this
    // environment can genuinely assert without a browser.
    it('Tab visits each step\'s Status <Select> in row order, matching visual/DOM order', async () => {
        await renderStepsEditable();

        const step1 = screen.getByRole('combobox', { name: 'Status for step 1' });
        const step2 = screen.getByRole('combobox', { name: 'Status for step 2' });

        step1.focus();
        expect(step1).toHaveFocus();

        await userEvent.tab();
        expect(step2).toHaveFocus();
    });
});
