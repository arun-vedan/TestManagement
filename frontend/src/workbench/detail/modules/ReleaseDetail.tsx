import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Chip,
  CircularProgress,
  Collapse,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  FormLabel,
  IconButton,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import { DataGrid, GridColDef, GridSortCellParams, GridToolbarQuickFilter } from '@mui/x-data-grid';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import LinkIcon from '@mui/icons-material/Link';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getFields, getTestPlanList } from '../../../api/apiCalls';
import {
  GateStatus,
  QualityGateRule,
  RELEASE_STATUSES,
  Release,
  deleteRelease,
  getGateStatus,
  getRelease,
  linkTestPlan,
  unlinkTestPlan,
  updateRelease,
} from '../../../api/releaseApi';
import { ReleaseLensData, getReleaseLens, reportErrorMessage } from '../../../api/reportApi';
import { getCurrentProjectId } from '../../../currentProject';
import { qk } from '../../../Hooks/queryKeys';
import keycloak from '../../../keycloak';
import { tabKey } from '../../store/workbenchStore';
import { useWorkbench } from '../../WorkbenchStoreProvider';
import { StatusChip, StatusChipColor } from '../../../Components/common/StatusChip';
import { isUnresolvedDefectStatus } from '../../../Components/common/defectStatusRules';
import { AiSummaryPanel } from '../../../Components/AI/AiSummaryPanel';
import { AiAvailable } from '../../../Components/AI/AiAvailable';
import DetailHeader from '../DetailHeader';
import { FieldDefinition, FieldGrid } from '../FieldGrid';
import DetailTabs from '../DetailTabs';
import LinksSection from '../LinksSection';
import CommentsSection from '../CommentsSection';
import { usePermissions } from '../../../Hooks/usePermissions';
import { STATUS_KEYS } from './TestRunDetail';

export interface ReleaseDetailProps {
  entityId: string;
}

// Module id for Releases (src/workbench/modules.ts's ModuleId 6).
const MODULE_ID = 6;

interface KeycloakTokenParsed {
  sub?: string;
  name?: string;
  preferred_username?: string;
}

interface TestPlanOption {
  _id: string;
  TestPlanId: string;
}

// Widened with an index signature so a `Release` (or the `{}` shown while
// loading) can be handed to FieldGrid's `values` prop as-is, the same way
// every sibling module's own *Record type does (e.g. DefectDetail's
// DefectRecord) -- FieldGrid only ever reads named properties off it, it
// never depends on `Release`'s own narrower field types.
interface ReleaseValues extends Partial<Release> {
  [key: string]: unknown;
}

const RELEASE_STATUS_COLORS: Record<string, StatusChipColor> = {
  planned: 'default',
  'in-progress': 'info',
  frozen: 'warning',
  released: 'success',
  cancelled: 'error',
};

const GATE_RESULT_COLORS: Record<string, StatusChipColor> = {
  pass: 'success',
  fail: 'error',
};

// WP-F24 Task 1 -- this used to say fabricating a getFields(6) call would
// be dishonest against a collection nothing populated. That was true when
// it was written; it stopped being true the moment this task added the
// call below. The premise it was protecting against is real, though, so it
// is recorded here precisely instead of just deleted:
//
// Verified live against this environment's own Mongo (2026-09-25, via
// mongosh, read-only aggregate/distinct/count -- srckube-fields.fields and
// srckube-user.projects): of 622 projects, exactly ONE (project 1) has any
// field-DEFINITION documents at all, and module 6 (releases) has ZERO
// anywhere, same as module 3. There is no bootstrap that seeds a new
// project with defaults. TestCaseDetail.tsx/RequirementDetail.tsx (modules
// 1/2) read `const fields = fieldsQuery.data ?? []` with nothing to fall
// back to -- verified by reading both files -- so on any project other than
// 1, their own Details tab renders whatever FieldGrid does with an empty
// `fields` array: nothing. That is those modules' latent gap, not a
// pattern to copy here.
//
// R1: `getFields(6)` (below) SUPPLEMENTS this fixed list, it never
// replaces it. A release's name/status/notes are load-bearing -- deleting
// or hiding one through Settings would break the entity, not customise it
// -- so they are declared here directly and are never at the mercy of
// whatever module-6 field documents a project does or does not have.
// Whatever getFields(6) DOES return is merged on top by
// mergeConfiguredReleaseFields, below, so a project that eventually gets
// module-6 field definitions (today none do) sees them appear alongside
// these, and the 621-projects-with-nothing-configured case renders exactly
// this list and nothing else.
//
// `targetDate` is handled separately below via its own field (a native
// date input): FieldGrid has no date field type (R5 -- out of scope for
// this task to add one, it would touch five other consumers), the same
// reason TestPlanDetail hand-rolls its own Planned Start/End controls
// instead of routing them through FieldGrid.
const RELEASE_FIELDS: FieldDefinition[] = [
  { fieldName: 'name', displayName: 'Name', fieldType: 'Text', isDisplayed: true, isMandatory: true, isDefault: true },
  {
    fieldName: 'status',
    displayName: 'Status',
    fieldType: 'DropDown',
    isDisplayed: true,
    isMandatory: true,
    isDefault: true,
    defaultValue: [...RELEASE_STATUSES],
  },
  { fieldName: 'notes', displayName: 'Notes', fieldType: 'TextArea', isDisplayed: true, isMandatory: false, isDefault: true },
];

// R2 -- the collision rule, decided and made visible here rather than left
// as an accident of iteration order: a configured field whose `fieldName`
// matches one of the built-ins above does not get a second row (a release
// has exactly one 'status'), and is not silently swallowed either -- that
// silent-no-op is the one outcome R2 forbids, because a user who adds a
// 'status' field in Settings and sees this form completely unchanged will
// conclude Settings itself is broken, which is the exact complaint that
// opened this whole work package. Instead the built-in's `displayName` is
// replaced by the configured field's own `displayName`, when it set a
// non-empty one, so the collision surfaces exactly where the user is
// already looking -- on the form itself, immediately. Every other
// built-in property (`fieldType`, `isMandatory`, `isDefault`,
// `defaultValue`) is left untouched: R1 forbids a built-in from being
// weakened into something deletable, hideable, or differently typed --
// only its label may change.
//
// Non-colliding configured fields are appended after the built-ins,
// unfiltered here -- `FieldGrid` itself already drops anything with
// `isDisplayed: false` (its own `visibleFields` filter), so this function
// does not need to re-implement that.
// WP-F24 Task 1 (fix round 2) -- MAJOR finding: the collision guard above
// only ever protected the three `RELEASE_FIELDS` names. `targetDate` is a
// fourth top-level `Release` attribute -- rendered outside `FieldGrid`
// entirely (R5) -- that this guard never looked at, and the reviewer traced
// the live failure: a configured field literally named `targetDate` was
// appended as a normal addition, rendered a SECOND time inside `FieldGrid`,
// and (being `isDefault`-less) committed into `dynamicFields.targetDate` --
// which the old `{ ...rawValues, ...dynamicFields }` spread order let
// silently shadow the real date picker's own value, with no error anywhere.
// `linkedTestPlanIds`/`qualityGates`/`releaseId`/etc. are exactly as
// exposed (an array or object replaced by a string, or the Lens's own query
// key silently re-pointed) -- the reviewer's point stands that `targetDate`
// was only the name the trace happened to start from.
//
// Rather than hand-list `targetDate` as a fourth name beside the three
// above (this programme's own "a rule expressed twice drifts" pattern,
// hit five times already per the coordinator), this Set is DERIVED from
// the `Release` interface itself (api/releaseApi.ts) via `keyof Release`,
// so drift is a COMPILE ERROR, not a documentation debt:
// `Record<keyof Release, true>` requires every key `Release` declares to
// be listed here (omitting a newly-added field is a "Property is missing"
// tsc error) and rejects any key that ISN'T one of `Release`'s own
// (excess-property checking on an object literal) -- so adding, removing,
// or renaming a field on `Release` cannot leave this guard silently
// stale in either direction. This is why the source is the frontend's own
// `Release` interface and not the backend Mongoose schema: importing a
// backend model into frontend code isn't sensible (different runtimes,
// different module systems, and the schema already isn't the frontend's
// own contract -- `Release` in releaseApi.ts is).
const RELEASE_RESERVED_FIELD_MAP: Record<keyof Release, true> = {
  _id: true,
  id: true,
  releaseId: true,
  name: true,
  projectId: true,
  targetDate: true,
  status: true,
  linkedTestPlanIds: true,
  notes: true,
  qualityGates: true,
  dynamicFields: true,
  createdBy: true,
  updatedBy: true,
  createdAt: true,
  updatedAt: true,
};
const RESERVED_RELEASE_FIELD_NAMES: ReadonlySet<string> = new Set(Object.keys(RELEASE_RESERVED_FIELD_MAP));

