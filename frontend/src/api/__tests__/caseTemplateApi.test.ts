// WP-F08 Task 2 -- unit coverage for the CaseTemplate client functions,
// mocking axiosPrivate directly (same technique as datasetApi.test.ts/
// sharedStepApi's own callers). THE POINT: prove each function hits the
// exact backend contract Task 1 built (method + URL +
// /api/v1/casetemplate, NOT a `serviceApi()` helper -- there is no such
// helper anywhere in frontend/src) and that listCaseTemplates filters by
// moduleId so CaseTemplatePicker only ever asks for the module it opened
// from.

import axiosPrivate from '../axios';
import { listCaseTemplates, createCaseTemplate, deleteCaseTemplate, CaseTemplatePayload } from '../caseTemplateApi';

jest.mock('../axios', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
  },
}));

const mockGet = axiosPrivate.get as jest.Mock;
const mockPost = axiosPrivate.post as jest.Mock;
const mockDelete = axiosPrivate.delete as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('api/caseTemplateApi.ts', () => {
  it('listCaseTemplates GETs /api/v1/casetemplate filtered by moduleId and unwraps data', async () => {
    mockGet.mockResolvedValueOnce({ data: { success: true, count: 1, data: [{ _id: 'ct1', moduleId: 1 }] } });
    const result = await listCaseTemplates(1);
    // The single-line break this catches: dropping the `params` object
    // (or sending it under the wrong key) makes this fail -- the picker
    // would then ask the server for every module's templates instead of
    // just its own.
    expect(mockGet).toHaveBeenCalledWith('/api/v1/casetemplate', { params: { moduleId: 1 } });
    expect(result).toEqual([{ _id: 'ct1', moduleId: 1 }]);
  });

  it('createCaseTemplate POSTs /api/v1/casetemplate with the payload, prefill included untouched', async () => {
    const payload: CaseTemplatePayload = {
      moduleId: 1,
      name: 'Regression — login',
      prefill: { TestCaseSummary: 'Login should work', datasetId: 'ds1' },
    };
    mockPost.mockResolvedValueOnce({ data: { success: true, data: { _id: 'ct9', CaseTemplateId: 'CT-9', ...payload } } });
    const result = await createCaseTemplate(payload);
    expect(mockPost).toHaveBeenCalledWith('/api/v1/casetemplate', payload);
    expect(result).toEqual({ _id: 'ct9', CaseTemplateId: 'CT-9', ...payload });
  });

  it('deleteCaseTemplate DELETEs /api/v1/casetemplate/:id', async () => {
    mockDelete.mockResolvedValueOnce({ data: { success: true, data: {} } });
    await deleteCaseTemplate('ct1');
    expect(mockDelete).toHaveBeenCalledWith('/api/v1/casetemplate/ct1');
  });
});
