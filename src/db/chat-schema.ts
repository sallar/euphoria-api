import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { profile } from "./profile-schema";

export const chatMessageTypeValues = ["text", "image"] as const;

export const chatMessageTypeEnum = pgEnum("chat_message_type", chatMessageTypeValues);

export type ChatMessageAttachment = {
  type: "image";
  url: string;
  mimeType?: string;
  width?: number;
  height?: number;
};

export const chatConversation = pgTable(
  "chat_conversation",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    profileOneId: uuid("profile_one_id")
      .notNull()
      .references(() => profile.id, { onDelete: "cascade" }),
    profileTwoId: uuid("profile_two_id")
      .notNull()
      .references(() => profile.id, { onDelete: "cascade" }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex("chat_conversation_profile_pair_unique_idx").on(
      table.profileOneId,
      table.profileTwoId,
    ),
    check(
      "chat_conversation_profile_order_check",
      sql`${table.profileOneId} < ${table.profileTwoId}`,
    ),
    index("chat_conversation_profile_one_idx").on(
      table.profileOneId,
      table.lastMessageAt.desc(),
      table.createdAt.desc(),
    ),
    index("chat_conversation_profile_two_idx").on(
      table.profileTwoId,
      table.lastMessageAt.desc(),
      table.createdAt.desc(),
    ),
  ],
);

export const chatMessage = pgTable(
  "chat_message",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => chatConversation.id, { onDelete: "cascade" }),
    senderProfileId: uuid("sender_profile_id").references(() => profile.id, {
      onDelete: "set null",
    }),
    messageType: chatMessageTypeEnum("message_type").default("text").notNull(),
    content: text("content"),
    attachments: jsonb("attachments")
      .$type<ChatMessageAttachment[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    replyToMessageId: uuid("reply_to_message_id").references((): AnyPgColumn => chatMessage.id, {
      onDelete: "set null",
    }),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    check(
      "chat_message_text_content_check",
      sql`${table.messageType} <> 'text' or length(btrim(coalesce(${table.content}, ''))) > 0`,
    ),
    check(
      "chat_message_reply_not_self_check",
      sql`${table.replyToMessageId} is null or ${table.replyToMessageId} <> ${table.id}`,
    ),
    index("chat_message_conversation_created_at_idx").on(
      table.conversationId,
      table.createdAt.desc(),
      table.id.desc(),
    ),
    index("chat_message_sender_profile_id_idx").on(table.senderProfileId),
    index("chat_message_reply_to_message_id_idx").on(table.replyToMessageId),
  ],
);

export const chatMessageReaction = pgTable(
  "chat_message_reaction",
  {
    messageId: uuid("message_id")
      .notNull()
      .references(() => chatMessage.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profile.id, { onDelete: "cascade" }),
    emoji: varchar("emoji", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.messageId, table.profileId, table.emoji] }),
    check("chat_message_reaction_emoji_not_blank_check", sql`length(btrim(${table.emoji})) > 0`),
    index("chat_message_reaction_profile_id_idx").on(table.profileId),
    index("chat_message_reaction_emoji_idx").on(table.emoji),
  ],
);

export const chatConversationReadState = pgTable(
  "chat_conversation_read_state",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => chatConversation.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id")
      .notNull()
      .references(() => profile.id, { onDelete: "cascade" }),
    lastReadMessageId: uuid("last_read_message_id").references(() => chatMessage.id, {
      onDelete: "set null",
    }),
    lastReadAt: timestamp("last_read_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.profileId] }),
    index("chat_conversation_read_state_profile_idx").on(table.profileId, table.updatedAt.desc()),
    index("chat_conversation_read_state_last_read_message_idx").on(table.lastReadMessageId),
  ],
);