export interface MergedReleaseFields {
  fields: FieldDefinition[];
  // R2, applied to the class of collision `FieldGrid` has no control for
  // at all (targetDate/linkedTestPlanIds/qualityGates/releaseId/etc, as
  // opposed to a RELEASE_FIELDS collision, which relabels): these
  // fieldNames from `configured` are excluded from `fields` entirely
  // (there is nothing to relabel -- a `qualityGates` control would have
  // to invent a rules editor, not reuse an existing one), but NOT silently
  // -- an admin who names a field `targetDate` deserves to know it does
  // nothing, per R2's "not an invisible no-op". The caller renders this.
  ignoredReservedCollisions: string[];
}

// R2 -- the collision rule, decided and made visible here rather than left
// as an accident of iteration order: a configured field whose `fieldName`
// matches one of the built-ins above does not get a second row (a release
// has exactly one 'status'), and is not silently swallowed either -- that
// silent-no-op is the one outcome R2 forbids, because a user who adds a
// 'status' field in Settings and sees this form completely unchanged will
// conclude Settings itself is broken, which is the exact complaint that
// opened this whole work package. Instead the built-in's `displayName` is
// replaced by the configured field's own `displayName`, when it set a
// non-empty one, so the collision surfaces exactly where the user is
// already looking -- on the form itself, immediately. Every other
// built-in property (`fieldType`, `isMandatory`, `isDefault`,
// `defaultValue`) is left untouched: R1 forbids a built-in from being
// weakened into something deletable, hideable, or differently typed --
// only its label may change.
//
// A collision with a RESERVED name that is NOT one of the three
// `RELEASE_FIELDS` above (fix round 2, see `RELEASE_RESERVED_FIELD_MAP`)
// takes the OTHER branch: excluded from `fields`, recorded in
// `ignoredReservedCollisions` instead of relabelled, since there is no
// `FieldGrid` control representing e.g. `linkedTestPlanIds` to relabel.
//
// Non-colliding configured fields are appended after the built-ins,
// unfiltered here -- `FieldGrid` itself already drops anything with
// `isDisplayed: false` (its own `visibleFields` filter), so this function
// does not need to re-implement that.
export function mergeConfiguredReleaseFields(configured: FieldDefinition[]): MergedReleaseFields {
  const builtInNames = new Set(RELEASE_FIELDS.map((f) => f.fieldName));
  const builtIns = RELEASE_FIELDS.map((builtIn) => {
    const collision = configured.find((f) => f.fieldName === builtIn.fieldName);
    return collision?.displayName ? { ...builtIn, displayName: collision.displayName } : builtIn;
  });
  const additions: FieldDefinition[] = [];
  const ignoredReservedCollisions: string[] = [];
  configured.forEach((field) => {
    if (builtInNames.has(field.fieldName)) return; // handled by the relabel above
    if (RESERVED_RELEASE_FIELD_NAMES.has(field.fieldName)) {
      ignoredReservedCollisions.push(field.fieldName);
      return;
    }
    additions.push(field);
  });
  return { fields: [...builtIns, ...additions], ignoredReservedCollisions };
}

