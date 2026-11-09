/* eslint-disable testing-library/no-node-access -- same false-positive
   eslint-plugin-testing-library pattern CsvImportToolbar.test.tsx's own
   header comment documents for `.mock`/api-module property access, not
   real DOM traversal. */
// Wave C-2 (Register A3) -- "Export CSV" toolbar action, the export-side
// counterpart of CsvImportToolbar.tsx. api/exportApi.ts is mocked here
// (its own paging/CSV-building/mid-failure behaviour is covered by
// api/__tests__/exportApi.test.ts) -- this file's job is: is the button
// reachable and correctly gated, does it show a busy state while
// exporting, does a failure surface as a visible error without ever
// calling downloadCsv, and is the whole action absent for a module with
// no export config (module 6, releases -- no list API).
//
// Since the source-panel redesign (2026-11-06) the trigger is a "More
// actions" menu item, so this is a hook (useCsvExport) plus <CsvExportAlerts>.
// The harness below wires them the way SourcePanelHeader does, with a plain
// button standing in for the menu item.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useCsvExport, CsvExportAlerts } from '../CsvExportToolbar';
import { ModuleId } from '../modules';
import { usePermissions } from '../../Hooks/usePermissions';
import { fetchAllRowsForExport, rowsToCsv, downloadCsv, getExportConfig, ExportPagingError } from '../../api/exportApi';

jest.mock('../../Hooks/usePermissions', () => ({
  __esModule: true,
  usePermissions: jest.fn(),
  default: jest.fn(),
}));
const mockUsePermissions = usePermissions as unknown as jest.Mock;

jest.mock('../../api/exportApi', () => {
  const actual = jest.requireActual('../../api/exportApi');
  return {
    ...actual,
    fetchAllRowsForExport: jest.fn(),
    rowsToCsv: jest.fn(),
    downloadCsv: jest.fn(),
  };
});
const mockFetchAllRowsForExport = fetchAllRowsForExport as jest.Mock;
const mockRowsToCsv = rowsToCsv as jest.Mock;
const mockDownloadCsv = downloadCsv as jest.Mock;

function CsvExportToolbar({ moduleId }: { moduleId: ModuleId }): JSX.Element | null {
  const exporter = useCsvExport(moduleId);
  if (!exporter.available) return null;
  return (
    <>
      <button disabled={exporter.exporting} onClick={() => exporter.run()}>
        {exporter.exporting ? 'Exporting…' : 'Export CSV'}
      </button>
      <CsvExportAlerts exporter={exporter} />
    </>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockUsePermissions.mockReturnValue({ can: () => true });
});

describe('useCsvExport + <CsvExportAlerts>', () => {
  it('renders the Export CSV action for a module with an export config, when the user can read', () => {
    render(<CsvExportToolbar moduleId={1} />);
    expect(screen.getByRole('button', { name: /export csv/i })).toBeInTheDocument();
  });

  it('renders nothing for a module with no list API (module 6, releases)', () => {
    expect(getExportConfig(6)).toBeUndefined();
    const { container } = render(<CsvExportToolbar moduleId={6} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the user cannot even read', () => {
    mockUsePermissions.mockReturnValue({ can: () => false });
    const { container } = render(<CsvExportToolbar moduleId={1} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a busy state while paging, downloads the file, and does not stay busy afterward', async () => {
    let resolvePaging: (value: unknown) => void = () => {};
    mockFetchAllRowsForExport.mockReturnValue(
      new Promise((resolve) => {
        resolvePaging = resolve;
      })
    );
    mockRowsToCsv.mockReturnValue('TestCaseId,TestCaseSummary,TestCaseDescription,parentId\r\n');

    render(<CsvExportToolbar moduleId={1} />);
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));

    expect(await screen.findByRole('button', { name: /exporting/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /exporting/i })).toBeDisabled();
    // The panel-level progress line is what stays visible once the menu closes.
    expect(screen.getByRole('status')).toHaveTextContent(/exporting/i);

    resolvePaging({ rows: [{ TestCaseId: 'TC-1' }], truncated: false });

    await waitFor(() => expect(mockDownloadCsv).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: /export csv/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /export csv/i })).not.toBeDisabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('surfaces a mid-paging failure as a visible error and never calls downloadCsv', async () => {
    mockFetchAllRowsForExport.mockRejectedValue(new ExportPagingError('Export failed while fetching page 2: network blip'));

    render(<CsvExportToolbar moduleId={1} />);
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));

    expect(await screen.findByText(/network blip/i)).toBeInTheDocument();
    expect(mockDownloadCsv).not.toHaveBeenCalled();
    expect(mockRowsToCsv).not.toHaveBeenCalled();
  });

  it('warns, but still downloads, when the row ceiling truncated the export', async () => {
    mockFetchAllRowsForExport.mockResolvedValue({ rows: [{ TestCaseId: 'TC-1' }], truncated: true });
    mockRowsToCsv.mockReturnValue('TestCaseId\r\nTC-1\r\n');

    render(<CsvExportToolbar moduleId={1} />);
    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));

    expect(await screen.findByText(/5000/)).toBeInTheDocument();
    expect(mockDownloadCsv).toHaveBeenCalledTimes(1);
  });
});
