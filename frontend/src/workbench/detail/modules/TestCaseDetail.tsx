import React, { useEffect, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Divider, FormLabel, Stack, TextField } from '@mui/material';
import PlaylistAddIcon from '@mui/icons-material/PlaylistAdd';
import LibraryBooksIcon from '@mui/icons-material/LibraryBooks';
import TableChartIcon from '@mui/icons-material/TableChart';
import SaveAsOutlinedIcon from '@mui/icons-material/SaveAsOutlined';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getFields, getTcList, saveTestCase, updateTestCase } from '../../../api/apiCalls';
import { getCurrentProjectId } from '../../../currentProject';
import { qk } from '../../../Hooks/queryKeys';
import keycloak from '../../../keycloak';
import { TCStepsContext } from '../../../Context/testSteps';
import AddDeleteTableRows from '../../../Components/Tabs/AddDeleteTableRows';
import { SharedStepPicker } from '../../../Components/sharedSteps/SharedStepPicker';
import { SharedStepManagerDialog } from '../../../Components/sharedSteps/SharedStepManagerDialog';
import { listSharedSteps } from '../../../api/sharedStepApi';
import { DatasetBindControl } from '../../../Components/datasets/DatasetBindControl';
import { DatasetManagerDialog } from '../../../Components/datasets/DatasetManagerDialog';
import { SaveAsTemplateDialog } from '../../../Components/templates/SaveAsTemplateDialog';
import { isDraftEntityId, tabKey } from '../../store/workbenchStore';
import { useWorkbench } from '../../WorkbenchStoreProvider';
import { resolveSelectedParentId } from '../../tree/selectedParent';
import DetailHeader from '../DetailHeader';
import { FieldDefinition, FieldGrid } from '../FieldGrid';
import DetailTabs from '../DetailTabs';
import LinksSection from '../LinksSection';
import CommentsSection from '../CommentsSection';
import LifecycleStatusSection from '../LifecycleStatusSection';
import TagsSection from '../TagsSection';
import { usePermissions } from '../../../Hooks/usePermissions';

export interface TestCaseDetailProps {
  entityId: string;
}

// Module id for Test Cases (src/workbench/modules.ts's ModuleId 1).
const MODULE_ID = 1;

// WP-F06 Task 5 -- widened from `{ testStep, Expected }` to also allow the
// two shared-step reference fields, so a row built by insertSharedStep
// below (`{ testStep: '', Expected: '', sharedStepId, sharedStepTitle }`)
// type-checks in the same steps array/state/mutation as every plain row,
// with no separate "reference row" type threaded through draftSteps/
// commitSteps/TCStepsContext.
type StepRow = { testStep: string; Expected: string; sharedStepId?: string; sharedStepTitle?: string };

const DEFAULT_STEPS: StepRow[] = [{ testStep: '', Expected: '' }];

interface TestCaseRecord {
  _id?: string;
  TestCaseId?: string;
  TestCaseSummary?: string;
  // WP-F06 Task 4 -- sharedStepId/sharedStepTitle are present on a
  // reference row (a step authored once in the shared-step library and
  // pointed to from here instead of copied). This component never passes
  // ?expand=steps, so a reference row it reads back carries only these two
  // fields meaningfully; testStep/Expected on such a row are ignored by
  // AddDeleteTableRows/TableRows, not authoritative content. The stored
  // `sharedStepTitle` itself is only a snapshot taken at insert time, not
  // kept in sync with the shared step -- WP-F06 Task 6 fix round 1 below
  // resolves the LIVE title from the same list the picker/manager query
  // and prefers that at render time, falling back to this stored value.
  TestSteps?: Array<{ testStep: string; Expected: string; sharedStepId?: string; sharedStepTitle?: string }>;
  tags?: string[];
  // WP-F07a Task 4 -- the dataset this case's {{placeholders}} resolve
  // against (models/testrepo.js's `datasetId`, Task 1). A bare mongo _id
  // string, or absent/null when nothing is bound.
  datasetId?: string | null;
  [key: string]: unknown;
}

// WP-F07a Task 4 -- the shape a substituted TestSteps entry carries back
// from `GET /api/v1/testrepo/:id?substitute=<rowIndex>` (Task 3's
// contract): `testStep`/`Expected` are the SUBSTITUTED text,
// `authoredTestStep`/`authoredExpected` the original alongside it in the
// same response. This component only ever reads the substituted pair for
// the read-only preview column -- the authored pair it already has, from
// `values.TestSteps`, untouched by this fetch.
interface SubstitutedStepRow {
  testStep: string;
  Expected: string;
  substituted?: boolean;
  sharedStepId?: string;
}