// WP-F15/F18 Task 2 -- the first detail view Releases has ever had in the
// workbench (Task 1 gave module 6 only a list; EntityDetail.tsx's own
// header comment on this cutover records that this was the last of the six
// modules to get one). Content, per the task's own scope: a release's own
// fields (name/status/targetDate/notes), its quality gates alongside their
// CURRENT status (live, via getGateStatus -- api/releaseApi.ts), and its
// linked test plans with add/remove (linkTestPlan/unlinkTestPlan). WP-F18b
// Task 2 added editing of the quality-gate RULES themselves here too (see
// QualityGatesPanel below), through the same updateRelease(id, {
// qualityGates }) call the old standalone nav page's own editor made,
// before WP-F18b Task 4 retired that page and this became the only editor.
// Linking a release to defects/requirements/test cases via the generic
// link graph is added by Task 3 (this file's Links tab, below) -- the
// piece that stops a release being an island.
//
// Releases are not draft-capable (workbench/modules.ts's
// DRAFT_CAPABLE_MODULES excludes module 6 -- see its own comment for why
// this stays a deliberate choice rather than a leftover gap), so unlike
// TestCaseDetail/RequirementDetail/TestPlanDetail/DefectDetail this file has
// no draft-mode branch at all -- the same shape TestRunDetail (module 4,
// also excluded from that set) already has. Create instead happens via
// SourcePanel.tsx's own "New Release" dialog (module-6-only), which opens
// straight into a real, already-saved tab of this component -- there is no
// unsaved/draft state this file ever needs to render.
//
// WP-F18b Task 3 -- delete, the other capability the nav page had
// exclusively until now. Rendered in the header row (below), gated on
// can('delete') independently of can('write') -- a contributor has write
// but not delete (permissions.ts's PERMISSION_MATRIX), so this must not be
// folded into the canWrite check above it. Confirms first, naming the
// release, same as the old standalone nav page's own handleDelete did and
// Components/settings/EnvironmentsPanel.tsx's delete dialog (WP-F18b Task
// 1) still does -- there is no undo on either side of this call.
export function ReleaseDetail({ entityId }: ReleaseDetailProps): JSX.Element {
  const projectId = getCurrentProjectId();
  const { can } = usePermissions();
  const canWrite = can('write');
  // Independent of canWrite -- a contributor has write but NOT delete
  // (permissions.ts's PERMISSION_MATRIX). Folding this into canWrite is
  // the specific regression this file's own header comment warns about.
  const canDelete = can('delete');
  const queryClient = useQueryClient();
  const setTabDirty = useWorkbench((state) => state.setTabDirty);
  const closeTab = useWorkbench((state) => state.closeTab);
  const setSelection = useWorkbench((state) => state.setSelection);
  const currentSelection = useWorkbench((state) => state.selection[MODULE_ID]);
  const thisTabKey = tabKey(MODULE_ID, entityId);
  const { sub, name } = (keycloak.tokenParsed as KeycloakTokenParsed | undefined) ?? {};

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedPlanToLink, setSelectedPlanToLink] = useState('');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // `entityId` here is the release's Mongo `_id`, NOT its human `releaseId`
  // ('REL-n'). Every one of getRelease/updateRelease/linkTestPlan/
  // unlinkTestPlan/getGateStatus keys its `:id` route param off `_id`
  // (backend/releaseService/controllers/releases.js's `Release.findOne({
  // _id: req.params.id, ... })`, repeated in every handler in that file),
  // and entityListConfigs.tsx's releaseConfig.getRowId already hands
  // DataGrid rows `_id` for exactly that reason (Task 1). Every other
  // migrated module's entityId is its own human id because that IS what
  // those services' fetch-by-id routes accept; Releases is the one module
  // where the human id and the lookup key differ.
  const entityQuery = useQuery({
    queryKey: qk.entity(projectId, MODULE_ID, entityId),
    queryFn: async (): Promise<Release> => getRelease(entityId),
  });

  // WP-F24 Task 1 (fix round 1) -- dynamicFields flattened onto the
  // top-level values object so FieldGrid's `values[field.fieldName]`
  // lookup finds a configured field's value the same way it finds a
  // built-in's, same convention RequirementDetail.tsx's own entityQuery
  // uses (`Object.assign(reqValues[0], reqValues[0]['dynamicFields'])`,
  // itself matching TabContent.tsx:222).
  //
  // Fix round 2 (MAJOR) -- the old comment here claimed dynamicFields keys
  // "never" collide with a real top-level field. That was an invariant the
  // CODE did not actually enforce (the exact stale-claim-beside-unenforced-
  // behaviour shape this programme keeps producing): nothing stopped a
  // `dynamicFields.targetDate` from existing and, because it was spread
  // AFTER `rawValues`, silently overwriting the real date's value with no
  // error. `mergeConfiguredReleaseFields` (below) now stops a NEW such key
  // from ever being written via this file's own commit path -- but
  // correctness here must not depend on that guard catching every future
  // caller of `updateRelease`/every future field on `Release`. So the
  // spread itself is made safe independently: any `dynamicFields` entry
  // whose key names a genuine top-level `Release` field (the same
  // `RESERVED_RELEASE_FIELD_NAMES` the merge guard uses -- one source, not
  // a second hand-list) is dropped before the spread, not merely
  // discouraged from being written in the first place.
  const rawValues = (entityQuery.data ?? {}) as ReleaseValues;
  const safeDynamicFields = Object.fromEntries(
    Object.entries((rawValues.dynamicFields as Record<string, unknown>) ?? {}).filter(
      ([key]) => !RESERVED_RELEASE_FIELD_NAMES.has(key),
    ),
  );
  const values: ReleaseValues = { ...rawValues, ...safeDynamicFields };

  // WP-F24 Task 1 -- field *definitions*, not entity data, same convention
  // (and same cache key shape, `['project', projectId, MODULE_ID,
  // 'fields']`) TestCaseDetail.tsx/RequirementDetail.tsx use, and the same
  // key FieldsPanel.tsx invalidates on save -- matching it is what makes a
  // save in Settings show up here without a manual refresh.
  //
  // Deliberately NOT folded into the `entityQuery.isLoading`/`isError`
  // guards below: this query 404s or resolves empty for nearly every
  // project (RELEASE_FIELDS's own header comment above has the verified
  // counts), and R1 requires the built-ins to render regardless -- gating
  // the page on this query succeeding would blank the whole Details tab on
  // exactly the "nothing configured" path this task exists to keep
  // working. `fieldsQuery.data ?? []` is what makes a still-loading OR a
  // permanently-failed query behave identically to "nothing configured":
  // `mergeConfiguredReleaseFields([]).fields` is just `RELEASE_FIELDS` unchanged.
  const fieldsQuery = useQuery({
    queryKey: ['project', projectId, MODULE_ID, 'fields'] as const,
    queryFn: () => getFields(MODULE_ID) as Promise<FieldDefinition[]>,
  });
  const { fields: releaseFields, ignoredReservedCollisions } = mergeConfiguredReleaseFields(fieldsQuery.data ?? []);

  const testPlansQuery = useQuery({
    queryKey: ['project', projectId, MODULE_ID, 'pickable-test-plans'] as const,
    queryFn: async (): Promise<TestPlanOption[]> => getTestPlanList(''),
  });

  const testPlanLabel = (id: string): string => testPlansQuery.data?.find((p) => p._id === id)?.TestPlanId ?? id;

  const commitField = useMutation({
    mutationFn: async (
      patch: Partial<Pick<Release, 'name' | 'status' | 'notes' | 'targetDate' | 'dynamicFields'>>,
    ) => updateRelease(entityId, patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: qk.entity(projectId, MODULE_ID, entityId) });
      const previous = queryClient.getQueryData<Release>(qk.entity(projectId, MODULE_ID, entityId));
      queryClient.setQueryData<Release>(qk.entity(projectId, MODULE_ID, entityId), (old) => {
        const merged: Release = { ...(old as Release), ...patch };
        // A configured field's patch is `{ dynamicFields: { thatOneField:
        // value } }` (handleFieldCommit below) -- a plain `...patch` spread
        // would REPLACE the whole cached `dynamicFields` object with just
        // that one key, optimistically blanking every other configured
        // field's value until the onSettled invalidate below refetches and
        // repairs it. Merged explicitly here so that flash never happens.
        if (patch.dynamicFields) {
          merged.dynamicFields = { ...(old as Release)?.dynamicFields, ...patch.dynamicFields };
        }
        return merged;
      });
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(qk.entity(projectId, MODULE_ID, entityId), context.previous);
      }
      setErrorMessage('Could not save that change. Please try again.');
    },
    onSuccess: () => setTabDirty(thisTabKey, false),
    onSettled: () => queryClient.invalidateQueries({ queryKey: qk.entity(projectId, MODULE_ID, entityId) }),
  });

  const handleFieldChange = () => setTabDirty(thisTabKey, true);
  // WP-F24 Task 1 (fix round 1) -- the branch this file was missing, found
  // and confirmed by the coordinator: `mergeConfiguredReleaseFields`
  // supplying `releaseFields` was never enough on its own, because a
  // configured field's value has nowhere to live on `Release` as a
  // top-level key (backend/releaseService/models/Release.js has no
  // `priority`/etc. path, and never will -- fieldsService is generic
  // across projects, the schema can't declare every project's own field
  // names). Same split RequirementDetail.tsx's own commitField uses: a
  // BUILT-IN field (isDefault: true -- RELEASE_FIELDS above hard-codes
  // this for name/status/notes, and a relabelled collision keeps it via
  // mergeConfiguredReleaseFields's spread) commits as a top-level key,
  // exactly as before; anything else commits into `dynamicFields`, the
  // schema path added in this fix round. `releaseFields` (not the raw
  // `RELEASE_FIELDS` constant) is looked up here specifically so a
  // relabelled collision is still recognised as the built-in it is.
  const handleFieldCommit = (fieldName: string, value: unknown) => {
    const fieldDef = releaseFields.find((f) => f.fieldName === fieldName);
    if (fieldDef && !fieldDef.isDefault) {
      commitField.mutate({ dynamicFields: { [fieldName]: value } });
    } else {
      commitField.mutate({ [fieldName]: value } as Partial<Release>);
    }
  };

  // WP-F18b Task 3 -- same call the old standalone nav page's own
  // handleDelete made (deleteRelease(release._id) -- entityId here IS that _id, per
  // this file's own header comment). Closes this tab and clears the
  // list-scoped selection on success, same "the deleted row must not keep
  // being referenced" discipline Hooks/mutations/useDeleteEntity.ts
  // follows for modules 1/2/3/4/5 (releases have no tree presence to
  // race against -- module 6 returns no tree leaves at all, Hooks/queries/
  // useTreeChildren.ts's fetchLeaves -- but the list view keys off this
  // same `selection[6]`, entityListConfigs.tsx's ReleaseIdCell).
  const deleteReleaseMutation = useMutation({
    mutationFn: async () => deleteRelease(entityId),
    onSuccess: () => {
      setDeleteDialogOpen(false);
      closeTab(thisTabKey);
      if (currentSelection === entityId) {
        setSelection(MODULE_ID, null);
      }
      queryClient.invalidateQueries({ queryKey: ['entityList', MODULE_ID] });
    },
    onError: () => setErrorMessage('Could not delete this release. Please try again.'),
  });

  // Both endpoints return the release's full post-mutation state
  // (backend/releaseService/controllers/releases.js's linkTestPlan/
  // unlinkTestPlan handlers), so the cache is written directly from the
  // response rather than a separate invalidate-and-refetch round trip --
  // same shortcut the old standalone nav page's own refreshManageRelease took.
  //
  // Fix round (Finding 1, MAJOR) -- attaching/detaching a plan changes what
  // the Lens derives (R1: it must never keep showing a plan's derived
  // members after that plan is gone, and must start showing them the
  // moment one is attached). But the lens lives under its OWN query key
  // (['project', pid, 6, 'release-lens', <releaseId>], set by
  // ReleaseLensPanel below), keyed on the release's HUMAN id -- not
  // `qk.entity`'s key, which is keyed on `entityId` (the Mongo `_id`,
  // this file's header comment explains why Releases is the one module
  // where those differ). `setQueryData` above only ever touches the entity
  // key, so it can never reach the lens's cached response -- that
  // required a separate, explicit invalidation here. `updated.releaseId`
  // (the mutation response's own field, not the possibly-stale `values`
  // closure) is used as the human id, since it is that same post-mutation
  // release document.
  const linkPlan = useMutation({
    mutationFn: async (testPlanId: string) => linkTestPlan(entityId, testPlanId),
    onSuccess: (updated) => {
      queryClient.setQueryData(qk.entity(projectId, MODULE_ID, entityId), updated);
      queryClient.invalidateQueries({
        queryKey: ['project', projectId, MODULE_ID, 'release-lens', updated.releaseId],
      });
      setSelectedPlanToLink('');
    },
    onError: () => setErrorMessage('Could not link that test plan. Please try again.'),
  });

  const unlinkPlan = useMutation({
    mutationFn: async (testPlanId: string) => unlinkTestPlan(entityId, testPlanId),
    onSuccess: (updated) => {
      queryClient.setQueryData(qk.entity(projectId, MODULE_ID, entityId), updated);
      queryClient.invalidateQueries({
        queryKey: ['project', projectId, MODULE_ID, 'release-lens', updated.releaseId],
      });
    },
    onError: () => setErrorMessage('Could not unlink that test plan. Please try again.'),
  });

  const linkedTestPlanIds = values.linkedTestPlanIds ?? [];
  const linkableTestPlans = (testPlansQuery.data ?? []).filter((p) => !linkedTestPlanIds.includes(p._id));

  if (entityQuery.isLoading) {
    return <CircularProgress aria-label={`Loading ${entityId}`} />;
  }
  if (entityQuery.isError) {
    return <Alert severity="error">Could not load this release.</Alert>;
  }

  return (
    <Box>
      {errorMessage && (
        <Alert severity="error" onClose={() => setErrorMessage(null)} sx={{ mb: 2 }}>
          {errorMessage}
        </Alert>
      )}
      <Stack direction="row" justifyContent="space-between" alignItems="flex-start" spacing={2}>
        <DetailHeader id={values.releaseId ?? entityId} summary={values.name}>
          {values.status && (
            <Box mt={0.5}>
              <StatusChip status={values.status} colorMap={RELEASE_STATUS_COLORS} />
            </Box>
          )}
        </DetailHeader>
        {canDelete && (
          <Button
            size="small"
            color="error"
            variant="outlined"
            startIcon={<DeleteIcon fontSize="small" />}
            onClick={() => setDeleteDialogOpen(true)}
            sx={{ flexShrink: 0 }}
          >
            Delete
          </Button>
        )}
      </Stack>

      <DetailTabs
        tabs={[
          {
            label: 'Details',
            content: (
              <Box>
                {/* R2 (fix round 2) -- a configured field that collides with
                    a reserved Release attribute FieldGrid has no control
                    for (targetDate/linkedTestPlanIds/qualityGates/etc) is
                    excluded above, but silently excluding it is exactly the
                    invisible no-op R2 forbids -- the admin who created it
                    gets no other signal that it does nothing. Surfaced
                    here, on the same tab, the moment it would otherwise be
                    invisible. */}
                {ignoredReservedCollisions.length > 0 && (
                  <Alert severity="warning" sx={{ mb: 2 }} data-testid="release-ignored-reserved-fields">
                    {`Configured field${ignoredReservedCollisions.length === 1 ? '' : 's'} `}
                    {ignoredReservedCollisions.map((n) => `"${n}"`).join(', ')}
                    {` ${
                      ignoredReservedCollisions.length === 1 ? 'has' : 'have'
                    } the same name as a built-in release attribute that has no editable field here (e.g. Target Date, Linked Test Plans, Quality Gates) and will not appear on this form. Rename it in Settings to use it.`}
                  </Alert>
                )}
                <FieldGrid
                  readOnly={!canWrite}
                  fields={releaseFields}
                  values={values}
                  moduleId={MODULE_ID}
                  entityId={entityId}
                  onFieldChange={handleFieldChange}
                  onFieldCommit={handleFieldCommit}
                />
                <TargetDateField
                  value={values.targetDate}
                  readOnly={!canWrite}
                  onChange={handleFieldChange}
                  onCommit={(next) => handleFieldCommit('targetDate', next)}
                />
                {/* WP-F18b Task 4 -- ported from Pages/releases.tsx's own
                    Manage Release dialog, which was the only place a
                    release-scoped AI summary (scope="release", per
                    Components/AI/AiSummaryPanel.tsx's own WP-053 header
                    comment: "the release page's Manage Release dialog") was
                    reachable. Missed by Tasks 1-3's own premise list (this
                    WP's plan enumerates create/delete/gate-editing/
                    environments as the nav page's exclusive capabilities and
                    does not mention this panel), caught here before deleting
                    that page, not after. */}
                <AiAvailable>
                  <Box mt={4}>
                    <AiSummaryPanel scope="release" releaseId={values.releaseId} title="AI summary" />
                  </Box>
                </AiAvailable>
              </Box>
            ),
          },
          {
            // WP-F15/F18 Task 5 -- the lens (Task 4's
            // GET /reports/release-lens), the piece that finally answers
            // "what is IN this release" from a screen a user actually
            // opens. Keyed off `values.releaseId` (the human id,
            // 'REL-n'), not `entityId` (this component's own Mongo `_id`)
            // -- reportApi.ts's getReleaseLens takes the same param
            // computeReleaseLens's own header comment documents the lens
            // service reads by, and it is the one thing on this page that
            // is NOT keyed by `_id`.
            label: 'Lens',
            content: <ReleaseLensPanel releaseId={values.releaseId} />,
          },
          {
            label: 'Quality Gates',
            content: (
              <QualityGatesPanel releaseId={entityId} qualityGates={values.qualityGates ?? []} canWrite={canWrite} />
            ),
          },
          {
            label: 'Linked Test Plans',
            content: (
              <Box>
                {linkedTestPlanIds.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    No test plans linked yet.
                  </Typography>
                ) : (
                  <Stack spacing={0.5} mb={2}>
                    {linkedTestPlanIds.map((planId) => (
                      <Stack key={planId} direction="row" alignItems="center" spacing={1}>
                        <Typography variant="body2">{testPlanLabel(planId)}</Typography>
                        {canWrite && (
                          <IconButton
                            size="small"
                            aria-label={`Unlink ${testPlanLabel(planId)}`}
                            onClick={() => unlinkPlan.mutate(planId)}
                          >
                            <LinkOffIcon fontSize="small" />
                          </IconButton>
                        )}
                      </Stack>
                    ))}
                  </Stack>
                )}
                {canWrite && (
                  <Stack direction="row" spacing={1} alignItems="center">
                    <TextField
                      select
                      size="small"
                      label="Test plan"
                      value={selectedPlanToLink}
                      onChange={(e) => setSelectedPlanToLink(e.target.value)}
                      sx={{ minWidth: 220 }}
                    >
                      {linkableTestPlans.map((p) => (
                        <MenuItem key={p._id} value={p._id}>
                          {p.TestPlanId}
                        </MenuItem>
                      ))}
                    </TextField>
                    <Button
                      size="small"
                      startIcon={<LinkIcon />}
                      disabled={!selectedPlanToLink}
                      onClick={() => linkPlan.mutate(selectedPlanToLink)}
                    >
                      Link
                    </Button>
                  </Stack>
                )}
              </Box>
            ),
          },
          {
            label: 'Links',
            content: (
              // WP-F15/F18 Task 3 -- ends the island: the same LinksSection
              // every other detail module mounts (DefectDetail/
              // TestCaseDetail/RequirementDetail), given srcModule=6.
              // linkIssueService's sourceId/destinationId are the entities'
              // HUMAN ids (verified against real seeded links, e.g.
              // Bug-1 -> TC-1), not Mongo _ids -- so `issueId` here is
              // `values.releaseId` ('REL-n'), never `entityId` (this
              // component's own Mongo `_id`, per the header comment on
              // entityQuery above). Passing `entityId` here would create
              // links keyed on a Mongo id that no other module's Links tab
              // ever queries by, so they would save successfully and then
              // be unreadable from either side.
              <LinksSection srcModule={MODULE_ID} summary={values.name} issueId={values.releaseId ?? ''} />
            ),
          },
        ]}
      />
      <Divider sx={{ my: 2 }} />
      <CommentsSection moduleId={MODULE_ID} typeId={entityId} userName={name} userId={sub} />

      {/* WP-F18b Task 3 -- confirms first and names the release, same shape
          as Components/settings/EnvironmentsPanel.tsx's delete dialog. Not
          window.confirm: the old standalone nav page used that, but a real
          MUI <Dialog> is what every OTHER delete confirmation added since
          (Task 1's EnvironmentsPanel) uses, and it is the only one of the
          two that a screen reader announces and this component's own a11y
          suite can assert on. */}
      <Dialog open={deleteDialogOpen} onClose={() => setDeleteDialogOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Delete {values.releaseId ?? entityId}?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This permanently deletes “{values.releaseId ?? entityId}
            {values.name ? ` — ${values.name}` : ''}”. This cannot be undone.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteDialogOpen(false)} disabled={deleteReleaseMutation.isPending}>
            Cancel
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={deleteReleaseMutation.isPending}
            onClick={() => deleteReleaseMutation.mutate()}
          >
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

