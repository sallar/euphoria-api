import Elysia, { t } from "elysia";

import {
  apnsEnvironmentSchema,
  devicePlatformSchema,
  notificationChannelSchema,
  notificationDeliveryStatusSchema,
  notificationTypeSchema,
  pushProviderSchema,
} from "./enums";
import {
  REALTIME_PROTOCOL_VERSION,
  realtimeSchemas,
  type RealtimeSchemaVariant,
  realtimeUnion,
} from "./realtime";

const uuid = t.String({ format: "uuid" });

export const NotificationData = t.Record(t.String(), t.Any());

export const Notification = t.Object({
  id: uuid,
  createdAt: t.Date(),
  updatedAt: t.Date(),
  type: notificationTypeSchema,
  title: t.String(),
  body: t.String(),
  data: NotificationData,
  readAt: t.Nullable(t.Date()),
  archivedAt: t.Nullable(t.Date()),
  actorProfileId: t.Nullable(uuid),
  relatedProfileId: t.Nullable(uuid),
});

const NotificationListResponse = t.Object({
  data: t.Array(Notification),
  cursor: t.Nullable(t.String({ format: "date-time" })),
});

const NotificationUnreadCount = t.Object({
  count: t.Integer({ minimum: 0 }),
});

const NotificationDelivery = t.Object({
  id: uuid,
  notificationId: uuid,
  channel: notificationChannelSchema,
  status: notificationDeliveryStatusSchema,
  provider: t.Nullable(pushProviderSchema),
  apnsEnvironment: t.Nullable(apnsEnvironmentSchema),
  pushTokenId: t.Nullable(uuid),
  attemptCount: t.Integer({ minimum: 0 }),
  lastAttemptAt: t.Nullable(t.Date()),
  nextAttemptAt: t.Nullable(t.Date()),
  deliveredAt: t.Nullable(t.Date()),
  failedAt: t.Nullable(t.Date()),
  error: t.Nullable(t.String()),
  providerMetadata: t.Nullable(t.Record(t.String(), t.Union([t.String(), t.Number(), t.Null()]))),
  createdAt: t.Date(),
  updatedAt: t.Date(),
});

const NotificationReadAllResponse = t.Object({
  count: t.Integer({ minimum: 0 }),
});

export const PushToken = t.Object({
  id: uuid,
  provider: pushProviderSchema,
  apnsEnvironment: t.Nullable(apnsEnvironmentSchema),
  platform: devicePlatformSchema,
  deviceId: t.Nullable(t.String()),
  enabled: t.Boolean(),
  lastRegisteredAt: t.Date(),
  disabledAt: t.Nullable(t.Date()),
  createdAt: t.Date(),
  updatedAt: t.Date(),
});

export const PushTokenInsert = t.Union([
  t.Object({
    provider: t.Optional(t.Literal("expo")),
    token: t.String({ minLength: 1 }),
    platform: devicePlatformSchema,
    deviceId: t.Optional(t.String()),
  }),
  t.Object({
    provider: t.Literal("apns"),
    apnsEnvironment: apnsEnvironmentSchema,
    token: t.String({ pattern: "^([0-9A-Fa-f]{2})+$" }),
    platform: t.Literal("ios"),
    deviceId: t.String({ minLength: 1, pattern: ".*\\S.*" }),
  }),
]);

export const NotificationPingCommand = t.Object(
  {
    type: t.Literal("ping"),
  },
  { description: "Application-level heartbeat request." },
);

export const NotificationMarkReadCommand = t.Object(
  {
    type: t.Literal("mark_read"),
    notificationId: uuid,
  },
  { description: "Marks one notification as read." },
);

export const NotificationMarkAllReadCommand = t.Object(
  {
    type: t.Literal("mark_all_read"),
  },
  { description: "Marks all current notifications as read." },
);

export const NotificationConnectedEvent = t.Object(
  {
    type: t.Literal("connected"),
    unreadCount: t.Integer({ minimum: 0 }),
    protocolVersion: t.Literal(REALTIME_PROTOCOL_VERSION, {
      description:
        "Realtime wire protocol version. Clients must stop processing an unsupported version.",
    }),
  },
  { description: "Confirms the notification socket, unread count, and protocol version." },
);

export const NotificationCreatedEvent = t.Object(
  {
    type: t.Literal("notification"),
    notification: Notification,
  },
  { description: "Delivers a newly created canonical notification." },
);

export const NotificationUnreadCountEvent = t.Object(
  {
    type: t.Literal("unread_count"),
    count: t.Integer({ minimum: 0 }),
  },
  { description: "Reports the current unread notification count." },
);

export const NotificationReadEvent = t.Object(
  {
    type: t.Literal("notification_read"),
    notification: t.Nullable(Notification),
  },
  {
    description:
      "Reports the notification after a mark-read command, or null when no accessible notification matched.",
  },
);

