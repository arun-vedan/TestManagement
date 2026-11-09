import * as React from 'react';
import { styled, useTheme, Theme, CSSObject, ThemeProvider } from '@mui/material/styles';
import Box from '@mui/material/Box';
import MuiDrawer from '@mui/material/Drawer';
import MuiAppBar, { AppBarProps as MuiAppBarProps } from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import List from '@mui/material/List';
import CssBaseline from '@mui/material/CssBaseline';
import Divider from '@mui/material/Divider';
import IconButton from '@mui/material/IconButton';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import Tooltip from '@mui/material/Tooltip';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import theme1 from '../../Theme/theme';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import HomeIcon from '@mui/icons-material/Home';
import { Stack } from '@mui/system';
import CustomizedMenus from '../Menu/userMenu';
import NotificationBell from './NotificationBell';
import ProjectSwitcher from './ProjectSwitcher';
import { Link, useLocation, useParams } from 'react-router-dom';
import Button from '@mui/material/Button';
import AppsIcon from '@mui/icons-material/Apps';
import FolderIcon from '@mui/icons-material/Folder';
import AssessmentIcon from '@mui/icons-material/Assessment';
import SettingsIcon from '@mui/icons-material/Settings';
import GridViewIcon from '@mui/icons-material/GridView';
import { getCurrentProjectId } from '../../currentProject';
import { brand } from '../../brand';
import { tokens } from '../../Theme/tokens';

// WP-044 — every in-app nav link is now project-scoped
// (/projects/:projectId/...) instead of flat (/testexecution etc). The
// :projectId comes from the route via useParams() when available (every
// project-scoped page renders this through MainLayout, nested under
// Layouts/ProjectRouteLayout.tsx) and falls back to
// currentProject.ts's singleton when it isn't (Pages/projects.tsx -- the
// org-wide project list -- and Page404 also render through MainLayout but
// aren't nested under a :projectId route themselves).
//
// "Audit" and "API Keys" are no longer separate top-level items -- both
// relocated under Settings (Pages/settings/index.tsx) per this WP's
// acceptance. "Reports" and "Settings" are new. "Projects" keeps pointing
// at the flat, non-project-scoped /projects (the org-wide project list,
// unaffected by this WP) rather than a project-scoped path.
//
// WP-078 Part A -- RECORDED DECISION (owner, EXECUTION_LOG.md): the
// navigation is split between this drawer and the workbench rail
// (workbench/ModuleRail.tsx). The drawer answers "which area of the app am
// I in" (Home/Projects/Reports/Settings); the rail answers "which kind of
// work item am I looking at". Requirements/Test Repository/Test Plan/Test
// Execution/Defect are REMOVED from here -- each duplicated a rail entry
// under a DIFFERENT label ("Test Repository" vs the rail's "Test Cases",
// "Test Execution" vs "Test Runs", "Defect" vs "Defects"), which was the
// actual source of confusion, not just the duplication itself.
//
// WP-F18b Task 4 -- Releases is no longer an exception either. It used to
// stay here because the standalone page (Pages/releases.tsx, routed at
// /projects/:id/releases) owned release CRUD and quality-gate editing while
// the workbench rail's own "Releases" entry (module 6) only had a list and
// detail view (WP-F15/F18 Tasks 1-2) -- dropping this entry then would have
// stranded a live route nothing else linked to. WP-F18b Tasks 1-3 moved
// every one of those capabilities into the workbench and Settings, and this
// task removed that page; the rail is now the only entry point, so this
// drawer entry is removed the same way its five siblings already were.

const drawerWidth = 240;

// WP-F21e -- shared between the AppBar's own height (below) and the
// fillHeight offset that clears it (~90 lines down, in the `main` Box's
// sx). They were two bare '5vh' literals tied together only by a comment;
// a future AppBar height tweak here would silently reintroduce the bug
// that offset exists to fix (the tab strip rendering underneath the bar)
// with no compile-time or lint signal. One constant, used in both places.
//
// Dropdown-height defect follow-up -- this constant used to be '5vh', a
// percentage of the VIEWPORT applied to a bar whose own contents
// (Toolbar's default minHeight, 64px at this app's desktop breakpoints;
// ProjectSwitcher's `size="small"` Select, ~38px) are sized in fixed
// pixels and don't shrink with it. 5vh only reaches 64px at a 1280px-tall
// viewport -- on anything shorter (any laptop screen), the AppBar's own
// painted background fell short of its Toolbar's actual height, and the
// ProjectSwitcher (and the icon cluster beside it) rendered PAST the
// bottom of the navy bar, overlapping the page content directly below it.
// Confirmed by measuring the rendered AppBar/Toolbar boxes and reading
// actual pixel colour at the seam across several viewport heights.
// A fixed height tied to the Toolbar's own natural size removes the
// mismatch instead of narrowing it.
const APPBAR_HEIGHT = '64px';