interface TargetDateFieldProps {
  value?: string;
  readOnly?: boolean;
  onChange: () => void;
  onCommit: (value: string) => void;
}

// Same draft-state-plus-onBlur-commit shape as TestPlanDetail's own Planned
// Start/End controls (PlanDetailsFields), for the same reason: a fixed
// field FieldGrid has no native control for, next to fields that do go
// through it.
function TargetDateField({ value, readOnly, onChange, onCommit }: TargetDateFieldProps): JSX.Element {
  const [draft, setDraft] = useState(value?.slice(0, 10) ?? '');
  useEffect(() => setDraft(value?.slice(0, 10) ?? ''), [value]);
  return (
    <Box mt={4} maxWidth={240}>
      <FormLabel htmlFor="Target Date" sx={{ display: 'block', fontSize: 12, color: 'text.secondary', mb: 0.5 }}>
        Target Date
      </FormLabel>
      <TextField
        fullWidth
        type="date"
        id="Target Date"
        size="small"
        disabled={readOnly}
        InputLabelProps={{ shrink: true }}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          onChange();
        }}
        onBlur={() => onCommit(draft)}
      />
    </Box>
  );
}

// WP-F23 Task 1 -- the Lens at scale. `LensGroup` used to be a heading plus
// its children rendered flat (one Typography per requirement/test case, one
// Stack per derived row) -- readable at three items, an unreadable wall at
// three hundred, per this task's own brief. Requirements/test cases/defects
// now render inside DataGrid (already a dependency, `TestPlanDetail.tsx`
// this WP's own precedent), client-side paged at 25/50/100 -- both payloads
// already arrive whole (releaseLens.js computes and ships everything in one
// response), so paging the RENDER costs nothing and needs no endpoint
// change (R3). What follows are the row shapes, the sort comparators R2
// requires, and the columns -- kept above the component so they are plain,
// testable functions rather than logic buried inside JSX.
interface LensRequirementRow {
  id: string;
  reqId: string;
  requirementSummary?: string;
  isDerived: boolean;
  via: string;
}

