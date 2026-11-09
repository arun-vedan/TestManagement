import * as React from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import IconButton from '@mui/material/IconButton';
import Badge from '@mui/material/Badge';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Divider from '@mui/material/Divider';
import CircularProgress from '@mui/material/CircularProgress';
import NotificationsNoneIcon from '@mui/icons-material/NotificationsNone';
import FiberManualRecordIcon from '@mui/icons-material/FiberManualRecord';
import { getNotifications, markNotificationRead, AppNotification } from '../../api/notificationApi';
import { EmptyState } from '../common/EmptyState';

// WP-031 — notification bell: unread badge + dropdown list.
//
// Polling, not websockets (deferred per the WP's own scope note). Interval
// chosen deliberately at 30s, matching the ONE polling/staleness constant
// already used everywhere else react-query appears in this app
// (queryClient.ts's default staleTime, usePermissions.tsx's staleTime) --
// reusing that number rather than inventing a second one keeps this app's
// "how fresh is fresh enough" answer consistent in exactly one place. 30s
// is frequent enough that a new notification shows up on the next glance
// at the bell without feeling stale, and infrequent enough (drops the
// unread count check for the whole app from N page-mount-triggered fetches
// to one fixed-cadence one) not to meaningfully add to the per-service rate
// limit budget (backend/shared/service-core/security.js's per-service
// limiter, see scripts/run-api-tests.sh's WP-002c comment) the way a
// sub-10s interval would risk. `refetchIntervalInBackground` is left at its
// react-query default (false) so an unfocused tab stops polling entirely,
// same spirit as queryClient.ts's refetchOnWindowFocus:false decision one
// layer up.
const POLL_INTERVAL_MS = 30_000;

function timeAgo(iso: string): string {
    const ms = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(ms) || ms < 0) return 'just now';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(iso).toLocaleDateString();
}

const NOTIFICATIONS_QUERY_KEY = ['notifications'];

export default function NotificationBell() {
    const [anchorEl, setAnchorEl] = React.useState<null | HTMLElement>(null);
    const open = Boolean(anchorEl);
    const queryClient = useQueryClient();

    const { data, isLoading, isError } = useQuery({
        queryKey: NOTIFICATIONS_QUERY_KEY,
        queryFn: () => getNotifications(),
        refetchInterval: POLL_INTERVAL_MS,
        // This query's own freshness window is intentionally shorter than
        // queryClient.ts's app-wide 30s default staleTime -- a badge count
        // that only revalidated on remount (the app-wide default's actual
        // effect for a component that stays mounted, like this bell) would
        // never update on its own; refetchInterval is what makes it live.
        staleTime: POLL_INTERVAL_MS
    });

    const markReadMutation = useMutation({
        mutationFn: (id: string) => markNotificationRead(id),
        onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: NOTIFICATIONS_QUERY_KEY });
        }
    });

    const notifications = data?.data ?? [];
    const unreadCount = data?.unreadCount ?? 0;

    const handleOpen = (event: React.MouseEvent<HTMLElement>) => setAnchorEl(event.currentTarget);
    const handleClose = () => setAnchorEl(null);

    const handleItemClick = (notification: AppNotification) => {
        if (!notification.read) {
            markReadMutation.mutate(notification._id);
        }
    };

    return (
        <Box>
            <IconButton
                id="notification-bell-button"
                aria-controls={open ? 'notification-bell-menu' : undefined}
                aria-haspopup="true"
                aria-expanded={open ? 'true' : undefined}
                aria-label={unreadCount > 0 ? `${unreadCount} unread notifications` : 'Notifications'}
                onClick={handleOpen}
                sx={{ color: '#fff' }}
            >
                <Badge badgeContent={unreadCount} color="error" max={99}>
                    <NotificationsNoneIcon fontSize="small" sx={{ color: '#fff' }} />
                </Badge>
            </IconButton>
            <Menu
                id="notification-bell-menu"
                MenuListProps={{ 'aria-labelledby': 'notification-bell-button', sx: { p: 0 } }}
                anchorEl={anchorEl}
                open={open}
                onClose={handleClose}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
                transformOrigin={{ vertical: 'top', horizontal: 'right' }}
                PaperProps={{ sx: { width: 380, maxHeight: 480 } }}
            >
                <Box px={2} py={1.5}>
                    <Typography variant="subtitle1" fontWeight={600}>
                        Notifications
                    </Typography>
                </Box>
                <Divider />
                {isLoading && (
                    <Box display="flex" justifyContent="center" p={3}>
                        <CircularProgress size={24} role="status" aria-label="Loading notifications" />
                    </Box>
                )}
                {isError && (
                    <Box p={2} role="alert">
                        <Typography color="error" variant="body2">
                            Couldn&apos;t load notifications.
                        </Typography>
                    </Box>
                )}
                {!isLoading && !isError && notifications.length === 0 && (
                    <EmptyState message="You're all caught up — no notifications yet." />
                )}
                {!isLoading &&
                    !isError &&
                    notifications.map((notification) => (
                        <MenuItem
                            key={notification._id}
                            onClick={() => handleItemClick(notification)}
                            disableRipple
                            sx={{
                                alignItems: 'flex-start',
                                whiteSpace: 'normal',
                                py: 1.25,
                                gap: 1,
                                backgroundColor: notification.read ? 'transparent' : 'action.hover'
                            }}
                        >
                            <Box mt={0.75} sx={{ minWidth: 10 }}>
                                {!notification.read && (
                                    <FiberManualRecordIcon
                                        sx={{ fontSize: 8, color: 'primary.main' }}
                                        titleAccess="Unread"
                                    />
                                )}
                            </Box>
                            <Box flex={1}>
                                <Typography variant="body2" fontWeight={notification.read ? 400 : 600}>
                                    {notification.message}
                                </Typography>
                                <Typography variant="caption" color="text.secondary">
                                    {timeAgo(notification.ts)}
                                </Typography>
                            </Box>
                        </MenuItem>
                    ))}
            </Menu>
        </Box>
    );
}
