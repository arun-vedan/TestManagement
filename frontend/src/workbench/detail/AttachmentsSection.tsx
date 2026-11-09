import React from 'react';
import { Box } from '@mui/material';
import { AttachemntListComp } from '../../Components/attachments/attachments';

export interface AttachmentItem {
  attachmentId: string;
  name: string;
}

export interface AttachmentsSectionProps {
  attachmentList: AttachmentItem[];
  file: File | null;
  fileName: string;
  loading: boolean;
  onFileChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onUpload: () => void;
  onDelete: (attachmentId: string) => void;
}

// WP-074 -- thin wrapper around the existing AttachemntListComp
// (Components/attachments/attachments.tsx), extracted from
// Components/Tabs/TabContent.tsx:784-786. That block was gated on
// `selectedModule === 2` (requirements) -- Test Cases never showed
// attachments in TabContent, so TestCaseDetail does not consume this;
// RequirementDetail (WP-075) is its first real consumer.
export function AttachmentsSection({
  attachmentList,
  file,
  fileName,
  loading,
  onFileChange,
  onUpload,
  onDelete,
}: AttachmentsSectionProps): JSX.Element {
  return (
    <Box mt={2} p={1}>
      <AttachemntListComp
        attachmentList={attachmentList}
        handleItemDelete={onDelete}
        file={file}
        fileName={fileName}
        handleFileChange={onFileChange}
        handleUpload={onUpload}
        loading={loading}
      />
    </Box>
  );
}

export default AttachmentsSection;