function buildRequirementRows(section: ReleaseLensData['requirements']): LensRequirementRow[] {
  const linkedRows: LensRequirementRow[] = section.linked.map((r) => ({
    id: r.reqId,
    reqId: r.reqId,
    requirementSummary: r.requirementSummary,
    isDerived: false,
    via: '',
  }));
  const derivedRows: LensRequirementRow[] = section.derived.map((r) => ({
    id: r.reqId,
    reqId: r.reqId,
    requirementSummary: r.requirementSummary,
    isDerived: true,
    via: `via ${r.via.map((v) => v.TestCaseId).join(', ')}`,
  }));
  return [...linkedRows, ...derivedRows];
}

interface LensTestCaseRow {
  id: string;
  TestCaseId: string;
  TestCaseSummary?: string;
  isDerived: boolean;
  via: string;
  latestStatus: string;
}

function buildTestCaseRows(section: ReleaseLensData['testCases']): LensTestCaseRow[] {
  const linkedRows: LensTestCaseRow[] = section.linked.map((tc) => ({
    id: tc.TestCaseId,
    TestCaseId: tc.TestCaseId,
    TestCaseSummary: tc.TestCaseSummary,
    isDerived: false,
    via: '',
    latestStatus: tc.latestStatus,
  }));
  const derivedRows: LensTestCaseRow[] = section.derived.map((tc) => ({
    id: tc.TestCaseId,
    TestCaseId: tc.TestCaseId,
    TestCaseSummary: tc.TestCaseSummary,
    isDerived: true,
    via: `via ${tc.via.map((v) => v.TestPlanId).join(', ')}`,
    latestStatus: tc.latestStatus,
  }));
  return [...linkedRows, ...derivedRows];
}

interface LensDefectRow {
  id: string;
  defectId: string;
  summary?: string;
  Status: string;
  Severity: string;
}

function buildDefectRows(section: ReleaseLensData['defects']): LensDefectRow[] {
  return section.linked.map((d) => ({
    id: d.defectId,
    defectId: d.defectId,
    summary: d.summary,
    Status: d.Status,
    Severity: d.Severity,
  }));
}

// R2's default sort for requirements: derived before asserted, then id.
// Requirements carry no execution concept of their own -- this genuinely
// is the one attention-worthy signal available for them, so it stays the
// PRIMARY axis here.
function compareMembershipDerivedFirst(
  v1: string,
  v2: string,
  p1: GridSortCellParams<string>,
  p2: GridSortCellParams<string>,
): number {
  if (v1 !== v2) {
    return v1 === 'Derived' ? -1 : 1;
  }
  return String(p1.id).localeCompare(String(p2.id));
}

// Fix round 1 (R3 amended) -- R2's actual ask for test cases: "by execution
// state, failing first". Task 1's own report recorded this as an open
// finding (the lens payload carried no per-case execution status at all);
// the coordinator amended R3 to permit exactly the small additive field
// this needed (backend/reportingService/services/releaseLens.js now
// attaches `latestStatus`, reusing coverage.js's own `resolveExecutionSets`
// scoped to THIS release's resolved plans, never project-wide -- see that
// file's own header comment). This closes the finding: failing first, then
// not-yet-verified (No Run / InProgress / 'Not run in this release' / any
// status this vocabulary doesn't recognize), then passing.
//
// An UNRECOGNISED status must never sort as if it were a pass (only the
// literal string 'Pass' ever ranks as passing) -- WP-F13 already
// established that the documented Pass/Fail/No Run vocabulary is the CI
// ingestion set, not everything the human path can write, and a status
// this code has never seen is exactly the "not yet verified" case, not a
// silent pass.
function testCaseExecutionRank(status: string): number {
  if (status === 'Fail') {
    return 0;
  }
  if (status === 'Pass') {
    return 2;
  }
  return 1;
}

// Derived-vs-asserted is now the SECONDARY axis for test cases (still
// useful -- an inferred member among two equally-failing cases is still
// the one nobody has vetted -- just not the primary one anymore now that a
// real execution signal exists). `p1.api.getRow` is the sanctioned way to
// reach fields beyond the sorted column's own value from inside a
// `sortComparator` (`GridSortCellParams` exposes `id`/`field`/`value`/
// `rowNode`/`api`, not the row itself).
function compareTestCaseExecutionFirst(
  v1: string,
  v2: string,
  p1: GridSortCellParams<string>,
  p2: GridSortCellParams<string>,
): number {
  const r1 = testCaseExecutionRank(v1);
  const r2 = testCaseExecutionRank(v2);
  if (r1 !== r2) {
    return r1 - r2;
  }
  const row1 = p1.api.getRow(p1.id) as LensTestCaseRow;
  const row2 = p2.api.getRow(p2.id) as LensTestCaseRow;
  if (row1.isDerived !== row2.isDerived) {
    return row1.isDerived ? -1 : 1;
  }
  return String(p1.id).localeCompare(String(p2.id));
}

// Fix round 2 -- StatusChip's own colorMap-miss fallback
// (Components/common/StatusChip.tsx's `resolveStatus`) hashes an unmapped
// status string onto a ROTATION that includes 'success', and
// DEFAULT_STATUS_ICONS is keyed by the resolved colour -- so an execution
// status this vocabulary doesn't recognise (live data already has
// 'InProgress'; the general case is anything the human execution path
// writes that nobody enumerated here) could render as a GREEN chip with a
// checkmark, entirely by hash coincidence. `testCaseExecutionRank` above
// already guarantees an unrecognised status can never SORT as passing;
// without this, it could still be PAINTED as passing, and a reader
// scanning a dense grid reads colour before text.
//
// Mechanism: resolve the colour ourselves and hand StatusChip a
// single-entry colorMap keyed by the EXACT value being rendered, so its
// own lookup can never miss -- the hash-rotation fallback is unreachable
// from this column, not merely unlikely for it to be hit. Vocabulary
// sourced from TestRunDetail.tsx's own STATUS_KEYS (the real execution
// vocabulary), plus this task's own 'Not run in this release' sentinel;
// anything else (including a status nobody has enumerated) resolves to
// 'default' -- StatusChip's own DEFAULT_STATUS_ICONS has no 'default'
// entry, so a status outside this list renders with no icon either.
//
// Fix round (final review) -- "sourced from TestRunDetail.tsx's own
// STATUS_KEYS" used to be true only in prose: STATUS_KEYS was a
// module-private const there, so this object was a hand-copy nothing
// enforced. STATUS_KEYS is now exported, and this Record's key type is
// derived from it directly (`(typeof STATUS_KEYS)[number]`, plus this
// file's own sentinel) -- if TestRunDetail.tsx's vocabulary ever grows, a
// missing key here is a `tsc` error on THIS file, not a silent grey chip
// discovered a navigation later. `ReleaseDetail.test.tsx` also checks this
// at runtime, independent of the type checker (exported below for that).
export const TEST_CASE_STATUS_COLORS: Record<(typeof STATUS_KEYS)[number] | 'Not run in this release', StatusChipColor> = {
  Pass: 'success',
  Fail: 'error',
  Blocked: 'warning',
  InProgress: 'info',
  'No Run': 'default',
  'Not run in this release': 'default',
};

function testCaseStatusColorMap(status: string): Record<string, StatusChipColor> {
  return { [status]: TEST_CASE_STATUS_COLORS[status as keyof typeof TEST_CASE_STATUS_COLORS] ?? 'default' };
}

