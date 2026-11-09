import React, { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormLabel,
  Grid,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { DataGrid, GridColDef, GridRowSelectionModel } from '@mui/x-data-grid';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import SaveAsOutlinedIcon from '@mui/icons-material/SaveAsOutlined';
import { getTestPlanList, getTestExecutionList, getTcList, updatedTestPlan, createTestExecution, saveApiTestPlan, updateTestExecution } from '../../../api/apiCalls';
import { getCurrentProjectId } from '../../../currentProject';
import { qk } from '../../../Hooks/queryKeys';
import keycloak from '../../../keycloak';
import { isDraftEntityId, tabKey } from '../../store/workbenchStore';
import { useWorkbench } from '../../WorkbenchStoreProvider';
import { resolveSelectedParentId } from '../../tree/selectedParent';
import { StatusChip, StatusChipColor } from '../../../Components/common/StatusChip';
import DetailHeader from '../DetailHeader';
import DetailTabs from '../DetailTabs';
import CommentsSection from '../CommentsSection';
import TagsSection from '../TagsSection';
import { usePermissions } from '../../../Hooks/usePermissions';
import { SaveAsTemplateDialog } from '../../../Components/templates/SaveAsTemplateDialog';
import { AssigneeSelect } from '../AssigneeSelect';

export interface TestPlanDetailProps {
  entityId: string;
}

// Module id for Test Plans (src/workbench/modules.ts's ModuleId 3).
const MODULE_ID = 3;

interface TestCaseRow {
  TestCaseId: string;
  TestCaseSummary?: string;
  TestStatus?: string;
  id: number;
  [key: string]: unknown;
}

interface TestPlanRecord {
  _id?: string;
  TestPlanId?: string;
  parentId?: unknown;
  TestCases?: TestCaseRow[];
  objective?: string;
  scope?: string;
  entryCriteria?: string;
  exitCriteria?: string;
  risk?: string;
  schedule?: { plannedStart?: string; plannedEnd?: string };
  environment?: string;
  tags?: string[];
  [key: string]: unknown;
}

interface TestCaseOption {
  TestCaseId: string;
  TestCaseSummary?: string;
}

interface ExecutionRow {
  _id?: string;
  TestExecutionId: string;
  assignedTo?: string;
  [key: string]: unknown;
}

interface KeycloakTokenParsed {
  sub?: string;
  name?: string;
  preferred_username?: string;
}

const RISK_COLORS: Record<string, StatusChipColor> = { Low: 'success', Medium: 'warning', High: 'error' };

// WP-076 Part A -- TestPlanDetail, source of truth for fetch/save shape is
// Components/Tabs/TestPlanContent.tsx (Test Cases / Test Executions tabs)
// and PlanDetails.tsx (the enrichment form), neither of which this file
// touches -- Pages/testPlan.tsx (their only mount point) is retired by this
// same WP's cutover, so both are now orphaned dead code, left in place only
// because Components/Tabs/TabContent.tsx (still reachable via Defects until
// WP-077) imports TestPlanContent unconditionally; WP-078 owns deleting
// them.
//
// UNLIKE TestCaseDetail/RequirementDetail, module 3 has no generic
// dynamic-fields record: TabContent.tsx's own fetch effect explicitly
// skips `getFields(selectedModule)` when selectedModule === 3, and a live
// query of srckube-fields.fields for moduleId:3 (verified via the mongodb
// MCP tool) returns zero documents. So there is deliberately no
// FieldGrid/getFields(3) "Details" tab here -- fabricating one would
// display fields the live product has never had. A plan's own "fields"
// are the fixed enrichment schema below (objective/scope/risk/
// entryCriteria/exitCriteria/schedule/environment, WP-014's
// api/testPlanApi.ts shape) plus its TestCases membership -- both already
// present on the SAME row `getTestPlanList` returns (that call passes no
// `select=`, unlike TabContent's `select=_id,TestPlanId,TestCases`), so one
// entity query covers both this file's tabs.
//
// Server state lives ONLY in React Query. `addOpen`/`addSelectionModel`/
// `membershipSelectionModel` are local UI-only state (a picker panel's
// open/closed state and which DataGrid rows are checked) -- not a copy of
// fetched data; the grids themselves always render straight off
// entityQuery.data / availableQuery.data.
export function TestPlanDetail({ entityId }: TestPlanDetailProps): JSX.Element {
  const projectId = getCurrentProjectId();
  // RBAC. The legacy page gated its Edit affordance on can('write')
  // (TabContent.tsx:631); per-field inline edit removed that single
  // button and nothing replaced it, so read-only users were shown
  // editable fields whose writes the backend then rejected.
  const { can } = usePermissions();
  const canWrite = can('write');
  const queryClient = useQueryClient();
  const setTabDirty = useWorkbench((state) => state.setTabDirty);
  const openTab = useWorkbench((state) => state.openTab);
  const setActiveModule = useWorkbench((state) => state.setActiveModule);
  const replaceTab = useWorkbench((state) => state.replaceTab);
  const selection = useWorkbench((state) => state.selection[MODULE_ID]);
  const expandedIds = useWorkbench((state) => state.expanded[MODULE_ID]);
  const thisTabKey = tabKey(MODULE_ID, entityId);
  const isDraft = isDraftEntityId(entityId);
  const { sub, name } = (keycloak.tokenParsed as KeycloakTokenParsed | undefined) ?? {};

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  // WP-F08 Task 2 -- "Save as template" dialog open/close, same pattern
  // as TestCaseDetail.tsx's own.
  const [saveAsTemplateOpen, setSaveAsTemplateOpen] = useState(false);
  // "Create Execution" asks who the run is for before creating it; the
  // assignee defaults to whoever is creating it (the backend's own default).
  const [createExecOpen, setCreateExecOpen] = useState(false);
  const [newExecAssignee, setNewExecAssignee] = useState<string | null>(null);
  const [membershipSelectionModel, setMembershipSelectionModel] = useState<GridRowSelectionModel>([]);
  const [addSelectionModel, setAddSelectionModel] = useState<GridRowSelectionModel>([]);
  // WP-F05b fix round 1 -- module 3 has no per-field draft form at all
  // (this file's own header comment), so unlike the other four
  // draft-capable modules there is no `draftValues` buffer for a tag typed
  // before Create to land in. This is the one field of it that exists,
  // added specifically so TagsSection has somewhere to write during draft
  // mode -- see createTestPlan's own payload below for why this was
  // necessary (Test Plans are draft-capable too, DRAFT_CAPABLE_MODULES in
  // workbench/modules.ts, and the same silent-drop bug applied here).
  const [draftTags, setDraftTags] = useState<string[]>([]);

  const entityQuery = useQuery({
    queryKey: qk.entity(projectId, MODULE_ID, entityId),
    queryFn: async (): Promise<TestPlanRecord> => {
      const rows = await getTestPlanList(`TestPlanId=${entityId}`);
      return (rows && rows[0]) || {};
    },
    // A draft sentinel names no real record -- see TestCaseDetail's
    // identical guard for the full rationale.
    enabled: !isDraft,
  });

  const values: TestPlanRecord = isDraft ? {} : entityQuery.data ?? {};
  const testCases = values.TestCases ?? [];
  const memberIds = new Set(testCases.map((tc) => tc.TestCaseId));

  const executionsQuery = useQuery({
    queryKey: ['project', projectId, MODULE_ID, 'executions', entityId] as const,
    queryFn: async (): Promise<ExecutionRow[]> => getTestExecutionList(`TestPlanId=${values._id}`),
    enabled: Boolean(values._id),
  });

  // WP-079 Part B -- for a draft, the test-case picker below IS the whole
  // form (there is no "Add test cases" toggle to gate it on yet), so it
  // must load immediately rather than waiting for `addOpen`.
  const availableQuery = useQuery({
    queryKey: ['project', projectId, 1, 'pickable-test-cases'] as const,
    queryFn: async (): Promise<TestCaseOption[]> => getTcList(''),
    enabled: addOpen || isDraft,
  });

  // Wave B-4 (clone) -- module 3 has no per-field draft form at all (this
  // file's own header comment), so the one thing worth pre-filling is
  // which test cases the source plan already had (useCloneEntity.ts's
  // `TestCaseIds`), pre-checked in THIS SAME picker rather than a
  // separate UI. `availableRows` (below) is only known once
  // `availableQuery` resolves, so this waits for that instead of running
  // once on mount like TestCaseDetail/RequirementDetail's own prefill
  // effects; `prefillApplied` keeps it from re-checking rows the user has
  // since unchecked.
  const clonePrefill = useWorkbench((state) => (isDraft ? state.draftPrefill[entityId] : undefined));
  const [prefillApplied, setPrefillApplied] = useState(false);

  // Membership + enrichment fields both PUT through the same live endpoint
  // (`updatedTestPlan` -> /api/v1/testplan/:id) -- the ticket's own
  // "live API" for test-plan writes. Optimistic-patch-then-invalidate,
  // same shape as TestCaseDetail/RequirementDetail's commitField.
  const commitPlan = useMutation({
    mutationFn: async (patch: Record<string, unknown>) => updatedTestPlan(values._id, patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: qk.entity(projectId, MODULE_ID, entityId) });
      const previous = queryClient.getQueryData<TestPlanRecord>(qk.entity(projectId, MODULE_ID, entityId));
      queryClient.setQueryData<TestPlanRecord>(qk.entity(projectId, MODULE_ID, entityId), (old) => ({
        ...(old ?? {}),
        ...patch,
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

  const executionsKey = ['project', projectId, MODULE_ID, 'executions', entityId] as const;

  const createExecution = useMutation({
    mutationFn: async ({ selected, assignedTo }: { selected: TestCaseRow[]; assignedTo: string | null }) =>
      createTestExecution({
        TestCases: selected,
        TestPlanId: values._id,
        ...(assignedTo ? { assignedTo } : {}),
      }),
    onSuccess: (created) => {
      setCreateExecOpen(false);
      queryClient.invalidateQueries({ queryKey: executionsKey });
      const newExecId = (created as { data?: { TestExecutionId?: string } })?.data?.TestExecutionId;
      if (newExecId) {
        setActiveModule(4);
        openTab({ module: 4, entityId: newExecId, title: newExecId });
      }
    },
    onError: () => setErrorMessage('Could not create a test execution. Please try again.'),
  });

  // Reassigning an existing execution. The legacy plan page had a user
  // picker on each execution row; the workbench port dropped it and left a
  // read-only column showing the raw user id.
  const assignExecution = useMutation({
    mutationFn: async ({ executionId, assignedTo }: { executionId: string; assignedTo: string }) =>
      updateTestExecution({ assignedTo }, executionId),
    onError: () => setErrorMessage('Could not reassign that test execution. Please try again.'),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: executionsKey });
    },
  });

  const handlePlanFieldChange = () => setTabDirty(thisTabKey, true);
  const handlePlanFieldCommit = (fieldName: keyof TestPlanRecord, value: unknown) => {
    commitPlan.mutate({ [fieldName]: value });
    setTabDirty(thisTabKey, false);
  };

  const handleRemoveSelected = () => {
    const remaining = testCases.filter((_, idx) => !membershipSelectionModel.includes(idx + 1));
    commitPlan.mutate({ TestCases: remaining, parentId: values.parentId });
    setMembershipSelectionModel([]);
  };

  // Same filtered+re-indexed array the "available test cases" DataGrid
  // renders (see its `rows` prop below) -- addSelectionModel's ids are the
  // DataGrid's own row ids, assigned AFTER the member filter, so selection
  // must be resolved against this exact array, not the raw query data.
  const availableRows: Array<TestCaseOption & { id: number }> = (availableQuery.data ?? [])
    .filter((tc) => !memberIds.has(tc.TestCaseId))
    .map((tc, i) => ({ ...tc, id: i + 1 }));

  useEffect(() => {
    const ids = clonePrefill?.TestCaseIds;
    if (isDraft && !prefillApplied && Array.isArray(ids) && ids.length > 0 && availableQuery.data) {
      const idSet = new Set(ids as string[]);
      const matched = availableRows.filter((row) => idSet.has(row.TestCaseId)).map((row) => row.id);
      if (matched.length > 0) {
        setAddSelectionModel(matched);
      }
      setPrefillApplied(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDraft, clonePrefill, availableQuery.data, prefillApplied]);

  // WP-079 Part B -- module 3 has no field documents at all (see this
  // file's own header comment), so a draft plan is created from its own
  // attributes, not a field form: exactly the shape
  // TestPlanContent.tsx's saveTestPlan posts for a new plan (~lines
  // 96-131), `{ TestCases, parentId }`, nothing else. parentId is resolved
  // the same way TestCaseDetail's Create action resolves one
  // (resolveSelectedParentId, shared). For a draft, `memberIds` is always
  // empty (there is no membership yet), so `availableRows` above already
  // is the full pickable list -- no separate draft-only rows array needed.
  const createTestPlan = useMutation({
    mutationFn: async () => {
      const parentId = resolveSelectedParentId(queryClient, projectId, MODULE_ID, selection, expandedIds);
      const selectedRows = availableRows.filter((row) => addSelectionModel.includes(row.id));
      const testCasesToCreate: TestCaseRow[] = selectedRows.map((tc, i) => ({
        TestCaseId: tc.TestCaseId,
        TestCaseSummary: tc.TestCaseSummary,
        TestStatus: 'No Run',
        id: i + 1,
      }));
      // WP-F05b fix round 1 -- `tags` explicitly included: draftTags is
      // this module's own state (added above), not one of the admin Fields
      // Configuration entries -- there is no `fields.forEach` loop here to
      // (fail to) pick it up in the first place, unlike the other three
      // draft-capable modules, but the payload still needs to name it
      // explicitly since saveApiTestPlan sends exactly what it's given.
      // `?? []`, never `null` -- the model rejects `tags: null` with a 400
      // (Task 1).
      const saved = (await saveApiTestPlan({
        TestCases: testCasesToCreate,
        parentId: Number(parentId),
        tags: draftTags ?? [],
      })) as {
        data?: { TestPlanId?: string };
      };
      return { saved, parentId };
    },
    onSuccess: ({ saved, parentId }) => {
      const newId = String(saved.data?.TestPlanId ?? '');
      replaceTab(thisTabKey, { module: MODULE_ID, entityId: newId, title: newId });
      // The tree (Hooks/queries/useTreeChildren.ts) caches exactly this key
      // per parent -- invalidating it is what makes the freshly-created
      // row appear without a manual refresh.
      queryClient.invalidateQueries({ queryKey: qk.children(projectId, MODULE_ID, parentId) });
    },
    onError: () => setErrorMessage('Could not create the test plan. Please try again.'),
  });

  const handleAddSelected = () => {
    const toAdd = availableRows.filter((row) => addSelectionModel.includes(row.id));
    const nextId = testCases.length > 0 ? Math.max(...testCases.map((tc) => tc.id ?? 0)) + 1 : 1;
    const newRows: TestCaseRow[] = toAdd.map((tc, i) => ({
      TestCaseId: tc.TestCaseId,
      TestCaseSummary: tc.TestCaseSummary,
      TestStatus: 'No Run',
      id: nextId + i,
    }));
    commitPlan.mutate({ TestCases: [...testCases, ...newRows], parentId: values.parentId });
    setAddSelectionModel([]);
  };

  const handleCreateExecution = () => {
    setNewExecAssignee(sub ?? null);
    setCreateExecOpen(true);
  };

  const handleConfirmCreateExecution = () => {
    const selected = testCases.filter((_, idx) => membershipSelectionModel.includes(idx + 1));
    createExecution.mutate({ selected, assignedTo: newExecAssignee });
  };

  const membershipColumns: GridColDef[] = [
    { field: 'TestCaseId', headerName: 'Test Case Id', flex: 1 },
    { field: 'TestCaseSummary', headerName: 'Summary', flex: 3 },
    { field: 'TestStatus', headerName: 'Test Status', flex: 1 },
  ];

  const availableColumns: GridColDef[] = [
    { field: 'TestCaseId', headerName: 'Test Case Id', flex: 1 },
    { field: 'TestCaseSummary', headerName: 'Summary', flex: 3 },
  ];

  const executionColumns: GridColDef[] = [
    { field: 'TestExecutionId', headerName: 'Test Execution Id', flex: 1 },
    {
      field: 'assignedTo',
      headerName: 'Assigned To',
      flex: 1.5,
      sortable: false,
      renderCell: (params) => (
        <Box sx={{ width: '100%' }}>
          <AssigneeSelect
            value={params.row.assignedTo}
            label={`Assigned to ${params.row.TestExecutionId}`}
            hideLabel
            disabled={!canWrite || !params.row._id}
            onChange={(userId) => {
              if (userId && userId !== params.row.assignedTo && params.row._id) {
                assignExecution.mutate({ executionId: params.row._id, assignedTo: userId });
              }
            }}
          />
        </Box>
      ),
    },
    {
      field: 'open',
      headerName: '',
      flex: 0.5,
      sortable: false,
      renderCell: (params) => (
        <Button
          size="small"
          variant="outlined"
          startIcon={<PlayArrowIcon />}
          onClick={() => {
            setActiveModule(4);
            openTab({ module: 4, entityId: params.row.TestExecutionId, title: params.row.TestExecutionId });
          }}
        >
          Open
        </Button>
      ),
    },
  ];

  if (!isDraft && entityQuery.isLoading) {
    return <CircularProgress aria-label={`Loading ${entityId}`} />;
  }
  if (!isDraft && entityQuery.isError) {
    return <Alert severity="error">Could not load this test plan.</Alert>;
  }

  if (isDraft) {
    return (
      <Box>
        {errorMessage && (
          <Alert severity="error" onClose={() => setErrorMessage(null)} sx={{ mb: 2 }}>
            {errorMessage}
          </Alert>
        )}
        <DetailHeader id="New Test Plan" />
        <Box mb={2}>
          <TagsSection
            module={MODULE_ID}
            entityId={entityId}
            tags={draftTags}
            onChange={setDraftTags}
            readOnly={!canWrite}
          />
        </Box>
        <Typography variant="subtitle1" mb={1}>
          Test cases (optional -- more can be added after the plan is created)
        </Typography>
        <div data-testid="draft-available-test-cases-grid" style={{ width: '100%' }}>
          <DataGrid
            autoHeight
            loading={availableQuery.isLoading}
            rows={availableRows}
            columns={availableColumns}
            checkboxSelection
            onRowSelectionModelChange={setAddSelectionModel}
            rowSelectionModel={addSelectionModel}
            getRowId={(row) => row.id}
          />
        </div>
        <Box mt={2}>
          <Button
            variant="contained"
            color="primary"
            onClick={() => createTestPlan.mutate()}
            disabled={createTestPlan.isPending}
          >
            Create
          </Button>
        </Box>
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
      {/* Every other detail view states the entity's identity and its
          current state in the header, and shows its tags directly beneath
          -- Requirement and Test Case both do, via LifecycleStatusSection
          and TagsSection. A plan did neither: its risk and its tags were
          both buried inside the third tab, so the two things that say what
          kind of plan this is were two clicks from view. The risk chip here
          mirrors the Select that still lives in Details -- read-only, the
          way LifecycleStatusSection's own chip reads on a requirement. */}
      <DetailHeader id={values.TestPlanId ?? entityId} summary={values.objective}>
        {values.risk && (
          <Box mt={0.5}>
            <StatusChip status={values.risk} colorMap={RISK_COLORS} />
          </Box>
        )}
      </DetailHeader>

      {/* WP-F08 Task 2 -- see TestCaseDetail.tsx's identical control for
          the full R4 (snapshot, not a live link) rationale. For module 3
          the captured prefill is the plan's test-case membership
          (entityPrefill.ts's own case 3), the one thing worth carrying
          into a new plan started from this template. */}
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
      <Box mb={4}>
        <TagsSection
          module={MODULE_ID}
          entityId={entityId}
          tags={values.tags ?? []}
          onChange={(nTags) => {
            handlePlanFieldChange();
            handlePlanFieldCommit('tags', nTags);
          }}
          readOnly={!canWrite}
        />
      </Box>
      <DetailTabs
        tabs={[
          {
            label: 'Test Cases',
            content: (
              <Box>
                <Stack direction="row" spacing={1} justifyContent="flex-end" mb={1}>
                  <Button
                    variant="outlined"
                    color="primary"
                    disabled={membershipSelectionModel.length === 0 || !canWrite}
                    onClick={handleCreateExecution}
                  >
                    Create Execution
                  </Button>
                  <Button
                    variant="outlined"
                    color="error"
                    disabled={membershipSelectionModel.length === 0 || !canWrite}
                    onClick={handleRemoveSelected}
                  >
                    Remove selected
                  </Button>
                  <Button variant="outlined" color="primary" disabled={!canWrite} onClick={() => setAddOpen((o) => !o)}>
                    {addOpen ? 'Close' : 'Add test cases'}
                  </Button>
                </Stack>
                <div data-testid="plan-test-cases-grid" style={{ width: '100%' }}>
                  <DataGrid
                    autoHeight
                    rows={testCases.map((tc, i) => ({ ...tc, id: i + 1 }))}
                    columns={membershipColumns}
                    checkboxSelection
                    onRowSelectionModelChange={setMembershipSelectionModel}
                    rowSelectionModel={membershipSelectionModel}
                    getRowId={(row) => row.id}
                  />
                </div>
                {addOpen && (
                  <Box mt={2}>
                    <Typography variant="subtitle1" mb={1}>Available test cases</Typography>
                    <div data-testid="available-test-cases-grid" style={{ width: '100%' }}>
                      <DataGrid
                        autoHeight
                        loading={availableQuery.isLoading}
                        rows={availableRows}
                        columns={availableColumns}
                        checkboxSelection
                        onRowSelectionModelChange={setAddSelectionModel}
                        rowSelectionModel={addSelectionModel}
                        getRowId={(row) => row.id}
                      />
                    </div>
                    <Button
                      variant="outlined"
                      color="primary"
                      sx={{ mt: 1 }}
                      disabled={addSelectionModel.length === 0}
                      onClick={handleAddSelected}
                    >
                      Add selected
                    </Button>
                  </Box>
                )}
              </Box>
            ),
          },
          {
            label: 'Test Executions',
            content: (
              <div style={{ width: '100%' }}>
                <DataGrid
                  autoHeight
                  loading={executionsQuery.isLoading}
                  rows={(executionsQuery.data ?? []).map((row, i) => ({ ...row, id: row._id ?? i }))}
                  columns={executionColumns}
                />
              </div>
            ),
          },
          {
            label: 'Details',
            content: (
              <PlanDetailsFields
                values={values}
                entityId={entityId}
                canWrite={canWrite}
                onFieldChange={handlePlanFieldChange}
                onFieldCommit={handlePlanFieldCommit}
              />
            ),
          },
        ]}
      />
      <Divider sx={{ my: 2 }} />
      <CommentsSection moduleId={MODULE_ID} typeId={entityId} userName={name} userId={sub} />
      <Dialog
        open={createExecOpen}
        onClose={() => setCreateExecOpen(false)}
        fullWidth
        maxWidth="xs"
        aria-labelledby="create-execution-title"
      >
        <DialogTitle id="create-execution-title">Create test execution</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" mb={2}>
            {membershipSelectionModel.length} test case{membershipSelectionModel.length === 1 ? '' : 's'} selected
          </Typography>
          <AssigneeSelect value={newExecAssignee} onChange={setNewExecAssignee} label="Assign to" />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCreateExecOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleConfirmCreateExecution} disabled={createExecution.isPending}>
            Create
          </Button>
        </DialogActions>
      </Dialog>
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

interface PlanDetailsFieldsProps {
  values: TestPlanRecord;
  entityId: string;
  canWrite: boolean;
  onFieldChange: () => void;
  onFieldCommit: (fieldName: keyof TestPlanRecord, value: unknown) => void;
}

// The WP-014 enrichment schema is a small FIXED set of named fields (not
// the generic dynamic-Fields system -- module 3 has none, see this file's
// header comment), so it is rendered as discrete named controls rather
// than a mapped-over field array. Each control follows the same
// draft-state-plus-onBlur-commit shape FieldGrid's own TextInputField/
// TextAreaField use, converting PlanDetails.tsx's single page-level "Save
// Plan Details" button into the per-field inline edit this WP's other
// modules already use -- the one deliberate behaviour change here.
function PlanDetailsFields({ values, entityId, canWrite, onFieldChange, onFieldCommit }: PlanDetailsFieldsProps): JSX.Element {
  const [objective, setObjective] = useState(values.objective ?? '');
  const [scope, setScope] = useState(values.scope ?? '');
  const [entryCriteria, setEntryCriteria] = useState(values.entryCriteria ?? '');
  const [exitCriteria, setExitCriteria] = useState(values.exitCriteria ?? '');
  const [environment, setEnvironment] = useState(values.environment ?? '');
  const [plannedStart, setPlannedStart] = useState(values.schedule?.plannedStart?.slice(0, 10) ?? '');
  const [plannedEnd, setPlannedEnd] = useState(values.schedule?.plannedEnd?.slice(0, 10) ?? '');

  useEffect(() => setObjective(values.objective ?? ''), [values.objective]);
  useEffect(() => setScope(values.scope ?? ''), [values.scope]);
  useEffect(() => setEntryCriteria(values.entryCriteria ?? ''), [values.entryCriteria]);
  useEffect(() => setExitCriteria(values.exitCriteria ?? ''), [values.exitCriteria]);
  useEffect(() => setEnvironment(values.environment ?? ''), [values.environment]);
  useEffect(() => setPlannedStart(values.schedule?.plannedStart?.slice(0, 10) ?? ''), [values.schedule?.plannedStart]);
  useEffect(() => setPlannedEnd(values.schedule?.plannedEnd?.slice(0, 10) ?? ''), [values.schedule?.plannedEnd]);

  const handleRiskChange = (event: SelectChangeEvent) => {
    onFieldChange();
    onFieldCommit('risk', event.target.value);
  };

  return (
    // Same label treatment FieldGrid gives every other module's Details
    // tab, applied here in one place because this tab hand-rolls its
    // fields rather than going through FieldGrid. Spacing unit is 4px
    // (tokens.density.spacing), so spacing={4} is a 16px gutter.
    <Box sx={{ py: 2, '& .MuiFormLabel-root': { display: 'block', fontSize: 12, color: 'text.secondary', mb: 0.5 } }}>
      <Grid container spacing={4}>
        <Grid item xs={12} sm={6}>
          <FormLabel htmlFor="Objective">Objective</FormLabel>
          <TextField
            fullWidth
            id="Objective"
            value={objective}
            onChange={(e) => {
              setObjective(e.target.value);
              onFieldChange();
            }}
            onBlur={() => onFieldCommit('objective', objective)}
          />
        </Grid>
        <Grid item xs={12} sm={6}>
          <FormLabel htmlFor="Environment">Environment</FormLabel>
          <TextField
            fullWidth
            id="Environment"
            value={environment}
            onChange={(e) => {
              setEnvironment(e.target.value);
              onFieldChange();
            }}
            onBlur={() => onFieldCommit('environment', environment)}
          />
        </Grid>
        <Grid item xs={12} sm={6}>
          <FormLabel htmlFor="Scope">Scope</FormLabel>
          <TextField
            fullWidth
            multiline
            minRows={2}
            id="Scope"
            value={scope}
            onChange={(e) => {
              setScope(e.target.value);
              onFieldChange();
            }}
            onBlur={() => onFieldCommit('scope', scope)}
          />
        </Grid>
        <Grid item xs={12} sm={6}>
          <FormControl fullWidth>
            <InputLabel id="test-plan-risk-label">Risk</InputLabel>
            <Select labelId="test-plan-risk-label" label="Risk" value={values.risk ?? ''} onChange={handleRiskChange}>
              <MenuItem value=""><em>Not set</em></MenuItem>
              <MenuItem value="Low">Low</MenuItem>
              <MenuItem value="Medium">Medium</MenuItem>
              <MenuItem value="High">High</MenuItem>
            </Select>
          </FormControl>
          {values.risk && (
            <Box mt={1}>
              <StatusChip status={values.risk} colorMap={RISK_COLORS} />
            </Box>
          )}
        </Grid>
        <Grid item xs={12} sm={6}>
          <FormLabel htmlFor="Entry Criteria">Entry Criteria</FormLabel>
          <TextField
            fullWidth
            multiline
            minRows={2}
            id="Entry Criteria"
            value={entryCriteria}
            onChange={(e) => {
              setEntryCriteria(e.target.value);
              onFieldChange();
            }}
            onBlur={() => onFieldCommit('entryCriteria', entryCriteria)}
          />
        </Grid>
        <Grid item xs={12} sm={6}>
          <FormLabel htmlFor="Exit Criteria">Exit Criteria</FormLabel>
          <TextField
            fullWidth
            multiline
            minRows={2}
            id="Exit Criteria"
            value={exitCriteria}
            onChange={(e) => {
              setExitCriteria(e.target.value);
              onFieldChange();
            }}
            onBlur={() => onFieldCommit('exitCriteria', exitCriteria)}
          />
        </Grid>
        <Grid item xs={12} sm={6}>
          <FormLabel htmlFor="Planned Start">Planned Start</FormLabel>
          <TextField
            fullWidth
            type="date"
            id="Planned Start"
            InputLabelProps={{ shrink: true }}
            value={plannedStart}
            onChange={(e) => {
              setPlannedStart(e.target.value);
              onFieldChange();
            }}
            onBlur={() => onFieldCommit('schedule', { ...values.schedule, plannedStart })}
          />
        </Grid>
        <Grid item xs={12} sm={6}>
          <FormLabel htmlFor="Planned End">Planned End</FormLabel>
          <TextField
            fullWidth
            type="date"
            id="Planned End"
            InputLabelProps={{ shrink: true }}
            value={plannedEnd}
            onChange={(e) => {
              setPlannedEnd(e.target.value);
              onFieldChange();
            }}
            onBlur={() => onFieldCommit('schedule', { ...values.schedule, plannedEnd })}
          />
        </Grid>
      </Grid>
    </Box>
  );
}

export default TestPlanDetail;
