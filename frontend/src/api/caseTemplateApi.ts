import axiosPrivate from './axios';
import { ModuleId } from '../workbench/modules';

// WP-F08 Task 2 -- the CaseTemplate CRUD surface Task 1 built
// (backend/testRepoService/routes/caseTemplate.js), same convention as
// sharedStepApi.ts/datasetApi.ts: apiCalls.tsx is off-limits for new call
// sites, so this is its own isolated module. There is no `serviceApi()`
// helper anywhere in frontend/src -- that name only exists in the
// Playwright test harness -- so every call below goes through
// axiosPrivate with the full `/api/v1/casetemplate` path, exactly like
// sharedStepApi.ts does for `/api/v1/sharedstep`.
//
// Secured end-to-end by the same keycloak.protect() -> requireProjectScope()
// -> authorize() chain as every other testRepoService route; X-Project-Id
// is added automatically by axiosPrivate's request interceptor, so no
// per-call header wiring is needed here either.

// backend/testRepoService/models/CaseTemplate.js's authoritative shape.
// `prefill` is deliberately untyped beyond `Record<string, unknown>` --
// see that model's own header comment: it holds whatever
// buildEntityPrefill (workbench/entityPrefill.ts) produces for the given
// module, which differs across the four draft-capable modules, and a
// stricter type here would just be a second place for that shape to fall
// out of sync.
export interface CaseTemplate {
  _id: string;
  id: number;
  CaseTemplateId: string;
  projectId: number;
  moduleId: ModuleId;
  name: string;
  description?: string;
  prefill: Record<string, unknown>;
  createdBy?: string;
  updatedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CaseTemplatePayload {
  moduleId: ModuleId;
  name: string;
  description?: string;
  prefill: Record<string, unknown>;
}

const CASE_TEMPLATE_BASE = '/api/v1/casetemplate';

// Filtered server-side by moduleId (advancedResults, service-core, passes
// any query param through as a Mongo filter except select/sort/page/
// limit/expand/substitute) so CaseTemplatePicker only ever asks for -- and
// only ever renders -- templates for the module it was opened from.
export const listCaseTemplates = async (moduleId: ModuleId): Promise<CaseTemplate[]> => {
  const resp = await axiosPrivate.get(CASE_TEMPLATE_BASE, { params: { moduleId } });
  return resp.data.data;
};

export const createCaseTemplate = async (body: CaseTemplatePayload): Promise<CaseTemplate> => {
  const resp = await axiosPrivate.post(CASE_TEMPLATE_BASE, body);
  return resp.data.data;
};

export const deleteCaseTemplate = async (id: string): Promise<void> => {
  await axiosPrivate.delete(`${CASE_TEMPLATE_BASE}/${id}`);
};