// Preview text is read-only display data ONLY, aligned to the AUTHORED
// steps array by position -- never merged into it. A row with
// `sharedStepId` expands into a variable-length run of plain rows on the
// backend (expandSteps() flattens one reference into N rows before
// substituteSteps() runs, utils/expandSteps.js), so there is no single
// substituted entry that corresponds to it; every entry the expansion
// produced is consumed from `previewSteps` and skipped, keeping every
// LATER plain row's alignment correct, but no per-row preview is shown
// for the reference row itself (showing one of its N expanded sub-steps
// as if it were the whole reference would be misleading, not helpful).
function alignPreviewToAuthored(
  authored: StepRow[],
  previewSteps: SubstitutedStepRow[] | undefined
): Array<SubstitutedStepRow | undefined> {
  if (!previewSteps) return authored.map(() => undefined);
  let cursor = 0;
  return authored.map((row) => {
    if (row.sharedStepId) {
      while (cursor < previewSteps.length && previewSteps[cursor]?.sharedStepId === row.sharedStepId) {
        cursor += 1;
      }
      return undefined;
    }
    const match = previewSteps[cursor];
    cursor += 1;
    return match;
  });
}

interface KeycloakTokenParsed {
  sub?: string;
  name?: string;
  preferred_username?: string;
}

