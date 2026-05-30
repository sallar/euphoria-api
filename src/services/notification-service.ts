import type { SQL } from "drizzle-orm";

import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";

import type { Notification, PushToken } from "@/models/notification";

import {
  notification,
  notificationChannelValues,
  notificationDelivery,
  notificationTypeValues,
  userPushToken,
} from "@/db/notification-schema";
import { db } from "@/lib/db";

import { notificationSockets } from "./notification-sockets";

export type NotificationType = (typeof notificationTypeValues)[number];
export type NotificationChannel = (typeof notificationChannelValues)[number];

type NotificationRow = typeof notification.$inferSelect;
type PushTokenRow = typeof userPushToken.$inferSelect;

type CreateNotificationInput = {
  recipientUserId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  actorProfileId?: string | null;
  relatedProfileId?: string | null;
  channels?: NotificationChannel[];
};

const defaultNotificationChannels: NotificationChannel[] = ["in_app", "push"];
const defaultNotificationLimit = 20;
const maxNotificationLimit = 100;

const notificationFields = {
  id: notification.id,
  createdAt: notification.createdAt,
  updatedAt: notification.updatedAt,
  type: notification.type,
  title: notification.title,
  body: notification.body,
  data: notification.data,
  readAt: notification.readAt,
  archivedAt: notification.archivedAt,
  actorProfileId: notification.actorProfileId,
  relatedProfileId: notification.relatedProfileId,
};

const pushTokenFields = {
  id: userPushToken.id,
  provider: userPushToken.provider,
  token: userPushToken.token,
  platform: userPushToken.platform,
  deviceId: userPushToken.deviceId,
  enabled: userPushToken.enabled,
  lastRegisteredAt: userPushToken.lastRegisteredAt,
  disabledAt: userPushToken.disabledAt,
  createdAt: userPushToken.createdAt,
  updatedAt: userPushToken.updatedAt,
};

const toNotification = (
  row: Pick<NotificationRow, keyof typeof notificationFields>,
): Notification => ({
  ...row,
  data: row.data ?? {},
});

const toPushToken = (row: Pick<PushTokenRow, keyof typeof pushTokenFields>): PushToken => row;

export const normalizeNotificationLimit = (limit: number | undefined) =>
  Math.min(Math.max(Math.trunc(limit ?? defaultNotificationLimit), 1), maxNotificationLimit);

export const listNotifications = async ({
  cursor,
  limit,
  unreadOnly,
  userId,
}: {
  cursor?: string;
  limit?: number;
  unreadOnly?: boolean;
  userId: string;
}) => {
  const pageSize = normalizeNotificationLimit(limit);
  const conditions: SQL[] = [
    eq(notification.recipientUserId, userId),
    isNull(notification.archivedAt),
  ];

  if (cursor) conditions.push(lt(notification.createdAt, new Date(cursor)));
  if (unreadOnly) conditions.push(isNull(notification.readAt));

  const rows = await db
    .select(notificationFields)
    .from(notification)
    .where(and(...conditions))
    .orderBy(desc(notification.createdAt), desc(notification.id))
    .limit(pageSize + 1);

  const data = rows.slice(0, pageSize).map(toNotification);
  const next = rows[pageSize];

  return {
    data,
    cursor: next?.createdAt.toISOString() ?? null,
  };
};

export const getUnreadNotificationCount = async (userId: string) => {
  const [result] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notification)
    .where(
      and(
        eq(notification.recipientUserId, userId),
        isNull(notification.readAt),
        isNull(notification.archivedAt),
      ),
    );

  return Number(result?.count ?? 0);
};

export const broadcastUnreadNotificationCount = async (userId: string) => {
  const count = await getUnreadNotificationCount(userId);
  notificationSockets.sendToUser(userId, { type: "unread_count", count });
  return count;
};

export const markNotificationRead = async (userId: string, notificationId: string) => {
  const [updatedNotification] = await db
    .update(notification)
    .set({
      readAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(notification.id, notificationId),
        eq(notification.recipientUserId, userId),
        isNull(notification.archivedAt),
      ),
    )
    .returning(notificationFields);

  const readNotification = updatedNotification ? toNotification(updatedNotification) : null;
  if (readNotification) await broadcastUnreadNotificationCount(userId);

  return readNotification;
};

export const markAllNotificationsRead = async (userId: string) => {
  const updatedNotifications = await db
    .update(notification)
    .set({
      readAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(notification.recipientUserId, userId),
        isNull(notification.readAt),
        isNull(notification.archivedAt),
      ),
    )
    .returning({ id: notification.id });

  await broadcastUnreadNotificationCount(userId);
  return updatedNotifications.length;
};

