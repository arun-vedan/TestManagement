import { EmptyState } from '../../Components/common/EmptyState';

// WP-044 — Modules / Folders reserved Settings tabs.
//
// backend/moduleService and backend/folderService both exist and are live
// (see the WP-021/WP-022 scope-enforcement work across them), and
// Components/folderStructure.tsx already *browses* a project's module/
// folder tree elsewhere in the app -- but no WP has yet built a frontend
// surface for *configuring* modules or folders as first-class
// administrable entities (create/rename/reorder/deactivate a module
// independent of the tree UI embedded in testrepo/requirements/etc.).
// That's a real feature gap, not a routing concern -- out of scope for a
// re-platform WP per GR-4's own spirit ("a backend capability isn't
// delivered until the UI surfaces it" describes exactly what's still
// missing here). Reserving the slot in Settings' navigation and saying so
// plainly here (and in EXECUTION_LOG.md's WP-044 report) is deliberate:
// the tab exists so a future WP has an obvious home, not so this WP can
// claim the capability is delivered when it isn't.
//
// Wave D-1 built exactly that surface for the third member of this
// original trio -- Fields -- which is why it no longer renders through
// this component (see Pages/settings/FieldsTab.tsx /
// Components/settings/FieldsPanel.tsx instead). Modules and Folders remain
// genuinely unbuilt.
export interface ReservedTabProps {
    label: string;
}

export default function ReservedTab({ label }: ReservedTabProps) {
    return (
        <EmptyState
            message={`${label} management isn't built yet. This tab is reserved for a future work package -- see EXECUTION_LOG.md's WP-044 report.`}
        />
    );
}
