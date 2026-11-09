import React, { useEffect, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Divider, FormLabel, Stack, TextField } from '@mui/material';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import SaveAsOutlinedIcon from '@mui/icons-material/SaveAsOutlined';
import { getFields, getReqList, saveRequirement, updateRequirement, uploadAttachment } from '../../../api/apiCalls';
import { getCurrentProjectId } from '../../../currentProject';
import { qk } from '../../../Hooks/queryKeys';
import { useCoverage } from '../../../Hooks/queries/useCoverage';
import { usePermissions } from '../../../Hooks/usePermissions';
import keycloak from '../../../keycloak';
import { isDraftEntityId, tabKey } from '../../store/workbenchStore';
import { useWorkbench } from '../../WorkbenchStoreProvider';
import { resolveSelectedParentId } from '../../tree/selectedParent';
import { StatusChip } from '../../../Components/common/StatusChip';
import { AiTestCaseDrawer } from '../../../Components/AI/AiTestCaseDrawer';
import { AiLintPanel } from '../../../Components/AI/AiLintPanel';
import { AiAvailable } from '../../../Components/AI/AiAvailable';
import DetailHeader from '../DetailHeader';
import { FieldDefinition, FieldGrid } from '../FieldGrid';
import DetailTabs from '../DetailTabs';
import LinksSection from '../LinksSection';
import CommentsSection from '../CommentsSection';
import AttachmentsSection, { AttachmentItem } from '../AttachmentsSection';
import LifecycleStatusSection from '../LifecycleStatusSection';
import TagsSection from '../TagsSection';
import { SaveAsTemplateDialog } from '../../../Components/templates/SaveAsTemplateDialog';

export interface RequirementDetailProps {
  entityId: string;
}

// Module id for Requirements (src/workbench/modules.ts's ModuleId 2).
const MODULE_ID = 2;

interface RequirementRecord {
  _id?: string;
  reqId?: string;
  requirementSummary?: string;
  status?: string;
  attachment?: AttachmentItem[];
  tags?: string[];
  [key: string]: unknown;
}

interface KeycloakTokenParsed {
  sub?: string;
  name?: string;
  preferred_username?: string;
}

