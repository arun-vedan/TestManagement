import { Box, Typography } from '@mui/material';
import { ReactNode } from 'react';

// Shared "nothing to show" placeholder for lists/panels/dialogs. Keeps empty
// states visually consistent instead of every page hand-rolling its own
// <Typography color="text.secondary"> message.

export interface EmptyStateProps {
    message: string;
    icon?: ReactNode;
    action?: ReactNode;
}

export const EmptyState = ({ message, icon, action }: EmptyStateProps) => {
    return (
        <Box
            display="flex"
            flexDirection="column"
            alignItems="center"
            justifyContent="center"
            gap={1}
            p={3}
            textAlign="center"
        >
            {icon}
            <Typography color="text.secondary">{message}</Typography>
            {action}
        </Box>
    );
};

export default EmptyState;