// WP-074 -- first module built on the shared detail kit (Step 4 of this
// WP). Source of truth for the fetch/save shape is
// Components/Tabs/TabContent.tsx's selectedModule === 1 branch
// (~lines 247-303 for the fetch, ~424-429 for the save). One thing was
// deliberately NOT ported at the time, out of that WP's scope:
//
//  - createdBy/updatedBy id -> display-name enrichment (getCreatedBy) and
//    the "Created By / Created At / Updated By / Updated At" panel that
//    consumed it (TabContent.tsx:676-701) -- neither DetailHeader nor
//    FieldGrid owns that block, and nothing here displays those values,
//    so fetching them would be speculative.
//
// WP-079 Part A -- the OTHER thing WP-074 deliberately left out, the
// not-yet-saved ("newTestCase") draft flow, is added below. It had been a
// real show-stopper: every migration WP through WP-078 excluded it, and
// deleting Pages/testcases.tsx (WP-074's own cutover) removed the only UI
// that ever created a test case at all. `entityId` being a draft sentinel
// (store's `isDraftEntityId`, `new:<random>`) now branches this component
// into a save-nothing-yet mode: `entityQuery` is disabled outright (there
// is no record for getTcList to fetch), field *definitions* still come
// from getFields(1) exactly as for a real entity (dynamic, DB-driven,
// never hardcoded), and each field's value lives in `draftValues` (a
// useState buffer) until "Create" is pressed. This is the ONE deliberate
// exception to "server state lives only in React Query" mentioned below --
// there is no server record yet for React Query to hold, so a plain
// buffer is the only place a not-yet-saved edit CAN live. It is discarded
// the instant the real entity exists: EntityDetail.tsx keys this
// component by entityId, and Create swaps the tab's entityId (via
// `replaceTab`) from the draft sentinel to the new business id, which
// remounts this component fresh under that key.
//
// WP-074e Part 1a: LifecycleStatus (Components/governance/LifecycleStatus.tsx,
// Sprint 2.1 governance) WAS rendered by TabContent.tsx:637-650 for this
// module but never made it into this file when it was written -- deleting
// Pages/testcases.tsx then made it unreachable (a GR-4 violation). Restored
// below via the shared LifecycleStatusSection kit component (also used by
// RequirementDetail, WP-075), gated the same way TabContent gated it: only
// once the record has actually loaded a status.
//
// Server state lives ONLY in React Query, keyed via qk.entity (fields
// definitions use their own key -- they are not per-entity data). There is
// no useState mirror of either query's data anywhere in this file.
export function TestCaseDetail({ entityId }: TestCaseDetailProps): JSX.Element {
  const projectId = getCurrentProjectId();
  // RBAC. The legacy page gated its Edit affordance on can('write')
  // (TabContent.tsx:631); per-field inline edit removed that single
  // button and nothing replaced it, so read-only users were shown
  // editable fields whose writes the backend then rejected.
  const { can } = usePermissions();
  const canWrite = can('write');
  const queryClient = useQueryClient();
  const setTabDirty = useWorkbench((state) => state.setTabDirty);
  const replaceTab = useWorkbench((state) => state.replaceTab);
  const selection = useWorkbench((state) => state.selection[MODULE_ID]);
  const expandedIds = useWorkbench((state) => state.expanded[MODULE_ID]);
  const thisTabKey = tabKey(MODULE_ID, entityId);
  const isDraft = isDraftEntityId(entityId);
  const { sub, name, preferred_username } = (keycloak.tokenParsed as KeycloakTokenParsed | undefined) ?? {};

  // Local, ephemeral UI state ONLY (an error banner's text) -- not a copy
  // of server data.
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // WP-F06 Task 5 -- the two dialogs the Steps tab toolbar opens: picking
  // a shared step to insert, and managing the library itself. Neither
  // holds server state of its own (both fetch through their own
  // react-query hooks); this is just which one is open right now.
  const [sharedStepPickerOpen, setSharedStepPickerOpen] = useState(false);
  const [sharedStepManagerOpen, setSharedStepManagerOpen] = useState(false);
  // WP-F07a Task 4 -- the dataset library's own CRUD surface (its bind
  // side lives in DatasetBindControl, rendered inline below, not as a
  // dialog). No server state of its own, same as the two above.
  const [datasetManagerOpen, setDatasetManagerOpen] = useState(false);
  // WP-F08 Task 2 -- "Save as template" dialog, local open/close state
  // only (mirrors the three above); the actual capture happens inside
  // SaveAsTemplateDialog itself, fed this component's own already-loaded
  // `values` once it's known below.
  const [saveAsTemplateOpen, setSaveAsTemplateOpen] = useState(false);
  // Which of the bound dataset's rows to preview, or null for "no
  // preview" (the default -- R3's "preview off by default"). Reset
  // whenever the entity or its binding changes so a stale row index from
  // a PREVIOUS dataset (which may not have that many rows, or any dataset
  // at all) never silently carries over.
  const [previewRowIndex, setPreviewRowIndex] = useState<number | null>(null);

  // WP-079 Part A -- the one legitimate exception to "server state lives
  // only in React Query" (see the header comment above): a draft has no
  // server record yet, so its in-progress edits have nowhere else to
  // live. `draftValues` mirrors the shape FieldGrid/DetailHeader read from
  // a real entity's `values` (flattened dynamic fields included);
  // `draftSteps` mirrors `steps`. Both are only ever read when
  // `isDraft` -- a real entity's rendering path below never touches them.
  const [draftValues, setDraftValues] = useState<TestCaseRecord>({});
  const [draftSteps, setDraftSteps] = useState<StepRow[]>(DEFAULT_STEPS);

  // Wave B-4 (clone) -- seeds the draft buffer from a recorded prefill
  // (the tree row's "Clone" action, useCloneEntity.ts) exactly once, the
  // same pattern DefectDetail.tsx's own A6 draftIntent effect uses.
  // `TestSteps` is pulled out separately: it belongs to `draftSteps`, a
  // state this component keeps apart from `draftValues` (see the Steps
  // tab below), not a field FieldGrid itself ever renders.
  const draftPrefill = useWorkbench((state) => (isDraft ? state.draftPrefill[entityId] : undefined));
  useEffect(() => {
    if (isDraft && draftPrefill) {
      const { TestSteps, ...rest } = draftPrefill;
      setDraftValues((prev) => ({ ...prev, ...rest }));
      if (Array.isArray(TestSteps) && TestSteps.length > 0) {
        setDraftSteps(TestSteps as StepRow[]);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDraft, draftPrefill]);

  const fieldsQuery = useQuery({
    // Field *definitions*, not entity data -- deliberately not qk.entity.
    // Loaded for a draft too: fields stay dynamic and DB-driven regardless
    // of whether the record behind them exists yet.
    queryKey: ['project', projectId, MODULE_ID, 'fields'] as const,
    queryFn: () => getFields(MODULE_ID) as Promise<FieldDefinition[]>,
  });

  const entityQuery = useQuery({
    queryKey: qk.entity(projectId, MODULE_ID, entityId),
    queryFn: async (): Promise<TestCaseRecord> => {
      const rows = await getTcList(`TestCaseId=${entityId}`);
      const row = (rows && rows[0]) || {};
      // Matches TabContent.tsx:262's
      // `Object.assign(tcValues[0], tcValues[0]['dynamicFields'])` --
      // dynamic field values are flattened onto the top level so FieldGrid
      // can read them by plain fieldName regardless of isDefault.
      return { ...row, ...((row as { dynamicFields?: Record<string, unknown> }).dynamicFields ?? {}) };
    },
    // A draft sentinel names no real record -- there is nothing to fetch,
    // so this query must never fire for one (not even once, and not as a
    // 404 caught and ignored: firing it at all would be a request against
    // a nonexistent id).
    enabled: !isDraft,
  });

  const fields = fieldsQuery.data ?? [];
  const values: TestCaseRecord = isDraft ? draftValues : entityQuery.data ?? {};
  const steps = isDraft
    ? draftSteps
    : values.TestSteps && values.TestSteps.length > 0
      ? values.TestSteps
      : DEFAULT_STEPS;

  // WP-F06 Task 6 fix round 1 -- `sharedStepTitle` on a stored row is a
  // snapshot taken at insert time (TestStepSchema has no way to keep it in
  // sync), so it goes stale the instant the referenced shared step is
  // renamed: the stored value never changes, only the live library does.
  // Resolve against the SAME list SharedStepPicker/SharedStepManagerDialog
  // already query (identical key, so a rename made in the manager is
  // reflected here with no extra fetch), and fall back to the stored value
  // only when the live list hasn't loaded yet or no longer has this id (a
  // deleted shared step's already-inserted references keep showing their
  // last known title instead of going blank). `enabled` skips the fetch
  // entirely for the common case of a test case with no shared-step
  // references at all.
  const sharedStepTitlesQuery = useQuery({
    queryKey: ['sharedsteps', projectId] as const,
    queryFn: () => listSharedSteps(),
    enabled: steps.some((s) => !!s.sharedStepId),
  });
  const sharedStepTitleById = new Map(
    (sharedStepTitlesQuery.data ?? []).map((s) => [s._id, s.title] as const)
  );
  const resolveStepTitles = (rows: StepRow[]): StepRow[] =>
    rows.map((row) =>
      row.sharedStepId && sharedStepTitleById.has(row.sharedStepId)
        ? { ...row, sharedStepTitle: sharedStepTitleById.get(row.sharedStepId) }
        : row
    );
  const displaySteps = resolveStepTitles(steps);

  // WP-F07a Task 4 -- see this file's own `useState` comment above: a
  // stale row index from a previous entity/binding must never silently
  // carry over. isDraft is excluded from the dep list on purpose --
  // draft mode never renders DatasetBindControl at all (no saved `_id`
  // for /parameters yet), so there is nothing to reset there.
  useEffect(() => {
    setPreviewRowIndex(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId, values.datasetId]);

  // R3 (the rule this whole task exists to uphold): this query's result is
  // used ONLY to render the read-only preview column below -- it is never
  // written into `steps`/`displaySteps`/`draftSteps`, and nothing derived
  // from it is ever passed to commitSteps/updateTestCase. `substitute` is
  // sent as a plain non-negative integer string built from a number this
  // component itself set via DatasetBindControl's row Select -- never an
  // empty string (Task 3's contract rejects `?substitute=` with no value
  // as 400; `enabled` below simply omits the whole query, and therefore
  // the whole param, whenever no row is selected).
  const previewQuery = useQuery({
    queryKey: ['testcase-preview', projectId, entityId, previewRowIndex] as const,
    queryFn: async (): Promise<TestCaseRecord | null> => {
      const rows = await getTcList(`TestCaseId=${entityId}&substitute=${previewRowIndex}`);
      return (rows && rows[0]) || null;
    },
    enabled: !isDraft && previewRowIndex !== null,
  });
  const previewRows = alignPreviewToAuthored(
    displaySteps,
    previewQuery.data?.TestSteps as SubstitutedStepRow[] | undefined
  );
  const previewActive = previewRowIndex !== null;

  // WP-079 Part A -- saves the draft buffer, in the shape TabContent's own
  // new-test-case branch built it in (TabContent.tsx:472-479): TestCaseSummary/
  // TestCaseDescription/TestSteps top-level, every other field split by its
  // own definition's `isDefault` (top-level if true, nested under
  // `dynamicFields` if false) -- exactly commitField's per-field rule above,
  // just applied to the whole buffer at once instead of one field at a time.
  // parentId is resolved from whatever is selected in the tree RIGHT NOW
  // (folderStructure.tsx's rule: a selected folder's own id, else a
  // selected leaf's parent, else root) -- captured once per Create attempt,
  // not on every render, so a save mid-flight is not retargeted by a
  // selection change.
  const createTestCase = useMutation({
    mutationFn: async () => {
      const parentId = resolveSelectedParentId(queryClient, projectId, MODULE_ID, selection, expandedIds);
      const payload: Record<string, unknown> = {
        parentId: Number(parentId),
        updatedBy: preferred_username,
        TestCaseSummary: draftValues.TestCaseSummary ?? '',
        TestCaseDescription: draftValues.TestCaseDescription ?? '',
        TestSteps: draftSteps,
        // WP-F05b fix round 1 -- `tags` is a fixed schema field (Task 1),
        // not one of the admin-configured Fields Configuration entries
        // `fields.forEach` below loops over, so without this explicit line
        // a tag typed into TagsSection while creating a draft was silently
        // dropped: the chips appeared, Create fired, and the saved record
        // came back with no tags and no error. `?? []`, never `null` --
        // the model rejects `tags: null` with a 400 (Task 1).
        tags: draftValues.tags ?? [],
        // WP-F07a Task 5 fix round 1 -- `datasetId` is the exact same
        // class of field as `tags` immediately above: a fixed schema field
        // (models/testrepo.js), not one of the admin-configured Fields
        // Configuration entries the `fields.forEach` loop below iterates
        // over (module 1 declares no `datasetId` field). Without this
        // explicit line, cloning a parameterised case (useCloneEntity.ts's
        // buildClonePlan flattens the source record -- `datasetId` included
        // -- into `draftPrefill`, which the effect above spreads into
        // `draftValues` just fine) silently dropped the binding on Create:
        // `draftValues.datasetId` held the source case's real binding the
        // whole time, but nothing ever copied it into this payload, so the
        // clone kept its `{{placeholders}}` and lost the dataset with no
        // error anywhere. `?? null` (never `undefined`) matches
        // DatasetBindControl's own unbind value and models/testrepo.js's
        // unconstrained `ObjectId` path -- an ordinary (non-clone) create
        // sends `datasetId: null`, which the backend's own falsy check
        // (`if (reqdetails.datasetId)`) already treats as "no binding",
        // identical to the field being absent.
        datasetId: (draftValues.datasetId as string | null | undefined) ?? null,
        dynamicFields: {},
      };
      fields.forEach((field) => {
        if (field.fieldName === 'TestCaseSummary' || field.fieldName === 'TestCaseDescription') return;
        if (!(field.fieldName in draftValues)) return;
        if (field.isDefault) {
          payload[field.fieldName] = draftValues[field.fieldName];
        } else {
          (payload.dynamicFields as Record<string, unknown>)[field.fieldName] = draftValues[field.fieldName];
        }
      });
      const saved = (await saveTestCase(payload)) as { TestCaseId?: string };
      return { saved, parentId };
    },
    onSuccess: ({ saved, parentId }) => {
      const newId = String(saved.TestCaseId ?? '');
      replaceTab(thisTabKey, { module: MODULE_ID, entityId: newId, title: newId });
      // The tree (Hooks/queries/useTreeChildren.ts, read by EntityTree)
      // caches exactly this key per parent -- invalidating it is what
      // makes the freshly-created row appear without a manual refresh.
      queryClient.invalidateQueries({ queryKey: qk.children(projectId, MODULE_ID, parentId) });
    },
    onError: () => {
      setErrorMessage('Could not create the test case. Please try again.');
    },
  });

  // Per-field commit -- replaces TabContent's page-level handleSave
  // (TabContent.tsx:397-507, the `selectedModule === 1` / not-new branch).
  // Sends only the one changed field, shaped exactly like TabContent's
  // updateData: dynamicFields for non-default fields, top-level for
  // default ones.
  const commitField = useMutation({
    mutationFn: async ({ fieldName, value }: { fieldName: string; value: unknown }) => {
      const fieldDef = fields.find((f) => f.fieldName === fieldName);
      const payload: Record<string, unknown> = { updatedBy: preferred_username };
      if (fieldDef && !fieldDef.isDefault) {
        payload.dynamicFields = { [fieldName]: value };
      } else {
        payload[fieldName] = value;
      }
      return updateTestCase(payload, values._id);
    },
    onMutate: async ({ fieldName, value }) => {
      await queryClient.cancelQueries({ queryKey: qk.entity(projectId, MODULE_ID, entityId) });
      const previous = queryClient.getQueryData<TestCaseRecord>(qk.entity(projectId, MODULE_ID, entityId));
      queryClient.setQueryData<TestCaseRecord>(qk.entity(projectId, MODULE_ID, entityId), (old) => ({
        ...(old ?? {}),
        [fieldName]: value,
      }));
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(qk.entity(projectId, MODULE_ID, entityId), context.previous);
      }
      setErrorMessage('Could not save that change. Please try again.');
    },
    onSuccess: () => {
      setTabDirty(thisTabKey, false);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: qk.entity(projectId, MODULE_ID, entityId) });
    },
  });

  const commitSteps = useMutation({
    mutationFn: async (newSteps: StepRow[]) => updateTestCase({ TestSteps: newSteps }, values._id),
    onMutate: async (newSteps) => {
      await queryClient.cancelQueries({ queryKey: qk.entity(projectId, MODULE_ID, entityId) });
      const previous = queryClient.getQueryData<TestCaseRecord>(qk.entity(projectId, MODULE_ID, entityId));
      queryClient.setQueryData<TestCaseRecord>(qk.entity(projectId, MODULE_ID, entityId), (old) => ({
        ...(old ?? {}),
        TestSteps: newSteps,
      }));
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(qk.entity(projectId, MODULE_ID, entityId), context.previous);
      }
      setErrorMessage('Could not save the test steps. Please try again.');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: qk.entity(projectId, MODULE_ID, entityId) });
    },
  });

  const handleLifecycleError = (message: string) => {
    setErrorMessage(message);
  };

  // In DRAFT mode this must also accumulate the value, not just flag the
  // tab dirty. FieldGrid's controls only call onFieldCommit on blur, so a
  // user who typed into a field and clicked Create directly -- without
  // moving focus first -- lost that field entirely: the backend either
  // rejected the record for a missing mandatory value or saved it
  // incomplete. Writing through on change costs nothing here (the draft
  // buffer is local state, no request), and removes the whole class of
  // "value only lands if you happen to click elsewhere first".
  const handleFieldChange = (fieldName?: string, value?: unknown) => {
    setTabDirty(thisTabKey, true);
    if (isDraft && fieldName !== undefined) {
      setDraftValues((prev) => ({ ...prev, [fieldName]: value }));
    }
  };
  // Draft: no server record to PUT a single field to yet -- accumulate
  // into the draft buffer instead. Real entity: unchanged, per-field
  // commit via commitField.
  const handleFieldCommit = (fieldName: string, value: unknown) => {
    if (isDraft) {
      setDraftValues((prev) => ({ ...prev, [fieldName]: value }));
      return;
    }
    commitField.mutate({ fieldName, value });
  };

  // WP-F06 Task 5 -- appends a reference row (SharedStepPicker.tsx's
  // onInsert shape: `{ sharedStepId, sharedStepTitle }`, never the shared
  // step's expanded text -- see that file's header comment for why) to
  // whichever steps collection is authoritative right now. Draft: no
  // server record exists yet, so this goes straight into the same
  // `draftSteps` buffer createTestCase.mutate() later sends as
  // `TestSteps`. Real entity: routed through the same commitSteps
  // mutation the Steps tab's own add/delete/edit path already uses, so
  // this is one more caller of that mutation, not a second write path.
  const insertSharedStep = (row: { sharedStepId: string; sharedStepTitle: string }) => {
    // testStep/Expected are required by StepRow's shape (and by
    // TableRows.tsx, which reads them before ever checking sharedStepId on
    // rows that don't have it) -- empty strings here are never rendered:
    // TableRows.tsx's `row.sharedStepId` branch shows sharedStepTitle
    // instead and never reads either field.
    const nextSteps: StepRow[] = [...steps, { testStep: '', Expected: '', ...row }];
    if (isDraft) {
      handleFieldChange();
      setDraftSteps(nextSteps);
    } else {
      commitSteps.mutate(nextSteps);
    }
  };

  if (fieldsQuery.isLoading || (!isDraft && entityQuery.isLoading)) {
    return <CircularProgress aria-label={`Loading ${entityId}`} />;
  }
  if (!isDraft && entityQuery.isError) {
    return <Alert severity="error">Could not load this test case.</Alert>;
  }

  if (isDraft) {
    return (
      <Box>
        {errorMessage && (
          <Alert severity="error" onClose={() => setErrorMessage(null)} sx={{ mb: 2 }}>
            {errorMessage}
          </Alert>
        )}
        <DetailHeader id="New Test Case" />
        <Box mb={2}>
          {/* TestCaseSummary is excluded from FieldGrid (same as the real
              entity path below) -- rendered here instead, mirroring
              TabContent.tsx:666-673's dedicated Summary box. */}
          <FormLabel htmlFor="Summary">Summary</FormLabel>
          <TextField
            id="Summary"
            fullWidth
            multiline
            minRows={2}
            size="small"
            sx={{ mt: 1 }}
            value={(draftValues.TestCaseSummary as string) ?? ''}
            onChange={(e) => {
              handleFieldChange();
              setDraftValues((prev) => ({ ...prev, TestCaseSummary: e.target.value }));
            }}
          />
        </Box>
        <Box mb={2}>
          <TagsSection
            module={MODULE_ID}
            entityId={entityId}
            tags={draftValues.tags ?? []}
            onChange={(nTags) => handleFieldCommit('tags', nTags)}
            readOnly={!canWrite}
          />
        </Box>
        <DetailTabs
          tabs={[
            {
              label: 'Details',
              content: (
                <FieldGrid
                  readOnly={!canWrite}
                  fields={fields}
                  values={draftValues}
                  onFieldChange={handleFieldChange}
                  onFieldCommit={handleFieldCommit}
                />
              ),
            },
            {
              label: 'Steps',
              content: (
                <Box>
                  {canWrite ? (
                    <Stack direction="row" spacing={1} mb={1}>
                      <Button
                        size="small"
                        variant="outlined"
                        startIcon={<PlaylistAddIcon fontSize="small" />}
                        onClick={() => setSharedStepPickerOpen(true)}
                      >
                        Insert shared step…
                      </Button>
                      <Button
                        size="small"
                        variant="outlined"
                        startIcon={<LibraryBooksIcon fontSize="small" />}
                        onClick={() => setSharedStepManagerOpen(true)}
                      >
                        Manage shared steps…
                      </Button>
                      <Button
                        size="small"
                        variant="outlined"
                        startIcon={<TableChartIcon fontSize="small" />}
                        onClick={() => setDatasetManagerOpen(true)}
                      >
                        Manage datasets…
                      </Button>
                    </Stack>
                  ) : null}
                  {/* WP-F07a Task 4 -- no DatasetBindControl here: binding
                      reads/writes GET/PUT /api/v1/testrepo/:id, which
                      needs a real, already-saved `_id` a draft doesn't
                      have yet. Same exclusion rule as the Links/Comments
                      tabs below this one -- bind it after Create. */}
                  <TCStepsContext.Provider
                    value={{
                      tcSteps: displaySteps,
                      setTcSteps: (nSteps: StepRow[]) => {
                        handleFieldChange();
                        setDraftSteps(nSteps);
                      },
                    }}
                  >
                    <AddDeleteTableRows rows={displaySteps} editable module={MODULE_ID} />
                  </TCStepsContext.Provider>
                </Box>
              ),
            },
            // No Links/Comments tab here -- both key off a real business
            // id (issueId/typeId), which a draft does not have yet. Owner
            // decision recorded in this WP's dispatch: no attachments at
            // test-case level either, so that section is never added here.
          ]}
        />
        <Box mt={2}>
          <Button
            variant="contained"
            color="primary"
            onClick={() => createTestCase.mutate()}
            disabled={createTestCase.isPending}
          >
            Create
          </Button>
        </Box>
        <SharedStepPicker
          projectId={projectId}
          open={sharedStepPickerOpen}
          onClose={() => setSharedStepPickerOpen(false)}
          onInsert={insertSharedStep}
        />
        <SharedStepManagerDialog
          projectId={projectId}
          open={sharedStepManagerOpen}
          onClose={() => setSharedStepManagerOpen(false)}
        />
        <DatasetManagerDialog
          projectId={projectId}
          open={datasetManagerOpen}
          onClose={() => setDatasetManagerOpen(false)}
        />
      </Box>
    );
  }

  return (
    <Box>
      {errorMessage && (
        <Alert severity="error" onClose={() => setErrorMessage(null)} sx={{ mb: 2 }}>
          {errorMessage}
        </Alert>
      )}
      <DetailHeader id={values.TestCaseId ?? entityId} summary={values.TestCaseSummary}>
        {values.status && (
          <Box mt={0.5}>
            <LifecycleStatusSection
              projectId={projectId}
              module={MODULE_ID}
              entityId={entityId}
              mongoId={values._id ?? ''}
              entityIdLabel={values.TestCaseId ?? entityId}
              status={values.status as string}
              entityType="testcase"
              onError={handleLifecycleError}
            />
          </Box>
        )}
      </DetailHeader>
      {/* WP-F08 Task 2 -- captures the record as it stands right now (R4:
          a snapshot, not a live link -- editing this case afterward never
          touches templates already made from it, and vice versa). Gated on
          canWrite exactly like the Steps tab toolbar below: saving a
          template is a write action. */}
      {canWrite && (
        <Box mb={2}>
          <Button
            size="small"
            variant="text"
            startIcon={<SaveAsOutlinedIcon fontSize="small" />}
            onClick={() => setSaveAsTemplateOpen(true)}
          >
            Save as template…
          </Button>
        </Box>
      )}
      <Box mb={2}>
        <TagsSection
          module={MODULE_ID}
          entityId={entityId}
          tags={values.tags ?? []}
          onChange={(nTags) => handleFieldCommit('tags', nTags)}
          readOnly={!canWrite}
        />
      </Box>
      <DetailTabs
        tabs={[
          {
            label: 'Details',
            content: (
              <FieldGrid
                readOnly={!canWrite}
                fields={fields}
                values={values}
                onFieldChange={handleFieldChange}
                onFieldCommit={handleFieldCommit}
              />
            ),
          },
          {
            label: 'Steps',
            content: (
              <Box>
                {/* WP-F06 Task 5 -- insert a reference to a shared step, or
                    open the library's own CRUD surface. Both gated on
                    canWrite: inserting mutates this test case's steps, and
                    a viewer has no legitimate action inside the manager
                    either (its own create/edit/delete controls are gated
                    the same way -- see SharedStepManagerDialog.tsx). */}
                {canWrite ? (
                  <Stack direction="row" spacing={1} mb={1}>
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<PlaylistAddIcon fontSize="small" />}
                      onClick={() => setSharedStepPickerOpen(true)}
                    >
                      Insert shared step…
                    </Button>
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<LibraryBooksIcon fontSize="small" />}
                      onClick={() => setSharedStepManagerOpen(true)}
                    >
                      Manage shared steps…
                    </Button>
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<TableChartIcon fontSize="small" />}
                      onClick={() => setDatasetManagerOpen(true)}
                    >
                      Manage datasets…
                    </Button>
                  </Stack>
                ) : null}
                {/* WP-F07a Task 4 -- bind ONE dataset to this case and pick
                    a row to preview. Binding writes `datasetId` through
                    commitField (a plain top-level field, same write path
                    every other default field on this record already
                    uses); the row selection never reaches any write path
                    at all (see previewQuery's own header comment above --
                    R3, the whole point of this task). */}
                <Box mb={2}>
                  <DatasetBindControl
                    projectId={projectId}
                    testCaseId={values._id}
                    datasetId={values.datasetId ?? null}
                    canWrite={canWrite}
                    onBind={(nextDatasetId) => commitField.mutate({ fieldName: 'datasetId', value: nextDatasetId })}
                    previewRowIndex={previewRowIndex}
                    onPreviewRowChange={setPreviewRowIndex}
                  />
                </Box>
                {previewActive && previewQuery.isError ? (
                  <Alert severity="error" sx={{ mb: 1 }}>
                    Could not load the preview for this row.
                  </Alert>
                ) : null}
                {/* AddDeleteTableRows (Components/Tabs/AddDeleteTableRows.tsx)
                    is reused as-is -- it still expects TCStepsContext, so this
                    just points that context's setter at the steps mutation
                    instead of a page-level useState<TestSteps>, keeping no
                    parallel copy of server data here. `previewRows` is a
                    separate, parallel prop (see AddDeleteTableRows.tsx's own
                    header comment) -- it is never folded into `displaySteps`,
                    so `setTcSteps`/`commitSteps.mutate` below only ever sees
                    the authored rows, `{{placeholders}}` intact. */}
                <TCStepsContext.Provider value={{ tcSteps: displaySteps, setTcSteps: (nSteps: StepRow[]) => commitSteps.mutate(nSteps) }}>
                  <AddDeleteTableRows
                    rows={displaySteps}
                    editable
                    module={MODULE_ID}
                    previewRows={previewActive ? previewRows : undefined}
                  />
                </TCStepsContext.Provider>
              </Box>
            ),
          },
          {
            label: 'Links',
            content: <LinksSection srcModule={MODULE_ID} summary={values.TestCaseSummary} issueId={entityId} />,
          },
        ]}
      />
      <Divider sx={{ my: 2 }} />
      <CommentsSection moduleId={MODULE_ID} typeId={entityId} userName={name} userId={sub} />
      <SharedStepPicker
        projectId={projectId}
        open={sharedStepPickerOpen}
        onClose={() => setSharedStepPickerOpen(false)}
        onInsert={insertSharedStep}
      />
      <DatasetManagerDialog
        projectId={projectId}
        open={datasetManagerOpen}
        onClose={() => setDatasetManagerOpen(false)}
      />
      <SharedStepManagerDialog
        projectId={projectId}
        open={sharedStepManagerOpen}
        onClose={() => setSharedStepManagerOpen(false)}
      />
      <SaveAsTemplateDialog
        projectId={projectId}
        module={MODULE_ID}
        open={saveAsTemplateOpen}
        onClose={() => setSaveAsTemplateOpen(false)}
        record={values}
      />
    </Box>
  );
}

export default TestCaseDetail;
