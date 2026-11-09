// Wave C-1 (Register A3) -- CSV import for test cases (module 1). The
// backend (WP-045, backend/testRepoService/controllers/importExport.js)
// has existed with no UI ever wired to it; this proves the UI half:
//   - choosing a file + mapping columns enables Preview
//   - Preview renders the real per-row report (line numbers + reasons)
//   - Commit stays disabled while the preview has invalid rows
//   - a clean preview + successful commit reports the created count and
//     tells the caller to invalidate the tree (via onImported)
//   - a 422 from commit AFTER a clean preview (the server re-validates
//     and never trusts a client-reported clean preview) shows the
//     server's actual returned report, not a generic failure message
//
// api/importApi.ts is mocked at the module boundary (no network); the real
// ImportPolicyError class is used (via requireActual) so `instanceof`
// checks inside the component behave exactly as they will against the
// real client.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CsvImportDialog } from '../CsvImportDialog';
import { previewImport, commitImport, ImportPolicyError, ImportReport } from '../../../api/importApi';

jest.mock('../../../api/importApi', () => {
  const actual = jest.requireActual('../../../api/importApi');
  return {
    ...actual,
    previewImport: jest.fn(),
    commitImport: jest.fn(),
  };
});

const mockPreview = previewImport as jest.Mock;
const mockCommit = commitImport as jest.Mock;

function renderDialog(onImported = jest.fn(), onClose = jest.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <CsvImportDialog open onClose={onClose} onImported={onImported} />
    </QueryClientProvider>,
  );
  return { ...utils, onImported, onClose };
}

function csvFile(content: string, name = 'cases.csv'): File {
  return new File([content], name, { type: 'text/csv' });
}

async function chooseFile(content: string) {
  const input = screen.getByLabelText(/choose csv file/i);
  fireEvent.change(input, { target: { files: [csvFile(content)] } });
  // FileReader in jsdom resolves via setImmediate -- wait for the mapping
  // controls it produces rather than asserting synchronously.
  return screen.findAllByRole('combobox');
}

// MUI's <Select> (non-native) isn't a real <select> -- it's a div with
// role="combobox" backed by a popup listbox, the same control
// DefectDetail.test.tsx/RequirementDetail.test.tsx already drive this way
// (mouseDown to open, click the resulting option). A plain
// fireEvent.change on the combobox node itself does not fire MUI's
// onChange at all.
async function selectMapping(header: string, optionLabel: string | RegExp) {
  const combo = screen.getByRole('combobox', { name: new RegExp(`map "${header}" to`, 'i') });
  fireEvent.mouseDown(combo);
  fireEvent.click(await screen.findByRole('option', { name: optionLabel }));
}

const CLEAN_REPORT: ImportReport = {
  success: true,
  policy: 'all-or-nothing',
  willImport: 2,
  headers: ['Title', 'Details'],
  ignoredColumns: [],
  summary: { totalRows: 2, validRows: 2, invalidRows: 0 },
  rows: [
    { line: 2, data: { TestCaseSummary: 'Login', TestCaseDescription: 'Verify login' }, valid: true, errors: [] },
    { line: 3, data: { TestCaseSummary: 'Logout', TestCaseDescription: 'Verify logout' }, valid: true, errors: [] },
  ],
};

const DIRTY_REPORT: ImportReport = {
  success: true,
  policy: 'all-or-nothing',
  willImport: 0,
  headers: ['Title', 'Details'],
  ignoredColumns: [],
  summary: { totalRows: 2, validRows: 1, invalidRows: 1 },
  rows: [
    { line: 2, data: { TestCaseSummary: 'Login', TestCaseDescription: 'Verify login' }, valid: true, errors: [] },
    { line: 3, data: { TestCaseSummary: '' }, valid: false, errors: ['TestCaseDescription is required'] },
  ],
};

beforeEach(() => {
  mockPreview.mockReset();
  mockCommit.mockReset();
});