// R2's default sort for defects: unresolved before resolved, then id.
function compareDefectStatusUnresolvedFirst(
  v1: string,
  v2: string,
  p1: GridSortCellParams<string>,
  p2: GridSortCellParams<string>,
): number {
  const u1 = isUnresolvedDefectStatus(v1);
  const u2 = isUnresolvedDefectStatus(v2);
  if (u1 !== u2) {
    return u1 ? -1 : 1;
  }
  return String(p1.id).localeCompare(String(p2.id));
}

// R5 -- the "Membership" column is the grid's replacement for the old
// "Derived" chip + `via` caption Stack: a reader still sees, at a glance,
// which rows someone asserted and which the system inferred (the chip),
// and still sees what a derived member was derived from (the "Derived via"
// column, blank for an asserted row). `lens-derived-chip` keeps its exact
// pre-existing name (WP-F15b), `lens-asserted-chip` is its new counterpart.
const requirementColumns: GridColDef<LensRequirementRow>[] = [
  { field: 'reqId', headerName: 'Requirement Id', flex: 1 },
  {
    field: 'requirementSummary',
    headerName: 'Summary',
    flex: 2,
    valueGetter: (params) => params.row.requirementSummary || '—',
  },
  {
    field: 'membership',
    headerName: 'Membership',
    flex: 0.9,
    valueGetter: (params) => (params.row.isDerived ? 'Derived' : 'Asserted'),
    sortComparator: compareMembershipDerivedFirst,
    renderCell: (params) =>
      params.value === 'Derived' ? (
        <Chip size="small" color="info" variant="outlined" label="Derived" data-testid="lens-derived-chip" />
      ) : (
        <Chip size="small" variant="outlined" label="Asserted" data-testid="lens-asserted-chip" />
      ),
  },
  {
    field: 'via',
    headerName: 'Derived via',
    flex: 1.4,
    valueGetter: (params) => params.row.via,
    renderCell: (params) =>
      params.value ? (
        <Typography variant="caption" color="text.secondary" data-testid="lens-requirement-derived-via">
          {params.value}
        </Typography>
      ) : null,
  },
];

const testCaseColumns: GridColDef<LensTestCaseRow>[] = [
  { field: 'TestCaseId', headerName: 'Test Case Id', flex: 1 },
  {
    field: 'TestCaseSummary',
    headerName: 'Summary',
    flex: 2,
    valueGetter: (params) => params.row.TestCaseSummary || '—',
  },
  // R2 (fix round 1, R3 amended) -- this release's own latest execution
  // status, the PRIMARY default sort axis for this grid (see
  // compareTestCaseExecutionFirst above). `data-testid` lets a browser
  // journey assert on this cell directly rather than only on row order.
  {
    field: 'latestStatus',
    headerName: 'Status',
    flex: 0.9,
    sortComparator: compareTestCaseExecutionFirst,
    renderCell: (params) => (
      <StatusChip
        status={params.value}
        colorMap={testCaseStatusColorMap(params.value)}
        data-testid="lens-testcase-status-chip"
      />
    ),
  },
  {
    field: 'membership',
    headerName: 'Membership',
    flex: 0.9,
    valueGetter: (params) => (params.row.isDerived ? 'Derived' : 'Asserted'),
    // No longer the default sort for this grid (see the Test cases
    // DataGrid's own `initialState.sorting` below) -- kept sortable on its
    // own so a user who clicks this header still gets a meaningful order;
    // R2's own secondary axis (derived-vs-asserted) is now embedded inside
    // compareTestCaseExecutionFirst's own tie-break instead.
    sortComparator: compareMembershipDerivedFirst,
    renderCell: (params) =>
      params.value === 'Derived' ? (
        <Chip size="small" color="info" variant="outlined" label="Derived" data-testid="lens-derived-chip" />
      ) : (
        <Chip size="small" variant="outlined" label="Asserted" data-testid="lens-asserted-chip" />
      ),
  },
  {
    field: 'via',
    headerName: 'Derived via',
    flex: 1.4,
    valueGetter: (params) => params.row.via,
    renderCell: (params) =>
      params.value ? (
        <Typography variant="caption" color="text.secondary" data-testid="lens-testcase-derived-via">
          {params.value}
        </Typography>
      ) : null,
  },
];

const defectColumns: GridColDef<LensDefectRow>[] = [
  { field: 'defectId', headerName: 'Defect Id', flex: 1 },
  { field: 'summary', headerName: 'Summary', flex: 2, valueGetter: (params) => params.row.summary || '—' },
  {
    field: 'Status',
    headerName: 'Status',
    flex: 0.8,
    sortComparator: compareDefectStatusUnresolvedFirst,
    renderCell: (params) => <StatusChip status={params.value} />,
  },
  { field: 'Severity', headerName: 'Severity', flex: 0.7 },
];

// Stable module-scope components (not created inline per render) so
// DataGrid's `slots.toolbar` identity does not change on every render --
// each just wraps the library's own quick-filter search box with a
// data-testid, since GridToolbarQuickFilter renders no testid of its own.
function RequirementsQuickFilterToolbar(): JSX.Element {
  return (
    <Box data-testid="lens-requirements-quickfilter" sx={{ p: 1 }}>
      <GridToolbarQuickFilter />
    </Box>
  );
}

function TestCasesQuickFilterToolbar(): JSX.Element {
  return (
    <Box data-testid="lens-test-cases-quickfilter" sx={{ p: 1 }}>
      <GridToolbarQuickFilter />
    </Box>
  );
}

function DefectsQuickFilterToolbar(): JSX.Element {
  return (
    <Box data-testid="lens-defects-quickfilter" sx={{ p: 1 }}>
      <GridToolbarQuickFilter />
    </Box>
  );
}

interface ReleaseLensPanelProps {
  // The release's human id ('REL-n'), possibly still empty while
  // `getRelease` is in flight -- see the query's own `enabled` guard below.
  releaseId?: string;
}

