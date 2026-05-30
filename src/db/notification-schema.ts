import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

import { user } from "./auth-schema";
import { profile } from "./profile-schema";

export const notificationTypeValues = [
  "profile_like",
  "profile_match",
  "message",
  "system",
] as const;
export const notificationChannelValues = ["in_app", "push"] as const;
export const notificationDeliveryStatusValues = [
  "pending",
  "delivered",
  "failed",
  "skipped",
] as const;
export const pushProviderValues = ["expo"] as const;
export const devicePlatformValues = ["ios", "android", "web"] as const;

export const notificationTypeEnum = pgEnum("notification_type", notificationTypeValues);
export const notificationChannelEnum = pgEnum("notification_channel", notificationChannelValues);
export const notificationDeliveryStatusEnum = pgEnum(
  "notification_delivery_status",
  notificationDeliveryStatusValues,
);
export const pushProviderEnum = pgEnum("push_provider", pushProviderValues);
export const devicePlatformEnum = pgEnum("device_platform", devicePlatformValues);

export const notification = pgTable(
  "notification",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    recipientUserId: text("recipient_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    actorProfileId: uuid("actor_profile_id").references(() => profile.id, {
      onDelete: "set null",
    }),
    relatedProfileId: uuid("related_profile_id").references(() => profile.id, {
      onDelete: "set null",
    }),
    type: notificationTypeEnum("type").notNull(),
    title: varchar("title", { length: 140 }).notNull(),
    body: text("body").notNull(),
    data: jsonb("data")
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("notification_recipient_created_at_idx").on(
      table.recipientUserId,
      table.createdAt.desc(),
    ),
    index("notification_recipient_unread_idx")
      .on(table.recipientUserId, table.createdAt.desc())
      .where(sql`${table.readAt} is null and ${table.archivedAt} is null`),
    index("notification_type_idx").on(table.type),
    index("notification_actor_profile_id_idx").on(table.actorProfileId),
    index("notification_related_profile_id_idx").on(table.relatedProfileId),
  ],
);

export const userPushToken = pgTable(
  "user_push_token",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    provider: pushProviderEnum("provider").default("expo").notNull(),
    token: text("token").notNull(),
    platform: devicePlatformEnum("platform").notNull(),
    deviceId: text("device_id"),
    enabled: boolean("enabled").default(true).notNull(),
    lastRegisteredAt: timestamp("last_registered_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("user_push_token_provider_token_unique_idx").on(table.provider, table.token),
    index("user_push_token_user_enabled_idx").on(table.userId, table.enabled),
  ],
);

export const notificationDelivery = pgTable(
  "notification_delivery",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    notificationId: uuid("notification_id")
      .notNull()
      .references(() => notification.id, { onDelete: "cascade" }),
    recipientUserId: text("recipient_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    channel: notificationChannelEnum("channel").notNull(),
    status: notificationDeliveryStatusEnum("status").default("pending").notNull(),
    provider: pushProviderEnum("provider"),
    pushTokenId: uuid("push_token_id").references(() => userPushToken.id, {
      onDelete: "set null",
    }),
    attemptCount: integer("attempt_count").default(0).notNull(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("notification_delivery_notification_id_idx").on(table.notificationId),
    index("notification_delivery_recipient_created_at_idx").on(
      table.recipientUserId,
      table.createdAt.desc(),
    ),
    index("notification_delivery_queue_idx").on(
      table.channel,
      table.status,
      table.nextAttemptAt,
      table.createdAt,
    ),
    index("notification_delivery_push_token_id_idx").on(table.pushTokenId),
  ],
);
