import { render, screen } from '@testing-library/react';
import { ThemeProvider } from '@mui/material';
import theme from '../../../Theme/theme';
import { AiGeneratedBadge, AI_GENERATED_BADGE_RULE } from '../AiGeneratedBadge';

// WP-051 -- the badge is the one deliberate visual exception this WP calls
// out (GR-8: a user must always be able to tell what came from a model).
// Proves the label is always visible text (never color-only, matching this
// codebase's own WCAG 1.4.1 convention already established for StatusChip)
// and that the exact badge rule is present in the accessible tooltip text,
// not just in a code comment nobody using the UI ever sees.

const renderBadge = () =>
    render(
        <ThemeProvider theme={theme}>
            <AiGeneratedBadge />
        </ThemeProvider>
    );

describe('AiGeneratedBadge (WP-051)', () => {
    it('renders a visible "AI-generated" text label', () => {
        renderBadge();
        expect(screen.getByText('AI-generated')).toBeInTheDocument();
    });

    it('exposes the exact badge rule via an accessible tooltip', () => {
        renderBadge();
        expect(screen.getByLabelText(AI_GENERATED_BADGE_RULE)).toBeInTheDocument();
    });
});
