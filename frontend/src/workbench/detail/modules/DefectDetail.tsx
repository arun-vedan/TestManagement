import React, { useEffect, useState } from 'react';
import { Alert, Box, Button, CircularProgress, Divider } from '@mui/material';
import SaveAsOutlinedIcon from '@mui/icons-material/SaveAsOutlined';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getFields, getDefectList, postDefect, updateDefect, uploadAttachment, getCreatedBy, createLink } from '../../../api/apiCalls';
import { getCurrentProjectId } from '../../../currentProject';
import { qk } from '../../../Hooks/queryKeys';
import keycloak from '../../../keycloak';
import { isDraftEntityId, tabKey } from '../../store/workbenchStore';
import { useWorkbench } from '../../WorkbenchStoreProvider';
import DetailHeader from '../DetailHeader';
import { FieldDefinition, FieldGrid } from '../FieldGrid';
import DetailTabs from '../DetailTabs';
import LinksSection from '../LinksSection';
import CommentsSection from '../CommentsSection';
import AttachmentsSection, { AttachmentItem } from '../AttachmentsSection';
import TagsSection from '../TagsSection';
import { usePermissions } from '../../../Hooks/usePermissions';
import { SaveAsTemplateDialog } from '../../../Components/templates/SaveAsTemplateDialog';

export interface DefectDetailProps {
  entityId: string;
}

// Module id for Defects (src/workbench/modules.ts's ModuleId 5).
const MODULE_ID = 5;

interface DefectRecord {
  _id?: string;
  defectId?: string;
  summary?: string;
  Status?: string;
  assignedTo?: string;
  attachment?: AttachmentItem[];
  tags?: string[];
  [key: string]: unknown;
}

interface KeycloakTokenParsed {
  sub?: string;
  name?: string;
  preferred_username?: string;
}

