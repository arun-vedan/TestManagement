// Color tokens for the shared chart primitives (TrendChart, DonutChart,
// BarChart, StatTile).
//
// These hex values are copied verbatim from the `dataviz` skill's reference
// palette (references/palette.md) -- they are NOT derived from
// `Theme/theme.tsx`. That is deliberate: the skill's "documented palette
// only" rule says every categorical/status slot must be a hex from the
// validated instance, never eyeballed or substituted from an unrelated
// brand color. `theme.tsx`'s single teal primary (#244855) has no CVD
// validation and isn't a categorical *set*, so it cannot supply these
// roles. What these components DO take from `theme.tsx` is chart chrome --
// axis/gridline/text ink -- via `useTheme()` at render time (see
// ChartCard.tsx and each chart component), so typography and surface
// colors stay consistent with the rest of the app while the data-carrying
// hues stay CVD-safe.
//
// Validated 2026-08-29 against this app's actual chart surface (MUI's
// default light background, #ffffff -- theme.tsx does not override
// palette.background) using the skill's validator:
//
//   node scripts/validate_palette.js \
//     "#2a78d6,#eb6834,#1baf7a,#eda100,#e87ba4,#008300,#4a3aa7,#e34948" \
//     --mode light --surface "#ffffff"
//
// Result: ALL CHECKS PASS. Worst adjacent CVD ΔE 9.1 (protan), worst
// adjacent normal-vision ΔE 19.6 -- both clear the target/floor. Three
// slots (aqua, yellow, magenta) sit below 3:1 contrast on this surface,
// which is a WARN, not a FAIL -- the skill requires "relief" (visible
// direct labels or a table view) rather than color alone for those slots,
// which is exactly what ChartCard's table-view toggle and each chart's
// legend/direct labels provide.
//
// Order is the CVD-safety mechanism (skill: "Assign categorical hues in
// fixed order, never cycled") -- always index into this array in order,
// never re-sort or cherry-pick by name.
export const CATEGORICAL_PALETTE: string[] = [
    '#2a78d6', // 1 blue
    '#eb6834', // 2 orange
    '#1baf7a', // 3 aqua
    '#eda100', // 4 yellow
    '#e87ba4', // 5 magenta
    '#008300', // 6 green
    '#4a3aa7', // 7 violet
    '#e34948', // 8 red
];

// All-pairs form cap (scatter/bubble/choropleth/small-multiples -- any two
// marks can be neighbors). Not used by these four components today, kept
// here so a future all-pairs chart in this folder doesn't have to re-derive
// it: only the first three slots clear the CVD floor under `--pairs all`.
export const ALL_PAIRS_SAFE_CATEGORICAL_COUNT = 3;

// Reserved status scale (good -> critical). Deliberately distinct from the
// categorical slots above so a status color never impersonates a series.
// Per the skill, these are NEVER used for "series N" and always ship with
// an icon + label, never color alone -- see StatTile's delta row.
export const STATUS_COLORS = {
    good: '#0ca30c',
    warning: '#fab219',
    serious: '#ec835a',
    critical: '#d03b3b',
} as const;

// Neutral "Other" / de-emphasis gray for folded categories (DonutChart) and
// emphasis-form context series. Taken from the skill's chart-chrome table
// (muted ink), not a 9th generated hue.
export const MUTED_SERIES_COLOR = '#898781';

// Series-count ladder gates, from choosing-a-form.md. DonutChart uses this
// to fold long tails into "Other" instead of spending a 9th/10th hue.
export const DONUT_MAX_DIRECT_SEGMENTS = 5; // + 1 "Other" slot = 6 total, the skill's part-to-whole cap