// WP-F15/F18 Task 5 -- R5 built into every line of this component: nothing
// here shows a count without also showing what it was counted OUT OF, and
// a release with nothing linked reads as an explicit "Nothing linked yet",
// never a bare zero, a fabricated percentage, or an error. This is the
// piece the whole work package was building toward -- Task 4's lens
// (backend/reportingService/services/releaseLens.js), on the screen a user
// actually opens.
function ReleaseLensPanel({ releaseId }: ReleaseLensPanelProps): JSX.Element {
  const projectId = getCurrentProjectId();
  const lensQuery = useQuery({
    queryKey: ['project', projectId, MODULE_ID, 'release-lens', releaseId] as const,
    queryFn: async () => getReleaseLens(releaseId as string),
    // `releaseId` is `values.releaseId` off the still-loading entity query
    // above -- undefined for exactly the render where `entityQuery.data` is
    // not there yet. Firing this with `releaseId: undefined` would ask the
    // lens for a literal "undefined" release and get back a 404 that has
    // nothing to do with this release at all.
    enabled: Boolean(releaseId),
  });

  if (!releaseId || lensQuery.isLoading) {
    return <CircularProgress size={20} aria-label="Loading release lens" />;
  }
  if (lensQuery.isError) {
    return <Alert severity="warning">{reportErrorMessage(lensQuery.error)}</Alert>;
  }

  const data = lensQuery.data?.data as ReleaseLensData;
  const { requirements, testCases, defects, testPlans, executions, links } = data;

  // R5's own empty-state rule: NOTHING is linked to this release at all --
  // not a defect/requirement/test case via the link graph, and not a test
  // plan via `linkedTestPlanIds` either. A percentage over zero items would
  // read as "perfect" here; this reads as what it is.
  //
  // WP-F15b Task 2 -- this guard was re-examined, not just carried forward,
  // against the new derived keys: could a release whose ONLY members are
  // derived ever read as "nothing linked"? No. Derivation traverses
  // `resolvedPlans`, which is filtered from `release.linkedTestPlanIds` --
  // so `requirements.derivedCount > 0` or `testCases.derivedCount > 0`
  // implies at least one configured plan, i.e. `testPlans.configuredCount
  // > 0`, which already flips this guard to `false` on its own. No
  // `derivedCount` term needs adding here; one is proven redundant by the
  // shape of the data, not assumed to be covered by `configuredCount`.
  const nothingLinked =
    requirements.linkedCount === 0 && testCases.linkedCount === 0 && defects.linkedCount === 0 && testPlans.configuredCount === 0;

  // R4 -- an aggregate derived count still needs its own denominator: "how
  // many source items does that derivation trace back to", distinct from
  // the per-row `via` each item already carries. Distinct-id, not a sum of
  // `via.length`, since the same plan/case can be the source for more than
  // one derived member.
  const derivedRequirementViaCaseCount = new Set(
    requirements.derived.flatMap((r) => r.via.map((v) => v.TestCaseId)),
  ).size;
  const derivedTestCaseViaPlanCount = new Set(testCases.derived.flatMap((tc) => tc.via.map((v) => v._id))).size;

  return (
    <Box>
      {nothingLinked ? (
        <Alert severity="info" sx={{ mb: 2 }}>
          Nothing linked yet. No requirements, test cases, defects or test plans are linked to this release.
        </Alert>
      ) : (
        // Fix round (Finding 2, MINOR) -- this headline predates derived
        // membership and, before this fix, read ONLY `linkedCount`/
        // `links.*`. A release with a plan attached and nothing hand-linked
        // announced "0 linked requirements, 0 linked test cases" directly
        // above group titles correctly saying N were derived -- R2's
        // "derived and asserted stay visibly distinct" tipping into
        // "derived is invisible exactly where a skimming reader looks
        // first". Same "N linked, M derived via ..." clause the group
        // titles already use (same `derivedRequirementViaCaseCount`/
        // `derivedTestCaseViaPlanCount` denominators, computed once above),
        // appended only when there is something derived to report -- a
        // release with genuinely zero of either still reads as a plain "0
        // linked requirements" with no trailing clause.
        <Typography variant="body2" sx={{ mb: 2 }}>
          {`${defects.linkedCount} linked defect${defects.linkedCount === 1 ? '' : 's'}, `}
          {`${requirements.linkedCount} linked requirement${requirements.linkedCount === 1 ? '' : 's'}`}
          {requirements.derivedCount > 0
            ? `, ${requirements.derivedCount} derived via ${derivedRequirementViaCaseCount} test case${derivedRequirementViaCaseCount === 1 ? '' : 's'}`
            : ''}
          {', '}
          {`${testCases.linkedCount} linked test case${testCases.linkedCount === 1 ? '' : 's'}`}
          {testCases.derivedCount > 0
            ? `, ${testCases.derivedCount} derived via ${derivedTestCaseViaPlanCount} plan${derivedTestCaseViaPlanCount === 1 ? '' : 's'}`
            : ''}
          {', '}
          {`${testPlans.linkedCount} linked test plan${testPlans.linkedCount === 1 ? '' : 's'}, `}
          {`${executions.executed} executed`}
          {executions.passRatePercent !== null ? ` (${executions.passRatePercent}% pass rate)` : ''}
          {'.'}
        </Typography>
      )}

      {/* Denominator, always visible, never buried: what the link graph
          actually returned before any of the counts above were derived
          from it -- so a reader can see there IS something behind the
          numbers, not just take them on faith. */}
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
        {`Counted from ${links.distinctCounterparts} linked item${links.distinctCounterparts === 1 ? '' : 's'} `}
        {`(${links.rawLinkRowsSeen} link row${links.rawLinkRowsSeen === 1 ? '' : 's'} seen`}
        {links.unresolvedCount > 0 ? `, ${links.unresolvedCount} unresolved (deleted or cross-project)` : ''}
        {links.ignoredOtherModuleCount > 0 ? `, ${links.ignoredOtherModuleCount} linked to an uncounted module` : ''}
        {') plus '}
        {`${testPlans.configuredCount} configured test plan${testPlans.configuredCount === 1 ? '' : 's'}`}
        {testPlans.unresolvedCount > 0 ? ` (${testPlans.unresolvedCount} no longer resolve)` : ''}
        {'.'}
      </Typography>

      <Stack spacing={2}>
        {/* WP-F23 Task 1 -- R1: the group is collapsed by default (this
            title, with its counts, is the ALWAYS-visible summary half; the
            grid below is the detail half that collapses). WP-F15b Task 2's
            own R2/R5 concern -- derived rows are a SIBLING list, not folded
            into `linked`, each one still distinguishable and still naming
            its source -- now lives in the grid's own "Membership"/"Derived
            via" columns (see requirementColumns above) rather than a
            separate Stack per row. The group title's own "N derived via M
            …" clause is unchanged: R4's denominator rule applied to the
            derivation itself, not just the explicit count. */}
        <LensGroup
          testId="lens-group-requirements"
          title={`Requirements (${requirements.linkedCount} linked${
            requirements.derivedCount > 0
              ? `, ${requirements.derivedCount} derived via ${derivedRequirementViaCaseCount} test case${derivedRequirementViaCaseCount === 1 ? '' : 's'}`
              : ''
          })`}
        >
          {requirements.linkedCount === 0 && requirements.derivedCount === 0 ? (
            <Typography variant="body2" color="text.secondary">No requirements linked.</Typography>
          ) : (
            <div data-testid="lens-requirements-grid" style={{ width: '100%' }}>
              <DataGrid
                autoHeight
                rows={buildRequirementRows(requirements)}
                columns={requirementColumns}
                getRowId={(row) => row.id}
                initialState={{
                  pagination: { paginationModel: { page: 0, pageSize: 25 } },
                  sorting: { sortModel: [{ field: 'membership', sort: 'asc' }] },
                }}
                pageSizeOptions={[25, 50, 100]}
                slots={{ toolbar: RequirementsQuickFilterToolbar }}
              />
            </div>
          )}
        </LensGroup>

        <LensGroup
          testId="lens-group-test-cases"
          title={`Test cases (${testCases.linkedCount} linked${
            testCases.derivedCount > 0
              ? `, ${testCases.derivedCount} derived via ${derivedTestCaseViaPlanCount} plan${derivedTestCaseViaPlanCount === 1 ? '' : 's'}`
              : ''
          })`}
        >
          {testCases.linkedCount === 0 && testCases.derivedCount === 0 ? (
            <Typography variant="body2" color="text.secondary">No test cases linked.</Typography>
          ) : (
            <div data-testid="lens-test-cases-grid" style={{ width: '100%' }}>
              <DataGrid
                autoHeight
                rows={buildTestCaseRows(testCases)}
                columns={testCaseColumns}
                getRowId={(row) => row.id}
                initialState={{
                  pagination: { paginationModel: { page: 0, pageSize: 25 } },
                  sorting: { sortModel: [{ field: 'latestStatus', sort: 'asc' }] },
                }}
                pageSizeOptions={[25, 50, 100]}
                slots={{ toolbar: TestCasesQuickFilterToolbar }}
              />
            </div>
          )}
        </LensGroup>

        <LensGroup testId="lens-group-defects" title={`Defects (${defects.linkedCount})`}>
          {defects.linked.length === 0 ? (
            <Typography variant="body2" color="text.secondary">No defects linked.</Typography>
          ) : (
            <div data-testid="lens-defects-grid" style={{ width: '100%' }}>
              <DataGrid
                autoHeight
                rows={buildDefectRows(defects)}
                columns={defectColumns}
                getRowId={(row) => row.id}
                initialState={{
                  pagination: { paginationModel: { page: 0, pageSize: 25 } },
                  sorting: { sortModel: [{ field: 'Status', sort: 'asc' }] },
                }}
                pageSizeOptions={[25, 50, 100]}
                slots={{ toolbar: DefectsQuickFilterToolbar }}
              />
            </div>
          )}
        </LensGroup>

        <LensGroup
          testId="lens-group-test-plans"
          title={`Test plans (${testPlans.linkedCount} of ${testPlans.configuredCount} configured)`}
        >
          {testPlans.linked.length === 0 ? (
            <Typography variant="body2" color="text.secondary">No test plans linked.</Typography>
          ) : (
            testPlans.linked.map((p) => <Typography key={p._id} variant="body2">{p.TestPlanId}</Typography>)
          )}
        </LensGroup>

        <LensGroup testId="lens-group-executions" title="Executions">
          <Typography variant="body2">
            {`${executions.executed} executed — ${executions.passed} passed, ${executions.failed} failed, ${executions.blocked} blocked`}
            {executions.passRatePercent !== null ? ` (${executions.passRatePercent}% pass rate)` : ''}
            {'.'}
          </Typography>
          {executions.note && (
            <Typography variant="body2" color="text.secondary">{executions.note}</Typography>
          )}
        </LensGroup>
      </Stack>
    </Box>
  );
}

interface LensGroupProps {
  title: string;
  // Drives this group's own outer/toggle data-testids (`${testId}` /
  // `${testId}-toggle`) -- distinct per group so a11y/browser-journey tests
  // can target one group's disclosure without an index-based query.
  testId: string;
  children: React.ReactNode;
}