const openedMixin = (theme: Theme): CSSObject => ({
  width: drawerWidth,
  transition: theme.transitions.create('width', {
    easing: theme.transitions.easing.sharp,
    duration: theme.transitions.duration.enteringScreen,
  }),
  overflowX: 'hidden',
});

const closedMixin = (theme: Theme): CSSObject => ({
  transition: theme.transitions.create('width', {
    easing: theme.transitions.easing.sharp,
    duration: theme.transitions.duration.leavingScreen,
  }),
  overflowX: 'hidden',
  // WP-F19 -- was spacing(5)+1 (41px), narrower than MUI's own mini-drawer
  // convention and too tight for an icon to sit in comfortably, so the
  // collapsed drawer read as an unlabelled sliver rather than navigation.
  // spacing(7)+1 / spacing(8)+1 are the documented mini-variant widths.
  width: `calc(${theme.spacing(7)} + 1px)`,
  [theme.breakpoints.up('sm')]: {
    width: `calc(${theme.spacing(8)} + 1px)`,
  },
});

const DrawerHeader = styled('div')(({ theme }) => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  padding: theme.spacing(0, 1),
  // necessary for content to be below app bar
  ...theme.mixins.toolbar,
}));

interface AppBarProps extends MuiAppBarProps {
  open?: boolean;
}

const AppBar = styled(MuiAppBar, {
  shouldForwardProp: (prop) => prop !== 'open',
})<AppBarProps>(({ theme, open }) => ({
  backgroundColor: '#fff',
  color: theme1.palette.primary.dark,


  zIndex: theme.zIndex.drawer + 10,
  transition: theme.transitions.create(['width', 'margin'], {
    easing: theme.transitions.easing.sharp,
    duration: theme.transitions.duration.leavingScreen,
  }),
  ...(open && {
    marginLeft: drawerWidth,

    transition: theme.transitions.create(['width', 'margin'], {
      easing: theme.transitions.easing.sharp,
      duration: theme.transitions.duration.enteringScreen,
    }),
  }),
}));

// WP-F20 -- the navy paper moved here from the theme's global MuiDrawer
// override, which was styling all five of the app's drawers (this one plus
// the four AI panels) when only this one wants it.
const NAV_PAPER = {
  backgroundColor: tokens.brand,
  color: '#fff',
  borderBottomRightRadius: '16px',
};

const Drawer = styled(MuiDrawer, { shouldForwardProp: (prop) => prop !== 'open' })(
  ({ theme, open }) => ({
    width: drawerWidth,
    flexShrink: 0,
    whiteSpace: 'nowrap',
    boxSizing: 'border-box',
    '& .MuiDrawer-paper': NAV_PAPER,
    ...(open && {
      ...openedMixin(theme),
      '& .MuiDrawer-paper': { ...openedMixin(theme), ...NAV_PAPER },
    }),
    ...(!open && {
      ...closedMixin(theme),
      '& .MuiDrawer-paper': { ...closedMixin(theme), ...NAV_PAPER },
    }),
  }),
);
interface LayoutProps {
  children: React.ReactNode;
  /**
   * WP-078 Part A -- opt-in flex-fill mode for a consumer (the workbench)
   * that needs a real, bounded "available height below the chrome" to lay
   * out its own internal flex chain (rail | source panel | detail, each
   * scrolling internally) rather than letting the whole page scroll.
   * Defaults to false, which keeps every other MainLayout consumer's
   * current rendering byte-for-byte unchanged -- see MainLayout.tsx's own
   * header comment for why this is a prop rather than the default.
   */
  fillHeight?: boolean;
}

interface NavItem {
  key: string;
  label: string;
  to: string;
  icon: React.ReactNode;
  /** Highlight for this item and every sub-route under it (e.g. every /settings/* tab). */
  selected: (pathname: string) => boolean;
}

