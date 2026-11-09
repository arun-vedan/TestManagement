import { ComponentType } from 'react';
import { Chip, ChipProps, SvgIconProps } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import InfoIcon from '@mui/icons-material/Info';

// Shared status pill for entities that carry a workflow/lifecycle status.
//
// Two vocabularies are expected to use this:
//  - Fixed-vocabulary governance statuses (draft/review/approved/deprecated/
//    archived), currently rendered ad hoc in
//    Components/governance/LifecycleStatus.tsx.
//  - A future dynamic-vocabulary defect status (owned by a separate work
//    package) where the set of possible statuses isn't known ahead of time.
//
// `colorMap` covers the known/fixed case. For a status not present in the
// map (including the whole dynamic-vocabulary case, where no map is passed
// at all), a deterministic hash over the status string picks one of MUI's
// standard chip colors -- so unknown statuses still get a stable, distinct
// color across renders instead of all collapsing to grey.

export type StatusChipColor = 'default' | 'primary' | 'secondary' | 'error' | 'info' | 'success' | 'warning';

const FALLBACK_COLOR_ROTATION: StatusChipColor[] = ['primary', 'secondary', 'info', 'success', 'warning', 'error'];

export const LIFECYCLE_STATUS_COLORS: Record<string, StatusChipColor> = {
    draft: 'default',
    review: 'info',
    approved: 'success',
    deprecated: 'warning',
    archived: 'error',
};

const hashStatus = (status: string): number => {
    let hash = 0;
    for (let i = 0; i < status.length; i++) {
        hash = (hash * 31 + status.charCodeAt(i)) >>> 0;
    }
    return hash;
};

interface ResolvedStatus {
    color: StatusChipColor;
    // Whether `color` came from a caller-supplied colorMap entry that
    // actually matched `status`, as opposed to the hash-based fallback
    // rotation. Drives the WP-046 icon fix below -- see its comment.
    fromKnownMap: boolean;
}

const resolveStatus = (status: string, colorMap?: Record<string, StatusChipColor>): ResolvedStatus => {
    const fromMap = colorMap?.[status];
    if (fromMap) {
        return { color: fromMap, fromKnownMap: true };
    }
    if (!status) {
        return { color: 'default', fromKnownMap: false };
    }
    return { color: FALLBACK_COLOR_ROTATION[hashStatus(status) % FALLBACK_COLOR_ROTATION.length], fromKnownMap: false };
};

// WP-046 — WCAG 1.4.1 (Use of Color): a chip's meaning must never rely on
// color alone. The visible label text already covers this for every
// caller, but severity-style statuses benefit from a redundant icon too --
// e.g. someone scanning a dense grid column by shape/color rather than
// reading every label, or a colorblind user who can't reliably tell this
// chip's color apart from a neighboring one.
//
// Deliberately keyed by resolved MUI color, not by the raw status string:
// StatusChip is reused across unrelated fixed vocabularies (lifecycle
// status, release/gate status, link type, risk level) that all funnel
// through the same five semantic colors. Only applied when the color came
// from a caller-supplied, known-semantics colorMap match (`fromKnownMap`)
// -- NEVER the hash-based fallback rotation used for dynamic/unrecognized
// vocabularies (e.g. an unmapped defect status), where the color is only a
// stable disambiguator with no severity meaning. Slapping a "success"
// checkmark on a hash-picked green for an arbitrary status string would
// misinform rather than help, so that case intentionally gets no icon --
// its text label is the (sufficient) non-color signal.
const DEFAULT_STATUS_ICONS: Partial<Record<StatusChipColor, ComponentType<SvgIconProps>>> = {
    success: CheckCircleIcon,
    error: ErrorIcon,
    warning: WarningAmberIcon,
    info: InfoIcon,
};

export interface StatusChipProps extends Omit<ChipProps, 'color' | 'label'> {
    /** The raw status value, e.g. "approved" or a dynamic defect status. */
    status: string;
    /** Optional display override; defaults to the raw status text. */
    label?: string;
    /** Optional status -> chip color map. Falls back to LIFECYCLE_STATUS_COLORS-shaped lookups when omitted. */
    colorMap?: Record<string, StatusChipColor>;
    /** Opt out of the default severity icon (e.g. a chip too small to fit one). */
    hideIcon?: boolean;
}

export const StatusChip = ({ status, label, colorMap, hideIcon, size = 'small', ...rest }: StatusChipProps) => {
    const { color, fromKnownMap } = resolveStatus(status, colorMap);
    // @mui/icons-material icons render via SvgIcon, which sets
    // aria-hidden="true" by default -- this icon is purely a redundant
    // visual signal alongside the label text, never an accessible-name
    // source, so screen reader users see/hear only the label (no
    // double-announcement).
    const Icon = !hideIcon && fromKnownMap ? DEFAULT_STATUS_ICONS[color] : undefined;

    return (
        <Chip
            label={label ?? status}
            color={color}
            size={size}
            icon={Icon ? <Icon /> : undefined}
            {...rest}
        />
    );
};

export default StatusChip;