export const NotificationReadAllEvent = t.Object(
  {
    type: t.Literal("notifications_read"),
    count: t.Integer({ minimum: 0 }),
  },
  { description: "Reports how many notifications were marked read." },
);

export const NotificationPongEvent = t.Object(
  {
    type: t.Literal("pong"),
  },
  { description: "Acknowledges an application-level heartbeat request." },
);

const exampleIds = {
  notification: "00000000-0000-4000-8000-000000000011",
  actorProfile: "00000000-0000-4000-8000-000000000012",
  relatedProfile: "00000000-0000-4000-8000-000000000013",
  conversation: "00000000-0000-4000-8000-000000000014",
} as const;
const exampleTimestamp = "2026-07-16T12:00:00.000Z";
const exampleNotification = {
  id: exampleIds.notification,
  createdAt: exampleTimestamp,
  updatedAt: exampleTimestamp,
  type: "message",
  title: "New message from Alex",
  body: "See you tonight!",
  data: { conversationId: exampleIds.conversation },
  readAt: null,
  archivedAt: null,
  actorProfileId: exampleIds.actorProfile,
  relatedProfileId: exampleIds.relatedProfile,
};

export const notificationClientCommandRegistry = [
  {
    name: "NotificationPingCommand",
    wireType: "ping",
    schema: NotificationPingCommand,
    summary: "Ping the notification socket",
    description: "The mobile client sends an application-level heartbeat request.",
    example: { type: "ping" },
  },
  {
    name: "NotificationMarkReadCommand",
    wireType: "mark_read",
    schema: NotificationMarkReadCommand,
    summary: "Mark one notification read",
    description: "Marks one accessible notification as read.",
    example: { type: "mark_read", notificationId: exampleIds.notification },
  },
  {
    name: "NotificationMarkAllReadCommand",
    wireType: "mark_all_read",
    schema: NotificationMarkAllReadCommand,
    summary: "Mark all notifications read",
    description: "Marks every current accessible notification as read.",
    example: { type: "mark_all_read" },
  },
] as const satisfies readonly RealtimeSchemaVariant[];

export const notificationServerEventRegistry = [
  {
    name: "NotificationConnectedEvent",
    wireType: "connected",
    schema: NotificationConnectedEvent,
    summary: "Notification socket connected",
    description: "Confirms the current unread count and realtime protocol version.",
    example: { type: "connected", unreadCount: 2, protocolVersion: REALTIME_PROTOCOL_VERSION },
  },
  {
    name: "NotificationCreatedEvent",
    wireType: "notification",
    schema: NotificationCreatedEvent,
    summary: "Notification created",
    description: "Carries a newly created canonical notification.",
    example: { type: "notification", notification: exampleNotification },
  },
  {
    name: "NotificationUnreadCountEvent",
    wireType: "unread_count",
    schema: NotificationUnreadCountEvent,
    summary: "Unread count changed",
    description: "Carries the current canonical unread notification count.",
    example: { type: "unread_count", count: 2 },
  },
  {
    name: "NotificationReadEvent",
    wireType: "notification_read",
    schema: NotificationReadEvent,
    summary: "Notification marked read",
    description: "Carries the updated notification when the requested notification exists.",
    example: {
      type: "notification_read",
      notification: { ...exampleNotification, readAt: exampleTimestamp },
    },
  },
  {
    name: "NotificationReadAllEvent",
    wireType: "notifications_read",
    schema: NotificationReadAllEvent,
    summary: "All notifications marked read",
    description: "Carries the number of notifications changed by the command.",
    example: { type: "notifications_read", count: 2 },
  },
  {
    name: "NotificationPongEvent",
    wireType: "pong",
    schema: NotificationPongEvent,
    summary: "Notification heartbeat acknowledged",
    description: "Acknowledges a notification ping command.",
    example: { type: "pong" },
  },
] as const satisfies readonly RealtimeSchemaVariant[];

export const NotificationClientCommand = realtimeUnion(notificationClientCommandRegistry);
export const NotificationServerEvent = realtimeUnion(notificationServerEventRegistry);

export type Notification = typeof Notification.static;
export type NotificationClientCommand = typeof NotificationClientCommand.static;
export type NotificationDelivery = typeof NotificationDelivery.static;
export type NotificationListResponse = typeof NotificationListResponse.static;
export type NotificationServerEvent = typeof NotificationServerEvent.static;
export type PushToken = typeof PushToken.static;
export type PushTokenInsert = typeof PushTokenInsert.static;

export const notificationModel = new Elysia({ name: "notification-model" }).model({
  Notification,
  NotificationData,
  NotificationDelivery,
  NotificationListResponse,
  NotificationReadAllResponse,
  NotificationUnreadCount,
  PushToken,
  PushTokenInsert,
  ...realtimeSchemas(notificationClientCommandRegistry, notificationServerEventRegistry),
  NotificationClientCommand,
  NotificationServerEvent,
});