export default function MainDrawer({ children, fillHeight = false }: LayoutProps) {
  const { pathname } = useLocation();
  const { projectId: projectIdParam } = useParams<{ projectId?: string }>();
  const theme = useTheme();
  // Starts COLLAPSED, at the owner's request: the workbench is where the
  // work happens and the drawer is a signpost, not a workspace.
  //
  // WP-F19 had made it start open for a real reason -- collapsed, this was
  // a strip of unlabelled icons with nothing to tell a new user what any of
  // them were, since ListItemText is hidden at opacity 0 in that state.
  // That reason has not gone away, so the labels now surface as tooltips
  // while collapsed rather than being simply lost. The space is reclaimed;
  // the discoverability is not.
  const [open, setOpen] = React.useState(false);

  // Route-sourced when available; falls back to the last-active project
  // (or the seeded default) for pages rendered outside a /projects/:id
  // route -- see this file's own header comment.
  const projectId = projectIdParam ? Number(projectIdParam) : getCurrentProjectId();
  const base = `/projects/${projectId}`;

  const handleDrawerOpen = () => {
    setOpen(true);
  };

  const handleDrawerClose = () => {
    setOpen(false);
  };

  const navItems: NavItem[] = [
    { key: 'Home', label: 'Home', to: `${base}/dashboard`, icon: <HomeIcon />, selected: (p) => p === `${base}/dashboard` },
    // WP-F19 -- the workbench had NO drawer entry at all. WP-078's split gave
    // the drawer the job of answering "which AREA of the app am I in", then
    // never added an area entry for the one where all the test work happens:
    // it was reachable only from a dashboard drill-down link, a legacy
    // redirect, or a typed URL, and the module rail that navigates it lives
    // INSIDE it (workbench/Workbench.tsx renders ModuleRail), so it could not
    // serve as the way in. This is ONE area entry, not the five per-module
    // entries WP-078 deliberately removed -- those duplicated rail entries
    // under mismatched labels, which is the confusion that decision fixed and
    // this does not reintroduce. Lands on module 1; the rail takes over there.
    { key: 'Workbench', label: 'Workbench', to: `${base}/workbench/testcases`, icon: <GridViewIcon />, selected: (p) => p.startsWith(`${base}/workbench`) },
    { key: 'Projects', label: 'Projects', to: '/projects', icon: <FolderIcon />, selected: (p) => p === '/projects' },
    { key: 'Reports', label: 'Reports', to: `${base}/reports`, icon: <AssessmentIcon />, selected: (p) => p === `${base}/reports` },
    { key: 'Settings', label: 'Settings', to: `${base}/settings`, icon: <SettingsIcon />, selected: (p) => p.startsWith(`${base}/settings`) },
  ];

  return (
    <ThemeProvider theme={theme1}>
      <Box sx={{ display: 'flex', ...(fillHeight ? { height: '100%', minHeight: 0 } : {}) }}>
        <CssBaseline />
        <AppBar sx={{ 'borderBottomLeftRadius': '16px', 'textAlign': 'center', 'top': 'auto', 'bgcolor': 'primary.main', 'height': APPBAR_HEIGHT }} elevation={0} position="fixed" open={open}>
          <Toolbar >
            <Box mb={2}>
            <Stack direction="row" alignItems="center" spacing={1}>
              <img src={brand.assets.mark} height={32} alt="" />
              <img src={brand.assets.wordmarkOnDark} height={22} alt={brand.name} />
            </Stack>
            </Box>
            <Stack direction={'row'} alignItems={'center'} sx={{ marginLeft: "auto" }} mb={3} >
              <ProjectSwitcher />

              <Button id="demo-customized-button"
                aria-controls={open ? 'demo-customized-menu' : undefined}
                aria-haspopup="true"
                aria-expanded={open ? 'true' : undefined}
                sx={{ 'color': '#fff' }}
                disableElevation>
                <AppsIcon fontSize='small' sx={{'color': '#fff', marginRight:"10px"}}></AppsIcon>
                <SearchOutlinedIcon fontSize='small' sx={{ 'color': '#fff' }}></SearchOutlinedIcon></Button>

              <NotificationBell />

              <Box >
                <CustomizedMenus></CustomizedMenus>
              </Box>


            </Stack>

          </Toolbar>
        </AppBar>
        <Drawer variant="permanent" open={open} >
          <DrawerHeader />
          <Divider />
          <List >
            {navItems.map((item) => (
              <Link to={item.to} style={{ textDecoration: 'none', color: '#fff' }} key={item.key}>
                <ListItem style={{ 'textDecoration': 'none' }} key={item.key} disablePadding sx={{ display: 'block' }}>
                  {/* Title only while collapsed -- an open drawer already
                      shows the label, and a tooltip repeating it would just
                      be noise on hover. */}
                  <Tooltip title={open ? '' : item.label} placement="right">
                  <ListItemButton
                    selected={item.selected(pathname)}
                    style={{ textDecoration: 'none' }}
                    sx={{
                      minHeight: 48,
                      justifyContent: open ? 'initial' : 'center',
                      px: 2.5,
                      // Second WP-F20-shaped fix -- this ListItemButton used
                      // to get its white text for free from a global
                      // MuiListItemButton theme override that also painted
                      // every OTHER ListItemButton in the app navy (see
                      // Theme/theme.tsx's comment). Removing that override
                      // exposed react-router's <Link> UA default (link-blue)
                      // for this text, since Typography's default variant
                      // has no color of its own to beat it with -- the
                      // color now lives explicitly on the Link itself
                      // (above) and, for the selected state, here.
                      '&.Mui-selected': {
                        // WP-078 -- was the literal '#F2545B' ("Change to
                        // your desired color") placeholder text, one of
                        // the six hexes the acceptance sweep bans in
                        // src/; theme1.palette.primary.dark is the same
                        // token this file already uses (line ~104) for a
                        // distinct-but-on-brand highlight.
                        backgroundColor: theme1.palette.primary.dark,
                        // Matches the color the removed global override
                        // used to give the selected item -- preserved
                        // exactly rather than left to default to white,
                        // since that pairing is what made "selected" visually
                        // distinct from the rest of the (also white-text)
                        // list before this fix.
                        color: '#006685',
                        '&:hover': {
                          backgroundColor: theme1.palette.primary.dark,
                        },
                      },
                    }}
                  >
                    <ListItemIcon
                      sx={{
                        minWidth: 0,
                        mr: open ? 3 : 'auto',
                        justifyContent: 'center',
                        color: '#fff'
                      }}
                    >
                      {item.icon}
                    </ListItemIcon>
                    <ListItemText style={{ textDecoration: 'none' }} primary={item.label} sx={{ opacity: open ? 1 : 0 }} />
                  </ListItemButton>
                  </Tooltip>
                </ListItem>
              </Link>
            ))}
          </List>
          <Divider />

          <DrawerHeader>
            <IconButton data-testid="drawer-collapse" aria-label="Collapse navigation" onClick={handleDrawerClose} sx={{ 'color': '#fff', display: !open ? 'none' : 'flex' }}>
              {theme.direction === 'rtl' ? <ChevronRightIcon /> : <ChevronLeftIcon />}
            </IconButton>
            <IconButton data-testid="drawer-expand" aria-label="Expand navigation" onClick={handleDrawerOpen} sx={{ 'color': '#fff', display: open ? 'none' : 'flex' }}>
              {theme.direction === 'rtl' ? <ChevronLeftIcon /> : <ChevronRightIcon />}
            </IconButton>
          </DrawerHeader>
        </Drawer>
        <Box
          component="main"
          sx={{
            flexGrow: 1,
            p: 3,
            // WP-F21 -- clear the fixed AppBar.
            //
            // The AppBar above is `position="fixed"` with `height:
            // APPBAR_HEIGHT`, so it is out of flow and paints over
            // whatever starts at y:0. The non-fillHeight branch of
            // MainLayout happens to clear it by wrapping children in
            // `mt: '3vh'`; the fillHeight branch (WP-078 Part A, used only
            // by the workbench) has no such offset, so the workbench's top
            // 5vh rendered UNDERNEATH the bar. The entity tab strip sits
            // exactly there, which meant the AppBar's toolbar intercepted
            // every click on it -- tabs looked present and simply did not
            // respond, so a user working two tickets saw the app stuck
            // between them.
            //
            // Offset in the AppBar's OWN unit (APPBAR_HEIGHT), not
            // theme.mixins.toolbar: DrawerHeader uses the latter (56/64px)
            // and would over-shoot at this viewport and under-shoot at a
            // tall one. The explicit calc() keeps the flex chain's height
            // definite without depending on box-sizing for a padding-based
            // offset. WP-F21e -- both values below now read from the same
            // APPBAR_HEIGHT constant as the AppBar itself, so they cannot
            // drift out of sync with it again.
            ...(fillHeight
              ? {
                  mt: APPBAR_HEIGHT,
                  height: `calc(100% - ${APPBAR_HEIGHT})`,
                  minHeight: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden'
                }
              : {}),
          }}
        >
          {children}

        </Box>
      </Box>
    </ThemeProvider>
  );
}
