import React from 'react';
import { Box, Button, Typography } from '@mui/material';

export type WorkbenchRegion = 'rail' | 'panel' | 'detail';

const REGION_LABELS: Record<WorkbenchRegion, string> = {
  rail: 'module rail',
  panel: 'source panel',
  detail: 'detail area',
};

interface Props {
  region: WorkbenchRegion;
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
}

// WP-072 — one boundary per shell region (rail / panel / detail), so a
// crash in one region (most likely: a per-module detail view once
// WP-074+ wire real content in) cannot blank the other two. "Try again"
// resets only THIS boundary's own state, letting the region attempt to
// render again without reloading the whole workbench.
export default class RegionErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // eslint-disable-next-line no-console -- surfacing the crash is the point; there is no error-reporting service wired up yet.
    console.error(`RegionErrorBoundary(${this.props.region}) caught an error:`, error, info.componentStack);
  }

  private handleRetry = (): void => {
    this.setState({ hasError: false });
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      const label = REGION_LABELS[this.props.region];
      return (
        <Box role="alert" sx={{ p: 2, display: 'flex', flexDirection: 'column', gap: 1 }}>
          <Typography variant="body2">
            Something went wrong in the {label}.
          </Typography>
          <Button size="small" variant="outlined" onClick={this.handleRetry} sx={{ alignSelf: 'flex-start' }}>
            Try again
          </Button>
        </Box>
      );
    }
    return this.props.children;
  }
}
