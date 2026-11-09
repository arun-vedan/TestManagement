import axiosPrivate from './axios';

// WP-031 — notificationService frontend client. A *new* module, per the
// pattern WP-011/WP-014/WP-020/WP-025/WP-032 established (linkApi.ts,
// testPlanApi.ts, projectApi.ts, releaseApi.ts, apiKeyApi.ts) — apiCalls.tsx
// is off-limits (WP-015 rewrote it wholesale; every later WP's own note
// repeats this).
//
// Backed by backend/notificationService's /api/v1/notifications routes
// (see routes/notifications.js, controllers/notifications.js), reached
// through Kong like every other route this app already calls via
// axiosPrivate (api/axios.tsx already attaches the bearer token and the
// X-Project-Id header automatically -- no per-call header wiring needed
// here, unlike apiKeyApi.ts's manage_project-gated routes).
//
// Response shapes below are read directly off the committed controller,
// not assumed:
//   GET   /api/v1/notifications             -> { success, count, unreadCount, data: Notification[] }
//   PATCH /api/v1/notifications/:id/read     -> { success, data: Notification }
//
// A notification is per-user by construction (models/Notification.js's
// header comment) and every query is scoped to the CALLING token's own
// `sub` server-side -- there is no client-supplied userId anywhere in this
// module, matching the backend's own "never trust a client-supplied
// identity" convention (WP-020b).

export type NotificationType = 'execution-completed' | 'defect-assigned' | 'status-review';

export interface NotificationEntityRef {
    entityType: string;
    entityId: string;
}

export interface AppNotification {
    _id: string;
    userId: string;
    projectId?: number;
    type: NotificationType;
    message: string;
    entityRef: NotificationEntityRef;
    read: boolean;
    ts: string;
    correlationId?: string;
    sourceEventId?: string;
    createdAt: string;
    updatedAt: string;
}

export interface NotificationListResult {
    data: AppNotification[];
    count: number;
    unreadCount: number;
}

const NOTIFICATIONS_BASE = '/api/v1/notifications';

export const getNotifications = async (unreadOnly = false): Promise<NotificationListResult> => {
    const resp = await axiosPrivate.get(NOTIFICATIONS_BASE, {
        params: unreadOnly ? { unreadOnly: 'true' } : undefined
    });
    return { data: resp.data.data, count: resp.data.count, unreadCount: resp.data.unreadCount };
};

export const markNotificationRead = async (id: string): Promise<AppNotification> => {
    const resp = await axiosPrivate.patch(`${NOTIFICATIONS_BASE}/${id}/read`);
    return resp.data.data;
};
