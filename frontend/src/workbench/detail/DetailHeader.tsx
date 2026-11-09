import React from 'react';
import { Box, Typography } from '@mui/material';

export interface DetailHeaderProps {
  id: string;
  summary?: string;
  /** Extra content rendered under the id/summary line -- e.g. a status badge. */
  children?: React.ReactNode;
}

// WP-074 -- extracted from Components/Tabs/TabContent.tsx's non-edit header
// line (`{fieldValues['TestCaseId']} : {fieldValues['TestCaseSummary']}` /
// the equivalent `reqId`/`requirementSummary` line for requirements,
// TabContent.tsx:567-580). TabContent drew this text in the banned hex
// `#1F618D`; `color="primary.main"` is the theme's brand color filling the
// same role without a hardcoded value.
export function DetailHeader({ id, summary, children }: DetailHeaderProps): JSX.Element {
  return (
    <Box mb={2}>
      {/* A summary is free text with no length limit -- a requirement's
          can run to a paragraph, and a plan's objective (the closest thing
          a plan has to a name) often does. Unclamped, one long one turns
          the header into four lines of h6 and pushes the whole view down.
          Two lines, then ellipsis, with the full text on hover and in the
          accessible name via `title`. */}
      <Typography
        variant="h6"
        color="primary.main"
        title={summary ? `${id} : ${summary}` : id}
        sx={{
          display: '-webkit-box',
          WebkitBoxOrient: 'vertical',
          WebkitLineClamp: 2,
          overflow: 'hidden',
        }}
      >
        <b>{id}</b>
        {summary ? ` : ${summary}` : null}
      </Typography>
      {children}
    </Box>
  );
}

export default DetailHeader;
