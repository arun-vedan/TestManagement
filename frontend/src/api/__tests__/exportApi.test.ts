// Wave C-2 (Register A3) -- CSV export. Mocks entityGridApi.ts's page
// fetchers (no network); covers the paging-through-multiple-pages
// behaviour, the mid-paging failure surfacing as an error rather than a
// partial download, the exact importer-matching header row for test
// cases, and that a module with no list API (module 6, releases) is not
// offered.
import { ALLOWED_FIELDS } from '../importApi';
import {
  MAX_EXPORT_ROWS,
  ExportPagingError,
  fetchAllRowsForExport,
  rowsToCsv,
  getExportConfig,
} from '../exportApi';
import { EntityPage, FetchPageParams } from '../entityGridApi';

describe('fetchAllRowsForExport', () => {
  it('pages through multiple pages and includes rows from all of them', async () => {
    const page0: EntityPage<{ id: number }> = { rows: [{ id: 1 }, { id: 2 }], rowCountEstimate: 4, hasNextPage: true };
    const page1: EntityPage<{ id: number }> = { rows: [{ id: 3 }, { id: 4 }], rowCountEstimate: 4, hasNextPage: false };
    const fetchPage = jest.fn<Promise<EntityPage<{ id: number }>>, [FetchPageParams]>();
    fetchPage.mockResolvedValueOnce(page0).mockResolvedValueOnce(page1);

    const { rows, truncated } = await fetchAllRowsForExport(fetchPage);

    expect(rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
    expect(truncated).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    // Second call asked for the next page (0-indexed page param increments).
    expect(fetchPage.mock.calls[0][0].page).toBe(0);
    expect(fetchPage.mock.calls[1][0].page).toBe(1);
  });

  it('stops at a single page when hasNextPage is false', async () => {
    const fetchPage = jest.fn().mockResolvedValueOnce({ rows: [{ id: 1 }], rowCountEstimate: 1, hasNextPage: false });
    const { rows } = await fetchAllRowsForExport(fetchPage);
    expect(rows).toEqual([{ id: 1 }]);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('surfaces a mid-paging failure as an ExportPagingError rather than returning a partial result', async () => {
    const fetchPage = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: 1 }], rowCountEstimate: 2, hasNextPage: true })
      .mockRejectedValueOnce(new Error('network blip'));

    let caught: unknown;
    try {
      await fetchAllRowsForExport(fetchPage);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ExportPagingError);
    expect((caught as Error).message).toMatch(/network blip/);
  });

  it('stops at the MAX_EXPORT_ROWS ceiling rather than paging forever', async () => {
    const bigPage = { rows: Array.from({ length: MAX_EXPORT_ROWS }, (_, i) => ({ id: i })), rowCountEstimate: MAX_EXPORT_ROWS + 1, hasNextPage: true };
    const fetchPage = jest.fn().mockResolvedValue(bigPage);
    const { rows, truncated } = await fetchAllRowsForExport(fetchPage);
    expect(rows.length).toBe(MAX_EXPORT_ROWS);
    expect(truncated).toBe(true);
  });
});

describe('test case export config (round-trip with the importer)', () => {
  it('uses the importer ALLOWED_FIELDS as header names, byte for byte', () => {
    const config = getExportConfig(1);
    expect(config).toBeDefined();
    const headers = config!.columns.map((c) => c.header);
    for (const field of ALLOWED_FIELDS) {
      expect(headers).toContain(field);
    }
  });

  it('produces a CSV whose header row is exactly the importer-mapped columns (plus the readability id column)', () => {
    const config = getExportConfig(1)!;
    const rows = [{ TestCaseId: 'TC-1', TestCaseSummary: 'Login works', TestCaseDescription: 'desc, with a comma', parentId: 0 }];
    const csv = rowsToCsv(config.columns, rows);
    const [headerLine] = csv.split('\r\n');
    const headerFields = headerLine.split(',');
    for (const field of ALLOWED_FIELDS) {
      expect(headerFields).toContain(field);
    }
    expect(csv).toContain('"desc, with a comma"');
  });
});

describe('getExportConfig', () => {
  it('offers export for every module with a real paginated list API', () => {
    expect(getExportConfig(1)).toBeDefined(); // test cases
    expect(getExportConfig(2)).toBeDefined(); // requirements
    expect(getExportConfig(3)).toBeDefined(); // test plans
    expect(getExportConfig(4)).toBeDefined(); // test executions/runs
    expect(getExportConfig(5)).toBeDefined(); // defects
  });

  it('does not offer export for module 6 (releases), which has no list API in entityGridApi.ts', () => {
    expect(getExportConfig(6)).toBeUndefined();
  });
});