// WP-F23 Task 1 -- R1: the heading (title, carrying every count above) is
// ALWAYS rendered; only `children` -- the part that becomes a wall at scale
// -- collapses, and starts collapsed. `Collapse ... unmountOnExit` is the
// same shape TestRunDetail.tsx's own "Test Case Details" toggle already
// uses in this codebase: a collapsed group's DataGrid is not mounted at all
// until opened, so a release with three hundred items pays nothing for the
// groups nobody has expanded yet.
function LensGroup({ title, testId, children }: LensGroupProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  return (
    <Box data-testid={testId}>
      <ButtonBase
        onClick={() => setExpanded((open) => !open)}
        aria-expanded={expanded}
        aria-label={`Toggle ${title}`}
        data-testid={`${testId}-toggle`}
        sx={{ width: '100%', justifyContent: 'flex-start', gap: 0.5, py: 0.5 }}
      >
        <ExpandMoreIcon
          fontSize="small"
          sx={{
            color: 'text.secondary',
            transform: expanded ? 'none' : 'rotate(-90deg)',
            transition: 'transform 120ms',
            '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
          }}
        />
        <Typography variant="subtitle2">{title}</Typography>
      </ButtonBase>
      <Collapse in={expanded} unmountOnExit>
        <Box sx={{ pl: 4, pt: 0.5 }}>{children}</Box>
      </Collapse>
    </Box>
  );
}

interface QualityGatesPanelProps {
  releaseId: string;
  qualityGates: Release['qualityGates'];
  canWrite: boolean;
}

// WP-F18b Task 2 -- gate EDITING joins the gate STATUS this tab already
// rendered, so the owner no longer has to leave the workbench to change a
// rule and come back to see its effect. Saves through the exact same call
// the old standalone nav page's own handleSaveGates made (updateRelease(id, {
// qualityGates })) -- qualityGates is a plain field on Release, not a
// separate entity, so there is no second mechanism to invent here. That nav
// page (Pages/releases.tsx) kept its own copy of this editor until WP-F18b
// Task 4 retired the page; this is now the only surface for that field.
//
// An unconfigured release says so plainly rather than reporting a vacuous,
// misleading pass -- the same "state what was counted" discipline the old
// nav page's own gate-status panel followed ("No quality gates
// configured -- vacuously green"). That STATUS half never renders an empty
// results table for a release with no saved rules; only the EDIT half
// (visible to writers only) offers an explicit, separately-labelled way to
// add a first one.
function QualityGatesPanel({ releaseId, qualityGates, canWrite }: QualityGatesPanelProps): JSX.Element {
  const projectId = getCurrentProjectId();
  const queryClient = useQueryClient();
  const [gateDraft, setGateDraft] = useState<QualityGateRule[]>(() => qualityGates.map((g) => ({ ...g })));
  const [gateError, setGateError] = useState<string | null>(null);

  // Re-sync the draft whenever the release's SAVED gates change -- either a
  // fresh fetch, or this panel's own save completing (see saveGates.onSuccess
  // below, which writes the mutation response into the entity cache this
  // prop is derived from). Same value-prop-plus-useEffect shape
  // TargetDateField above uses for the same reason.
  useEffect(() => {
    setGateDraft(qualityGates.map((g) => ({ ...g })));
  }, [qualityGates]);

  const gateStatusKey = ['project', projectId, MODULE_ID, 'gate-status', releaseId] as const;
  const gateStatusQuery = useQuery({
    queryKey: gateStatusKey,
    queryFn: async (): Promise<GateStatus> => getGateStatus(releaseId),
  });

  const saveGates = useMutation({
    mutationFn: async () => updateRelease(releaseId, { qualityGates: gateDraft }),
    onSuccess: (updated) => {
      setGateError(null);
      queryClient.setQueryData(qk.entity(projectId, MODULE_ID, releaseId), updated);
      // The whole reason this editor sits beside the status table: a saved
      // rule change must show its CONSEQUENCE immediately, not a status
      // still computed against the rules that were just replaced.
      queryClient.invalidateQueries({ queryKey: gateStatusKey });
    },
    onError: () => setGateError('Could not save quality gates. Please try again.'),
  });

  const addGateRule = () => setGateDraft((prev) => [...prev, { type: 'minPassRate', threshold: 80 }]);
  const removeGateRule = (index: number) => setGateDraft((prev) => prev.filter((_, i) => i !== index));
  const updateGateRule = (index: number, patch: Partial<QualityGateRule>) =>
    setGateDraft((prev) => prev.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));

  const noGatesConfigured = qualityGates.length === 0;

  return (
    <Box>
      {canWrite && (
        <Box mb={3}>
          <Typography variant="subtitle2" sx={{ mb: 1 }}>
            Edit rules
          </Typography>
          {gateError && (
            <Alert severity="error" sx={{ mb: 1 }} onClose={() => setGateError(null)}>
              {gateError}
            </Alert>
          )}
          {gateDraft.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              No rules configured yet.
            </Typography>
          ) : (
            <Stack spacing={1}>
              {gateDraft.map((rule, index) => (
                <Stack key={index} direction="row" spacing={1} alignItems="center">
                  <TextField
                    select
                    size="small"
                    label="Type"
                    value={rule.type}
                    onChange={(e) => updateGateRule(index, { type: e.target.value as QualityGateRule['type'] })}
                    sx={{ minWidth: 160 }}
                  >
                    <MenuItem value="minPassRate">minPassRate</MenuItem>
                    <MenuItem value="maxOpenDefects">maxOpenDefects</MenuItem>
                  </TextField>
                  <TextField
                    size="small"
                    label="Threshold"
                    type="number"
                    value={rule.threshold}
                    onChange={(e) => updateGateRule(index, { threshold: Number(e.target.value) })}
                    sx={{ maxWidth: 120 }}
                  />
                  {rule.type === 'maxOpenDefects' && (
                    <TextField
                      size="small"
                      label="Severity (optional)"
                      value={rule.severity ?? ''}
                      onChange={(e) => updateGateRule(index, { severity: e.target.value })}
                      sx={{ maxWidth: 160 }}
                    />
                  )}
                  <IconButton size="small" aria-label={`Remove rule ${index + 1}`} onClick={() => removeGateRule(index)}>
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </Stack>
              ))}
            </Stack>
          )}
          <Stack direction="row" spacing={1} mt={1}>
            <Button size="small" startIcon={<AddIcon />} onClick={addGateRule}>
              Add rule
            </Button>
            <Button
              size="small"
              variant="outlined"
              disabled={saveGates.isPending}
              onClick={() => saveGates.mutate()}
            >
              Save gates
            </Button>
          </Stack>
        </Box>
      )}

      {noGatesConfigured ? (
        <Typography variant="body2" color="text.secondary">
          No quality gates configured for this release.
        </Typography>
      ) : (
        <Box>
          {gateStatusQuery.isLoading && <CircularProgress size={20} aria-label="Loading gate status" />}
          {gateStatusQuery.isError && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              Could not evaluate live gate status. Showing configured rules only.
            </Alert>
          )}
          {gateStatusQuery.data && (
            <Stack direction="row" alignItems="center" spacing={1} mb={2}>
              <Typography variant="body2">Overall:</Typography>
              <StatusChip status={gateStatusQuery.data.overall} colorMap={{ green: 'success', red: 'error' }} />
            </Stack>
          )}
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Rule</TableCell>
                  <TableCell>Threshold</TableCell>
                  <TableCell>Actual</TableCell>
                  <TableCell>Result</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {qualityGates.map((rule, index) => {
                  // getGateStatus's own `rules` array is built by iterating
                  // this SAME `release.qualityGates` array in order, one
                  // result per rule, with nothing filtered out
                  // (backend/releaseService/controllers/releases.js's
                  // getGateStatus) -- so matching by position is exact,
                  // unlike matching by type+threshold, which would collide
                  // for two rules of the same type and threshold
                  // distinguished only by severity.
                  const result = gateStatusQuery.data?.rules[index];
                  return (
                    <TableRow key={index}>
                      <TableCell>
                        {rule.type}
                        {rule.severity ? ` (${rule.severity})` : ''}
                      </TableCell>
                      <TableCell>{rule.threshold}</TableCell>
                      <TableCell>{result ? result.actual : '—'}</TableCell>
                      <TableCell>
                        {result ? (
                          <StatusChip status={result.passed ? 'pass' : 'fail'} colorMap={GATE_RESULT_COLORS} />
                        ) : (
                          '—'
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        </Box>
      )}
    </Box>
  );
}

export default ReleaseDetail;