// WP-075a -- RequirementDetail follows TestCaseDetail's established pattern
// (WP-074a) exactly: fields from getFields(2) via react-query (dynamic,
// DB-driven -- never a hardcoded list), entity from getReqList keyed by
// qk.entity, per-field inline edit (no global edit mode), and the shared
// kit's Links/Comments/Attachments sections plus LifecycleStatusSection
// (WP-074e Part 1a). Source of truth for the fetch/save shape and the two
// AI drawers is Components/Tabs/TabContent.tsx's selectedModule === 2
// branch (~lines 204-245 for the fetch, ~416-423 for the save, ~587-614 and
// 782-843 for the attachments/AI/lifecycle wiring).
//
// WP-079 Part B -- draft mode, mirroring TestCaseDetail's own (WP-079 Part
// A) exactly: `entityId` being a draft sentinel (store's `isDraftEntityId`,
// `new:<random>`) disables the entity query outright (there is no record
// for getReqList to fetch yet), field *definitions* still come from
// getFields(2) (dynamic, DB-driven, same as a real entity), and each
// field's value lives in `draftValues` (a useState buffer, the one
// deliberate exception to "server state lives only in React Query" this
// file's own header comment below describes) until Create is pressed.
// Source of truth for the save shape is TabContent.tsx's newReq branch
// (~lines 443-467): requirementSummary/requirementDescription top-level,
// every other field split by its own definition's isDefault, plus a
// parentId resolved the same way TestCaseDetail's Create action resolves
// one (resolveSelectedParentId, shared). No AI drawers/Attachments/Links/
// Comments in draft mode -- all key off a real business id/Mongo _id a
// draft does not have yet, same exclusion TestCaseDetail documents for its
// own draft mode.
//
// Server state lives ONLY in React Query (fields' own key; entity data
// under qk.entity; untested-coverage under qk.coverage via useCoverage --
// deliberately NOT Context/CoverageContext.tsx, which stays mounted for the
// legacy pages until WP-078 deletes it). There is no useState mirror of any
// of it anywhere in this file -- `file`/`fileName`/`uploading` are ephemeral
// upload-widget UI state, not a copy of the attachment list itself (that
// always comes from the entity query).
export function RequirementDetail({ entityId }: RequirementDetailProps): JSX.Element {
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
  const { can: canPerform } = usePermissions();
  const coverage = useCoverage(projectId);

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [aiDrawerOpen, setAiDrawerOpen] = useState(false);
  const [aiLintOpen, setAiLintOpen] = useState(false);
  // WP-F08 Task 2 -- "Save as template" dialog open/close, same pattern
  // as TestCaseDetail.tsx's own.
  const [saveAsTemplateOpen, setSaveAsTemplateOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState('');
  const [uploading, setUploading] = useState(false);
  // WP-079 Part B -- the one legitimate exception to "server state lives
  // only in React Query" (see this file's header comment): a draft has no
  // server record yet, so its in-progress edits have nowhere else to live.
  const [draftValues, setDraftValues] = useState<RequirementRecord>({});

  // Wave B-4 (clone) -- seeds the draft buffer from a recorded prefill
  // (the tree row's "Clone" action, useCloneEntity.ts) exactly once, the
  // same pattern DefectDetail.tsx's own A6 draftIntent effect uses. No
  // separate steps-like state to split out here, unlike TestCaseDetail.
  const draftPrefill = useWorkbench((state) => (isDraft ? state.draftPrefill[entityId] : undefined));
  useEffect(() => {
    if (isDraft && draftPrefill) {
      setDraftValues((prev) => ({ ...prev, ...draftPrefill }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDraft, draftPrefill]);

  const fieldsQuery = useQuery({
    // Field *definitions*, not entity data -- deliberately not qk.entity,
    // same convention TestCaseDetail uses.
    queryKey: ['project', projectId, MODULE_ID, 'fields'] as const,
    queryFn: () => getFields(MODULE_ID) as Promise<FieldDefinition[]>,
  });

  const entityQuery = useQuery({
    queryKey: qk.entity(projectId, MODULE_ID, entityId),
    queryFn: async (): Promise<RequirementRecord> => {
      const rows = await getReqList(`reqId=${entityId}`);
      const row = (rows && rows[0]) || {};
      // Matches TabContent.tsx:222's
      // `Object.assign(reqValues[0], reqValues[0]['dynamicFields'])`.
      return { ...row, ...((row as { dynamicFields?: Record<string, unknown> }).dynamicFields ?? {}) };
    },
    // A draft sentinel names no real record -- see TestCaseDetail's
    // identical guard for the full rationale.
    enabled: !isDraft,
  });

  const fields = fieldsQuery.data ?? [];
  const values: RequirementRecord = isDraft ? draftValues : entityQuery.data ?? {};
  const attachmentList = values.attachment ?? [];

  // Per-field commit -- replaces TabContent's page-level handleSave
  // (TabContent.tsx:397-507, the `selectedModule === 2` / not-new branch).
  const commitField = useMutation({
    mutationFn: async ({ fieldName, value }: { fieldName: string; value: unknown }) => {
      const fieldDef = fields.find((f) => f.fieldName === fieldName);
      const payload: Record<string, unknown> = { updatedBy: preferred_username };
      if (fieldDef && !fieldDef.isDefault) {
        payload.dynamicFields = { [fieldName]: value };
      } else {
        payload[fieldName] = value;
      }
      return updateRequirement(payload, values._id);
    },
    onMutate: async ({ fieldName, value }) => {
      await queryClient.cancelQueries({ queryKey: qk.entity(projectId, MODULE_ID, entityId) });
      const previous = queryClient.getQueryData<RequirementRecord>(qk.entity(projectId, MODULE_ID, entityId));
      queryClient.setQueryData<RequirementRecord>(qk.entity(projectId, MODULE_ID, entityId), (old) => ({
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

  // Attachments -- TabContent.tsx:113-178's handleDelete/handleUpload,
  // ported onto the same optimistic-mutate-then-invalidate shape as
  // commitField above rather than a page-level setAttachmentList.
  const commitAttachments = useMutation({
    mutationFn: async (nAttachments: AttachmentItem[]) => updateRequirement({ attachment: nAttachments }, values._id),
    onMutate: async (nAttachments) => {
      await queryClient.cancelQueries({ queryKey: qk.entity(projectId, MODULE_ID, entityId) });
      const previous = queryClient.getQueryData<RequirementRecord>(qk.entity(projectId, MODULE_ID, entityId));
      queryClient.setQueryData<RequirementRecord>(qk.entity(projectId, MODULE_ID, entityId), (old) => ({
        ...(old ?? {}),
        attachment: nAttachments,
      }));
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(qk.entity(projectId, MODULE_ID, entityId), context.previous);
      }
      setErrorMessage('Could not update the attachments. Please try again.');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: qk.entity(projectId, MODULE_ID, entityId) });
    },
  });

  // WP-079 Part B -- saves the draft buffer, in the shape TabContent's own
  // newReq branch built it in (TabContent.tsx:443-467): requirementSummary/
  // requirementDescription top-level, every other field split by its own
  // definition's isDefault -- exactly commitField's per-field rule above,
  // just applied to the whole buffer at once. parentId is resolved from
  // whatever is selected in the tree right now (same rule TestCaseDetail's
  // Create action uses, via the shared resolveSelectedParentId).
  const createRequirement = useMutation({
    mutationFn: async () => {
      const parentId = resolveSelectedParentId(queryClient, projectId, MODULE_ID, selection, expandedIds);
      const payload: Record<string, unknown> = {
        parentId: Number(parentId),
        updatedBy: preferred_username,
        requirementSummary: draftValues.requirementSummary ?? '',
        requirementDescription: draftValues.requirementDescription ?? '',
        // WP-F05b fix round 1 -- see TestCaseDetail.tsx's identical fix for
        // the full rationale: `tags` is a fixed schema field, not one of
        // the admin Fields Configuration entries `fields.forEach` below
        // loops over, so it was silently dropped from a draft's create
        // payload without this line.
        tags: draftValues.tags ?? [],
        dynamicFields: {},
      };
      fields.forEach((field) => {
        if (field.fieldName === 'requirementSummary' || field.fieldName === 'requirementDescription') return;
        if (!(field.fieldName in draftValues)) return;
        if (field.isDefault) {
          payload[field.fieldName] = draftValues[field.fieldName];
        } else {
          (payload.dynamicFields as Record<string, unknown>)[field.fieldName] = draftValues[field.fieldName];
        }
      });
      const saved = (await saveRequirement(payload)) as { reqId?: string };
      return { saved, parentId };
    },
    onSuccess: ({ saved, parentId }) => {
      const newId = String(saved.reqId ?? '');
      replaceTab(thisTabKey, { module: MODULE_ID, entityId: newId, title: newId });
      // The tree (Hooks/queries/useTreeChildren.ts) caches exactly this key
      // per parent -- invalidating it is what makes the freshly-created
      // row appear without a manual refresh.
      queryClient.invalidateQueries({ queryKey: qk.children(projectId, MODULE_ID, parentId) });
    },
    onError: () => {
      setErrorMessage('Could not create the requirement. Please try again.');
    },
  });

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

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];
    if (picked) {
      setFile(picked);
      setFileName(picked.name);
    }
  };

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const uploaded = await uploadAttachment(formData);
      if (uploaded.status === 201) {
        const newItem: AttachmentItem = { attachmentId: uploaded.data.fileID, name: file.name };
        await commitAttachments.mutateAsync([...attachmentList, newItem]);
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
    commitAttachments.mutate(attachmentList.filter((a) => a.attachmentId !== attachmentId));
  };

  const handleLifecycleError = (message: string) => {
    setErrorMessage(message);
  };

  // WP-051's onAccepted refreshed the same untested-requirements coverage
  // set the manual "Link" button refreshes (TabContent.tsx:810,
  // `refreshUntested` from Context/CoverageContext.tsx). The workbench
  // replacement is useCoverage's invalidate() -- react-query cache, not a
  // useState copy.
  const handleAiAccepted = () => {
    coverage.invalidate();
  };

  // WP-052's onApplied merged the server's updated requirementDescription
  // straight into page-level fieldValues (TabContent.tsx:824). The
  // replacement patches the qk.entity cache the same way commitField does,
  // then invalidates so a real refetch settles it -- never a useState copy.
  const handleLintApplied = (updated: Record<string, unknown>) => {
    queryClient.setQueryData<RequirementRecord>(qk.entity(projectId, MODULE_ID, entityId), (old) => ({
      ...(old ?? {}),
      ...updated,
    }));
    queryClient.invalidateQueries({ queryKey: qk.entity(projectId, MODULE_ID, entityId) });
  };

  if (fieldsQuery.isLoading || (!isDraft && entityQuery.isLoading)) {
    return <CircularProgress aria-label={`Loading ${entityId}`} />;
  }
  if (!isDraft && entityQuery.isError) {
    return <Alert severity="error">Could not load this requirement.</Alert>;
  }

  if (isDraft) {
    return (
      <Box>
        {errorMessage && (
          <Alert severity="error" onClose={() => setErrorMessage(null)} sx={{ mb: 2 }}>
            {errorMessage}
          </Alert>
        )}
        <DetailHeader id="New Requirement" />
        <Box mb={2}>
          {/* requirementSummary is excluded from FieldGrid (same as the
              real entity path below) -- rendered here instead, mirroring
              TestCaseDetail's dedicated Summary box. */}
          <FormLabel htmlFor="Summary">Summary</FormLabel>
          <TextField
            id="Summary"
            fullWidth
            multiline
            minRows={2}
            size="small"
            sx={{ mt: 1 }}
            value={(draftValues.requirementSummary as string) ?? ''}
            onChange={(e) => {
              handleFieldChange();
              setDraftValues((prev) => ({ ...prev, requirementSummary: e.target.value }));
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
            // No AI actions/Attachments/Links/Comments here -- all key off
            // a real business id/Mongo _id a draft does not have yet.
          ]}
        />
        <Box mt={2}>
          <Button
            variant="contained"
            color="primary"
            onClick={() => createRequirement.mutate()}
            disabled={createRequirement.isPending}
          >
            Create
          </Button>
        </Box>
      </Box>
    );
  }

  // Known live product race (EXECUTION_LOG, WP-063b): TabContent.tsx:589
  // enabled "Generate test cases (AI)" before the requirement had loaded,
  // so an early click POSTed with no requirementId and 400d. Gated here on
  // the entity query actually having data -- the loading guard above
  // already keeps this component from rendering the button at all until
  // both queries settle, and this is a second, explicit guard against ever
  // handing the drawers an undefined requirementId (e.g. a malformed row).
  const entityLoaded = Boolean(values._id);

  return (
    <Box>
      {errorMessage && (
        <Alert severity="error" onClose={() => setErrorMessage(null)} sx={{ mb: 2 }}>
          {errorMessage}
        </Alert>
      )}
      <DetailHeader id={values.reqId ?? entityId} summary={values.requirementSummary}>
        <Stack direction="row" spacing={1} alignItems="center" mt={0.5}>
          {coverage.untestedReqIds.has(entityId) && (
            <StatusChip status="untested" label="Untested" colorMap={{ untested: 'warning' }} />
          )}
          {values.status && (
            <LifecycleStatusSection
              projectId={projectId}
              module={MODULE_ID}
              entityId={entityId}
              mongoId={values._id ?? ''}
              entityIdLabel={(values.reqId as string) ?? entityId}
              status={values.status as string}
              entityType="requirement"
              onError={handleLifecycleError}
            />
          )}
        </Stack>
      </DetailHeader>

      {/* WP-F08 Task 2 -- see TestCaseDetail.tsx's identical control for
          the full R4 (snapshot, not a live link) rationale. */}
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

      {/* Hidden entirely while AI is off for this deployment (AiAvailable). */}
      {canPerform('write') && (
        <AiAvailable>
        <Stack direction="row" spacing={1} justifyContent="flex-end" mb={1}>
          {/* Outlined brand, not filled secondary. Filled `secondary` put
              white on #B4CAD6 (1.70:1) so these read as disabled while being
              fully live. Outlined gives brand ink on white at 9.84:1, keeps
              colour reserved for status per spec §6, and keeps AI actions
              looking advisory rather than the loudest thing on the page
              (GR-8). */}
          <Button
            variant="outlined"
            color="primary"
            startIcon={<AutoAwesomeIcon />}
            disabled={!entityLoaded}
            onClick={() => setAiDrawerOpen(true)}
          >
            Generate test cases (AI)
          </Button>
          <Button
            variant="outlined"
            color="primary"
            startIcon={<AutoAwesomeIcon />}
            disabled={!entityLoaded}
            onClick={() => setAiLintOpen(true)}
          >
            Lint requirement (AI)
          </Button>
        </Stack>
        </AiAvailable>
      )}

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
            label: 'Attachments',
            content: (
              <AttachmentsSection
                attachmentList={attachmentList}
                file={file}
                fileName={fileName}
                loading={uploading}
                onFileChange={handleFileChange}
                onUpload={handleUpload}
                onDelete={handleDeleteAttachment}
              />
            ),
          },
          {
            label: 'Links',
            content: <LinksSection srcModule={MODULE_ID} summary={values.requirementSummary} issueId={entityId} />,
          },
        ]}
      />

      <Divider sx={{ my: 2 }} />
      <CommentsSection moduleId={MODULE_ID} typeId={entityId} userName={name} userId={sub} />

      {entityLoaded && (
        <AiTestCaseDrawer
          open={aiDrawerOpen}
          onClose={() => setAiDrawerOpen(false)}
          requirementId={values._id as string}
          reqId={(values.reqId as string) ?? entityId}
          requirementSummary={values.requirementSummary}
          onAccepted={handleAiAccepted}
        />
      )}
      {entityLoaded && (
        <AiLintPanel
          open={aiLintOpen}
          onClose={() => setAiLintOpen(false)}
          requirementId={values._id as string}
          onApplied={handleLintApplied}
        />
      )}
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

export default RequirementDetail;
