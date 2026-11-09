import { ModuleId } from './modules';

// WP-F08 Task 2 -- extracted out of useCloneEntity.ts's own buildClonePlan
// so a template's "capture this record's fields" (SaveAsTemplateDialog)
// and a clone's "flatten this record into a prefill" share ONE
// implementation of what a prefill looks like per module, rather than two
// that can drift. The plan's central constraint: two copies of this logic
// will drift, and this exact shape has already needed one correction
// (useCloneEntity silently dropped `datasetId` when cloning a
// parameterised test case, fixed by WP-F07a Task 5).

export interface RawRecord {
  dynamicFields?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface EntityPrefillResult {
  /** Prefill shape ready for setDraftPrefill/CaseTemplate.prefill -- the
   *  SAME flattened shape FieldGrid/draftValues read for every
   *  draft-capable module. */
  prefill: Record<string, unknown>;
  /** Which field on `prefill` holds the record's title/summary --
   *  undefined for module 3 (Test Plans), which has no per-field form at
   *  all (TestPlanDetail.tsx's own header comment). Callers that want to
   *  relabel it (useCloneEntity's "Copy of ..." prefix) use this to know
   *  which key to touch without hardcoding a per-module field name of
   *  their own. */
  summaryField?: string;
  /** The record's own summary value, read off `prefill` before any
   *  relabeling -- '' when the module has no summary field, or the
   *  record's own is empty. */
  summaryLabel: string;
}

// Flattens dynamicFields onto the top level exactly the way every detail
// view's own entityQuery does (TestCaseDetail.tsx/RequirementDetail.tsx/
// DefectDetail.tsx) -- so a captured field lands in the SAME draftValues
// key FieldGrid already reads, whether it's a default or a dynamic field.
// Idempotent: a detail component's own already-loaded `values` (itself
// already flattened once, by that same rule) flattens again to the exact
// same shape, so SaveAsTemplateDialog can hand this the live `values`
// object directly instead of re-fetching what is already on screen.
function flatten(row: RawRecord): Record<string, unknown> {
  return { ...row, ...(row.dynamicFields ?? {}) };
}

// Only ever called for the four draft-capable modules (DRAFT_CAPABLE_MODULES,
// below) -- both callers (useCloneEntity, SaveAsTemplateDialog) are gated
// on that same set before a row ever reaches here.
export function buildEntityPrefill(module: ModuleId, row: RawRecord): EntityPrefillResult {
  switch (module) {
    case 1: {
      const prefill = flatten(row);
      return { prefill, summaryField: 'TestCaseSummary', summaryLabel: (prefill.TestCaseSummary as string) ?? '' };
    }
    case 2: {
      const prefill = flatten(row);
      return { prefill, summaryField: 'requirementSummary', summaryLabel: (prefill.requirementSummary as string) ?? '' };
    }
    case 3: {
      // Module 3 has no per-field draft form at all (TestPlanDetail.tsx's
      // own header comment) -- the one thing worth carrying over is which
      // test cases the source plan already has, so the draft/template's
      // "add test cases" grid opens with the same rows pre-checked.
      const testCases = Array.isArray(row.TestCases) ? (row.TestCases as Array<{ TestCaseId: string }>) : [];
      return { prefill: { TestCaseIds: testCases.map((tc) => tc.TestCaseId) }, summaryLabel: '' };
    }
    case 5: {
      const prefill = flatten(row);
      // Attachments are files, not field values -- carrying a record's
      // fields forward (clone OR template) should never silently imply
      // the files came along too.
      delete prefill.attachment;
      return { prefill, summaryField: 'summary', summaryLabel: (prefill.summary as string) ?? '' };
    }
    default:
      throw new Error(`buildEntityPrefill: module ${module} has no create flow to build a prefill for`);
  }
}
