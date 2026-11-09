import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'jest-axe';
import Comments from '../displayComments';
import { getComments } from '../../../api/apiCalls';

// WP-046 — Comments was originally mounted from the now-deleted
// Components/Tabs/TabContent.tsx, reached from every legacy list page's
// detail tab (Pages/testcases.tsx/requirements.tsx/testPlan.tsx/
// testExecution.tsx/defects.tsx -> ScrollableTabs -> TabContent ->
// Comments). Test Cases, Requirements, Test Plans and Test Executions were
// retired into the workbench in WP-074/WP-075/WP-076 respectively, and
// WP-078 deleted TabContent/ScrollableTabs themselves (Defects' last path,
// alongside the rest of the legacy Tabs teardown). The workbench's own
// equivalent is workbench/detail/CommentsSection.tsx, a thin wrapper
// around this SAME component (see its header comment), mounted by every
// migrated module's detail view -- so this suite's coverage still exercises
// the one real caller left.
// Before this WP: edit/delete were clickable <span>s (mouse-only, no accessible
// name -- a real WCAG 2.1.1/4.1.2 failure, but see the "not axe-catchable"
// note below), and the delete-confirmation Dialog's aria-labelledby
// pointed at an id ("alert-dialog-title") that didn't exist anywhere in
// the component -- broken by any measure, and one axe DOES catch.

jest.mock('../../../api/apiCalls', () => ({
    getComments: jest.fn(),
    createComments: jest.fn(),
    updateCommentsByParam: jest.fn(),
    deleteCommentById: jest.fn()
}));

const mockGetComments = getComments as jest.Mock;

const COMMENT = {
    _id: 'c1',
    comments: 'Looks good to me',
    updatedAt: '2026-01-01',
    updatedByName: 'Alice',
    createdBy: 'user-1',
    isEdited: 0
};

beforeEach(() => {
    jest.clearAllMocks();
    mockGetComments.mockResolvedValue([COMMENT]);
});

function renderComments(overrides: Partial<{ userId: string; userName: string }> = {}) {
    return render(
        <Comments typeId="TC-1" moduleId={1} userId={overrides.userId ?? 'user-1'} userName={overrides.userName ?? 'Alice'} />
    );
}

describe('Comments (WP-046)', () => {
    it('has no axe violations once comments have loaded, including the comment owner\'s edit/delete controls', async () => {
        const { container } = renderComments();
        await screen.findByText('Looks good to me');
        expect(await axe(container)).toHaveNoViolations();
    });

    it('edit/delete are real, labeled buttons now (were clickable spans -- axe-catchable fix)', async () => {
        renderComments();
        await screen.findByText('Looks good to me');
        expect(screen.getByRole('button', { name: 'Edit comment' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Delete comment' })).toBeInTheDocument();
    });

    it('a non-owner sees neither edit nor delete control', async () => {
        renderComments({ userId: 'someone-else' });
        await screen.findByText('Looks good to me');
        expect(screen.queryByRole('button', { name: 'Edit comment' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Delete comment' })).not.toBeInTheDocument();
    });

    it('the delete-confirmation dialog has a real accessible name (was a dangling aria-labelledby reference)', async () => {
        renderComments();
        await screen.findByText('Looks good to me');
        await userEvent.click(screen.getByRole('button', { name: 'Delete comment' }));

        const dialog = await screen.findByRole('dialog', { name: 'Delete comment' });
        expect(dialog).toBeInTheDocument();
        expect(await axe(dialog)).toHaveNoViolations();
    });

    it('the add-comment and edit-comment textareas have real accessible names, not just a placeholder', async () => {
        renderComments();
        expect(screen.getByRole('textbox', { name: 'Add a comment' })).toBeInTheDocument();

        await screen.findByText('Looks good to me');
        await userEvent.click(screen.getByRole('button', { name: 'Edit comment' }));
        expect(screen.getByRole('textbox', { name: 'Edit comment' })).toBeInTheDocument();
    });

    it('Delete is keyboard-operable via a real button (NOT axe-catchable that it used to be a bare span -- see file header)', async () => {
        renderComments();
        await screen.findByText('Looks good to me');
        const del = screen.getByRole('button', { name: 'Delete comment' });

        del.focus();
        expect(del).toHaveFocus();
        await userEvent.keyboard('{Enter}');

        expect(await screen.findByRole('dialog')).toBeInTheDocument();
    });
});
