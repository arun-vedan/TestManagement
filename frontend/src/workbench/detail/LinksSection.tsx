import React from 'react';
import { LinkIssues } from '../../Components/LinkIssue/linkissue';

export interface LinksSectionProps {
  srcModule: number;
  summary?: string;
  issueId: string;
}

// WP-074 -- thin wrapper around the existing LinkIssues component
// (Components/LinkIssue/linkissue.tsx), extracted from
// Components/Tabs/TabContent.tsx:792. No behaviour of its own: LinkIssues
// already owns the create/list/remove-link UI and its own tests
// (linkissue.a11y.test.tsx) -- this only gives it a stable slot in the
// new detail kit.
export function LinksSection({ srcModule, summary, issueId }: LinksSectionProps): JSX.Element {
  return <LinkIssues srcModule={srcModule} summary={summary} issueId={issueId} />;
}

export default LinksSection;
