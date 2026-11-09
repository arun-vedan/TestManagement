import React, { useEffect, useState } from 'react';
import { Alert, Box, Button, ButtonBase, CircularProgress, Collapse, Divider, FormLabel, Grid, List, ListItem, ListItemButton, ListItemText, MenuItem, Select, Typography } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import SaveIcon from '@mui/icons-material/Save';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import BugReportIcon from '@mui/icons-material/BugReport';
import {
  getTestExecutionList,
  getTeTestCaseDetails,
  getFields,
  updateTestSteps,
  updateAttachment,
  updateTestExecution,
  uploadAttachment,
  getCreatedBy,
  getLinkedIssuesApi,
  createLink,
} from '../../../api/apiCalls';
import { getCurrentProjectId } from '../../../currentProject';
import { qk } from '../../../Hooks/queryKeys';
import keycloak from '../../../keycloak';
import { makeDraftEntityId, tabKey } from '../../store/workbenchStore';
import { useWorkbench } from '../../WorkbenchStoreProvider';
import { StatusChip } from '../../../Components/common/StatusChip';
import { parseEditorValue, FieldDefinition } from '../FieldGrid';
import AddDeleteTableRows from '../../../Components/Tabs/AddDeleteTableRows';
import { TCStepsContext } from '../../../Context/testSteps';
import DetailHeader from '../DetailHeader';
import AttachmentsSection, { AttachmentItem } from '../AttachmentsSection';
import CommentsSection from '../CommentsSection';
import TagsSection from '../TagsSection';
import { usePermissions } from '../../../Hooks/usePermissions';
import IssueSearch from '../../../Components/Lists/issueSearch';
import { LINK_TYPE_COLORS, LINK_TYPES, LinkType } from '../../../api/linkApi';
import { MODULE_SLUGS } from '../../modules';
import { tokens, StatusToken } from '../../../Theme/tokens';

// Module id for Test Cases (src/workbench/modules.ts's ModuleId 1) --
// the module a run's TestCaseId belongs to, distinct from this file's own
// MODULE_ID (4, Test Runs) below. Used only by the A6 defect-linking panel.
const TESTCASE_MODULE_ID = 1;
// Module id for Defects (src/workbench/modules.ts's ModuleId 5).
const DEFECT_MODULE_ID = 5;

export interface TestRunDetailProps {
  entityId: string;
}

// Module id for Test Runs / Test Executions (src/workbench/modules.ts's
// ModuleId 4).
const MODULE_ID = 4;

// TestExecutionContent.tsx's checkStepStatus/handleSave rollup vocabulary,
// verified live against srckube-testexecution.testexecutions
// (TestCases[].TestStatus), bridged onto tokens.status's own (camelCase)
// vocabulary -- the same bridge EntityTreeNode.tsx's STATUS_CHIP_COLORS
// builds for the tree, so the run view and the tree colour a failure the
// same way.
//
// tokens.status is imported directly rather than read off palette.status:
// Workbench.tsx mounts the ThemeProvider, but this component's own test
// harness renders it without one, and EntityTreeNode.tsx set the precedent
// of importing the tokens module for exactly that reason. Its values are
// contrast-checked against white in Theme/tokens.ts -- no hex is written
// here.
const RUN_STATUS_TOKENS: Record<string, StatusToken> = {
  'No Run': 'notRun',
  InProgress: 'inProgress',
  Pass: 'pass',
  Fail: 'fail',
  Blocked: 'blocked',
};

function statusColor(status: string | undefined): string {
  return tokens.status[RUN_STATUS_TOKENS[status ?? 'No Run'] ?? 'notRun'];
}

// 'InProgress' is a stored value, not something to show a tester. The
// other four are left exactly as they are stored: 'No Run' in particular
// is the term the step-status dropdown and the a11y test both use, and
// two spellings of one status would be worse than one slightly technical
// one.
const STATUS_LABELS: Record<string, string> = {
  'No Run': 'No Run',
  InProgress: 'In Progress',
  Pass: 'Pass',
  Fail: 'Fail',
  Blocked: 'Blocked',
};

// Exported (fix round, final review) -- ReleaseDetail.tsx's own
// TEST_CASE_STATUS_COLORS used to hand-copy this exact list, tied back
// here only by a comment ("sourced from TestRunDetail.tsx's own
// STATUS_KEYS"). A comment is not a dependency: this was a module-private
// const, so nothing enforced the two ever agreeing. Now the real binding
// -- ReleaseDetail derives its colour map's key set FROM this array, so a
// status added here cannot silently leave that other view's Lens tab
// painting it with a default grey chip.
export const STATUS_KEYS = ['No Run', 'InProgress', 'Pass', 'Fail', 'Blocked'] as const;

// Reading order for the roll-up only: executed outcomes first, outstanding
// last, so the bar fills left to right as the run progresses. STATUS_KEYS
// keeps its own order because it is the list the counts are computed over,
// and both test files address these cells by testid, never by position.
const STATUS_DISPLAY_ORDER = ['Pass', 'Fail', 'Blocked', 'InProgress', 'No Run'] as const;

interface StepRow {
  testStep: string;
  Expected: string;
  status?: string;
}

