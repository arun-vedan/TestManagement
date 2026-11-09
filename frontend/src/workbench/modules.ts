import ChecklistIcon from '@mui/icons-material/Checklist';
import DescriptionIcon from '@mui/icons-material/Description';
import AssignmentIcon from '@mui/icons-material/Assignment';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutline';
import BugReportIcon from '@mui/icons-material/BugReport';
import FlagIcon from '@mui/icons-material/Flag';
import { SvgIconComponent } from '@mui/icons-material';

export type ModuleId = 1 | 2 | 3 | 4 | 5 | 6;

export const MODULE_SLUGS: Record<ModuleId, string> = {
  1: 'testcases', 2: 'requirements', 3: 'testplans',
  4: 'testruns',  5: 'defects',      6: 'releases',
};

export const MODULE_LABELS: Record<ModuleId, string> = {
  1: 'Test Cases', 2: 'Requirements', 3: 'Test Plans',
  4: 'Test Runs',  5: 'Defects',      6: 'Releases',
};

const SLUG_TO_MODULE = Object.entries(MODULE_SLUGS)
  .reduce<Record<string, ModuleId>>((acc, [id, slug]) => {
    acc[slug] = Number(id) as ModuleId;
    return acc;
  }, {});

export function slugToModule(slug: string): ModuleId | null {
  return SLUG_TO_MODULE[slug] ?? null;
}

// WP-076 -- module icons live here beside the labels and slugs so the rail
// and the tab strip render the same glyph per module. They were originally
// private to TabStrip, which is why the rail shipped label-only in WP-072
// and lost the per-module iconography the legacy MainDrawer nav had.
export const MODULE_ICONS: Record<ModuleId, SvgIconComponent> = {
  1: ChecklistIcon,
  2: DescriptionIcon,
  3: AssignmentIcon,
  4: PlayCircleOutlineIcon,
  5: BugReportIcon,
  6: FlagIcon,
};

// WP-079 -- modules with a real not-yet-saved ("draft") create flow of
// their own detail component: 1 (Test Cases), 2 (Requirements), 3 (Test
// Plans), 5 (Defects). Module 4 (Test Runs) is deliberately excluded: an
// execution is created FROM a plan (TestPlanDetail's own "Create
// Execution" action), not from a blank draft tab -- see SourcePanel.tsx's
// original header comment on this set.
//
// WP-F18b Task 3 -- module 6 (Releases) stays excluded too, but the reason
// is no longer "no detail component" (ReleaseDetail.tsx has existed since
// WP-F15/F18 Task 2). It is deliberate on its own merits, checked rather
// than inherited: createRelease's ONLY required field is `name` (see
// api/releaseApi.ts) -- targetDate/notes/linkedTestPlanIds/qualityGates are
// all optional, and qualityGates in particular only makes sense to fill in
// once a release already has an id to key updateRelease(id, ...) calls
// off. A blank draft TAB (the mechanism this set exists for) is built for
// entities with several fields worth filling in before that first save --
// a release's create surface is one required string. SourcePanel.tsx's own
// "New Release" button (module-6-only, not gated by this set) opens a
// small dialog instead, calling createRelease directly and jumping straight
// to the real, saved ReleaseDetail tab -- the same shape the old standalone
// nav page's own create dialog used (Pages/releases.tsx, retired by WP-F18b
// Task 4), a proven interaction reused here, not a new one invented.
//
// Wave B-4 (clone) reuses this exact set: a clone is nothing but a
// pre-filled draft, so "does this module have a create flow to clone
// into" is the identical question SourcePanel's own "New ..." button
// already answers -- moved here (out of SourcePanel.tsx, which owned it
// first) so workbench/tree/EntityTree.tsx can gate the tree row's Clone
// action on the same single source of truth instead of duplicating the
// module list.
export const DRAFT_CAPABLE_MODULES: ReadonlySet<ModuleId> = new Set<ModuleId>([1, 2, 3, 5]);

// Owner decision 2026-11-06: folders exist ONLY in the test case repository
// (1) and requirements (2). Releases and defects never had a folder field at
// all, test runs are created from a plan, and test plans had no move API --
// so folders in those modules were empty shells nothing could be put into.
// Outside this set the tree loads no folder nodes (stale Folder records are
// left in the database, just never shown), lists every item flat at the
// root, and the panel offers no "New folder".
export const FOLDER_MODULES: ReadonlySet<ModuleId> = new Set<ModuleId>([1, 2]);
