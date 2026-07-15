import Elysia, { t } from "elysia";

import {
  devicePlatformRef,
  enumModel,
  notificationChannelRef,
  notificationDeliveryStatusRef,
  notificationTypeRef,
  pushProviderRef,
} from "./enums";
import { ref } from "./utils";

const notificationData = t.Record(t.String(), t.Any());
const uuid = t.String({ format: "uuid" });

const Notification = t.Object({
  id: uuid,
  createdAt: t.Date(),
  updatedAt: t.Date(),
  type: notificationTypeRef,
  title: t.String(),
  body: t.String(),
  data: notificationData,
  readAt: t.Nullable(t.Date()),
  archivedAt: t.Nullable(t.Date()),
  actorProfileId: t.Nullable(uuid),
  relatedProfileId: t.Nullable(uuid),
});

const NotificationListResponse = t.Object({
  data: t.Array(ref("Notification")),
  cursor: t.Nullable(t.String({ format: "date-time" })),
});

const NotificationUnreadCount = t.Object({
  count: t.Integer({ minimum: 0 }),
});

const NotificationDelivery = t.Object({
  id: uuid,
  notificationId: uuid,
  channel: notificationChannelRef,
  status: notificationDeliveryStatusRef,
  provider: t.Nullable(pushProviderRef),
  pushTokenId: t.Nullable(uuid),
  attemptCount: t.Integer({ minimum: 0 }),
  lastAttemptAt: t.Nullable(t.Date()),
  nextAttemptAt: t.Nullable(t.Date()),
  deliveredAt: t.Nullable(t.Date()),
  failedAt: t.Nullable(t.Date()),
  error: t.Nullable(t.String()),
  createdAt: t.Date(),
  updatedAt: t.Date(),
});

const NotificationReadAllResponse = t.Object({
  count: t.Integer({ minimum: 0 }),
});

const PushToken = t.Object({
  id: uuid,
  provider: pushProviderRef,
  token: t.String(),
  platform: devicePlatformRef,
  deviceId: t.Nullable(t.String()),
  enabled: t.Boolean(),
  lastRegisteredAt: t.Date(),
  disabledAt: t.Nullable(t.Date()),
  createdAt: t.Date(),
  updatedAt: t.Date(),
});

const PushTokenInsert = t.Object({
  token: t.String({ minLength: 1 }),
  platform: devicePlatformRef,
  deviceId: t.Optional(t.String()),
});

const NotificationSocketMessage = t.Union([
  t.Object({
    type: t.Literal("ping"),
  }),
  t.Object({
    type: t.Literal("mark_read"),
    notificationId: uuid,
  }),
  t.Object({
    type: t.Literal("mark_all_read"),
  }),
]);

const NotificationSocketEvent = t.Union([
  t.Object({
    type: t.Literal("connected"),
    unreadCount: t.Integer({ minimum: 0 }),
  }),
  t.Object({
    type: t.Literal("notification"),
    notification: ref("Notification"),
  }),
  t.Object({
    type: t.Literal("unread_count"),
    count: t.Integer({ minimum: 0 }),
  }),
  t.Object({
    type: t.Literal("notification_read"),
    notification: t.Nullable(ref("Notification")),
  }),
  t.Object({
    type: t.Literal("notifications_read"),
    count: t.Integer({ minimum: 0 }),
  }),
  t.Object({
    type: t.Literal("pong"),
  }),
]);

export type Notification = typeof Notification.static;
export type NotificationDelivery = typeof NotificationDelivery.static;
export type NotificationListResponse = typeof NotificationListResponse.static;
export type NotificationSocketEvent = typeof NotificationSocketEvent.static;
export type NotificationSocketMessage = typeof NotificationSocketMessage.static;
export type PushToken = typeof PushToken.static;

export const notificationModel = new Elysia({ name: "notification-model" }).use(enumModel).model({
  Notification,
  NotificationDelivery,
  NotificationListResponse,
  NotificationReadAllResponse,
  NotificationSocketEvent,
  NotificationSocketMessage,
  NotificationUnreadCount,
  PushToken,
  PushTokenInsert,
});
