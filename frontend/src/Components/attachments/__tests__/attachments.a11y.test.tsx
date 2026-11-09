import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { AttachemntListComp } from '../attachments';

// WP-046 — AttachemntListComp is mounted directly by
// Components/Tabs/DefectContent.tsx (the defect form target page's
// Attachments section). The "Choose File" trigger was a <label> wrapping a
// component="span" Button, with the real <input type="file"> hidden via
// display:none -- which removes it from the tab order entirely. A mouse
// click still worked (label-click delegates to its input even when
// hidden), but nothing here was keyboard-focusable at all: axe can't catch
// this either (a hidden-but-present form control plus a non-interactive
// span wrapped in a non-focusable label isn't a rule violation by itself),
// so this is verified with a real keyboard/focus assertion instead.

const ATTACHMENT = { attachmentId: 'a1', name: 'screenshot.png' };

function renderList(overrides: Partial<React.ComponentProps<typeof AttachemntListComp>> = {}) {
    return render(
        <AttachemntListComp
            attachmentList={[ATTACHMENT]}
            handleItemDelete={jest.fn()}
            file={null}
            fileName=""
            handleFileChange={jest.fn()}
            handleUpload={jest.fn()}
            loading={false}
            {...overrides}
        />
    );
}

describe('AttachemntListComp (WP-046)', () => {
    it('has no axe violations', async () => {
        const { container } = renderList();
        expect(await axe(container)).toHaveNoViolations();
    });

    it('the "Choose File" trigger is keyboard-focusable (was a hidden, unreachable input before this fix)', () => {
        renderList();
        // getByLabelText, not a role query -- the file input is visually
        // hidden (srOnlySx) but must resolve a real accessible name from
        // its wrapping <label> (the Button) to be reachable at all.
        const fileInput = screen.getByLabelText('Choose file', { selector: 'input' });
        fileInput.focus();
        expect(fileInput).toHaveFocus();
    });

    it('the delete control per attachment is a real, labeled button', () => {
        renderList();
        expect(screen.getByRole('button', { name: 'delete' })).toBeInTheDocument();
    });
});
