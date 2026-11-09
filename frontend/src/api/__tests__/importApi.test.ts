// Wave C-1 (Register A3) -- unit coverage for api/importApi.ts, mocking
// axiosPrivate directly (same technique api/__tests__/aiApi.test.ts uses).
//
// THE POINT: prove the request this client sends matches what
// backend/testRepoService/controllers/importExport.js actually expects
// (multipart, file field "file", a JSON-*string* "mapping" field -- not a
// raw object, since parseMapping() JSON.parse()s it), and that a 422 from
// commitImport surfaces as a typed ImportPolicyError carrying the full
// re-validated report, not a generic Error.
import axiosPrivate from '../axios';
import { previewImport, commitImport, ImportPolicyError, ImportReport } from '../importApi';

jest.mock('../axios', () => ({
  __esModule: true,
  default: { post: jest.fn() },
}));

const mockedPost = axiosPrivate.post as jest.Mock;

function makeFile(content = 'TestCaseSummary,TestCaseDescription\nLogin,Verify login\n'): File {
  return new File([content], 'cases.csv', { type: 'text/csv' });
}

const CLEAN_REPORT: ImportReport = {
  success: true,
  policy: 'all-or-nothing',
  willImport: 1,
  headers: ['TestCaseSummary', 'TestCaseDescription'],
  ignoredColumns: [],
  summary: { totalRows: 1, validRows: 1, invalidRows: 0 },
  rows: [{ line: 2, data: { TestCaseSummary: 'Login', TestCaseDescription: 'Verify login' }, valid: true, errors: [] }],
};

describe('api/importApi.ts', () => {
  beforeEach(() => {
    mockedPost.mockReset();
  });

  describe('previewImport', () => {
    it('POSTs multipart to /api/v1/testrepo/import/preview with a "file" field and a JSON-string "mapping" field', async () => {
      mockedPost.mockResolvedValueOnce({ status: 200, data: CLEAN_REPORT });
      const file = makeFile();
      const mapping = { TestCaseSummary: 'TestCaseSummary' as const, TestCaseDescription: 'TestCaseDescription' as const };

      const result = await previewImport(file, mapping);

      expect(mockedPost).toHaveBeenCalledTimes(1);
      const [url, body] = mockedPost.mock.calls[0];
      expect(url).toBe('/api/v1/testrepo/import/preview');
      expect(body).toBeInstanceOf(FormData);
      const formData = body as FormData;
      expect(formData.get('file')).toBe(file);
      // parseMapping() (backend) JSON.parse()s this field -- it must be a
      // string, not an object, or a real multipart client would reject it
      // before it ever reached the assertion above.
      expect(typeof formData.get('mapping')).toBe('string');
      expect(JSON.parse(formData.get('mapping') as string)).toEqual(mapping);
      expect(result).toEqual(CLEAN_REPORT);
    });
  });

  describe('commitImport', () => {
    it('POSTs the same multipart shape to /api/v1/testrepo/import/commit and returns the success body on 201', async () => {
      const successBody = { success: true, policy: 'all-or-nothing' as const, imported: 1, ignoredColumns: [], data: [{ TestCaseId: 'TC-1' }] };
      mockedPost.mockResolvedValueOnce({ status: 201, data: successBody });
      const file = makeFile();
      const mapping = { TestCaseSummary: 'TestCaseSummary' as const, TestCaseDescription: 'TestCaseDescription' as const };

      const result = await commitImport(file, mapping);

      const [url, body, config] = mockedPost.mock.calls[0];
      expect(url).toBe('/api/v1/testrepo/import/commit');
      expect((body as FormData).get('file')).toBe(file);
      expect(JSON.parse((body as FormData).get('mapping') as string)).toEqual(mapping);
      // validateStatus:()=>true is required so a 422 lands in `.then`, not
      // as a thrown axios error the caller would have to re-parse.
      expect(config.validateStatus(422)).toBe(true);
      expect(result).toEqual(successBody);
    });

    it('throws a typed ImportPolicyError carrying the full report on a 422 (server re-validation rejected the file)', async () => {
      const rejectedReport: ImportReport = {
        success: false,
        policy: 'all-or-nothing',
        willImport: 0,
        headers: ['TestCaseSummary', 'TestCaseDescription'],
        ignoredColumns: [],
        summary: { totalRows: 2, validRows: 1, invalidRows: 1 },
        rows: [
          { line: 2, data: { TestCaseSummary: 'Login' }, valid: true, errors: [] },
          { line: 3, data: {}, valid: false, errors: ['TestCaseSummary is required', 'TestCaseDescription is required'] },
        ],
      };
      mockedPost.mockResolvedValueOnce({
        status: 422,
        data: { ...rejectedReport, error: '1 of 2 row(s) failed validation; nothing was imported' },
      });

      const file = makeFile();
      const mapping = { TestCaseSummary: 'TestCaseSummary' as const, TestCaseDescription: 'TestCaseDescription' as const };

      let caught: unknown;
      try {
        await commitImport(file, mapping);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ImportPolicyError);
      const policyErr = caught as ImportPolicyError;
      expect(policyErr.message).toBe('1 of 2 row(s) failed validation; nothing was imported');
      expect(policyErr.policy).toBe('all-or-nothing');
      expect(policyErr.report.summary).toEqual({ totalRows: 2, validRows: 1, invalidRows: 1 });
      expect(policyErr.report.rows[1]).toEqual(rejectedReport.rows[1]);
    });

    it('throws a plain Error (not ImportPolicyError) for a non-422 failure', async () => {
      mockedPost.mockResolvedValueOnce({ status: 500, data: { error: 'testRepoService unavailable' } });
      const file = makeFile();
      await expect(commitImport(file, { TestCaseSummary: 'TestCaseSummary' as const, TestCaseDescription: 'TestCaseDescription' as const })).rejects.toThrow(
        'testRepoService unavailable',
      );
    });
  });
});
