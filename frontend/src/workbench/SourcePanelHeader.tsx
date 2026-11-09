import React, { useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  InputAdornment,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  OutlinedInput,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import ViewListOutlinedIcon from '@mui/icons-material/ViewListOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import AddIcon from '@mui/icons-material/Add';
import ArrowDropDownIcon from '@mui/icons-material/ArrowDropDown';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import CreateNewFolderOutlinedIcon from '@mui/icons-material/CreateNewFolderOutlined';
import LibraryAddOutlinedIcon from '@mui/icons-material/LibraryAddOutlined';
import FlagOutlinedIcon from '@mui/icons-material/FlagOutlined';
import DownloadIcon from '@mui/icons-material/Download';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import CheckIcon from '@mui/icons-material/Check';
import ClearIcon from '@mui/icons-material/Clear';
import { SvgIconComponent } from '@mui/icons-material';
import { useQueryClient } from '@tanstack/react-query';
import { useWorkbench } from './WorkbenchStoreProvider';
import { PanelMode, makeDraftEntityId } from './store/workbenchStore';
import { tokens } from '../Theme/tokens';
import AiDuplicateAuditToolbar from './AiDuplicateAuditToolbar';
import CsvImportToolbar from './CsvImportToolbar';
import { useCsvExport, CsvExportAlerts } from './CsvExportToolbar';
import { CaseTemplatePicker } from '../Components/templates/CaseTemplatePicker';
import { useAiAvailability } from '../Components/AI/AiAvailable';
import { ModuleId, DRAFT_CAPABLE_MODULES, FOLDER_MODULES, MODULE_LABELS } from './modules';
import { usePermissions } from '../Hooks/usePermissions';
import { getCurrentProjectId } from '../currentProject';
import { createFolderApi } from '../api/apiCalls';
import { createRelease } from '../api/releaseApi';
import { qk } from '../Hooks/queryKeys';
import keycloak from '../keycloak';
import { resolveSelectedParentId } from './tree/selectedParent';

// Source-panel redesign (2026-11-06). The panel used to stack every action as
// its own full-width row -- New <entity>, Start from template, New folder,
// Export CSV, plus Import CSV and Audit duplicates on Test Cases -- in three
// different button styles, which pushed the tree a third of the way down the
// column. Now: a title row with ONE primary "New" menu, then the view toggle
// with a "More actions" overflow menu. Every action calls exactly what its
// old button called, behind the same permission gate.

// Module id for Releases (workbench/modules.ts's ModuleId 6) -- matches
// entityListConfigs.tsx's ReleaseIdCell and ReleaseDetail.tsx's own local
// constant of the same name/value.
const RELEASE_MODULE_ID: ModuleId = 6;

// WP-074d / Wave B-2 -- the tree|list|search mode switch. A real MUI
// <ToggleButtonGroup exclusive> rather than bespoke buttons: it gets
// role="group" + each option's aria-pressed for free, and its own keyboard
// model (Tab in, then plain activation per button) without custom handling.
const PANEL_MODE_OPTIONS: { mode: PanelMode; label: string; caption: string; Icon: SvgIconComponent }[] = [
  { mode: 'tree', label: 'Tree view', caption: 'Tree', Icon: AccountTreeOutlinedIcon },
  { mode: 'list', label: 'List view', caption: 'List', Icon: ViewListOutlinedIcon },
  { mode: 'search', label: 'Search view', caption: 'Search', Icon: SearchOutlinedIcon },
];

function PanelModeToggle(): JSX.Element {
  const panelMode = useWorkbench((state) => state.panelMode);
  const setPanelMode = useWorkbench((state) => state.setPanelMode);

  return (
    <ToggleButtonGroup
      value={panelMode}
      exclusive
      size="small"
      aria-label="Panel view"
      onChange={(_event, next: PanelMode | null) => {
        // Exclusive groups emit `null` when the already-selected button is
        // clicked again -- ignore that so the panel never lands on "no
        // mode selected".
        if (next !== null) {
          setPanelMode(next);
        }
      }}
      sx={{ height: 28, flex: 1, minWidth: 0 }}
    >
      {PANEL_MODE_OPTIONS.map(({ mode, label, caption, Icon }) => (
        <ToggleButton
          key={mode}
          value={mode}
          aria-label={label}
          sx={{
            flex: 1,
            px: 1,
            py: 0,
            textTransform: 'none',
            '&.Mui-selected': { bgcolor: tokens.brandTint, color: tokens.brand },
            '&.Mui-selected:hover': { bgcolor: tokens.brandTint },
          }}
        >
          <Icon sx={{ fontSize: 16, mr: 0.5 }} />
          <Typography variant="caption" sx={{ fontWeight: 600 }}>
            {caption}
          </Typography>
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

// WP-079 Part A/B -- one label per draft-capable module, mirroring
// folderStructure.tsx's own createNewReq moduleId -> entity-name mapping
// rather than MODULE_LABELS (which is plural -- wrong for a singular "New ...").
// Module 4 (Test Runs) is excluded: an execution is created FROM a plan
// (TestPlanDetail's "Create Execution"). Module 6 (Releases) uses its own
// dialog, below, rather than a draft tab.
const NEW_ENTITY_LABEL: Partial<Record<ModuleId, string>> = {
  1: 'New Test Case',
  2: 'New Requirement',
  3: 'New Test Plan',
  5: 'New Defect',
};

interface KeycloakTokenParsed {
  sub?: string;
}

interface ActionItem {
  key: string;
  label: string;
  Icon: SvgIconComponent;
  onSelect: () => void;
  /** Longer caveat, shown as a tooltip so it never crowds the menu. */
  hint?: string;
  disabled?: boolean;
}

// A button that opens a menu of ActionItems. The chosen action runs only
// AFTER the menu's exit transition: MUI returns focus to the trigger as the
// menu closes, which would otherwise yank focus straight back out of
// whatever the action just opened (the inline folder-name input, a dialog's
// first field).
function ActionMenu({
  items,
  menuLabel,
  renderTrigger,
}: {
  items: ActionItem[];
  menuLabel: string;
  renderTrigger: (props: {
    onClick: (event: React.MouseEvent<HTMLElement>) => void;
    'aria-haspopup': 'menu';
    'aria-expanded': boolean;
    'aria-controls'?: string;
  }) => JSX.Element;
}): JSX.Element | null {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const pending = useRef<(() => void) | null>(null);
  const menuId = `${menuLabel.replace(/\s+/g, '-').toLowerCase()}-menu`;
  if (items.length === 0) return null;

  return (
    <>
      {renderTrigger({
        onClick: (event) => setAnchor(event.currentTarget),
        'aria-haspopup': 'menu',
        'aria-expanded': Boolean(anchor),
        'aria-controls': anchor ? menuId : undefined,
      })}
      <Menu
        id={menuId}
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        MenuListProps={{ 'aria-label': menuLabel, dense: true }}
        TransitionProps={{
          onExited: () => {
            const action = pending.current;
            pending.current = null;
            action?.();
          },
        }}
      >
        {items.map(({ key, label, Icon, onSelect, hint, disabled }) => (
          <Tooltip key={key} title={hint ?? ''} placement="left" disableHoverListener={!hint} describeChild>
            <MenuItem
              disabled={disabled}
              onClick={() => {
                pending.current = onSelect;
                setAnchor(null);
              }}
            >
              <ListItemIcon>
                <Icon fontSize="small" />
              </ListItemIcon>
              <ListItemText primary={label} />
            </MenuItem>
          </Tooltip>
        ))}
      </Menu>
    </>
  );
}

// WP-F18b Task 3 -- "New Release", module-6-only. NOT the draft-tab flow:
// a release's create surface is one required field (`name`), so a small
// dialog that calls createRelease directly and opens the real, already-saved
// release fits better than a blank draft tab with nowhere to put a
// qualityGates editor until the entity has an id. Same three fields the old
// standalone page's dialog used (Pages/releases.tsx, retired by WP-F18b).
function NewReleaseDialog({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element {
  const queryClient = useQueryClient();
  const openTab = useWorkbench((s) => s.openTab);
  const setSelection = useWorkbench((s) => s.setSelection);
  const [name, setName] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setName('');
    setTargetDate('');
    setNotes('');
    setError('');
  };

  const close = () => {
    if (saving) return;
    onClose();
  };

  const handleCreate = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Release name is required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const release = await createRelease({
        name: trimmedName,
        targetDate: targetDate || undefined,
        notes: notes.trim() || undefined,
      });
      // Same cache key EntityList.tsx's own `refresh` invalidates so the
      // list view picks up the new release without a manual refresh.
      queryClient.invalidateQueries({ queryKey: ['entityList', RELEASE_MODULE_ID] });
      setSelection(RELEASE_MODULE_ID, release._id);
      // Title matches entityListConfigs.tsx's ReleaseIdCell exactly.
      openTab({ module: RELEASE_MODULE_ID, entityId: release._id, title: release.releaseId || release._id });
      onClose();
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Unable to create release');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={close} fullWidth maxWidth="sm" TransitionProps={{ onEnter: reset }}>
      <DialogTitle>New Release</DialogTitle>
      <DialogContent>
        <Stack spacing={2} mt={1}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} fullWidth autoFocus />
          <TextField
            label="Target date"
            type="date"
            InputLabelProps={{ shrink: true }}
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
            fullWidth
          />
          <TextField
            label="Notes"
            multiline
            minRows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            fullWidth
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close} disabled={saving}>
          Cancel
        </Button>
        <Button variant="contained" onClick={handleCreate} disabled={saving}>
          Create
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// "New folder" -- an inline name-then-confirm/cancel input (not
// `window.prompt`, which is barely accessible and not stylable). Parent
// folder is resolved via resolveSelectedParentId, shared with
// TestCaseDetail's Create action. Attributed to the real signed-in user's
// `sub` in the real current project -- never folderStructure.tsx's legacy
// hardcoded literals.
function NewFolderInput({ moduleId, onDone }: { moduleId: ModuleId; onDone: () => void }): JSX.Element {
  const projectId = getCurrentProjectId();
  const queryClient = useQueryClient();
  const selection = useWorkbench((s) => s.selection[moduleId]);
  const expandedIds = useWorkbench((s) => s.expanded[moduleId]);
  const [name, setName] = useState('');
  const { sub } = (keycloak.tokenParsed as KeycloakTokenParsed | undefined) ?? {};

  const confirm = async () => {
    const folderName = name.trim();
    if (!folderName) {
      onDone();
      return;
    }
    const parentFolder = resolveSelectedParentId(queryClient, projectId, moduleId, selection, expandedIds);
    onDone();
    await createFolderApi({
      createdBy: sub,
      updatedBy: sub,
      moduleId,
      projectId,
      parentFolder: Number(parentFolder),
      folderName,
    });
    queryClient.invalidateQueries({ queryKey: qk.children(projectId, moduleId, parentFolder) });
  };

  return (
    <Box sx={{ px: 1, pb: 1 }}>
      <OutlinedInput
        autoFocus
        size="small"
        fullWidth
        placeholder="New folder name"
        inputProps={{ 'aria-label': 'New folder name' }}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            confirm();
          } else if (e.key === 'Escape') {
            onDone();
          }
        }}
        startAdornment={
          <InputAdornment position="start">
            <CreateNewFolderOutlinedIcon fontSize="small" />
          </InputAdornment>
        }
        endAdornment={
          <InputAdornment position="end">
            <IconButton aria-label="Confirm new folder" size="small" onClick={confirm}>
              <CheckIcon fontSize="small" />
            </IconButton>
            <IconButton aria-label="Cancel new folder" size="small" onClick={onDone}>
              <ClearIcon fontSize="small" />
            </IconButton>
          </InputAdornment>
        }
      />
    </Box>
  );
}

type PanelDialog = 'template' | 'release' | 'import' | 'audit' | null;

export default function SourcePanelHeader({ moduleId }: { moduleId: ModuleId | null }): JSX.Element {
  const { can } = usePermissions();
  const openTab = useWorkbench((s) => s.openTab);
  const projectId = getCurrentProjectId();
  const [dialog, setDialog] = useState<PanelDialog>(null);
  const [addingFolder, setAddingFolder] = useState(false);
  // A hook must run unconditionally; module 1 stands in while moduleId is
  // null and `available` is ignored below in that case.
  const exporter = useCsvExport(moduleId ?? 1);
  const ai = useAiAvailability();

  // WP-022 -- a viewer, or anyone without 'write' on this project, never
  // sees a create, import or audit action.
  const canWrite = can('write');
  const closeDialog = () => setDialog(null);

  const newItems: ActionItem[] = [];
  const moreItems: ActionItem[] = [];
  if (moduleId !== null) {
    const entityLabel = NEW_ENTITY_LABEL[moduleId];
    const draftCapable = DRAFT_CAPABLE_MODULES.has(moduleId);
    if (canWrite) {
      if (draftCapable && entityLabel) {
        // WP-079 -- opens a draft tab; the detail component derives its
        // parent from whatever is selected at Create time.
        newItems.push({
          key: 'entity',
          label: entityLabel,
          Icon: AddIcon,
          onSelect: () => openTab({ module: moduleId, entityId: makeDraftEntityId(), title: entityLabel }),
        });
      }
      if (draftCapable) {
        // WP-F08 -- also a draft tab, prefilled from a stored template.
        newItems.push({
          key: 'template',
          label: 'Start from template…',
          Icon: LibraryAddOutlinedIcon,
          onSelect: () => setDialog('template'),
        });
      }
      if (moduleId === RELEASE_MODULE_ID) {
        newItems.push({ key: 'release', label: 'New Release', Icon: FlagOutlinedIcon, onSelect: () => setDialog('release') });
      }
      if (FOLDER_MODULES.has(moduleId)) {
        newItems.push({
          key: 'folder',
          label: 'New folder',
          Icon: CreateNewFolderOutlinedIcon,
          onSelect: () => setAddingFolder(true),
        });
      }
    }
    if (exporter.available) {
      moreItems.push({
        key: 'export',
        label: exporter.exporting ? 'Exporting…' : 'Export CSV',
        Icon: DownloadIcon,
        hint: exporter.note,
        disabled: exporter.exporting,
        onSelect: () => {
          exporter.run();
        },
      });
    }
    // Import and the AI duplicate audit only exist for test cases (no other
    // module has an import endpoint or a bulk audit).
    if (moduleId === 1 && canWrite) {
      moreItems.push({ key: 'import', label: 'Import CSV', Icon: UploadFileIcon, onSelect: () => setDialog('import') });
      // Only while AI is actually available (useAiAvailability): with AI off
      // for the deployment this item could only ever 403.
      if (ai.state === 'available') {
        moreItems.push({
          key: 'audit',
          label: 'Audit duplicates (AI)',
          Icon: AutoAwesomeIcon,
          onSelect: () => setDialog('audit'),
        });
      }
    }
  }

  return (
    <Box sx={{ flexShrink: 0, borderBottom: 1, borderColor: 'divider' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, pt: 1.25, pb: 1 }}>
        <Typography
          component="h2"
          variant="subtitle1"
          noWrap
          sx={{ flex: 1, minWidth: 0, fontWeight: 700, color: tokens.brand, lineHeight: 1.2 }}
        >
          {moduleId !== null ? MODULE_LABELS[moduleId] : ''}
        </Typography>
        <ActionMenu
          items={newItems}
          menuLabel="Create"
          renderTrigger={(props) => (
            <Button
              {...props}
              variant="contained"
              size="small"
              disableElevation
              aria-label="New"
              startIcon={<AddIcon fontSize="small" />}
              endIcon={<ArrowDropDownIcon fontSize="small" />}
              sx={{ px: 1.25, py: 0.25, minWidth: 0, '& .MuiButton-endIcon': { ml: 0.25 } }}
            >
              New
            </Button>
          )}
        />
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 1, pb: 1 }}>
        <PanelModeToggle />
        <ActionMenu
          items={moreItems}
          menuLabel="More actions"
          renderTrigger={(props) => (
            <Tooltip title="More actions">
              <IconButton {...props} size="small" aria-label="More actions">
                <MoreHorizIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        />
      </Box>
      {addingFolder && moduleId !== null && (
        <NewFolderInput moduleId={moduleId} onDone={() => setAddingFolder(false)} />
      )}
      <CsvExportAlerts exporter={exporter} />
      {moduleId !== null && DRAFT_CAPABLE_MODULES.has(moduleId) && (
        <CaseTemplatePicker projectId={projectId} module={moduleId} open={dialog === 'template'} onClose={closeDialog} />
      )}
      {moduleId === RELEASE_MODULE_ID && <NewReleaseDialog open={dialog === 'release'} onClose={closeDialog} />}
      {moduleId === 1 && <CsvImportToolbar open={dialog === 'import'} onClose={closeDialog} />}
      {moduleId === 1 && <AiDuplicateAuditToolbar open={dialog === 'audit'} onClose={closeDialog} />}
    </Box>
  );
}