export const archiveNotification = async (userId: string, notificationId: string) => {
  const [archivedNotification] = await db
    .update(notification)
    .set({
      archivedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(notification.id, notificationId),
        eq(notification.recipientUserId, userId),
        isNull(notification.archivedAt),
      ),
    )
    .returning({ id: notification.id, readAt: notification.readAt });

  if (archivedNotification && archivedNotification.readAt === null)
    await broadcastUnreadNotificationCount(userId);

  return Boolean(archivedNotification);
};

export const createNotification = async (input: CreateNotificationInput) => {
  const channels = input.channels?.length ? input.channels : defaultNotificationChannels;

  const { createdNotification, inAppDeliveryId } = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(notification)
      .values({
        recipientUserId: input.recipientUserId,
        type: input.type,
        title: input.title,
        body: input.body,
        data: input.data ?? {},
        actorProfileId: input.actorProfileId ?? null,
        relatedProfileId: input.relatedProfileId ?? null,
      })
      .returning(notificationFields);

    let liveDeliveryId: string | undefined;
    if (channels.includes("in_app")) {
      const [delivery] = await tx
        .insert(notificationDelivery)
        .values({
          notificationId: created.id,
          recipientUserId: input.recipientUserId,
          channel: "in_app",
          status: "pending",
        })
        .returning({ id: notificationDelivery.id });

      liveDeliveryId = delivery.id;
    }

    if (channels.includes("push")) {
      const tokens = await tx
        .select({ id: userPushToken.id })
        .from(userPushToken)
        .where(
          and(
            eq(userPushToken.userId, input.recipientUserId),
            eq(userPushToken.provider, "expo"),
            eq(userPushToken.enabled, true),
          ),
        );

      if (tokens.length) {
        await tx.insert(notificationDelivery).values(
          tokens.map(({ id }) => ({
            notificationId: created.id,
            recipientUserId: input.recipientUserId,
            channel: "push" as const,
            status: "pending" as const,
            provider: "expo" as const,
            pushTokenId: id,
          })),
        );
      }
    }

    return {
      createdNotification: toNotification(created),
      inAppDeliveryId: liveDeliveryId,
    };
  });

  if (channels.includes("in_app")) {
    const sentConnections = notificationSockets.sendToUser(input.recipientUserId, {
      type: "notification",
      notification: createdNotification,
    });

    await broadcastUnreadNotificationCount(input.recipientUserId);

    if (inAppDeliveryId) {
      await db
        .update(notificationDelivery)
        .set({
          status: sentConnections > 0 ? "delivered" : "skipped",
          deliveredAt: sentConnections > 0 ? new Date() : null,
          updatedAt: new Date(),
        })
        .where(eq(notificationDelivery.id, inAppDeliveryId));
    }
  }

  return createdNotification;
};

export const listPushTokens = async (userId: string) => {
  const tokens = await db
    .select(pushTokenFields)
    .from(userPushToken)
    .where(and(eq(userPushToken.userId, userId), eq(userPushToken.enabled, true)))
    .orderBy(desc(userPushToken.lastRegisteredAt));

  return tokens.map(toPushToken);
};

export const registerPushToken = async ({
  deviceId,
  platform,
  token,
  userId,
}: {
  deviceId?: string | null;
  platform: PushToken["platform"];
  token: string;
  userId: string;
}) => {
  const now = new Date();
  const [registeredToken] = await db
    .insert(userPushToken)
    .values({
      userId,
      provider: "expo",
      token,
      platform,
      deviceId: deviceId ?? null,
      enabled: true,
      lastRegisteredAt: now,
      disabledAt: null,
    })
    .onConflictDoUpdate({
      target: [userPushToken.provider, userPushToken.token],
      set: {
        userId,
        platform,
        deviceId: deviceId ?? null,
        enabled: true,
        disabledAt: null,
        lastRegisteredAt: now,
        updatedAt: now,
      },
    })
    .returning(pushTokenFields);

  return toPushToken(registeredToken);
};

export const disablePushToken = async (userId: string, pushTokenId: string) => {
  const [disabledToken] = await db
    .update(userPushToken)
    .set({
      enabled: false,
      disabledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(userPushToken.id, pushTokenId), eq(userPushToken.userId, userId)))
    .returning({ id: userPushToken.id });

  return Boolean(disabledToken);
};
