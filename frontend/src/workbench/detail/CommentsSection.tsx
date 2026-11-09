import React from 'react';
import Comments from '../../Components/comments/displayComments';

export interface CommentsSectionProps {
  moduleId: number;
  typeId: string;
  userName?: string;
  userId?: string;
}

// WP-074 -- thin wrapper around the existing Comments component
// (Components/comments/displayComments.tsx), extracted from the
// always-visible `<Comments .../>` at the bottom of every TabContent
// detail view (Components/Tabs/TabContent.tsx:866). No behaviour of its
// own.
export function CommentsSection({ moduleId, typeId, userName, userId }: CommentsSectionProps): JSX.Element {
  return <Comments moduleId={moduleId} typeId={typeId} userName={userName} userId={userId} />;
}

export default CommentsSection;
