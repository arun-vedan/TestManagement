// Wave C-1 (Register A3) -- axe coverage for the CSV import dialog. A file
// input with no accessible name is exactly the kind of thing axe's
// "label" rule catches, and the per-header mapping <Select>s are
// dynamically generated (one per detected CSV column) so it is easy for a
// future edit to add one without a name -- this locks that in for both the
// pre-file and post-mapping states.
import { fireEvent, render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { axe } from 'jest-axe';
import theme from '../../../Theme/theme';
import { CsvImportDialog } from '../CsvImportDialog';
import { expectNoUnexpectedAxeViolations } from '../../../testUtils/a11y';
import { previewImport, commitImport } from '../../../api/importApi';

jest.mock('../../../api/importApi', () => {
  const actual = jest.requireActual('../../../api/importApi');
  return { ...actual, previewImport: jest.fn(), commitImport: jest.fn() };
});

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider theme={theme}>
      <QueryClientProvider client={client}>
        <CsvImportDialog open onClose={jest.fn()} onImported={jest.fn()} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  (previewImport as jest.Mock).mockReset();
  (commitImport as jest.Mock).mockReset();
});

describe('<CsvImportDialog> accessibility', () => {
  it('has no axe violations before a file is chosen', async () => {
    const { container } = renderDialog();
    expectNoUnexpectedAxeViolations(await axe(container));
  });

  it('has no axe violations once a file is chosen and columns are mapped', async () => {
    const { container } = renderDialog();
    const file = new File(['Title,Details\nLogin,Verify login\n'], 'cases.csv', { type: 'text/csv' });
    const input = screen.getByLabelText(/choose csv file/i);
    fireEvent.change(input, { target: { files: [file] } });
    await screen.findAllByRole('combobox');

    expectNoUnexpectedAxeViolations(await axe(container));
  });
});
