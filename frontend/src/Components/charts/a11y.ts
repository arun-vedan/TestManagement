import { SxProps, Theme } from '@mui/material';

// Visually-hidden but screen-reader-reachable content. Standard "sr-only"
// clip pattern -- content stays in the accessibility tree and in tab order
// (for focusable descendants) without taking visual space.
export const srOnlySx: SxProps<Theme> = {
    position: 'absolute',
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: 'hidden',
    clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap',
    border: 0,
};

// Builds a short natural-language summary of a numeric series, e.g.
// "12 points, rising from 4 to 19" -- used as the text alternative for
// compact marks (a StatTile's sparkline) where a full data table would be
// disproportionate to the mark's size. This is supplementary to, not a
// replacement for, ChartCard's table-view toggle used on the four full
// chart components.
export const describeTrend = (data: number[]): string => {
    const values = data.filter((v) => typeof v === 'number' && !Number.isNaN(v));
    if (values.length === 0) {
        return 'no trend data available';
    }
    if (values.length === 1) {
        return `single value ${values[0]}`;
    }
    const first = values[0];
    const last = values[values.length - 1];
    const direction = last > first ? 'rising' : last < first ? 'falling' : 'flat';
    return `${values.length} points, ${direction} from ${first} to ${last}`;
};

// Formats a signed delta for accessible/text display, e.g. 4.2 -> "+4.2%".
export const formatSignedPercent = (delta: number, digits = 1): string => {
    const sign = delta > 0 ? '+' : delta < 0 ? '' : '±';
    return `${sign}${delta.toFixed(digits)}%`;
};
