import { ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { Link as MuiLink, SxProps, Theme } from '@mui/material';

// WP-041 — every dashboard widget's "go look at the real data" affordance
// funnels through this one component, which always renders a real
// react-router <Link> (so it's keyboard-reachable and works with
// browser back/forward, unlike an onClick+navigate handler) to an href
// built by Pages/dashboard/dashboardLinks.ts.
export interface DrilldownLinkProps {
    to: string;
    children: ReactNode;
    sx?: SxProps<Theme>;
}

export function DrilldownLink({ to, children, sx }: DrilldownLinkProps) {
    return (
        <MuiLink component={RouterLink} to={to} variant="body2" sx={{ display: 'inline-block', mt: 0.5, ...sx }}>
            {children}
        </MuiLink>
    );
}

export default DrilldownLink;