interface RunTestCaseSummary {
  TestCaseId: string;
  TestCaseSummary?: string;
  TestStatus?: string;
  // WP-F07b Task 4 -- additive (R1: absent means 0), same as the backend
  // schema. A run with no parameterised cases never has these set, which
  // is exactly the regression guard: iterationRowKey/iterationLabel below
  // both treat "absent" identically to "0"/"no values", so such a run
  // renders exactly as it did before this feature existed.
  iterationIndex?: number;
  iterationValues?: Record<string, string>;
}

interface RunRecord {
  _id?: string;
  TestExecutionId?: string;
  assignedTo?: string;
  TestCases?: RunTestCaseSummary[];
  tags?: string[];
  [key: string]: unknown;
}

interface RunTestCaseDetail {
  TestCaseId: string;
  TestCaseSummary?: string;
  TestSteps?: StepRow[];
  attachment?: AttachmentItem[];
  dynamicFields?: Record<string, unknown>;
  // WP-F07b Task 4 -- see RunTestCaseSummary's identical fields above.
  iterationIndex?: number;
  iterationValues?: Record<string, string>;
  [key: string]: unknown;
}

// WP-F07b Task 4 -- a case within a run is now addressed by TestCaseId
// PLUS iterationIndex everywhere (list key, `selected` check, the detail
// fetch, both write mutations, and defect raising), matching the six
// backend sites Task 1 already fixed. `iterationIndex ?? 0`, never `||`:
// iterationIndex 0 is the ordinary, ubiquitous case (every pre-existing
// row, and iteration 0 of every parameterised case), not an absent one --
// a falsy check would silently collapse it back into the exact bug this
// task exists to remove. One helper, reused by the key and the `selected`
// comparison, so the two cannot drift apart the way TestCaseId-alone did.
function iterationRowKey(tcId: string, iterationIndex?: number | null): string {
  return `${tcId}::${iterationIndex ?? 0}`;
}

// Labels a row by the data that produced it, not by position: "TC-9 ·
// role=admin" tells a tester which data failed without opening the row;
// "TC-9 (2)" would not. Falls back to the bare TestCaseId -- identical to
// this file's pre-WP-F07b rendering -- when there are no iteration values
// at all (every existing, unparameterised run, and Task 2's own "a
// zero-row dataset behaves like an unbound case" rule), which is the
// regression guard: nothing about an ordinary run's list changes.
function iterationLabel(tcId: string, iterationValues?: Record<string, string> | null): string {
  const entries = iterationValues ? Object.entries(iterationValues) : [];
  if (entries.length === 0) return tcId;
  return `${tcId} · ${entries.map(([column, value]) => `${column}=${value}`).join(', ')}`;
}

// Verbatim port of TestExecutionContent.tsx's checkStepStatus + the
// sequential (not else-if) assignments in its handleSave -- preserved
// exactly, including the two checks that both resolve a partial-pass/no-
// fail/no-blocked state to 'InProgress', because e2e/specs/
// test-execution.spec.ts depends on this rollup and this WP is not the
// place to "clean up" its logic.
function computeTcStatus(steps: StepRow[]): string {
  const stepCount = steps.length;
  const count = (s: string) => steps.filter((step) => step.status === s).length;
  const noRunCount = count('No Run');
  const passCount = count('Pass');
  const failCount = count('Fail');
  const blockedCount = count('Blocked');
  const inProgressCount = count('InProgress');

  let tcStatus = 'No Run';
  if (failCount !== 0) tcStatus = 'Fail';
  if (blockedCount !== 0 && failCount === 0) tcStatus = 'Blocked';
  if (noRunCount === stepCount) tcStatus = 'No Run';
  if (inProgressCount !== 0 && failCount === 0 && blockedCount === 0) tcStatus = 'InProgress';
  if (passCount !== 0 && failCount === 0 && blockedCount === 0) tcStatus = 'InProgress';
  if (passCount === stepCount) tcStatus = 'Pass';
  return tcStatus;
}

// One heading treatment for every section of the run pane. Before this,
// "Test Cases" and "Test Case Details" drew a bare subtitle1 while "Steps"
// and "Linked Defects" drew subtitle1 + Divider -- four sections, two
// different rules, so the eye had to re-learn the structure at each one.
// Not a new visual device: it is the subtitle1 + Divider that half of them
// already used, applied to all of them. The attachments block is the one
// holdout -- its heading is an h6 inside the shared AttachemntListComp
// (Components/attachments/attachments.tsx), which Requirements and Defects
// render too, so unifying it is a change to those views, not this one.
// The run roll-up. Replaces a six-cell grid of bold label/number pairs in
// which every item shouted at the same volume, so "Fail 3" read no louder
// than "No Run 0".
//
// A run is a parts-of-a-whole -- every case sits in exactly one status and
// they sum to the total -- which is the one shape a stacked bar is
// genuinely for, and the reason this is a bar rather than the six numbers
// it replaces. The division of labour is deliberate:
//
//  - the percentage is the single figure worth reading from across a desk;
//  - the bar is the fast, wordless read of how much is left and how bad it
//    is, and it is where the colour lives;
//  - the legend carries the exact numbers, in neutral text.
//
// Colour appears as fills and dots only, never as the colour of a label or
// a number -- Theme/tokens.ts's own rule for these values ("intended as
// fills/dots beside a neutral label, never as the label colour itself"),
// and spec section 6's colour discipline, which reserves colour for status
// and priority. It is also never the only signal: every segment of the bar
// is restated as text in the legend directly beneath it, which is why the
// bar itself is aria-hidden rather than given a label that would
// double-announce the same five numbers.
interface RunProgressProps {
  counts: Record<string, number>;
  total: number;
}