describe('<CsvImportDialog>', () => {
  it('keeps Preview disabled until a file is chosen and the required columns are mapped', async () => {
    renderDialog();
    expect(screen.getByRole('button', { name: /^preview$/i })).toBeDisabled();

    const combos = await chooseFile('Title,Details,Notes\nLogin,Verify login,n/a\n');
    expect(combos).toHaveLength(3);
    // Nothing mapped yet -- still disabled.
    expect(screen.getByRole('button', { name: /^preview$/i })).toBeDisabled();

    await selectMapping('title', /summary/i);
    // Only one required field mapped -- still disabled.
    expect(screen.getByRole('button', { name: /^preview$/i })).toBeDisabled();

    await selectMapping('details', /description/i);
    expect(screen.getByRole('button', { name: /^preview$/i })).toBeEnabled();
  });

  it('renders the per-row report from preview, including source line numbers and reasons for invalid rows', async () => {
    mockPreview.mockResolvedValueOnce(DIRTY_REPORT);
    renderDialog();
    await chooseFile('Title,Details\nLogin,Verify login\nLogout,\n');
    await selectMapping('title', /summary/i);
    await selectMapping('details', /description/i);

    fireEvent.click(screen.getByRole('button', { name: /^preview$/i }));

    await waitFor(() => expect(mockPreview).toHaveBeenCalledTimes(1));
    expect(mockPreview).toHaveBeenCalledWith(
      expect.any(File),
      { Title: 'TestCaseSummary', Details: 'TestCaseDescription' },
    );

    // The real source line number (buildImportReport's `line`, not the
    // row's array index) for the failing row, and its actual reason.
    expect(await screen.findByText(/line 3/i)).toBeInTheDocument();
    expect(screen.getByText(/TestCaseDescription is required/)).toBeInTheDocument();
    expect(screen.getByText(/line 2/i)).toBeInTheDocument();
    // Nothing has been written yet -- this is the dry run.
    expect(screen.getByText(/nothing (has been|will be) (written|imported)/i)).toBeInTheDocument();
  });

  it('disables Commit while the preview has invalid rows', async () => {
    mockPreview.mockResolvedValueOnce(DIRTY_REPORT);
    renderDialog();
    await chooseFile('Title,Details\nLogin,Verify login\nLogout,\n');
    await selectMapping('title', /summary/i);
    await selectMapping('details', /description/i);
    fireEvent.click(screen.getByRole('button', { name: /^preview$/i }));

    await screen.findByText(/row\(s\) valid/i);
    expect(screen.getByRole('button', { name: /commit import/i })).toBeDisabled();
    expect(mockCommit).not.toHaveBeenCalled();
  });

  it('states the all-or-nothing policy explicitly once a file is loaded', async () => {
    renderDialog();
    await chooseFile('Title,Details\nLogin,Verify login\n');
    expect(screen.getByText(/all.or.nothing/i)).toBeInTheDocument();
  });

  it('a clean preview then a successful commit reports the created count and calls onImported', async () => {
    mockPreview.mockResolvedValueOnce(CLEAN_REPORT);
    mockCommit.mockResolvedValueOnce({ success: true, policy: 'all-or-nothing', imported: 2, ignoredColumns: [], data: [] });
    const { onImported } = renderDialog();

    await chooseFile('Title,Details\nLogin,Verify login\nLogout,Verify logout\n');
    await selectMapping('title', /summary/i);
    await selectMapping('details', /description/i);
    fireEvent.click(screen.getByRole('button', { name: /^preview$/i }));
    await screen.findByText(/2 of 2/i);

    const commitButton = screen.getByRole('button', { name: /commit import/i });
    expect(commitButton).toBeEnabled();
    fireEvent.click(commitButton);

    await waitFor(() => expect(mockCommit).toHaveBeenCalledTimes(1));
    expect(mockCommit).toHaveBeenCalledWith(
      expect.any(File),
      { Title: 'TestCaseSummary', Details: 'TestCaseDescription' },
    );
    expect(await screen.findByText(/imported 2 test case/i)).toBeInTheDocument();
    expect(onImported).toHaveBeenCalledWith(2);
  });

  it('shows the server-returned report (not a generic error) on a 422 from commit after a clean preview', async () => {
    mockPreview.mockResolvedValueOnce(CLEAN_REPORT);
    const rejection = new (jest.requireActual('../../../api/importApi').ImportPolicyError)(
      '1 of 2 row(s) failed validation; nothing was imported',
      DIRTY_REPORT,
    ) as ImportPolicyError;
    mockCommit.mockRejectedValueOnce(rejection);
    const { onImported } = renderDialog();

    await chooseFile('Title,Details\nLogin,Verify login\nLogout,Verify logout\n');
    await selectMapping('title', /summary/i);
    await selectMapping('details', /description/i);
    fireEvent.click(screen.getByRole('button', { name: /^preview$/i }));
    await screen.findByText(/2 of 2/i);

    fireEvent.click(screen.getByRole('button', { name: /commit import/i }));

    // The specific per-row reason from the SERVER'S commit-time report,
    // not just a bare "commit failed" string.
    expect(await screen.findByText(/TestCaseDescription is required/)).toBeInTheDocument();
    expect(screen.getByText(/line 3/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing was imported/i)).toBeInTheDocument();
    // Nothing was actually created -- onImported must not fire.
    expect(onImported).not.toHaveBeenCalled();
    // The stale, now-contradicted preview must not let a second click
    // straight through -- re-running Preview is required first.
    expect(screen.getByRole('button', { name: /commit import/i })).toBeDisabled();
  });

  it('lets the user cancel without ever calling preview or commit', () => {
    const { onClose } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onClose).toHaveBeenCalled();
    expect(mockPreview).not.toHaveBeenCalled();
    expect(mockCommit).not.toHaveBeenCalled();
  });
});

describe('<CsvImportDialog> mapping accessibility', () => {
  it('every mapping control and the file chooser has a real accessible name', async () => {
    renderDialog();
    const combos = await chooseFile('Title,Details\nLogin,Verify login\n');
    combos.forEach((combo) => {
      expect(combo).toHaveAccessibleName();
    });
    expect(screen.getByLabelText(/choose csv file/i)).toBeInTheDocument();
  });
});