// WP-077 Part A -- Defects follows TestCaseDetail (WP-074)/RequirementDetail
// (WP-075a)'s established pattern exactly: fields from getFields(5) via
// react-query (dynamic, DB-driven -- never a hardcoded list), entity from
// getDefectList keyed by qk.entity, per-field inline edit (no global edit
// mode), and the shared kit's Attachments/Links/Comments sections. Source
// of truth for the fetch/save shape is Components/Tabs/DefectContent.tsx
// (455 lines, NOT modified by this WP -- the legacy Defects page keeps
// working unchanged until a separate cutover dispatch):
//   - fetch: DefectContent.tsx:209-240 (getSelDefectDetails)
//   - save: DefectContent.tsx:123-172 (handleSave)
//   - attachments: DefectContent.tsx:41-122, 446 (AttachemntListComp)
//   - links: DefectContent.tsx:450 (LinkIssues srcModule={5})
//   - status workflow: DefectContent.tsx:353-368/411-427 (DefectStatus via
//     the field grid's IssueDropDown branch, added to FieldGrid.tsx by this
//     same WP -- see that file's header comment)
//   - assignedTo: DefectContent.tsx:405-410 (DynamicAutocomplete via the
//     field grid's UserDropDown branch)
//
// Two things are deliberately NOT ported, matching TestCaseDetail's own
// documented exclusions for the same reasons:
//   - createdBy/updatedBy id -> display-name enrichment (getCreatedBy) and
//     the "Created By / Created At / Updated By / Updated At" panel
//     (DefectContent.tsx:292-313) -- neither DetailHeader nor FieldGrid owns
//     that block.
//   - The not-yet-saved ("newDefect") draft/creation flow
//     (DefectContent.tsx:138-161's postDefect branch) -- out of this Part
//     A's scope, same as TestCaseDetail's excluded "newTestCase" flow.
//     FieldGrid's IssueDropDown branch still preserves the "Save the
//     defect to set its status" disabled placeholder for a record with no
//     Mongo _id, in case this component is ever reached before that.
//
// Unlike TestCase/Requirement, Defects has no separate governance
// LifecycleStatusSection header badge -- DefectContent.tsx never rendered
// one; the entire status workflow lives in the IssueDropDown field itself.
//
// Server state lives ONLY in React Query (fields' own key; entity data
// under qk.entity). There is no useState mirror of either query's data
// anywhere in this file -- `file`/`fileName`/`uploading` are ephemeral
// upload-widget UI state, not a copy of the attachment list itself (that
// always comes from the entity query).
export function DefectDetail({ entityId }: DefectDetailProps): JSX.Element {
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
  const thisTabKey = tabKey(MODULE_ID, entityId);
  const isDraft = isDraftEntityId(entityId);
  // A6 -- set by TestRunDetail's "Raise defect" action (or any future
  // caller of the same pattern) before this draft tab was ever opened; see
  // workbenchStore.ts's DefectDraftIntent header comment. `undefined` for a
  // draft opened the ordinary way (the "+" affordance in SourcePanel), and
  // always undefined once the entity is real (isDraft false).
  const draftIntent = useWorkbench((state) => (isDraft ? state.defectDraftIntents[entityId] : undefined));
  const consumeDefectDraftIntent = useWorkbench((state) => state.consumeDefectDraftIntent);
  const { sub, name, preferred_username } = (keycloak.tokenParsed as KeycloakTokenParsed | undefined) ?? {};

  // Local, ephemeral UI state ONLY (an error banner's text, an in-flight
  // upload widget) -- not a copy of server data.
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [fileName, setFileName] = useState('');
  const [uploading, setUploading] = useState(false);
  // WP-F08 Task 2 -- "Save as template" dialog open/close, same pattern
  // as TestCaseDetail.tsx's own.
  const [saveAsTemplateOpen, setSaveAsTemplateOpen] = useState(false);
  // WP-079 Part B -- the one legitimate exception to "server state lives
  // only in React Query" (see this file's header comment): a draft has no
  // server record yet, so its in-progress edits have nowhere else to live.
  const [draftValues, setDraftValues] = useState<DefectRecord>({});

  // A6 -- seeds the draft buffer from a recorded intent's `prefill` (e.g.
  // TestRunDetail's "Raise defect" summary/description) exactly once, the
  // same "sync a local buffer from an external value via effect" pattern
  // FieldGrid's own EditorField/DropDown draft states already use. Runs
  // again only if `draftIntent`'s object identity ever changes, which it
  // doesn't -- setDefectDraftIntent for a given draft id is called at most
  // once by any caller -- so this never clobbers a value the user typed
  // afterwards.
  useEffect(() => {
    if (isDraft && draftIntent) {
      setDraftValues((prev) => ({ ...prev, ...draftIntent.prefill }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDraft, draftIntent]);

  // Wave B-4 (clone) -- a SEPARATE prefill map from A6's `defectDraftIntents`
  // above (workbenchStore.ts's generic `draftPrefill`, the same one
  // TestCaseDetail/RequirementDetail/TestPlanDetail read): cloning a defect
  // seeds its draft buffer the same way, but carries no `link` and is never
  // read by consumeDefectDraftIntent, so a clone can never accidentally
  // create the A6 bidirectional link.
  const clonePrefill = useWorkbench((state) => (isDraft ? state.draftPrefill[entityId] : undefined));
  useEffect(() => {
    if (isDraft && clonePrefill) {
      setDraftValues((prev) => ({ ...prev, ...clonePrefill }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDraft, clonePrefill]);

  const fieldsQuery = useQuery({
    // Field *definitions*, not entity data -- deliberately not qk.entity,
    // same convention TestCaseDetail/RequirementDetail use.
    queryKey: ['project', projectId, MODULE_ID, 'fields'] as const,
    queryFn: () => getFields(MODULE_ID) as Promise<FieldDefinition[]>,
  });

  const entityQuery = useQuery({
    queryKey: qk.entity(projectId, MODULE_ID, entityId),
    // A draft sentinel names no real record -- see TestCaseDetail's
    // identical guard for the full rationale.
    enabled: !isDraft,
    queryFn: async (): Promise<DefectRecord> => {
      const rows = await getDefectList(`defectId=${entityId}`);
      const row: DefectRecord = (rows && rows[0]) || {};
      // DefectContent.tsx:219-221 -- `assignedTo` is stored as a raw
      // Keycloak user id (verified against real seeded defects: Bug-1/2/3
      // all carry a UUID there), resolved to a username before display.
      // Skipping this made DynamicAutocomplete unable to match any option
      // against the raw id, so the picker rendered blank -- caught by this
      // WP's own required browser verification against the live stack, not
      // by any of the (mocked-API) unit tests above it.
      //
      // Deliberately NOT mutating `row` itself (unlike
      // DefectContent.tsx:220's `defectDetails[0]['assignedTo'] = ...`) --
      // `row` is whatever object getDefectList's caller handed back, and
      // mutating it in place bled a resolved username into a shared fixture
      // across test runs when this was first written. Building a fresh
      // object instead keeps the queryFn free of that class of bug
      // entirely, matching this file's own "no useState mirror of server
      // data" discipline: nothing here holds or edits fetched data by
      // reference.
      const resolvedAssignedTo = row.assignedTo ? await getCreatedBy(row.assignedTo) : row.assignedTo;
      // Matches DefectContent.tsx's dynamicFields being read alongside the
      // top-level record (getSelDefectDetails defaults it to {} rather than
      // flattening it, but FieldGrid here -- like TestCaseDetail/
      // RequirementDetail -- reads dynamic values by plain fieldName, so
      // they are flattened onto the top level exactly the same way).
      return {
        ...row,
        ...((row as { dynamicFields?: Record<string, unknown> }).dynamicFields ?? {}),
        assignedTo: resolvedAssignedTo,
      };
    },
  });

  const fields = fieldsQuery.data ?? [];
  const values: DefectRecord = isDraft ? draftValues : entityQuery.data ?? {};
  const attachmentList = values.attachment ?? [];
  // WP-079 Part B -- UserDropDown (assignedTo) is deliberately excluded
  // from the field list a draft renders. DynamicAutocomplete
  // (Components/Lists/dropDownList.tsx)'s own "is this a not-yet-saved
  // record" check is a literal `.includes('newDefect')` string match on
  // the entity id -- our draft sentinel is `new:<random>` (store's
  // `makeDraftEntityId`), which never contains that substring, so without
  // this exclusion the picker would attempt a real `updateDefect('', ...)`
  // PUT the moment a value were picked. IssueDropDown (Status) needs no
  // equivalent exclusion: FieldGrid's own IssueDropDownField already gates
  // itself generically on `mongoId` being falsy (WP-077), which a draft's
  // values naturally never carry.
  const draftFields = fields.filter((field) => field.fieldType !== 'UserDropDown');

  // Per-field commit -- replaces DefectContent's page-level handleSave
  // (DefectContent.tsx:123-172, the not-new branch).
  const commitField = useMutation({
    mutationFn: async ({ fieldName, value }: { fieldName: string; value: unknown }) => {
      const fieldDef = fields.find((f) => f.fieldName === fieldName);
      // Status (IssueDropDown) and assignedTo (UserDropDown) are already
      // persisted server-side by the time this fires: DefectStatus's own
      // PUT .../status call, and DynamicAutocomplete's own updateDefect
      // call (Components/Lists/dropDownList.tsx) -- DefectContent.tsx's own
      // handleSave explicitly `delete sendVal['assignedTo']` (line 129) for
      // the identical reason: don't resend a field that a dedicated control
      // already saved. Re-sending here would only be a redundant PUT, never
      // a correctness bug, but this mutation's real job for these two field
      // types is to route the already-confirmed value through react-query's
      // cache-update-then-invalidate pipeline instead of local state -- see
      // the "status workflow ... through a mutation/invalidation" test.
      if (fieldDef?.fieldType === 'IssueDropDown' || fieldDef?.fieldType === 'UserDropDown') {
        return { alreadyPersisted: true };
      }
      const payload: Record<string, unknown> = { updatedBy: preferred_username };
      if (fieldDef && !fieldDef.isDefault) {
        payload.dynamicFields = { [fieldName]: value };
      } else {
        payload[fieldName] = value;
      }
      // NOTE: updateDefect's argument order is (id, body) -- the opposite
      // of updateRequirement/updateTestCase's (body, id). Verified against
      // api/apiCalls.tsx and DefectContent.tsx's own call sites.
      return updateDefect(values._id, payload);
    },
    onMutate: async ({ fieldName, value }) => {
      await queryClient.cancelQueries({ queryKey: qk.entity(projectId, MODULE_ID, entityId) });
      const previous = queryClient.getQueryData<DefectRecord>(qk.entity(projectId, MODULE_ID, entityId));
      queryClient.setQueryData<DefectRecord>(qk.entity(projectId, MODULE_ID, entityId), (old) => ({
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

  // Attachments -- DefectContent.tsx:57-122's handleDelete/handleUpload,
  // ported onto the same optimistic-mutate-then-invalidate shape as
  // commitField above rather than a page-level setAttachmentList.
  const commitAttachments = useMutation({
    mutationFn: async (nAttachments: AttachmentItem[]) => updateDefect(values._id, { attachment: nAttachments }),
    onMutate: async (nAttachments) => {
      await queryClient.cancelQueries({ queryKey: qk.entity(projectId, MODULE_ID, entityId) });
      const previous = queryClient.getQueryData<DefectRecord>(qk.entity(projectId, MODULE_ID, entityId));
      queryClient.setQueryData<DefectRecord>(qk.entity(projectId, MODULE_ID, entityId), (old) => ({
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

  // WP-079 Part B -- saves the draft buffer, in the shape DefectContent's
  // own postDefect branch built it in (DefectContent.tsx:123-161's
  // handleSave, via handleFieldChange): every field split by its own
  // definition's isDefault, top-level if true, nested under dynamicFields
  // otherwise. UNLIKE TestCaseDetail/RequirementDetail's Create actions, no
  // parentId is resolved or sent here at all -- DefectContent.tsx's own
  // handleSave never references one for a new defect, and the defects
  // model (backend/defectService/models/defects.js) has no parentId field,
  // verified by reading both.
  const createDefect = useMutation({
    mutationFn: async () => {
      // WP-F05b fix round 1 -- see TestCaseDetail.tsx's identical fix for
      // the full rationale: `tags` is a fixed schema field, not one of the
      // admin Fields Configuration entries `fields.forEach` below loops
      // over, so it was silently dropped from a draft's create payload
      // without this line.
      const payload: Record<string, unknown> = {
        updatedBy: preferred_username,
        tags: draftValues.tags ?? [],
        dynamicFields: {},
      };
      fields.forEach((field) => {
        // Never sent from a draft -- see draftFields' comment above for why.
        if (field.fieldType === 'UserDropDown') return;
        if (!(field.fieldName in draftValues)) return;
        if (field.isDefault) {
          payload[field.fieldName] = draftValues[field.fieldName];
        } else {
          (payload.dynamicFields as Record<string, unknown>)[field.fieldName] = draftValues[field.fieldName];
        }
      });
      return (await postDefect(payload)) as { defectId?: string };
    },
    onSuccess: async (saved) => {
      const newId = String(saved.defectId ?? '');
      replaceTab(thisTabKey, { module: MODULE_ID, entityId: newId, title: newId });
      // Module 5 is flat -- fetchLeaves (Hooks/queries/useTreeChildren.ts)
      // only ever returns module-5 leaves for the root parent, regardless
      // of which folder is selected (the defects model has no parentId
      // field at all) -- so root is the one cache entry that can ever show
      // this row.
      queryClient.invalidateQueries({ queryKey: qk.children(projectId, MODULE_ID, '0') });

      // A6 -- complete the other half of the intent recorded before this
      // draft was opened (e.g. TestRunDetail's "Raise defect"): create the
      // link back to the originating record now that this defect has a
      // real id. `consumeDefectDraftIntent` removes it from the store in
      // the same call, so a retried/duplicate onSuccess can never create
      // the pair twice. Mirrors Components/LinkIssue/linkissue.tsx's own
      // linkIssuesHandle exactly: two createLink calls, forward then
      // reverse, same payload shape (srcSummary/summary swapped along with
      // sourceId/destinationId and srcModule/destinationModule).
      const intent = consumeDefectDraftIntent(entityId);
      if (intent?.link) {
        const { sourceModule, sourceId, sourceSummary, linkType } = intent.link;
        const newSummary = (draftValues.summary as string | undefined) ?? '';
        try {
          await createLink({
            srcSummary: sourceSummary,
            sourceId,
            destinationId: newId,
            srcModule: sourceModule,
            destinationModule: MODULE_ID,
            summary: newSummary,
            linkType,
          });
          await createLink({
            srcSummary: newSummary,
            sourceId: newId,
            destinationId: sourceId,
            srcModule: MODULE_ID,
            destinationModule: sourceModule,
            summary: sourceSummary,
            linkType,
          });
        } catch {
          setErrorMessage('The defect was created, but linking it to the test case failed. Link it manually from the Links tab.');
        }
      }
    },
    onError: () => {
      setErrorMessage('Could not create the defect. Please try again.');
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
  const handleFieldError = (message: string) => {
    setErrorMessage(message);
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

  if (fieldsQuery.isLoading || (!isDraft && entityQuery.isLoading)) {
    return <CircularProgress aria-label={`Loading ${entityId}`} />;
  }
  if (!isDraft && entityQuery.isError) {
    return <Alert severity="error">Could not load this defect.</Alert>;
  }

  if (isDraft) {
    return (
      <Box>
        {errorMessage && (
          <Alert severity="error" onClose={() => setErrorMessage(null)} sx={{ mb: 2 }}>
            {errorMessage}
          </Alert>
        )}
        <DetailHeader id="New Defect" />
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
                  fields={draftFields}
                  values={draftValues}
                  moduleId={MODULE_ID}
                  entityId={entityId}
                  onFieldChange={handleFieldChange}
                  onFieldCommit={handleFieldCommit}
                  onError={handleFieldError}
                />
              ),
            },
            // No Attachments/Links/Comments here -- all key off a real
            // business id/Mongo _id a draft does not have yet.
          ]}
        />
        <Box mt={2}>
          <Button
            variant="contained"
            color="primary"
            onClick={() => createDefect.mutate()}
            disabled={createDefect.isPending}
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
      <DetailHeader id={values.defectId ?? entityId} summary={values.summary as string | undefined} />
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
      <DetailTabs
        tabs={[
          {
            label: 'Details',
            content: (
              <FieldGrid
                readOnly={!canWrite}
                fields={fields}
                values={values}
                moduleId={MODULE_ID}
                entityId={entityId}
                onFieldChange={handleFieldChange}
                onFieldCommit={handleFieldCommit}
                onError={handleFieldError}
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
            content: <LinksSection srcModule={MODULE_ID} summary={values.summary as string | undefined} issueId={entityId} />,
          },
        ]}
      />
      <Divider sx={{ my: 2 }} />
      <CommentsSection moduleId={MODULE_ID} typeId={entityId} userName={name} userId={sub} />
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

export default DefectDetail;