function RunProgress({ counts, total }: RunProgressProps): JSX.Element {
  const executed = total - (counts['No Run'] ?? 0);
  const percent = total === 0 ? 0 : Math.round((executed / total) * 100);

  return (
    <Box mb={3}>
      <Box display="flex" alignItems="baseline" gap={1} flexWrap="wrap">
        <Typography variant="h4" component="p" lineHeight={1}>
          {percent}%
        </Typography>
        <Typography variant="body2" color="text.secondary">
          executed — {executed} of {total} {total === 1 ? 'test case' : 'test cases'}
        </Typography>
      </Box>

      <Box
        aria-hidden
        display="flex"
        sx={{ height: 8, mt: 1, borderRadius: 1, overflow: 'hidden', bgcolor: 'action.hover' }}
      >
        {STATUS_DISPLAY_ORDER.map((status) => {
          const count = counts[status] ?? 0;
          // total is 0 only when every count is 0, so the division below
          // is never reached with a zero denominator.
          if (count === 0) return null;
          return (
            <Box
              key={status}
              sx={{ width: `${(count / total) * 100}%`, bgcolor: statusColor(status) }}
            />
          );
        })}
      </Box>

      <Box display="flex" flexWrap="wrap" columnGap={2.5} rowGap={0.5} mt={1}>
        {STATUS_DISPLAY_ORDER.map((status) => (
          <Box
            key={status}
            display="flex"
            alignItems="center"
            gap={0.75}
            data-testid={`status-count-${status}`}
          >
            <Box
              aria-hidden
              sx={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, bgcolor: statusColor(status) }}
            />
            <Typography variant="body2" color="text.secondary">
              {STATUS_LABELS[status]}
            </Typography>
            <Typography variant="body2" fontWeight={600}>
              {counts[status] ?? 0}
            </Typography>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }): JSX.Element {
  return (
    <>
      <Typography variant="subtitle1">{children}</Typography>
      <Divider sx={{ mb: 1 }} />
    </>
  );
}

interface KeycloakTokenParsed {
  sub?: string;
  name?: string;
}

// A6 -- "You cannot raise or link a defect from a failing test run"
// (PRODUCT_GAP_REGISTER.md's highest-value open gap): TestRunDetail had no
// defect action and no links section at all for the test case a tester is
// looking at. This panel is the fix, scoped to the selected test case:
//
//  - a read-only list of the defects already linked to it (always shown,
//    regardless of permission, so a tracked failure is visible to anyone
//    who can view the run);
//  - "Link existing defect", gated on canWrite -- a scoped-down version of
//    Components/LinkIssue/linkissue.tsx's own create-link form (same
//    IssueSearch component, same createLink calls, same bidirectional
//    payload shape, same LINK_TYPES vocabulary), fixed to Defects rather
//    than offering the full TestCase/Requirements/Defects picker, and
//    gated on canWrite (linkissue.tsx's own generic form is not -- adding
//    that gate there is out of this WP's scope and would ripple across
//    every other module's Links tab).
//
// Deliberately its OWN query (getLinkedIssuesApi filtered to
// destinationModule === 5) rather than embedding the full generic
// LinksSection/LinkIssues component: that component shows every linked
// module (TestCase/Requirements/Defects) and has no permission gate, and
// wiring a `readOnly` prop through it would touch RequirementDetail/
// TestCaseDetail/DefectDetail's identical usage too.
interface LinkedDefect {
  _id?: string;
  destinationId: string;
  destinationModule: number;
  summary?: string;
  linkType?: LinkType;
}

interface SelectedIssueOption {
  label: string;
  value: string;
}

interface DefectLinksSectionProps {
  projectId: string | number;
  testCaseId: string;
  testCaseSummary?: string;
  canWrite: boolean;
}

function DefectLinksSection({ projectId, testCaseId, testCaseSummary, canWrite }: DefectLinksSectionProps): JSX.Element {
  const queryClient = useQueryClient();
  const [linking, setLinking] = useState(false);
  const [selectedDefect, setSelectedDefect] = useState<SelectedIssueOption | null>(null);
  const [linkType, setLinkType] = useState<LinkType | ''>('');
  const [linkError, setLinkError] = useState<string | null>(null);

  const linksQueryKey = ['project', projectId, TESTCASE_MODULE_ID, testCaseId, 'defectLinks'] as const;
  const linksQuery = useQuery({
    queryKey: linksQueryKey,
    queryFn: async (): Promise<LinkedDefect[]> => {
      const rows: LinkedDefect[] = (await getLinkedIssuesApi(`sourceId=${testCaseId}`)) ?? [];
      return rows.filter((row) => row.destinationModule === DEFECT_MODULE_ID);
    },
    enabled: Boolean(testCaseId),
  });

  const linkExisting = useMutation({
    mutationFn: async () => {
      if (!selectedDefect || !linkType) return;
      const destSummary = selectedDefect.label.split(':').slice(1).join(':').trim();
      // Mirrors linkissue.tsx's linkIssuesHandle exactly: forward doc then
      // reverse doc, srcSummary/summary and sourceId/destinationId swapped.
      await createLink({
        srcSummary: testCaseSummary,
        sourceId: testCaseId,
        destinationId: selectedDefect.value,
        srcModule: TESTCASE_MODULE_ID,
        destinationModule: DEFECT_MODULE_ID,
        summary: destSummary,
        linkType,
      });
      await createLink({
        srcSummary: destSummary,
        sourceId: selectedDefect.value,
        destinationId: testCaseId,
        srcModule: DEFECT_MODULE_ID,
        destinationModule: TESTCASE_MODULE_ID,
        summary: testCaseSummary,
        linkType,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: linksQueryKey });
      setLinking(false);
      setSelectedDefect(null);
      setLinkType('');
    },
    onError: () => setLinkError('Could not link that defect. Please try again.'),
  });

  const links = linksQuery.data ?? [];

  return (
    <Box mt={2}>
      <SectionHeading>Linked Defects</SectionHeading>
      {linkError && (
        <Alert severity="error" onClose={() => setLinkError(null)} sx={{ my: 1 }}>
          {linkError}
        </Alert>
      )}
      {linksQuery.isLoading && <CircularProgress aria-label="Loading linked defects" size={20} />}
      {!linksQuery.isLoading && links.length === 0 && (
        <Typography color="text.secondary" variant="body2" sx={{ my: 1 }}>
          No defects linked yet.
        </Typography>
      )}
      {links.length > 0 && (
        <List dense>
          {links.map((link) => (
            <ListItem key={link._id ?? link.destinationId}>
              <ListItemText primary={`${link.destinationId}${link.summary ? ' : ' + link.summary : ''}`} />
              <StatusChip status={link.linkType ?? 'relates-to'} colorMap={LINK_TYPE_COLORS} />
            </ListItem>
          ))}
        </List>
      )}

      {canWrite && (
        <Box mt={2} display="flex" gap={2}>
          <Button variant="outlined" onClick={() => setLinking((v) => !v)}>Link existing defect</Button>
        </Box>
      )}

      {canWrite && linking && (
        <Grid container spacing={1} alignItems="center" mt={0.5}>
          <Grid item xs={12} md={6}>
            <IssueSearch selectedIssueType={DEFECT_MODULE_ID} setDestIssue={setSelectedDefect} />
          </Grid>
          <Grid item xs={7} md={3}>
            <Select
              inputProps={{ 'aria-label': 'Link type' }}
              displayEmpty
              fullWidth
              size="small"
              value={linkType}
              onChange={(e) => setLinkType(e.target.value as LinkType)}
              renderValue={(value) => (value ? (value as string) : <em>Link Type</em>)}
            >
              <MenuItem value="" disabled><em>Link Type</em></MenuItem>
              {LINK_TYPES.map((type) => (
                <MenuItem key={type} value={type}>{type}</MenuItem>
              ))}
            </Select>
          </Grid>
          <Grid item xs={5} md={3}>
            <Button
              fullWidth
              variant="contained"
              disabled={!selectedDefect || !linkType || linkExisting.isPending}
              onClick={() => linkExisting.mutate()}
            >
              Confirm Link
            </Button>
          </Grid>
        </Grid>
      )}
    </Box>
  );
}

// WP-076 Part A -- TestRunDetail, ported from
// Components/Tabs/TestExecutionContent.tsx (not modified at the time this
// component was written; Pages/testExecution.tsx, its only mount point, is
// retired by this same WP's cutover -- see EntityDetail.tsx for TestRunDetail's
// own, current mount point). This IS "the delicate one": the rollup in
// computeTcStatus above and the mutation payload shape below
// (`{ TestSteps, TestStatus }` via the real `updateTestSteps` API
// function) are preserved exactly, because e2e/specs/test-execution.spec.ts
// records a Pass against a step and asserts the result.
//
// UNLIKE TestCaseDetail/RequirementDetail there is no FieldGrid/
// getFields(4) "Details" tab for the run's own record: a live query of
// srckube-fields.fields for moduleId:4 (via the mongodb MCP tool) returns
// exactly ONE document -- a "Step Status" DropDown whose defaultValue IS
// the status vocabulary above -- not a FieldGrid-shaped attribute list.
// TabContent.tsx never called getFields(4) for a module-4 FieldGrid either
// (it isn't reachable from its own selectedModule-driven fetch effect).
// That one Field document's real, existing consumer is
// AddDeleteTableRows itself (module === 4 branch, api/apiCalls.tsx),
// reused unchanged below to populate the per-step Status <Select> -- this
// is where "fields come from getFields(4)" actually happens in this view.
//
// The nested test case's own fields (legacy `tcFields`, TabContent.tsx's
// `getFields(1)` when selectedModule === 4) are rendered read-only here,
// same as TestExecutionContent.tsx -- editing a TC's own definition mid-
// execution was never legacy behaviour, and turning that on would be a
// real, undiscussed behaviour change, not a straightforward port.
//
// Server state lives ONLY in React Query. `selectedTcId`/`edit` are
// ephemeral UI state (which test case is open, whether its steps are in
// edit mode) -- not a copy of fetched data. `pendingSteps` is the one
// exception the kit already establishes a precedent for (FieldGrid's own
// per-field `draft` local state, synced from query data via
// `useEffect(() => set..., [value])` and thrown away on every fresh
// load/selection/save): here it buffers the WHOLE steps array between
// Play and Save, exactly reproducing TestExecutionContent's own
// TCStepsContext-provided `tcSteps` buffer instead of collapsing it into
// FieldGrid's per-field commit-on-blur (which would silently drop the
// explicit Play/Save gate this rollup depends on).
export function TestRunDetail({ entityId }: TestRunDetailProps): JSX.Element {
  const projectId = getCurrentProjectId();
  // RBAC. The legacy page gated its Edit affordance on can('write')
  // (TabContent.tsx:631); per-field inline edit removed that single
  // button and nothing replaced it, so read-only users were shown
  // editable fields whose writes the backend then rejected.
  const { can } = usePermissions();
  const canWrite = can('write');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const setTabDirty = useWorkbench((state) => state.setTabDirty);
  const openTab = useWorkbench((state) => state.openTab);
  const setDefectDraftIntent = useWorkbench((state) => state.setDefectDraftIntent);
  const thisTabKey = tabKey(MODULE_ID, entityId);
  const { sub, name } = (keycloak.tokenParsed as KeycloakTokenParsed | undefined) ?? {};

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedTcId, setSelectedTcId] = useState<string | null>(null);
  // WP-F07b Task 4 -- the second half of a row's identity. null (not 0)
  // means "nothing selected yet"; once a row is selected this is always a
  // real number, including 0, which is why every read of it below uses
  // `?? 0` rather than treating null/0 the same way.
  const [selectedIterationIndex, setSelectedIterationIndex] = useState<number | null>(null);
  const [edit, setEdit] = useState(false);
  // A tester opens a run to record results, not to read the test case's
  // metadata -- so the metadata folds away and the screen opens on Steps.
  // Collapsed rather than removed: it is the only place in the run view
  // that shows the case's own fields.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pendingSteps, setPendingSteps] = useState<StepRow[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState('');
  const [uploading, setUploading] = useState(false);

  const entityQuery = useQuery({
    queryKey: qk.entity(projectId, MODULE_ID, entityId),
    queryFn: async (): Promise<RunRecord> => {
      const rows = await getTestExecutionList(`TestExecutionId=${entityId}`);
      return (rows && rows[0]) || {};
    },
  });

  const values: RunRecord = entityQuery.data ?? {};
  const runTestCases = values.TestCases ?? [];

  const assignedToQuery = useQuery({
    queryKey: ['project', projectId, MODULE_ID, 'assignedToName', values.assignedTo] as const,
    queryFn: async () => getCreatedBy(values.assignedTo as string),
    enabled: Boolean(values.assignedTo),
  });

  // The nested test case's own field DEFINITIONS -- module 1, not 4 (see
  // header comment). Read-only display only.
  const tcFieldsQuery = useQuery({
    queryKey: ['project', projectId, 1, 'fields'] as const,
    queryFn: () => getFields(1) as Promise<FieldDefinition[]>,
  });

  const selectedTcQuery = useQuery({
    // WP-F07b Task 4 -- keyed on the iteration too, not just the
    // TestCaseId: without this, switching from iteration 0 to iteration 1
    // of the same case would read back iteration 0's cached react-query
    // entry instead of ever fetching iteration 1's.
    queryKey: [...qk.entity(projectId, MODULE_ID, entityId), 'tc', selectedTcId, selectedIterationIndex] as const,
    queryFn: async (): Promise<RunTestCaseDetail> => {
      const detailList = await getTeTestCaseDetails(selectedTcId, entityId, selectedIterationIndex ?? 0);
      return detailList?.[0]?.TestCases?.[0] ?? {};
    },
    enabled: Boolean(selectedTcId) && selectedIterationIndex !== null,
  });

  const selectedTc = selectedTcQuery.data;

  // Reset the steps edit buffer whenever the selection changes or fresh
  // data arrives (a save's invalidate included) -- never diverges from
  // server truth except during an active, unsaved edit.
  useEffect(() => {
    setPendingSteps(selectedTc?.TestSteps ?? []);
    setEdit(false);
  }, [selectedTcId, selectedIterationIndex, selectedTc]);

  const commitSteps = useMutation({
    mutationFn: async (steps: StepRow[]) => {
      const tcStatus = computeTcStatus(steps);
      return updateTestSteps(selectedTcId, entityId, { TestSteps: steps, TestStatus: tcStatus }, selectedIterationIndex ?? 0);
    },
    onError: () => setErrorMessage('Could not save the test steps. Please try again.'),
    onSuccess: () => setEdit(false),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: qk.entity(projectId, MODULE_ID, entityId) });
      queryClient.invalidateQueries({ queryKey: [...qk.entity(projectId, MODULE_ID, entityId), 'tc', selectedTcId, selectedIterationIndex] });
      setTabDirty(thisTabKey, false);
    },
  });

  const commitAttachments = useMutation({
    mutationFn: async (nAttachments: AttachmentItem[]) =>
      updateAttachment(selectedTcId, entityId, { attachment: nAttachments }, selectedIterationIndex ?? 0),
    onError: () => setErrorMessage('Could not update the attachments. Please try again.'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: [...qk.entity(projectId, MODULE_ID, entityId), 'tc', selectedTcId, selectedIterationIndex] });
    },
  });

  // WP-F05b (Task 2) -- tags belong to the RUN's own record, not the
  // selected test case (unlike commitSteps/commitAttachments above, which
  // both PUT through .../updateteststep|updateattachment scoped to
  // selectedTcId). `updateTestExecution` (api/apiCalls.tsx -> PUT
  // /api/v1/testexecution/:id) is the run's own existing update path --
  // already used elsewhere (Components/Lists/dropDownList.tsx's assignedTo
  // picker) but not yet from this file -- reused here rather than adding a
  // new endpoint, on the same optimistic-mutate-then-invalidate shape
  // TestCaseDetail/RequirementDetail/DefectDetail's own commitField uses.
  const commitTags = useMutation({
    mutationFn: async (nTags: string[]) => updateTestExecution({ tags: nTags }, values._id),
    onMutate: async (nTags) => {
      await queryClient.cancelQueries({ queryKey: qk.entity(projectId, MODULE_ID, entityId) });
      const previous = queryClient.getQueryData<RunRecord>(qk.entity(projectId, MODULE_ID, entityId));
      queryClient.setQueryData<RunRecord>(qk.entity(projectId, MODULE_ID, entityId), (old) => ({
        ...(old ?? {}),
        tags: nTags,
      }));
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(qk.entity(projectId, MODULE_ID, entityId), context.previous);
      }
      setErrorMessage('Could not save that change. Please try again.');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: qk.entity(projectId, MODULE_ID, entityId) });
    },
  });

  const handleSelectTc = (tcId: string, iterationIndex?: number) => {
    setSelectedTcId(tcId);
    // WP-F07b Task 4 -- `?? 0`, not `||`: a row whose iterationIndex IS 0
    // (every pre-existing row) must select exactly as it always did.
    setSelectedIterationIndex(iterationIndex ?? 0);
  };

  const handleStepsChange = (nSteps: StepRow[]) => {
    setPendingSteps(nSteps);
    setTabDirty(thisTabKey, true);
  };

  const handleSaveSteps = () => {
    commitSteps.mutate(pendingSteps);
  };

  // A6 -- opens a module-5 draft tab pre-filled with the failure context
  // for the currently selected test case, and records the link that
  // DefectDetail's own create-success handler completes once the defect
  // has a real id (see workbenchStore.ts's DefectDraftIntent and
  // DefectDetail.tsx's createDefect.onSuccess). Real ids only
  // (selectedTc.TestCaseId, the run's own TestExecutionId, each step's
  // actual text/expected/status) -- never invented placeholder text.
  const handleRaiseDefect = () => {
    if (!selectedTc) return;
    const draftId = makeDraftEntityId();
    const runId = values.TestExecutionId ?? entityId;
    const stepLines = pendingSteps.length
      ? pendingSteps
          .map((step, idx) => `${idx + 1}. ${step.testStep} — Expected: ${step.Expected} — Status: ${step.status ?? 'No Run'}`)
          .join('\n')
      : 'No steps recorded.';
    // R5 -- "TC-9 failed" is not actionable when only ONE data row failed;
    // triage needs to know which data reproduces it. `iterationValues ?? {}`
    // (never a truthiness check on iterationIndex, which is 0 for the
    // common case) so an unparameterised case's defect text is BYTE
    // IDENTICAL to before this task -- the regression guard for R5.
    const iterationEntries = Object.entries(selectedTc.iterationValues ?? {});
    const iterationSuffix = iterationEntries.length
      ? ` (iteration ${selectedTc.iterationIndex ?? 0}: ${iterationEntries.map(([column, value]) => `${column}=${value}`).join(', ')})`
      : '';
    const summary = `Test case ${selectedTc.TestCaseId} failed in run ${runId}${iterationSuffix}`;
    const description = `Raised from test run ${runId}, test case ${selectedTc.TestCaseId}${
      selectedTc.TestCaseSummary ? ` (${selectedTc.TestCaseSummary})` : ''
    }${iterationSuffix}.\n\nSteps:\n${stepLines}`;

    setDefectDraftIntent(draftId, {
      prefill: { summary, description },
      link: {
        sourceModule: TESTCASE_MODULE_ID,
        sourceId: selectedTc.TestCaseId,
        sourceSummary: selectedTc.TestCaseSummary,
        linkType: 'relates-to',
      },
    });
    openTab({ module: DEFECT_MODULE_ID, entityId: draftId, title: 'New Defect' });
    // EntityDetail.tsx only ever renders the active tab when the ACTIVE
    // TAB'S module matches the current URL's module slug (Workbench.tsx's
    // own `activeEntityIdForModule` does the identical check) -- every
    // other draft-opening affordance (SourcePanel's "New X") already lives
    // on that module's own route, so this mismatch never came up before.
    // "Raise defect" is opened from the Test Runs route, so without this
    // navigation the new module-5 tab exists in the store and the tab
    // strip, but the detail region still shows "Select an item..." for it
    // -- found by this WP's own required browser verification, not
    // assumed. Mirrors ModuleRail.tsx's own cross-module navigation
    // (`/projects/:id/workbench/:slug`); Workbench.tsx's own effect then
    // appends `/${draftId}` once the store's activeEntityIdForModule syncs.
    navigate(`/projects/${projectId}/workbench/${MODULE_SLUGS[DEFECT_MODULE_ID]}`);
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];
    if (picked) {
      setFile(picked);
      setFileName(picked.name);
    }
  };

  const handleUpload = async () => {
    if (!file || !selectedTc) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const uploaded = await uploadAttachment(formData);
      if (uploaded.status === 201) {
        const newItem: AttachmentItem = { attachmentId: uploaded.data.fileID, name: file.name };
        await commitAttachments.mutateAsync([...(selectedTc.attachment ?? []), newItem]);
        setFileName('Upload Success');
        setFile(null);
      }
    } catch {
      setErrorMessage('Could not upload that file. Please try again.');
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteAttachment = (attachmentId: string) => {
    commitAttachments.mutate((selectedTc?.attachment ?? []).filter((a) => a.attachmentId !== attachmentId));
  };

  const statusCounts: Record<string, number> = STATUS_KEYS.reduce((acc, status) => {
    acc[status] = runTestCases.filter((tc) => tc.TestStatus === status).length;
    return acc;
  }, {} as Record<string, number>);

  if (entityQuery.isLoading) {
    return <CircularProgress aria-label={`Loading ${entityId}`} />;
  }
  if (entityQuery.isError) {
    return <Alert severity="error">Could not load this test run.</Alert>;
  }

  const tcFields = (tcFieldsQuery.data ?? []).filter(
    (f) => f.isDisplayed && !['requirementSummary', 'TestCaseSummary', 'Expected', 'testStep'].includes(f.fieldName),
  );

  return (
    <Box>
      {errorMessage && (
        <Alert severity="error" onClose={() => setErrorMessage(null)} sx={{ mb: 2 }}>
          {errorMessage}
        </Alert>
      )}
      <DetailHeader id={values.TestExecutionId ?? entityId}>
        {values.assignedTo && (
          <Typography variant="body2" color="text.secondary">
            Assigned To : {assignedToQuery.data ?? values.assignedTo}
          </Typography>
        )}
      </DetailHeader>

      <Box mb={2}>
        <TagsSection
          module={MODULE_ID}
          entityId={entityId}
          tags={values.tags ?? []}
          onChange={(nTags) => commitTags.mutate(nTags)}
          readOnly={!canWrite}
        />
      </Box>

      <RunProgress counts={statusCounts} total={runTestCases.length} />

      <Grid container spacing={4}>
        <Grid item xs={12} md={3}>
          <SectionHeading>Test Cases</SectionHeading>
          <List dense>
            {runTestCases.map((tc) => {
              // WP-F07b Task 4 -- a case within a run is addressed by
              // TestCaseId + iterationIndex now, not TestCaseId alone: three
              // iterations of one parameterised case share a TestCaseId, so
              // `key={tc.TestCaseId}` alone would give three siblings the
              // same React key (a collision React only warns about, never
              // throws) and `tc.TestCaseId === selectedTcId` would mark
              // every one of them selected at once. One helper
              // (iterationRowKey) computes both, so they cannot drift apart.
              const rowKey = iterationRowKey(tc.TestCaseId, tc.iterationIndex);
              const isSelected =
                selectedTcId !== null && rowKey === iterationRowKey(selectedTcId, selectedIterationIndex);
              return (
                // WP-076 -- ListItemButton wrapped in ListItem/disablePadding
                // (MUI's own documented pattern) rather than mounted directly
                // as List's child: List renders a real <ul>, and
                // ListItemButton's root is a <div role="button">, which
                // TestRunDetail.a11y.test.tsx's axe check (ported from
                // TestExecutionContent.a11y.test.tsx) caught as an invalid
                // list-children violation the old tree-based markup never hit.
                // The status was a StatusChip here, which is what the tree
                // (EntityTreeNode.tsx) still uses. A deliberate divergence:
                // the tree shows one chip on the odd node, this list shows
                // one per row for every case in the run, and twenty-odd
                // filled pills stacked in a narrow column is the clutter
                // itself. A rail down the left edge reads as a single
                // continuous column of colour -- the fastest way to find
                // the failure -- and costs no horizontal room, which is
                // what lets the label beside it stop wrapping.
                <ListItem key={rowKey} disablePadding>
                  <ListItemButton
                    selected={isSelected}
                    onClick={() => handleSelectTc(tc.TestCaseId, tc.iterationIndex)}
                    // 3px read as a hairline on screen and vanished under
                    // the selected row's own grey fill. 4px, and the fill
                    // is lightened so the rail survives selection.
                    sx={{
                      gap: 1,
                      borderLeft: 4,
                      borderLeftColor: statusColor(tc.TestStatus),
                      '&.Mui-selected': { bgcolor: 'action.selected' },
                    }}
                  >
                    <ListItemText
                      primary={iterationLabel(tc.TestCaseId, tc.iterationValues)}
                      primaryTypographyProps={{ variant: 'body2' }}
                    />
                    {/* WCAG 1.4.1 -- the rail's colour is never the only
                        signal for a row's status. */}
                    <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                      {STATUS_LABELS[tc.TestStatus ?? 'No Run'] ?? tc.TestStatus}
                    </Typography>
                  </ListItemButton>
                </ListItem>
              );
            })}
          </List>
        </Grid>

        {/* The only border added here, and it encodes something real: the
            case list ends, the work on one case begins. md and up only --
            stacked on a narrow tab the two are already sequential, and a
            rule across the top of the detail pane there would separate
            nothing. */}
        <Grid item xs={12} md={9} sx={{ borderLeft: { md: 1 }, borderColor: 'divider', pl: { md: 6 } }}>
          {selectedTcQuery.isLoading && <CircularProgress aria-label={`Loading ${selectedTcId}`} />}
          {selectedTc && (
            <Box>
              {/* Both actions were icon-only outlined buttons of equal
                  weight, so a bare play triangle had to carry "put the
                  steps into edit mode" on its own and neither button
                  looked more like the thing to press. Now each says what
                  it does, and Save is the one contained button on the
                  screen -- the tester's actual goal. The fixed 9/3 Grid
                  split became flex so a long summary and a pair of
                  labelled buttons stop fighting over a narrow pane.
                  Both names are now carried by visible text rather than
                  an aria-label, which is what WCAG 2.5.3 wants anyway. */}
              <Box display="flex" alignItems="center" justifyContent="space-between" gap={2} flexWrap="wrap">
                <Typography variant="h6" color="primary.main" sx={{ minWidth: 0 }}>
                  {selectedTc.TestCaseId} : {selectedTc.TestCaseSummary}
                </Typography>
                {/* "Raise defect" used to sit at the very bottom of this
                    pane, below the steps, the attachments and the linked-
                    defect list -- a scroll away from the moment a tester
                    marks a step Fail, which is the only moment it is ever
                    wanted. It belongs with the two actions the tester is
                    already using. Moved, not duplicated: one button with
                    this name still exists. */}
                <Box display="flex" gap={2} flexShrink={0}>
                  <Button
                    variant="outlined"
                    color="primary"
                    startIcon={<PlayArrowIcon />}
                    disabled={edit || !canWrite}
                    onClick={() => setEdit(true)}
                  >
                    Run
                  </Button>
                  <Button
                    variant="contained"
                    color="primary"
                    startIcon={<SaveIcon />}
                    disabled={!edit || !canWrite}
                    onClick={handleSaveSteps}
                  >
                    Save
                  </Button>
                  {canWrite && (
                    <Button variant="outlined" color="primary" startIcon={<BugReportIcon />} onClick={handleRaiseDefect}>
                      Raise defect
                    </Button>
                  )}
                </Box>
              </Box>

              <Box mt={3}>
                <ButtonBase
                  onClick={() => setDetailsOpen((open) => !open)}
                  aria-expanded={detailsOpen}
                  sx={{ width: '100%', justifyContent: 'flex-start', gap: 0.5, py: 0.5 }}
                >
                  <ExpandMoreIcon
                    fontSize="small"
                    sx={{
                      color: 'text.secondary',
                      transform: detailsOpen ? 'none' : 'rotate(-90deg)',
                      transition: 'transform 120ms',
                      '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
                    }}
                  />
                  <Typography variant="subtitle1">Test Case Details</Typography>
                </ButtonBase>
                <Divider sx={{ mb: 1 }} />
                <Collapse in={detailsOpen} unmountOnExit>
                <Grid container spacing={4}>
                  {tcFields.map((field) => {
                    const raw = field.isDefault
                      ? (selectedTc as Record<string, unknown>)[field.fieldName]
                      : selectedTc.dynamicFields?.[field.fieldName];
                    const display = field.fieldType === 'Editor' ? (parseEditorValue(raw) as { ops?: Array<{ insert?: string }> })?.ops?.map((op) => op.insert).join('') ?? '' : (raw as string) ?? '';
                    return (
                      <Grid item xs={field.fieldType === 'TextArea' || field.fieldType === 'Editor' ? 12 : 6} key={field.fieldName}>
                        <FormLabel
                          required={field.isMandatory}
                          sx={{ display: 'block', fontSize: 12, color: 'text.secondary', mb: 0.25 }}
                        >
                          {field.displayName}
                        </FormLabel>
                        {/* Was a filled `action.hover` pill per field -- a dozen
                            competing rectangles around text that is just text.
                            minHeight holds the row rhythm when a value is empty,
                            which is the only thing the filled box was really
                            doing. */}
                        <Typography variant="body2" sx={{ minHeight: 20 }}>{display}</Typography>
                      </Grid>
                    );
                  })}
                </Grid>
                </Collapse>
              </Box>

              <Box mt={3}>
                <SectionHeading>Steps</SectionHeading>
                <TCStepsContext.Provider value={{ tcSteps: pendingSteps, setTcSteps: handleStepsChange }}>
                  <AddDeleteTableRows rows={pendingSteps} editable={edit} module={MODULE_ID} />
                </TCStepsContext.Provider>
              </Box>

              <AttachmentsSection
                attachmentList={selectedTc.attachment ?? []}
                file={file}
                fileName={fileName}
                loading={uploading}
                onFileChange={handleFileChange}
                onUpload={handleUpload}
                onDelete={handleDeleteAttachment}
              />

              <DefectLinksSection
                projectId={projectId}
                testCaseId={selectedTc.TestCaseId}
                testCaseSummary={selectedTc.TestCaseSummary}
                canWrite={canWrite}
              />
            </Box>
          )}
          {!selectedTc && !selectedTcQuery.isLoading && (
            <Typography color="text.secondary">Select a test case to record a result.</Typography>
          )}
        </Grid>
      </Grid>

      <Divider sx={{ my: 2 }} />
      <CommentsSection moduleId={MODULE_ID} typeId={entityId} userName={name} userId={sub} />
    </Box>
  );
}

export default TestRunDetail;
