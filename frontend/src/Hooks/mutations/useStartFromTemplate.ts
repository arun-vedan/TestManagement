import { ModuleId } from '../../workbench/modules';
import { openDraftFromPrefill } from '../../workbench/openDraftFromPrefill';
import { useWorkbench } from '../../workbench/WorkbenchStoreProvider';
import { CaseTemplate } from '../../api/caseTemplateApi';

// WP-F08 Task 2 -- "start from template" is useCloneEntity's exact
// mechanism (openDraftFromPrefill: mint a draft id, setDraftPrefill,
// openTab) with a STORED prefill (CaseTemplate.prefill, captured once at
// save time -- R4) instead of a freshly-fetched live record. There is no
// fetch here at all: CaseTemplatePicker already has the template's
// prefill from the list it rendered, so unlike useCloneEntity this isn't
// even a mutation (nothing async happens) -- a plain callback is enough.
//
// The opened draft's tab title is the template's own `name` -- unlike a
// clone, a template is a named starting point, not "a copy of" the record
// it was captured from (R4: a template is a snapshot, not a live link
// back to its source; wording it as a copy of that source would imply a
// relationship this feature deliberately does not have).
export function useStartFromTemplate(module: ModuleId): (template: CaseTemplate) => void {
  const openTab = useWorkbench((s) => s.openTab);
  const setDraftPrefill = useWorkbench((s) => s.setDraftPrefill);

  return (template: CaseTemplate) => {
    openDraftFromPrefill(module, template.name, template.prefill, { openTab, setDraftPrefill });
  };
}
