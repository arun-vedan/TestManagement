import { Box } from "@mui/material"
import MainDrawer from "../NavBar/MainDrawer"
interface LayoutProps {
    children: React.ReactNode;
    /**
     * WP-078 Part A -- the workbench is the first MainLayout consumer that
     * needs a real, bounded height (its rail | source panel | detail
     * regions manage their own internal scrolling, per spec §6, rather than
     * letting the whole page scroll). Every other page just renders content
     * that overflows naturally and lets the document scroll -- the default
     * (false) keeps their exact previous mt/height rendering untouched.
     *
     * WP-072 flagged the bug this fixes: the old unconditional wrapper
     * below (`mt: '3vh', height: '10vh'`) was a hardcoded, effectively
     * arbitrary height that every page ignored (their content just
     * overflowed it, invisibly, since Box defaults to overflow: visible) --
     * harmless for them, but fatal for a component like Workbench.tsx that
     * treats its ancestor's height as authoritative for its own
     * `height: '100%'` flex chain. `fillHeight` establishes ONE real
     * `100vh` at this top-level shell and threads a definite, flexed height
     * the rest of the way down (MainDrawer.tsx's own `fillHeight` branch),
     * instead of leaving a second, conflicting `100vh` further down the
     * tree (Workbench.tsx used to declare its own) or a new arbitrary
     * `90vh`/`80vh` guess.
     */
    fillHeight?: boolean;
}
const MainLayout = ({ children, fillHeight = false }: LayoutProps) => {
    if (fillHeight) {
        return (
            <Box component="main" sx={{ height: '100vh', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <MainDrawer fillHeight>
                    {children}
                </MainDrawer>
            </Box>
        );
    }
    return (
        <main >
            <MainDrawer >
                <Box mt={'3vh'} height={'10vh'}>
                    {children}
                </Box>
            </MainDrawer>
        </main>
    )
}

export default MainLayout