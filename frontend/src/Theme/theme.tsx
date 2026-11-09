import { createTheme  } from "@mui/material";
import { tokens, StatusToken } from './tokens';

declare module '@mui/material/styles' {
  interface Palette {
    status: Record<StatusToken, string>;
  }
  interface PaletteOptions {
    status?: Record<StatusToken, string>;
  }
}

const theme = createTheme({
    spacing: tokens.density.spacing,
    palette:{
        primary: {
            light: tokens.brand,
            main: tokens.brand,
            dark: tokens.brandDeep,
            contrastText: '#fff',
          },
          secondary: {
            light: '#FFFFFF',
            main: tokens.brandTint,
            // Was '#fff', which is 1.70:1 against the old pale secondary --
            // far below WCAG's 4.5:1, and the reason contained secondary
            // buttons read as disabled. Brand ink on the tint gives 7.87:1.
            contrastText: tokens.brand,
            dark: '#4D6B5C'
          },
          success: {
            main: '#338A3E',
          },
          error: {
            main: '#BA000D'
          },
          status: { ...tokens.status },
    },
    typography: {
        fontFamily: [
          '"Helvetica Neue"',
        ].join(','),
        fontSize: tokens.density.fontSize,
      },
      components: {
        // WP-F20 -- this used to style EVERY MuiDrawer's paper navy with white
        // text. Only ONE drawer in the app wants that: the nav
        // (Components/NavBar/MainDrawer.tsx). The other four are the AI
        // panels -- AiTestCaseDrawer, AiDuplicateCheckDrawer,
        // AiDuplicateAuditPanel, AiLintPanel -- none of which set a
        // background of their own, so all four inherited a dark teal surface
        // while rendering TextFields, Alerts, helper text and dividers that
        // MUI styles for a LIGHT surface. That is the "hard to read" the
        // owner reported. The navy now lives on the nav drawer itself, where
        // it belongs, and every other drawer gets the default paper.
        //
        // Do not reintroduce a global paper override here: any drawer added
        // later would silently inherit it too, which is exactly how this
        // reached four components without anyone choosing it.
        //
        // Second instance of the same mistake, same fix: a global
        // MuiListItemButton override used to paint EVERY ListItemButton in
        // the app navy-with-white-text for the nav drawer's benefit. It
        // leaked into the workbench search results panel
        // (workbench/search/EntitySearchPanel.tsx) and the run detail's
        // Test Cases list (workbench/detail/modules/TestRunDetail.tsx) --
        // both plain lists on light surfaces, rendered as a cramped dark
        // block. The navy now lives on the nav drawer's own ListItemButton
        // sx (Components/NavBar/MainDrawer.tsx), which already carried a
        // `&.Mui-selected` override but had never needed its own TEXT color
        // (it was getting `color: #fff` for free from this global rule) --
        // that file's own comment covers the small local addition this
        // removal required. See PRODUCT_GAP_REGISTER.md for the dated entry.
        MuiFormLabel:{
          styleOverrides:{
            asterisk:{
              color: '#db3131',
            }
          }
        },
        // Dropdown-height defect fix -- this theme set no `defaultProps` at
        // all before this change, so every Select/TextField/Autocomplete
        // rendered at MUI's medium (~56px) height unless the individual
        // file happened to pass `size="small"` by hand. A coarse grep found
        // dozens of files that do and a handful that don't, which is why a
        // "New Field" dialog (Settings > Fields) could show a compact
        // Module selector right next to a full-height Type selector, and
        // why SharedStepManagerDialog's Title/Description fields render
        // taller than the per-step fields directly below them in the same
        // form -- same component, two different heights, purely by
        // accident of which file remembered the prop. Setting the default
        // once here makes every hand-written `size="small"` a no-op and
        // fixes the stragglers without touching 50+ files.
        //
        // MUI's `size` does not cascade to every descendant automatically
        // (verified against the installed @mui/material source): a
        // TextField forwards its own resolved size to the input it renders
        // internally, so MuiTextField needs its own entry rather than
        // relying on MuiOutlinedInput alone. A Select forwards an explicit
        // `size` prop the same way, so MuiSelect needs its own entry too.
        // FormControl's `size` only reaches descendants that read it from
        // FormControl context (OutlinedInput/Input/FilledInput do; Radio,
        // Checkbox and Switch do not), so MuiFormControl's default is safe
        // to add without shrinking checkboxes anywhere that wraps one in a
        // bare FormControl. MuiOutlinedInput covers any input rendered
        // without a TextField/Select wrapper at all. MuiAutocomplete is
        // included for the same reason even though this app's two current
        // instances already pass `size="small"` by hand.
        //
        // A multiline TextField (minRows/rows -- description fields,
        // comment boxes) is NOT excluded: `size="small"` on
        // MuiOutlinedInput only reduces its own padding
        // (16.5px/14px -> 8.5px/14px per the installed OutlinedInput
        // styles); it does not touch `rows`/`minRows`, which is what
        // actually governs a multiline field's height. This codebase
        // already combines `multiline` with `size="small"` in more than
        // one place (e.g. SharedStepManagerDialog's per-step fields), so
        // this is a proven-safe combination here, not a guess.
        MuiFormControl: {
          defaultProps: {
            size: 'small',
          },
        },
        MuiTextField: {
          defaultProps: {
            size: 'small',
          },
        },
        MuiSelect: {
          defaultProps: {
            size: 'small',
          },
        },
        MuiAutocomplete: {
          defaultProps: {
            size: 'small',
          },
        },
        // Shared overrides below centralize the app's hand-rolled `sx` colors
        // (buttons/inputs/tables/chips) so pages stop repeating them inline.
        // Scoped to these four component families per WP-016 — not a pass
        // over every page's inline styles.
        MuiButton: {
          styleOverrides: {
            root: {
              textTransform: 'none',
              borderRadius: '8px',
            },
            containedPrimary: {
              backgroundColor: tokens.brand,
              '&:hover': {
                backgroundColor: tokens.brandDeep,
              },
            },
          },
        },
        MuiOutlinedInput: {
          defaultProps: {
            size: 'small',
          },
          styleOverrides: {
            root: {
              borderRadius: '8px',
              '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
                borderColor: tokens.brand,
              },
            },
          },
        },
        // MUI zeroes DialogContent's top padding when it directly follows a
        // DialogTitle, but DialogContent is also `overflow-y: auto` -- so the
        // floating label of an outlined TextField placed first in a dialog
        // (it sits ~9px above the input's box) was clipped to a sliver, e.g.
        // SharedStepPicker's "Search shared steps". Restoring a small top
        // padding here fixes every dialog at once instead of each file
        // adding its own `sx={{ pt: 1 }}`.
        MuiDialogContent: {
          styleOverrides: {
            root: {
              '.MuiDialogTitle-root + &': {
                paddingTop: 8,
              },
            },
          },
        },
        MuiTableHead: {
          styleOverrides: {
            root: {
              backgroundColor: tokens.brandTint,
              '& .MuiTableCell-root': {
                fontWeight: 600,
                color: tokens.brand,
              },
            },
          },
        },
        MuiTableCell: {
          styleOverrides: {
            root: {
              borderBottom: '1px solid #e0e0e0',
            },
          },
        },
        MuiChip: {
          styleOverrides: {
            root: {
              fontWeight: 500,
            },
          },
        },
      }
})

export default theme