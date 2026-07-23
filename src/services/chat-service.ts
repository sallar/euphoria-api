import type { SQL } from "drizzle-orm";

import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";

import type { DurableJsonObject } from "@/db/durable-schema";
import type {
  ChatConversation,
  ChatMessage,
  ChatMessageReplySummary,
  ChatMessageReactionCount,
  ChatParticipantReadPosition,
  ChatProfileSummary,
} from "@/models/chat";
import type { Notification } from "@/models/notification";

import {
  CHAT_MESSAGE_SEND_COMMAND_NAME,
  CHAT_MESSAGE_SEND_COMMAND_VERSION,
  CHAT_MESSAGE_SEND_RESULT_VERSION,
  CHAT_EVENT_VERSION,
  type TransactionalChatPolicy,
  NOTIFICATION_PUSH_DELIVERY_JOB_KIND,
  NOTIFICATION_PUSH_DELIVERY_JOB_VERSION,
} from "@/config/transactional-chat-policy";
import { user } from "@/db/auth-schema";
import {
  chatConversation,
  chatConversationReadState,
  chatMessage,
  chatMessageReaction,
} from "@/db/chat-schema";
import { notification, notificationDelivery, userPushToken } from "@/db/notification-schema";
import { profile, profileReaction, profileReactionValues, profileUser } from "@/db/profile-schema";
import { decodeCursor, encodeCursor } from "@/lib/cursor";
import { db } from "@/lib/db";
import { findActiveProfileMembership } from "@/lib/profile-queries";

import { chatSockets } from "./chat-sockets";
import {
  type CommandOutcome,
  type DatabaseTransaction,
  runIdempotentCommand,
} from "./command-idempotency-service";
import { enqueueDeliveryJobInTransaction } from "./delivery-job-service";
import {
  appendDurableEventsInTransaction,
  createDurableEventCausalId,
  type DurableEventInput,
} from "./durable-event-service";
import { createNotification } from "./notification-service";
import { notificationSockets } from "./notification-sockets";

type ProfileReaction = (typeof profileReactionValues)[number];
type ChatServiceErrorCode =
  | "conversation_not_found"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "invalid_message"
  | "invalid_reaction"
  | "invalid_reply_target"
  | "message_not_found"
  | "conversation_not_matched"
  | "profile_not_found";

type ChatServiceResult<Value> =
  | {
      ok: true;
      data: Value;
    }
  | {
      ok: false;
      code: ChatServiceErrorCode;
      message: string;
    };

type ConversationAccess = {
  conversation: ConversationRow;
  otherProfileId: string;
};

type SendMessageRejectedResult = {
  version: typeof CHAT_MESSAGE_SEND_RESULT_VERSION;
  status: "rejected";
  httpStatus: 404 | 409 | 422;
  error: {
    code: "conversation_not_found" | "conversation_not_matched" | "invalid_reply_target";
    message: string;
  };
};

type SendMessageSucceededResult = {
  version: typeof CHAT_MESSAGE_SEND_RESULT_VERSION;
  status: "succeeded";
  message: DurableChatMessage;
};

type StoredSendMessageResult = SendMessageRejectedResult | SendMessageSucceededResult;

export type SendTextMessageResult =
  | {
      ok: true;
      data: ChatMessage;
      replayed: boolean;
    }
  | {
      ok: false;
      code:
        | "conversation_not_found"
        | "conversation_not_matched"
        | "idempotency_conflict"
        | "idempotency_in_progress"
        | "idempotency_key_required"
        | "invalid_message"
        | "invalid_idempotency_key"
        | "invalid_reply_target";
      message: string;
      httpStatus: 400 | 404 | 409 | 422;
      replayed?: boolean;
      terminalCommandResult?: boolean;
    };

export type ChatTransactionFailurePoint =
  | "after_idempotency_claim"
  | "after_authorization"
  | "after_common_lock"
  | "after_match_validation"
  | "after_reply_validation"
  | "after_message_insert"
  | "after_sender_read"
  | "after_conversation_projection"
  | "after_notification_state"
  | "after_durable_events"
  | "after_delivery_jobs"
  | "before_idempotency_outcome"
  | "after_idempotency_outcome";

export type ChatTransactionFailureInjector = (
  point: ChatTransactionFailurePoint,
) => Promise<void> | void;

type RawConversationRow = {
  id: string;
  profileOneId: string;
  profileTwoId: string;
  matchedProfileId: string;
  matchedProfileName: string;
  matchedProfileType: ChatProfileSummary["profileType"];
  isMatched: boolean;
  lastMessageAt: Date | null;
  lastMessageId: string | null;
  lastMessageSenderProfileId: string | null;
  lastMessageType: ChatMessage["messageType"] | null;
  lastMessageContent: string | null;
  lastMessageCreatedAt: Date | null;
  readStateLastReadMessageId: string | null;
  readStateLastReadAt: Date | null;
  unreadCount: number;
  firstUnreadMessageId: string | null;
  firstUnreadMessageCreatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  sortAt: Date;
  cursorSortAtMicros: string;
};

const defaultConversationLimit = 20;
const defaultMessageLimit = 30;
const maxPageLimit = 100;
const canonicalMessageIdempotencyKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const isCanonicalMessageIdempotencyKey = (value: string) =>
  canonicalMessageIdempotencyKeyPattern.test(value);

const conversationFields = {
  id: chatConversation.id,
  profileOneId: chatConversation.profileOneId,
  profileTwoId: chatConversation.profileTwoId,
  lastMessageAt: chatConversation.lastMessageAt,
  createdAt: chatConversation.createdAt,
  updatedAt: chatConversation.updatedAt,
};

const messageFields = {
  id: chatMessage.id,
  conversationId: chatMessage.conversationId,
  senderProfileId: chatMessage.senderProfileId,
  messageType: chatMessage.messageType,
  content: chatMessage.content,
  attachments: chatMessage.attachments,
  replyToMessageId: chatMessage.replyToMessageId,
  replySummary: chatMessage.replySummary,
  editedAt: chatMessage.editedAt,
  deletedAt: chatMessage.deletedAt,
  createdAt: chatMessage.createdAt,
  updatedAt: chatMessage.updatedAt,
};

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

type ChatMessageRow = Pick<typeof chatMessage.$inferSelect, keyof typeof messageFields>;
type ConversationRow = Pick<typeof chatConversation.$inferSelect, keyof typeof conversationFields>;
type DurableChatMessage = Omit<
  ChatMessage,
  "createdAt" | "deletedAt" | "editedAt" | "updatedAt"
> & {
  createdAt: string;
  deletedAt: string | null;
  editedAt: string | null;
  updatedAt: string;
};

type DurableNotification = Omit<
  Notification,
  "archivedAt" | "createdAt" | "readAt" | "updatedAt"
> & {
  archivedAt: string | null;
  createdAt: string;
  readAt: string | null;
  updatedAt: string;
};

const toDurableChatMessage = (message: ChatMessage): DurableChatMessage => ({
  ...message,
  createdAt: message.createdAt.toISOString(),
  deletedAt: message.deletedAt?.toISOString() ?? null,
  editedAt: message.editedAt?.toISOString() ?? null,
  updatedAt: message.updatedAt.toISOString(),
});

const fromDurableChatMessage = (message: DurableChatMessage): ChatMessage => ({
  ...message,
  createdAt: new Date(message.createdAt),
  deletedAt: message.deletedAt ? new Date(message.deletedAt) : null,
  editedAt: message.editedAt ? new Date(message.editedAt) : null,
  updatedAt: new Date(message.updatedAt),
});

const toDurableNotification = (value: Notification): DurableNotification => ({
  ...value,
  archivedAt: value.archivedAt?.toISOString() ?? null,
  createdAt: value.createdAt.toISOString(),
  readAt: value.readAt?.toISOString() ?? null,
  updatedAt: value.updatedAt.toISOString(),
});

const toNotification = (
  row: Pick<typeof notification.$inferSelect, keyof typeof notificationFields>,
): Notification => ({
  ...row,
  data: row.data ?? {},
});

const toDurableConversation = (conversation: ChatConversation) =>
  JSON.parse(JSON.stringify(conversation)) as DurableJsonObject;

const runFailureInjector = async (
  failureInjector: ChatTransactionFailureInjector | undefined,
  point: ChatTransactionFailurePoint,
) => {
  await failureInjector?.(point);
};

const normalizeLimit = (limit: number | undefined, fallback: number) =>
  Math.min(Math.max(Math.trunc(limit ?? fallback), 1), maxPageLimit);

const getProfilePair = (profileId: string, targetProfileId: string) =>
  profileId < targetProfileId
    ? { profileOneId: profileId, profileTwoId: targetProfileId }
    : { profileOneId: targetProfileId, profileTwoId: profileId };

const getOtherProfileId = (
  conversation: Pick<typeof chatConversation.$inferSelect, "profileOneId" | "profileTwoId">,
  profileId: string,
) =>
  conversation.profileOneId === profileId ? conversation.profileTwoId : conversation.profileOneId;

const lockProfilePairInTransaction = async ({
  profileId,
  targetProfileId,
  tx,
}: {
  profileId: string;
  targetProfileId: string;
  tx: DatabaseTransaction;
}) => {
  const pair = getProfilePair(profileId, targetProfileId);
  const key = `chat-profile-pair:${pair.profileOneId}:${pair.profileTwoId}`;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);

  const [conversation] = await tx
    .select(conversationFields)
    .from(chatConversation)
    .where(
      and(
        eq(chatConversation.profileOneId, pair.profileOneId),
        eq(chatConversation.profileTwoId, pair.profileTwoId),
      ),
    )
    .for("update")
    .limit(1);

  return { conversation: conversation ?? null, pair };
};

const findActiveProfileMembershipInTransaction = (
  tx: DatabaseTransaction,
  profileId: string,
  userId: string,
) =>
  tx
    .select({ profileId: profileUser.profileId })
    .from(profileUser)
    .innerJoin(profile, eq(profile.id, profileUser.profileId))
    .where(
      and(
        eq(profileUser.profileId, profileId),
        eq(profileUser.userId, userId),
        isNull(profile.deletedAt),
      ),
    )
    .limit(1);

const areProfilesMatchedInTransaction = async (
  tx: DatabaseTransaction,
  profileId: string,
  targetProfileId: string,
) => {
  const [result] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(profileReaction)
    .where(
      or(
        and(
          eq(profileReaction.profileId, profileId),
          eq(profileReaction.targetProfileId, targetProfileId),
          eq(profileReaction.reaction, "like"),
        ),
        and(
          eq(profileReaction.profileId, targetProfileId),
          eq(profileReaction.targetProfileId, profileId),
          eq(profileReaction.reaction, "like"),
        ),
      ),
    );

  return Number(result?.count ?? 0) === 2;
};

const getChatUnreadCountInTransaction = async (tx: ChatDatabaseExecutor, profileId: string) => {
  const [result] = (await tx.execute(sql`
    select count(*)::int as count
    from ${chatMessage} message
    inner join ${chatConversation} conversation
      on conversation.id = message.conversation_id
    left join ${chatConversationReadState} read_state
      on read_state.conversation_id = conversation.id
      and read_state.profile_id = ${profileId}
    where (
      conversation.profile_one_id = ${profileId}
      or conversation.profile_two_id = ${profileId}
    )
      and message.sender_profile_id is distinct from ${profileId}
      and (
        read_state.conversation_id is null
        or read_state.last_read_message_id is null
        or message.created_at > read_state.last_read_message_created_at
        or (
          message.created_at = read_state.last_read_message_created_at
          and message.id > read_state.last_read_message_id
        )
      )
  `)) as Array<{ count: number }>;

  return Number(result?.count ?? 0);
};

const advanceReadPositionInTransaction = async ({
  conversationId,
  message,
  profileId,
  tx,
}: {
  conversationId: string;
  message: { id: string };
  profileId: string;
  tx: DatabaseTransaction;
}) => {
  const messageCreatedAt = sql<Date>`(
    select ${chatMessage.createdAt}
    from ${chatMessage}
    where ${chatMessage.id} = ${message.id}
      and ${chatMessage.conversationId} = ${conversationId}
  )`;
  const [advanced] = await tx
    .insert(chatConversationReadState)
    .values({
      conversationId,
      profileId,
      lastReadMessageId: message.id,
      lastReadMessageCreatedAt: messageCreatedAt,
      lastReadAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .onConflictDoUpdate({
      target: [chatConversationReadState.conversationId, chatConversationReadState.profileId],
      set: {
        lastReadMessageId: sql`excluded.last_read_message_id`,
        lastReadMessageCreatedAt: sql`excluded.last_read_message_created_at`,
        lastReadAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      },
      setWhere: or(
        isNull(chatConversationReadState.lastReadMessageCreatedAt),
        sql`(
          ${chatConversationReadState.lastReadMessageCreatedAt},
          ${chatConversationReadState.lastReadMessageId}
        ) < (
          excluded.last_read_message_created_at,
          excluded.last_read_message_id
        )`,
      ),
    })
    .returning({
      profileId: chatConversationReadState.profileId,
      lastReadMessageId: chatConversationReadState.lastReadMessageId,
      lastReadMessageCreatedAt: chatConversationReadState.lastReadMessageCreatedAt,
      lastReadAt: chatConversationReadState.lastReadAt,
    });

  return advanced ?? null;
};

const boundTextByGraphemes = (text: string, maximum: number) => {
  const Segmenter = (
    Intl as unknown as {
      Segmenter: new (
        locale: undefined,
        options: { granularity: "grapheme" },
      ) => {
        segment: (value: string) => Iterable<{ segment: string }>;
      };
    }
  ).Segmenter;
  const segmenter = new Segmenter(undefined, { granularity: "grapheme" });
  const segments = segmenter.segment(text)[Symbol.iterator]();
  let preview = "";
  let count = 0;

  while (count < maximum) {
    const next = segments.next();
    if (next.done) return { text: preview, truncated: false };
    preview += next.value.segment;
    count += 1;
  }

  return {
    text: preview,
    truncated: !segments.next().done,
  };
};

const createReplySummary = (
  target: Pick<
    typeof chatMessage.$inferSelect,
    "content" | "id" | "messageType" | "senderProfileId"
  >,
): ChatMessageReplySummary => {
  const identity = {
    messageId: target.id,
    senderProfileId: target.senderProfileId,
    messageType: target.messageType,
  };

  if (target.messageType === "image") {
    return {
      ...identity,
      state: "available",
      preview: { kind: "image" },
    };
  }

  if (target.content === null) {
    return {
      ...identity,
      state: "unavailable",
    };
  }

  return {
    ...identity,
    state: "available",
    preview: {
      kind: "text",
      ...boundTextByGraphemes(target.content, 160),
    },
  };
};

const getUnreadNotificationCountInTransaction = async (tx: DatabaseTransaction, userId: string) => {
  const [result] = await tx
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

type CreatedMessageNotification = {
  notification: Notification;
  recipientUserId: string;
  unreadCount: number;
};

const createMessageNotificationStateInTransaction = async ({
  conversationId,
  message,
  recipientProfileId,
  senderProfileId,
  senderUserId,
  tx,
}: {
  conversationId: string;
  message: ChatMessage;
  recipientProfileId: string;
  senderProfileId: string;
  senderUserId: string;
  tx: DatabaseTransaction;
}) => {
  const [sender] = await tx
    .select({ name: profile.name })
    .from(profile)
    .where(eq(profile.id, senderProfileId))
    .limit(1);
  const recipients = await tx
    .select({ userId: profileUser.userId })
    .from(profileUser)
    .where(
      and(
        eq(profileUser.profileId, recipientProfileId),
        sql`${profileUser.userId} <> ${senderUserId}`,
      ),
    )
    .orderBy(profileUser.userId);

  const senderName = sender?.name ?? "Someone";
  const notificationPreview = boundTextByGraphemes(message.content ?? "Sent a message", 120);
  const body = notificationPreview.truncated
    ? `${notificationPreview.text.slice(0, -3)}...`
    : notificationPreview.text;
  const createdNotifications: CreatedMessageNotification[] = [];
  const pushDeliveryIds: string[] = [];

  for (const recipient of recipients) {
    const [createdRow] = await tx
      .insert(notification)
      .values({
        recipientUserId: recipient.userId,
        type: "message",
        title: `New message from ${senderName}`,
        body,
        actorProfileId: senderProfileId,
        relatedProfileId: recipientProfileId,
        data: {
          conversationId,
          messageId: message.id,
          senderProfileId,
          recipientProfileId,
          messageType: message.messageType,
        },
      })
      .returning(notificationFields);
    const created = toNotification(createdRow);

    const tokens = await tx
      .select({
        id: userPushToken.id,
        provider: userPushToken.provider,
        apnsEnvironment: userPushToken.apnsEnvironment,
      })
      .from(userPushToken)
      .where(and(eq(userPushToken.userId, recipient.userId), eq(userPushToken.enabled, true)))
      .orderBy(userPushToken.id);

    if (tokens.length) {
      const deliveries = await tx
        .insert(notificationDelivery)
        .values(
          tokens.map((token) => ({
            notificationId: created.id,
            recipientUserId: recipient.userId,
            channel: "push" as const,
            status: "pending" as const,
            provider: token.provider,
            apnsEnvironment: token.apnsEnvironment,
            pushTokenId: token.id,
          })),
        )
        .returning({ id: notificationDelivery.id });
      pushDeliveryIds.push(...deliveries.map(({ id }) => id));
    }

    createdNotifications.push({
      notification: created,
      recipientUserId: recipient.userId,
      unreadCount: await getUnreadNotificationCountInTransaction(tx, recipient.userId),
    });
  }

  return {
    createdNotifications,
    pushDeliveryIds,
  };
};

const enqueueMessagePushJobsInTransaction = async ({
  deliveryIds,
  policy,
  tx,
}: {
  deliveryIds: string[];
  policy: TransactionalChatPolicy;
  tx: DatabaseTransaction;
}) => {
  for (const notificationDeliveryId of deliveryIds) {
    await enqueueDeliveryJobInTransaction({
      availableInSeconds: policy.pushJobAvailableInSeconds,
      jobKind: NOTIFICATION_PUSH_DELIVERY_JOB_KIND,
      jobVersion: NOTIFICATION_PUSH_DELIVERY_JOB_VERSION,
      maxAttempts: policy.pushJobMaxAttempts,
      payload: { notificationDeliveryId },
      terminalRetentionSeconds: policy.pushJobTerminalRetentionSeconds,
      tx,
    });
  }
};

const toConversation = (
  row: RawConversationRow,
  participantReadPositions: ChatParticipantReadPosition[],
): ChatConversation => ({
  id: row.id,
  profileOneId: row.profileOneId,
  profileTwoId: row.profileTwoId,
  matchedProfileId: row.matchedProfileId,
  matchedProfile: {
    id: row.matchedProfileId,
    name: row.matchedProfileName,
    profileType: row.matchedProfileType,
  },
  isMatched: row.isMatched,
  lastMessageAt: row.lastMessageAt,
  ...(row.lastMessageId && row.lastMessageType && row.lastMessageCreatedAt
    ? {
        lastMessage: {
          id: row.lastMessageId,
          senderProfileId: row.lastMessageSenderProfileId,
          messageType: row.lastMessageType,
          content: row.lastMessageContent,
          createdAt: row.lastMessageCreatedAt,
        },
      }
    : {}),
  readState: {
    lastReadMessageId: row.readStateLastReadMessageId,
    lastReadAt: row.readStateLastReadAt,
    unreadCount: Number(row.unreadCount ?? 0),
    firstUnreadMessageId: row.firstUnreadMessageId,
    firstUnreadMessageCreatedAt: row.firstUnreadMessageCreatedAt,
  },
  participantReadPositions,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toMessage = (
  row: ChatMessageRow,
  reactionCounts: ChatMessageReactionCount[] = [],
  viewerReactions: string[] = [],
  replySummary: ChatMessageReplySummary | null = row.replySummary,
): ChatMessage => ({
  ...row,
  attachments: row.attachments ?? [],
  replySummary,
  reactionCounts,
  viewerReactions,
});

type ChatDatabaseExecutor = typeof db | DatabaseTransaction;

const loadParticipantReadPositions = async (
  executor: ChatDatabaseExecutor,
  conversationIds: string[],
) => {
  const positionsByConversationId = new Map<string, ChatParticipantReadPosition[]>();
  if (!conversationIds.length) return positionsByConversationId;
  const conversationIdList = sql.join(
    conversationIds.map((conversationId) => sql`${conversationId}::uuid`),
    sql`, `,
  );

  const rows = (await executor.execute(sql`
    select
      conversation.id as "conversationId",
      participant.profile_id as "profileId",
      read_state.last_read_message_id as "lastReadMessageId",
      read_state.last_read_message_created_at as "lastReadMessageCreatedAt",
      read_state.last_read_at as "lastReadAt"
    from ${chatConversation} conversation
    cross join lateral (
      values (conversation.profile_one_id), (conversation.profile_two_id)
    ) participant(profile_id)
    left join ${chatConversationReadState} read_state
      on read_state.conversation_id = conversation.id
      and read_state.profile_id = participant.profile_id
    where conversation.id in (${conversationIdList})
    order by conversation.id, participant.profile_id
  `)) as Array<{
    conversationId: string;
    profileId: string;
    lastReadMessageId: string | null;
    lastReadMessageCreatedAt: Date | null;
    lastReadAt: Date | null;
  }>;

  for (const row of rows) {
    const positions = positionsByConversationId.get(row.conversationId) ?? [];
    positions.push({
      profileId: row.profileId,
      lastReadMessageId: row.lastReadMessageId,
      lastReadMessageCreatedAt: row.lastReadMessageCreatedAt,
      lastReadAt: row.lastReadAt,
    });
    positionsByConversationId.set(row.conversationId, positions);
  }

  return positionsByConversationId;
};

const projectReplySummary = (
  summary: ChatMessageReplySummary | null,
  targetState: { deletedAt: Date | null } | undefined,
): ChatMessageReplySummary | null => {
  if (!summary) return null;

  const withoutPreview = (
    state: Extract<ChatMessageReplySummary["state"], "deleted" | "unavailable">,
  ): ChatMessageReplySummary => {
    const { messageId, messageType, preview: _preview, senderProfileId } = summary;
    return {
      messageId,
      senderProfileId,
      messageType,
      state,
    };
  };

  if (!targetState) {
    return withoutPreview("unavailable");
  }
  if (targetState.deletedAt) {
    return withoutPreview("deleted");
  }
  if (summary.state !== "available") {
    return withoutPreview(summary.state);
  }

  if (summary.messageType === "image" && summary.preview?.kind === "image") {
    return {
      messageId: summary.messageId,
      senderProfileId: summary.senderProfileId,
      messageType: summary.messageType,
      state: "available",
      preview: { kind: "image" },
    };
  }

  if (
    summary.messageType === "text" &&
    summary.preview?.kind === "text" &&
    typeof summary.preview.text === "string" &&
    typeof summary.preview.truncated === "boolean"
  ) {
    const boundedPreview = boundTextByGraphemes(summary.preview.text, 160);
    return {
      messageId: summary.messageId,
      senderProfileId: summary.senderProfileId,
      messageType: summary.messageType,
      state: "available",
      preview: {
        kind: "text",
        text: boundedPreview.text,
        truncated: summary.preview.truncated || boundedPreview.truncated,
      },
    };
  }

  return withoutPreview("unavailable");
};

const loadReplySummaryStates = async (executor: ChatDatabaseExecutor, rows: ChatMessageRow[]) => {
  const targetIds = Array.from(
    new Set(
      rows
        .map(({ replySummary }) => replySummary?.messageId)
        .filter((messageId): messageId is string => Boolean(messageId)),
    ),
  );
  const targetStates = new Map<string, { deletedAt: Date | null }>();
  if (!targetIds.length) return targetStates;

  const targets = await executor
    .select({
      id: chatMessage.id,
      deletedAt: chatMessage.deletedAt,
    })
    .from(chatMessage)
    .where(inArray(chatMessage.id, targetIds));

  for (const target of targets) {
    targetStates.set(target.id, { deletedAt: target.deletedAt });
  }
  return targetStates;
};

const loadReactionSummaries = async (
  messageIds: string[],
  viewerProfileId: string,
  executor: ChatDatabaseExecutor = db,
) => {
  const reactionCountsByMessageId = new Map<string, ChatMessageReactionCount[]>();
  const viewerReactionsByMessageId = new Map<string, string[]>();

  if (!messageIds.length) {
    return {
      reactionCountsByMessageId,
      viewerReactionsByMessageId,
    };
  }

  const counts = await executor
    .select({
      messageId: chatMessageReaction.messageId,
      emoji: chatMessageReaction.emoji,
      count: sql<number>`count(*)::int`,
    })
    .from(chatMessageReaction)
    .where(inArray(chatMessageReaction.messageId, messageIds))
    .groupBy(chatMessageReaction.messageId, chatMessageReaction.emoji)
    .orderBy(asc(chatMessageReaction.emoji));

  for (const count of counts) {
    const messageCounts = reactionCountsByMessageId.get(count.messageId) ?? [];
    messageCounts.push({
      emoji: count.emoji,
      count: Number(count.count),
    });
    reactionCountsByMessageId.set(count.messageId, messageCounts);
  }

  const viewerReactions = await executor
    .select({
      messageId: chatMessageReaction.messageId,
      emoji: chatMessageReaction.emoji,
    })
    .from(chatMessageReaction)
    .where(
      and(
        inArray(chatMessageReaction.messageId, messageIds),
        eq(chatMessageReaction.profileId, viewerProfileId),
      ),
    )
    .orderBy(asc(chatMessageReaction.emoji));

  for (const reaction of viewerReactions) {
    const messageReactions = viewerReactionsByMessageId.get(reaction.messageId) ?? [];
    messageReactions.push(reaction.emoji);
    viewerReactionsByMessageId.set(reaction.messageId, messageReactions);
  }

  return {
    reactionCountsByMessageId,
    viewerReactionsByMessageId,
  };
};

const getMessageWithReactions = async (
  messageId: string,
  viewerProfileId: string,
  executor: ChatDatabaseExecutor = db,
) => {
  const [row] = await executor
    .select(messageFields)
    .from(chatMessage)
    .where(eq(chatMessage.id, messageId))
    .limit(1);

  if (!row) return null;

  const { reactionCountsByMessageId, viewerReactionsByMessageId } = await loadReactionSummaries(
    [messageId],
    viewerProfileId,
    executor,
  );
  const replyTargetStates = await loadReplySummaryStates(executor, [row]);

  return toMessage(
    row,
    reactionCountsByMessageId.get(messageId),
    viewerReactionsByMessageId.get(messageId),
    projectReplySummary(
      row.replySummary,
      row.replySummary ? replyTargetStates.get(row.replySummary.messageId) : undefined,
    ),
  );
};

const getConversationAccess = async ({
  conversationId,
  profileId,
  userId,
}: {
  conversationId: string;
  profileId: string;
  userId: string;
}): Promise<ChatServiceResult<ConversationAccess>> => {
  const [profileAccess] = await findActiveProfileMembership(profileId, userId);
  if (!profileAccess) {
    return {
      ok: false,
      code: "profile_not_found",
      message: "Profile not found",
    };
  }

  const [conversation] = await db
    .select(conversationFields)
    .from(chatConversation)
    .where(
      and(
        eq(chatConversation.id, conversationId),
        or(
          eq(chatConversation.profileOneId, profileId),
          eq(chatConversation.profileTwoId, profileId),
        ),
      ),
    )
    .limit(1);

  if (!conversation) {
    return {
      ok: false,
      code: "conversation_not_found",
      message: "Conversation not found",
    };
  }

  return {
    ok: true,
    data: {
      conversation,
      otherProfileId: getOtherProfileId(conversation, profileId),
    },
  };
};

const getConversationParticipantIds = async (conversationId: string) => {
  const [conversation] = await db
    .select({
      profileOneId: chatConversation.profileOneId,
      profileTwoId: chatConversation.profileTwoId,
    })
    .from(chatConversation)
    .where(eq(chatConversation.id, conversationId))
    .limit(1);

  return conversation ? [conversation.profileOneId, conversation.profileTwoId] : [];
};

const listConversationPeerProfileIds = async (profileId: string) => {
  const rows = await db
    .select({
      profileOneId: chatConversation.profileOneId,
      profileTwoId: chatConversation.profileTwoId,
    })
    .from(chatConversation)
    .where(
      or(
        eq(chatConversation.profileOneId, profileId),
        eq(chatConversation.profileTwoId, profileId),
      ),
    );

  return Array.from(
    new Set(rows.map((row) => getOtherProfileId(row, profileId)).filter((id) => id !== profileId)),
  );
};

const loadChatConversationForProfile = async ({
  conversationId,
  executor = db,
  profileId,
}: {
  conversationId: string;
  executor?: ChatDatabaseExecutor;
  profileId: string;
}) => {
  const rows = (await executor.execute(sql`
    with conversation_row as (
      select
        conversation.id,
        conversation.profile_one_id as "profileOneId",
        conversation.profile_two_id as "profileTwoId",
        case
          when conversation.profile_one_id = ${profileId} then conversation.profile_two_id
          else conversation.profile_one_id
        end as "matchedProfileId",
        conversation.last_message_at as "lastMessageAt",
        conversation.created_at as "createdAt",
        conversation.updated_at as "updatedAt",
        coalesce(conversation.last_message_at, conversation.created_at) as "sortAt"
      from ${chatConversation} conversation
      where conversation.id = ${conversationId}
        and (
          conversation.profile_one_id = ${profileId}
          or conversation.profile_two_id = ${profileId}
        )
    )
    select
      conversation_row.id,
      conversation_row."profileOneId",
      conversation_row."profileTwoId",
      conversation_row."matchedProfileId",
      matched_profile.name as "matchedProfileName",
      matched_profile.profile_type as "matchedProfileType",
      exists (
        select 1
        from ${profileReaction} outgoing_like
        where outgoing_like.profile_id = ${profileId}
          and outgoing_like.target_profile_id = conversation_row."matchedProfileId"
          and outgoing_like.reaction = 'like'
      ) and exists (
        select 1
        from ${profileReaction} incoming_like
        where incoming_like.profile_id = conversation_row."matchedProfileId"
          and incoming_like.target_profile_id = ${profileId}
          and incoming_like.reaction = 'like'
      ) as "isMatched",
      conversation_row."lastMessageAt",
      last_message.id as "lastMessageId",
      last_message.sender_profile_id as "lastMessageSenderProfileId",
      last_message.message_type as "lastMessageType",
      last_message.content as "lastMessageContent",
      last_message.created_at as "lastMessageCreatedAt",
      read_state.last_read_message_id as "readStateLastReadMessageId",
      read_state.last_read_at as "readStateLastReadAt",
      coalesce(unread_state."unreadCount", 0) as "unreadCount",
      unread_state."firstUnreadMessageId",
      unread_state."firstUnreadMessageCreatedAt",
      conversation_row."createdAt",
      conversation_row."updatedAt",
      conversation_row."sortAt"
    from conversation_row
    inner join ${profile} matched_profile
      on matched_profile.id = conversation_row."matchedProfileId"
    left join ${chatConversationReadState} read_state
      on read_state.conversation_id = conversation_row.id
      and read_state.profile_id = ${profileId}
    left join lateral (
      select
        message.id,
        message.sender_profile_id,
        message.message_type,
        message.content,
        message.created_at
      from ${chatMessage} message
      where message.conversation_id = conversation_row.id
      order by message.created_at desc, message.id desc
      limit 1
    ) last_message on true
    left join lateral (
      select
        count(*)::int as "unreadCount",
        (array_agg(unread_message.id order by unread_message.created_at asc, unread_message.id asc))[1] as "firstUnreadMessageId",
        (array_agg(unread_message.created_at order by unread_message.created_at asc, unread_message.id asc))[1] as "firstUnreadMessageCreatedAt"
      from ${chatMessage} unread_message
      where unread_message.conversation_id = conversation_row.id
        and unread_message.sender_profile_id is distinct from ${profileId}
        and (
          read_state.conversation_id is null
          or read_state.last_read_message_id is null
          or unread_message.created_at > read_state.last_read_message_created_at
          or (
            unread_message.created_at = read_state.last_read_message_created_at
            and unread_message.id > read_state.last_read_message_id
          )
        )
    ) unread_state on true
  `)) as RawConversationRow[];

  const row = rows[0];
  if (!row) return null;
  const positions = await loadParticipantReadPositions(executor, [row.id]);
  return toConversation(row, positions.get(row.id) ?? []);
};

export const broadcastConversationUpsert = async (conversationId: string) => {
  const participantProfileIds = await getConversationParticipantIds(conversationId);

  for (const participantProfileId of participantProfileIds) {
    const conversation = await loadChatConversationForProfile({
      conversationId,
      profileId: participantProfileId,
    });

    if (!conversation) continue;

    chatSockets.sendToProfile(participantProfileId, {
      type: "conversation_upsert",
      conversation,
    });
    chatSockets.sendToProfile(participantProfileId, {
      type: "presence_snapshot",
      profiles: [
        {
          profileId: conversation.matchedProfileId,
          online: chatSockets.isProfileOnline(conversation.matchedProfileId),
        },
      ],
    });
  }
};

export const getChatPresenceSnapshot = async ({
  profileId,
  userId,
}: {
  profileId: string;
  userId: string;
}): Promise<
  ChatServiceResult<
    {
      profileId: string;
      online: boolean;
    }[]
  >
> => {
  const [profileAccess] = await findActiveProfileMembership(profileId, userId);
  if (!profileAccess) {
    return {
      ok: false,
      code: "profile_not_found",
      message: "Profile not found",
    };
  }

  const peerProfileIds = await listConversationPeerProfileIds(profileId);
  return {
    ok: true,
    data: peerProfileIds.map((peerProfileId) => ({
      profileId: peerProfileId,
      online: chatSockets.isProfileOnline(peerProfileId),
    })),
  };
};

export const broadcastChatPresenceChanged = async (profileId: string, online: boolean) => {
  const peerProfileIds = await listConversationPeerProfileIds(profileId);

  chatSockets.sendToProfiles(peerProfileIds, {
    type: "presence_changed",
    profileId,
    online,
  });
};

const notifyProfileMatchUsers = async ({
  conversationId,
  profileId,
  targetProfileId,
}: {
  conversationId: string;
  profileId: string;
  targetProfileId: string;
}) => {
  const participants = await db
    .select({
      profileId: profile.id,
      profileName: profile.name,
      userId: user.id,
    })
    .from(profile)
    .innerJoin(profileUser, eq(profile.id, profileUser.profileId))
    .innerJoin(user, eq(profileUser.userId, user.id))
    .where(inArray(profile.id, [profileId, targetProfileId]));

  const profileNames = new Map(
    participants.map((participant) => [participant.profileId, participant.profileName]),
  );
  const userIdsByProfile = new Map<string, Set<string>>();

  for (const participant of participants) {
    const userIds = userIdsByProfile.get(participant.profileId) ?? new Set<string>();
    userIds.add(participant.userId);
    userIdsByProfile.set(participant.profileId, userIds);
  }

  for (const [recipientProfileId, matchedProfileId] of [
    [profileId, targetProfileId],
    [targetProfileId, profileId],
  ] as const) {
    const matchedProfileName = profileNames.get(matchedProfileId) ?? "someone new";
    const recipientUserIds = userIdsByProfile.get(recipientProfileId) ?? new Set<string>();

    for (const recipientUserId of recipientUserIds) {
      await createNotification({
        recipientUserId,
        type: "profile_match",
        title: "It's a match",
        body: `You and ${matchedProfileName} liked each other.`,
        actorProfileId: matchedProfileId,
        relatedProfileId: recipientProfileId,
        data: {
          conversationId,
          profileId: recipientProfileId,
          matchedProfileId,
        },
      });
    }
  }
};

export const setProfileReactionAndSyncConversation = async ({
  policy,
  profileId,
  reaction,
  targetProfileId,
  userId,
}: {
  policy: TransactionalChatPolicy;
  profileId: string;
  reaction: ProfileReaction;
  targetProfileId: string;
  userId: string;
}) => {
  const result = await db.transaction(async (tx) => {
    const { conversation: lockedConversation, pair } = await lockProfilePairInTransaction({
      profileId,
      targetProfileId,
      tx,
    });
    const [[profileAccess], [target]] = await Promise.all([
      findActiveProfileMembershipInTransaction(tx, profileId, userId),
      tx
        .select({ id: profile.id })
        .from(profile)
        .where(and(eq(profile.id, targetProfileId), isNull(profile.deletedAt)))
        .limit(1),
    ]);
    if (!profileAccess || !target) {
      return {
        ok: false as const,
        code: "profile_not_found" as const,
        message: "Profile not found",
      };
    }

    const [existingReaction] = await tx
      .select({
        reaction: profileReaction.reaction,
      })
      .from(profileReaction)
      .where(
        and(
          eq(profileReaction.profileId, profileId),
          eq(profileReaction.targetProfileId, targetProfileId),
        ),
      )
      .limit(1);
    const alreadyLiked = existingReaction?.reaction === "like";

    await tx
      .insert(profileReaction)
      .values({
        profileId,
        targetProfileId,
        reaction,
      })
      .onConflictDoUpdate({
        target: [profileReaction.profileId, profileReaction.targetProfileId],
        set: {
          reaction,
          updatedAt: sql`clock_timestamp()`,
        },
      });

    const matched = await areProfilesMatchedInTransaction(tx, profileId, targetProfileId);
    let conversation = lockedConversation;
    if (matched && !conversation) {
      [conversation] = await tx.insert(chatConversation).values(pair).returning(conversationFields);
    }

    if (conversation) {
      [conversation] = await tx
        .update(chatConversation)
        .set({ updatedAt: sql`clock_timestamp()` })
        .where(eq(chatConversation.id, conversation.id))
        .returning(conversationFields);

      const participantProfileIds = [pair.profileOneId, pair.profileTwoId];
      const projections = await Promise.all(
        participantProfileIds.map(async (participantProfileId) => ({
          conversation: await loadChatConversationForProfile({
            conversationId: conversation!.id,
            executor: tx,
            profileId: participantProfileId,
          }),
          profileId: participantProfileId,
        })),
      );
      const causalId = createDurableEventCausalId();
      await appendDurableEventsInTransaction({
        causalId,
        events: [
          {
            scope: { kind: "chat-conversation", id: conversation.id },
            eventType: "chat.conversation.state",
            eventVersion: CHAT_EVENT_VERSION,
            payload: {
              conversationId: conversation.id,
              isMatched: matched,
              updatedAt: conversation.updatedAt.toISOString(),
            },
            retentionSeconds: policy.eventRetentionSeconds,
          },
          ...projections
            .filter(
              (
                entry,
              ): entry is {
                conversation: ChatConversation;
                profileId: string;
              } => entry.conversation !== null,
            )
            .map(({ conversation: projection, profileId: participantProfileId }) => ({
              scope: { kind: "chat-profile" as const, id: participantProfileId },
              eventType: "chat.conversation.upsert",
              eventVersion: CHAT_EVENT_VERSION,
              payload: {
                profileId: participantProfileId,
                conversation: toDurableConversation(projection),
              },
              retentionSeconds: policy.eventRetentionSeconds,
            })),
        ],
        tx,
      });
    }

    return {
      ok: true as const,
      shouldNotifyMatch: !alreadyLiked,
      reaction,
      matched,
      conversationId: conversation?.id ?? null,
    };
  });

  if (!result.ok) return result;

  if (result.conversationId) {
    await broadcastConversationUpsert(result.conversationId);

    if (result.matched && result.shouldNotifyMatch) {
      try {
        await notifyProfileMatchUsers({
          conversationId: result.conversationId,
          profileId,
          targetProfileId,
        });
      } catch (error) {
        console.error("Failed to create profile match notifications:", error);
      }
    }
  }

  return {
    ok: true as const,
    reaction: result.reaction,
    matched: result.matched,
    conversationId: result.conversationId,
  };
};

export const listChatConversations = async ({
  cursor,
  limit,
  profileId,
  userId,
}: {
  cursor?: string;
  limit?: number;
  profileId: string;
  userId: string;
}): Promise<ChatServiceResult<{ data: ChatConversation[]; cursor: string | null }>> => {
  const [profileAccess] = await findActiveProfileMembership(profileId, userId);
  if (!profileAccess) {
    return {
      ok: false,
      code: "profile_not_found",
      message: "Profile not found",
    };
  }

  const pageSize = normalizeLimit(limit, defaultConversationLimit);
  const context = { userId, profileId };
  const cursorSort = cursor
    ? decodeCursor({
        cursor,
        resource: "chat-conversations",
        direction: "next",
        context,
      })
    : null;
  const rows = (await db.execute(sql`
    with conversation_rows as (
      select
        conversation.id,
        conversation.profile_one_id as "profileOneId",
        conversation.profile_two_id as "profileTwoId",
        case
          when conversation.profile_one_id = ${profileId} then conversation.profile_two_id
          else conversation.profile_one_id
        end as "matchedProfileId",
        conversation.last_message_at as "lastMessageAt",
        conversation.created_at as "createdAt",
        conversation.updated_at as "updatedAt",
        coalesce(conversation.last_message_at, conversation.created_at) as "sortAt"
      from ${chatConversation} conversation
      where conversation.profile_one_id = ${profileId}
        or conversation.profile_two_id = ${profileId}
    )
    select
      conversation_rows.id,
      conversation_rows."profileOneId",
      conversation_rows."profileTwoId",
      conversation_rows."matchedProfileId",
      matched_profile.name as "matchedProfileName",
      matched_profile.profile_type as "matchedProfileType",
      exists (
        select 1
        from ${profileReaction} outgoing_like
        where outgoing_like.profile_id = ${profileId}
          and outgoing_like.target_profile_id = conversation_rows."matchedProfileId"
          and outgoing_like.reaction = 'like'
      ) and exists (
        select 1
        from ${profileReaction} incoming_like
        where incoming_like.profile_id = conversation_rows."matchedProfileId"
          and incoming_like.target_profile_id = ${profileId}
          and incoming_like.reaction = 'like'
      ) as "isMatched",
      conversation_rows."lastMessageAt",
      last_message.id as "lastMessageId",
      last_message.sender_profile_id as "lastMessageSenderProfileId",
      last_message.message_type as "lastMessageType",
      last_message.content as "lastMessageContent",
      last_message.created_at as "lastMessageCreatedAt",
      read_state.last_read_message_id as "readStateLastReadMessageId",
      read_state.last_read_at as "readStateLastReadAt",
      coalesce(unread_state."unreadCount", 0) as "unreadCount",
      unread_state."firstUnreadMessageId",
      unread_state."firstUnreadMessageCreatedAt",
      conversation_rows."createdAt",
      conversation_rows."updatedAt",
      conversation_rows."sortAt",
      ((extract(epoch from conversation_rows."sortAt") * 1000000)::bigint)::text as "cursorSortAtMicros"
    from conversation_rows
    inner join ${profile} matched_profile
      on matched_profile.id = conversation_rows."matchedProfileId"
    left join ${chatConversationReadState} read_state
      on read_state.conversation_id = conversation_rows.id
      and read_state.profile_id = ${profileId}
    left join lateral (
      select
        message.id,
        message.sender_profile_id,
        message.message_type,
        message.content,
        message.created_at
      from ${chatMessage} message
      where message.conversation_id = conversation_rows.id
      order by message.created_at desc, message.id desc
      limit 1
    ) last_message on true
    left join lateral (
      select
        count(*)::int as "unreadCount",
        (array_agg(unread_message.id order by unread_message.created_at asc, unread_message.id asc))[1] as "firstUnreadMessageId",
        (array_agg(unread_message.created_at order by unread_message.created_at asc, unread_message.id asc))[1] as "firstUnreadMessageCreatedAt"
      from ${chatMessage} unread_message
      where unread_message.conversation_id = conversation_rows.id
        and unread_message.sender_profile_id is distinct from ${profileId}
        and (
          read_state.conversation_id is null
          or read_state.last_read_message_id is null
          or unread_message.created_at > read_state.last_read_message_created_at
          or (
            unread_message.created_at = read_state.last_read_message_created_at
            and unread_message.id > read_state.last_read_message_id
          )
        )
    ) unread_state on true
    where ${cursorSort?.sortAtMicros ?? null}::text is null
      or conversation_rows."sortAt" < to_timestamp(${cursorSort?.sortAtMicros ?? null}::numeric / 1000000)
      or (
        conversation_rows."sortAt" = to_timestamp(${cursorSort?.sortAtMicros ?? null}::numeric / 1000000)
        and conversation_rows.id < ${cursorSort?.conversationId ?? null}::uuid
      )
    order by conversation_rows."sortAt" desc, conversation_rows.id desc
    limit ${pageSize + 1}
  `)) as RawConversationRow[];

  const dataRows = rows.slice(0, pageSize);
  const positions = await loadParticipantReadPositions(
    db,
    dataRows.map(({ id }) => id),
  );
  const data = dataRows.map((row) => toConversation(row, positions.get(row.id) ?? []));
  const lastReturned = rows[Math.min(rows.length, pageSize) - 1];
  const nextCursor =
    rows.length > pageSize && lastReturned
      ? encodeCursor({
          resource: "chat-conversations",
          direction: "next",
          context,
          sort: {
            sortAtMicros: lastReturned.cursorSortAtMicros,
            conversationId: lastReturned.id,
          },
        })
      : null;

  return {
    ok: true,
    data: {
      data,
      cursor: nextCursor,
    },
  };
};

export const getChatConversation = async ({
  conversationId,
  profileId,
  userId,
}: {
  conversationId: string;
  profileId: string;
  userId: string;
}): Promise<ChatServiceResult<ChatConversation>> => {
  const access = await getConversationAccess({ conversationId, profileId, userId });
  if (!access.ok) return access;

  const conversation = await loadChatConversationForProfile({ conversationId, profileId });
  if (!conversation) {
    return {
      ok: false,
      code: "conversation_not_found",
      message: "Conversation not found",
    };
  }

  return {
    ok: true,
    data: conversation,
  };
};

export const getChatUnreadCount = async ({
  profileId,
  userId,
}: {
  profileId: string;
  userId: string;
}): Promise<ChatServiceResult<{ count: number }>> => {
  const [profileAccess] = await findActiveProfileMembership(profileId, userId);
  if (!profileAccess) {
    return {
      ok: false,
      code: "profile_not_found",
      message: "Profile not found",
    };
  }

  return {
    ok: true,
    data: {
      count: await getChatUnreadCountInTransaction(db, profileId),
    },
  };
};

export const listChatMessages = async ({
  conversationId,
  cursor,
  limit,
  profileId,
  userId,
}: {
  conversationId: string;
  cursor?: string;
  limit?: number;
  profileId: string;
  userId: string;
}): Promise<ChatServiceResult<{ data: ChatMessage[]; cursor: string | null }>> => {
  const access = await getConversationAccess({ conversationId, profileId, userId });
  if (!access.ok) return access;

  const pageSize = normalizeLimit(limit, defaultMessageLimit);
  const context = { userId, profileId, conversationId };
  const cursorSort = cursor
    ? decodeCursor({
        cursor,
        resource: "chat-messages",
        direction: "next",
        context,
      })
    : null;
  const conditions: SQL[] = [eq(chatMessage.conversationId, conversationId)];
  if (cursorSort) {
    const cursorCreatedAt = sql`to_timestamp(${cursorSort.createdAtMicros}::numeric / 1000000)`;
    conditions.push(
      or(
        lt(chatMessage.createdAt, cursorCreatedAt),
        and(eq(chatMessage.createdAt, cursorCreatedAt), lt(chatMessage.id, cursorSort.messageId)),
      )!,
    );
  }

  const rows = await db
    .select({
      ...messageFields,
      cursorCreatedAtMicros: sql<string>`((extract(epoch from ${chatMessage.createdAt}) * 1000000)::bigint)::text`,
    })
    .from(chatMessage)
    .where(and(...conditions))
    .orderBy(desc(chatMessage.createdAt), desc(chatMessage.id))
    .limit(pageSize + 1);

  const dataRows = rows.slice(0, pageSize).reverse();
  const messageIds = dataRows.map(({ id }) => id);
  const { reactionCountsByMessageId, viewerReactionsByMessageId } = await loadReactionSummaries(
    messageIds,
    profileId,
  );
  const replyTargetStates = await loadReplySummaryStates(db, dataRows);
  const data = dataRows.map((row) =>
    toMessage(
      row,
      reactionCountsByMessageId.get(row.id),
      viewerReactionsByMessageId.get(row.id),
      projectReplySummary(
        row.replySummary,
        row.replySummary ? replyTargetStates.get(row.replySummary.messageId) : undefined,
      ),
    ),
  );
  const lastReturned = rows[Math.min(rows.length, pageSize) - 1];
  const nextCursor =
    rows.length > pageSize && lastReturned
      ? encodeCursor({
          resource: "chat-messages",
          direction: "next",
          context,
          sort: {
            createdAtMicros: lastReturned.cursorCreatedAtMicros,
            messageId: lastReturned.id,
          },
        })
      : null;

  return {
    ok: true,
    data: {
      data,
      cursor: nextCursor,
    },
  };
};

export const markChatConversationRead = async ({
  conversationId,
  messageId,
  policy,
  profileId,
  userId,
}: {
  conversationId: string;
  messageId?: string;
  policy: TransactionalChatPolicy;
  profileId: string;
  userId: string;
}): Promise<ChatServiceResult<ChatConversation>> => {
  const updateResult = await db.transaction(async (tx) => {
    const [candidate] = await tx
      .select(conversationFields)
      .from(chatConversation)
      .where(eq(chatConversation.id, conversationId))
      .limit(1);
    if (!candidate) {
      return {
        ok: false as const,
        code: "conversation_not_found" as const,
        message: "Conversation not found",
      };
    }

    const { conversation } = await lockProfilePairInTransaction({
      profileId: candidate.profileOneId,
      targetProfileId: candidate.profileTwoId,
      tx,
    });
    const [membership] = await findActiveProfileMembershipInTransaction(tx, profileId, userId);
    if (
      !conversation ||
      !membership ||
      (conversation.profileOneId !== profileId && conversation.profileTwoId !== profileId)
    ) {
      return {
        ok: false as const,
        code: "conversation_not_found" as const,
        message: "Conversation not found",
      };
    }

    const [targetMessage] = messageId
      ? await tx
          .select({
            id: chatMessage.id,
          })
          .from(chatMessage)
          .where(and(eq(chatMessage.id, messageId), eq(chatMessage.conversationId, conversationId)))
          .limit(1)
      : await tx
          .select({
            id: chatMessage.id,
          })
          .from(chatMessage)
          .where(eq(chatMessage.conversationId, conversationId))
          .orderBy(desc(chatMessage.createdAt), desc(chatMessage.id))
          .limit(1);

    if (messageId && !targetMessage) {
      return {
        ok: false as const,
        code: "message_not_found" as const,
        message: "Read target message not found",
      };
    }

    if (!targetMessage) {
      const projection = await loadChatConversationForProfile({
        conversationId,
        executor: tx,
        profileId,
      });
      return {
        ok: true as const,
        changed: false,
        conversation: projection!,
      };
    }

    const unreadBefore = await getChatUnreadCountInTransaction(tx, profileId);
    const advanced = await advanceReadPositionInTransaction({
      conversationId,
      message: targetMessage,
      profileId,
      tx,
    });
    const unreadAfter = await getChatUnreadCountInTransaction(tx, profileId);
    const participantProfileIds = [conversation.profileOneId, conversation.profileTwoId].sort();
    const projections = await Promise.all(
      participantProfileIds.map(async (participantProfileId) => ({
        conversation: await loadChatConversationForProfile({
          conversationId,
          executor: tx,
          profileId: participantProfileId,
        }),
        profileId: participantProfileId,
      })),
    );
    const viewerProjection = projections.find(
      ({ profileId: id }) => id === profileId,
    )?.conversation;
    if (!viewerProjection) throw new Error("Conversation read projection could not be loaded");

    if (advanced) {
      const causalId = createDurableEventCausalId();
      const events: DurableEventInput[] = [
        {
          scope: { kind: "chat-conversation" as const, id: conversationId },
          eventType: "chat.conversation.read",
          eventVersion: CHAT_EVENT_VERSION,
          payload: {
            conversationId,
            position: JSON.parse(JSON.stringify(advanced)) as DurableJsonObject,
          },
          retentionSeconds: policy.eventRetentionSeconds,
        },
      ];

      for (const projection of projections) {
        if (!projection.conversation) continue;
        events.push({
          scope: { kind: "chat-profile", id: projection.profileId },
          eventType: "chat.conversation.upsert",
          eventVersion: CHAT_EVENT_VERSION,
          payload: {
            profileId: projection.profileId,
            conversation: toDurableConversation(projection.conversation),
          },
          retentionSeconds: policy.eventRetentionSeconds,
        });
        if (projection.profileId === profileId && unreadBefore !== unreadAfter) {
          events.push({
            scope: { kind: "chat-profile", id: profileId },
            eventType: "chat.unread.aggregate",
            eventVersion: CHAT_EVENT_VERSION,
            payload: { profileId, count: unreadAfter },
            retentionSeconds: policy.eventRetentionSeconds,
          });
        }
      }

      await appendDurableEventsInTransaction({
        causalId,
        events,
        tx,
      });
    }

    return {
      ok: true as const,
      changed: Boolean(advanced),
      conversation: viewerProjection,
      position: advanced,
    };
  });

  if (!updateResult.ok) {
    return {
      ok: false,
      code: updateResult.code,
      message: updateResult.message,
    };
  }

  if (updateResult.changed) {
    await broadcastConversationUpsert(conversationId);
    if (updateResult.position) {
      chatSockets.sendToConversationSubscribers(conversationId, {
        type: "conversation_read",
        conversationId,
        position: updateResult.position,
      });
    }
  }

  return {
    ok: true,
    data: updateResult.conversation,
  };
};

export const sendTextMessage = async ({
  conversationId,
  failureInjector,
  idempotencyKey,
  policy,
  profileId,
  replyToMessageId,
  text,
  userId,
}: {
  conversationId: string;
  failureInjector?: ChatTransactionFailureInjector;
  idempotencyKey: string;
  policy: TransactionalChatPolicy;
  profileId: string;
  replyToMessageId?: string;
  text: string;
  userId: string;
}): Promise<SendTextMessageResult> => {
  if (!idempotencyKey) {
    return {
      ok: false,
      code: "idempotency_key_required",
      message: "Idempotency-Key is required",
      httpStatus: 400,
    };
  }
  if (!isCanonicalMessageIdempotencyKey(idempotencyKey)) {
    return {
      ok: false,
      code: "invalid_idempotency_key",
      message: "Idempotency-Key must be a canonical lowercase RFC 4122 UUID",
      httpStatus: 400,
    };
  }

  const content = text.trim();
  if (!content || content.length > 4000) {
    return {
      ok: false,
      code: "invalid_message",
      message: "Message text is invalid",
      httpStatus: 422,
    };
  }

  let committedNotifications: CreatedMessageNotification[] = [];
  const rejectedOutcome = (
    code: SendMessageRejectedResult["error"]["code"],
    message: string,
    httpStatus: SendMessageRejectedResult["httpStatus"],
  ): CommandOutcome => ({
    outcome: "rejected",
    result: {
      version: CHAT_MESSAGE_SEND_RESULT_VERSION,
      status: "rejected",
      httpStatus,
      error: { code, message },
    },
  });

  const commandResult = await runIdempotentCommand({
    actorUserId: userId,
    commandName: CHAT_MESSAGE_SEND_COMMAND_NAME,
    commandVersion: CHAT_MESSAGE_SEND_COMMAND_VERSION,
    idempotencyKey,
    normalizedRequest: {
      conversationId,
      actorProfileId: profileId,
      text: content,
      replyToMessageId: replyToMessageId ?? null,
    },
    retentionSeconds: policy.commandRetentionSeconds,
    afterOutcomePersisted: () => runFailureInjector(failureInjector, "after_idempotency_outcome"),
    execute: async (tx) => {
      await runFailureInjector(failureInjector, "after_idempotency_claim");
      const [candidate] = await tx
        .select(conversationFields)
        .from(chatConversation)
        .where(eq(chatConversation.id, conversationId))
        .limit(1);
      if (!candidate) {
        return rejectedOutcome("conversation_not_found", "Conversation not found", 404);
      }

      const { conversation } = await lockProfilePairInTransaction({
        profileId: candidate.profileOneId,
        targetProfileId: candidate.profileTwoId,
        tx,
      });
      await runFailureInjector(failureInjector, "after_common_lock");
      const [membership] = await findActiveProfileMembershipInTransaction(tx, profileId, userId);
      if (
        !conversation ||
        !membership ||
        (conversation.profileOneId !== profileId && conversation.profileTwoId !== profileId)
      ) {
        return rejectedOutcome("conversation_not_found", "Conversation not found", 404);
      }
      await runFailureInjector(failureInjector, "after_authorization");

      const otherProfileId = getOtherProfileId(conversation, profileId);
      const matched = await areProfilesMatchedInTransaction(tx, profileId, otherProfileId);
      if (!matched) {
        return rejectedOutcome(
          "conversation_not_matched",
          "Conversation is not currently matched",
          409,
        );
      }
      await runFailureInjector(failureInjector, "after_match_validation");

      const [replyTarget] = replyToMessageId
        ? await tx
            .select({
              id: chatMessage.id,
              senderProfileId: chatMessage.senderProfileId,
              messageType: chatMessage.messageType,
              content: chatMessage.content,
            })
            .from(chatMessage)
            .where(
              and(
                eq(chatMessage.id, replyToMessageId),
                eq(chatMessage.conversationId, conversationId),
                isNull(chatMessage.deletedAt),
              ),
            )
            .limit(1)
        : [];
      if (replyToMessageId && !replyTarget) {
        return rejectedOutcome("invalid_reply_target", "Reply target is invalid", 422);
      }
      await runFailureInjector(failureInjector, "after_reply_validation");

      const participantProfileIds = [conversation.profileOneId, conversation.profileTwoId].sort();
      const unreadBefore = new Map<string, number>();
      for (const participantProfileId of participantProfileIds) {
        unreadBefore.set(
          participantProfileId,
          await getChatUnreadCountInTransaction(tx, participantProfileId),
        );
      }

      const replySummary = replyTarget ? createReplySummary(replyTarget) : null;
      const [created] = await tx
        .insert(chatMessage)
        .values({
          conversationId,
          senderProfileId: profileId,
          messageType: "text",
          content,
          replyToMessageId: replyToMessageId ?? null,
          replySummary,
        })
        .returning(messageFields);
      const message = toMessage(created, [], [], replySummary);
      await runFailureInjector(failureInjector, "after_message_insert");

      const senderPosition = await advanceReadPositionInTransaction({
        conversationId,
        message: created,
        profileId,
        tx,
      });
      if (!senderPosition) throw new Error("Sender read position did not advance to new message");
      await runFailureInjector(failureInjector, "after_sender_read");

      await tx
        .update(chatConversation)
        .set({
          lastMessageAt: created.createdAt,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(eq(chatConversation.id, conversationId));
      await runFailureInjector(failureInjector, "after_conversation_projection");

      const notificationState = await createMessageNotificationStateInTransaction({
        conversationId,
        message,
        recipientProfileId: otherProfileId,
        senderProfileId: profileId,
        senderUserId: userId,
        tx,
      });
      await runFailureInjector(failureInjector, "after_notification_state");
      await enqueueMessagePushJobsInTransaction({
        deliveryIds: notificationState.pushDeliveryIds,
        policy,
        tx,
      });
      await runFailureInjector(failureInjector, "after_delivery_jobs");

      const unreadAfter = new Map<string, number>();
      const projections = [];
      for (const participantProfileId of participantProfileIds) {
        unreadAfter.set(
          participantProfileId,
          await getChatUnreadCountInTransaction(tx, participantProfileId),
        );
        const projection = await loadChatConversationForProfile({
          conversationId,
          executor: tx,
          profileId: participantProfileId,
        });
        if (!projection) throw new Error("Message conversation projection could not be loaded");
        projections.push({ conversation: projection, profileId: participantProfileId });
      }

      const causalId = createDurableEventCausalId();
      const events: DurableEventInput[] = [
        {
          scope: { kind: "chat-conversation" as const, id: conversationId },
          eventType: "chat.message.created",
          eventVersion: CHAT_EVENT_VERSION,
          payload: {
            conversationId,
            message: toDurableChatMessage(message),
          } as DurableJsonObject,
          retentionSeconds: policy.eventRetentionSeconds,
        },
        {
          scope: { kind: "chat-conversation" as const, id: conversationId },
          eventType: "chat.conversation.read",
          eventVersion: CHAT_EVENT_VERSION,
          payload: {
            conversationId,
            position: JSON.parse(JSON.stringify(senderPosition)) as DurableJsonObject,
          },
          retentionSeconds: policy.eventRetentionSeconds,
        },
      ];

      for (const projection of projections) {
        events.push({
          scope: { kind: "chat-profile", id: projection.profileId },
          eventType: "chat.conversation.upsert",
          eventVersion: CHAT_EVENT_VERSION,
          payload: {
            profileId: projection.profileId,
            conversation: toDurableConversation(projection.conversation),
          },
          retentionSeconds: policy.eventRetentionSeconds,
        });
        if (unreadBefore.get(projection.profileId) !== unreadAfter.get(projection.profileId)) {
          events.push({
            scope: { kind: "chat-profile", id: projection.profileId },
            eventType: "chat.unread.aggregate",
            eventVersion: CHAT_EVENT_VERSION,
            payload: {
              profileId: projection.profileId,
              count: unreadAfter.get(projection.profileId)!,
            },
            retentionSeconds: policy.eventRetentionSeconds,
          });
        }
      }

      for (const createdNotification of notificationState.createdNotifications) {
        events.push({
          scope: {
            kind: "notification-user",
            id: createdNotification.recipientUserId,
          },
          eventType: "notification.created",
          eventVersion: CHAT_EVENT_VERSION,
          payload: {
            notification: toDurableNotification(createdNotification.notification),
            unreadCount: createdNotification.unreadCount,
          } as DurableJsonObject,
          retentionSeconds: policy.eventRetentionSeconds,
        });
      }

      await appendDurableEventsInTransaction({
        causalId,
        events,
        tx,
      });
      await runFailureInjector(failureInjector, "after_durable_events");
      committedNotifications = notificationState.createdNotifications;
      await runFailureInjector(failureInjector, "before_idempotency_outcome");

      return {
        outcome: "succeeded",
        result: {
          version: CHAT_MESSAGE_SEND_RESULT_VERSION,
          status: "succeeded",
          message: toDurableChatMessage(message),
        },
      };
    },
  });

  if (!commandResult.ok) {
    return {
      ok: false,
      code: commandResult.error.code,
      message: commandResult.error.message,
      httpStatus: 409,
    };
  }

  if (!("result" in commandResult.outcome)) {
    throw new Error("Message command outcome must contain an inline result");
  }
  const storedResult = commandResult.outcome.result as StoredSendMessageResult;
  if (storedResult.version !== CHAT_MESSAGE_SEND_RESULT_VERSION) {
    throw new Error("Stored message command result version is unsupported");
  }
  if (storedResult.status === "rejected") {
    return {
      ok: false,
      code: storedResult.error.code,
      message: storedResult.error.message,
      httpStatus: storedResult.httpStatus,
      replayed: commandResult.replayed,
      terminalCommandResult: true,
    };
  }

  const message = fromDurableChatMessage(storedResult.message);
  if (!commandResult.replayed) {
    chatSockets.sendToConversationSubscribers(conversationId, {
      type: "message",
      conversationId,
      message,
    });
    try {
      await broadcastConversationUpsert(conversationId);
    } catch (error) {
      console.error("Failed to broadcast committed conversation projection:", error);
    }
    for (const createdNotification of committedNotifications) {
      notificationSockets.sendToUser(createdNotification.recipientUserId, {
        type: "notification",
        notification: createdNotification.notification,
      });
      notificationSockets.sendToUser(createdNotification.recipientUserId, {
        type: "unread_count",
        count: createdNotification.unreadCount,
      });
    }
  }

  return {
    ok: true,
    data: message,
    replayed: commandResult.replayed,
  };
};

export const setMessageReaction = async ({
  conversationId,
  emoji,
  failureInjector,
  messageId,
  policy,
  profileId,
  reacted,
  userId,
}: {
  conversationId: string;
  emoji: string;
  failureInjector?: ChatTransactionFailureInjector;
  messageId: string;
  policy: TransactionalChatPolicy;
  profileId: string;
  reacted: boolean;
  userId: string;
}): Promise<ChatServiceResult<ChatMessage>> => {
  const normalizedEmoji = emoji.trim();
  if (!normalizedEmoji || normalizedEmoji.length > 64) {
    return {
      ok: false,
      code: "invalid_reaction",
      message: "Reaction is invalid",
    };
  }

  const mutation = await db.transaction(async (tx) => {
    const [candidate] = await tx
      .select(conversationFields)
      .from(chatConversation)
      .where(eq(chatConversation.id, conversationId))
      .limit(1);
    if (!candidate) {
      return {
        ok: false as const,
        code: "conversation_not_found" as const,
        message: "Conversation not found",
      };
    }

    const { conversation } = await lockProfilePairInTransaction({
      profileId: candidate.profileOneId,
      targetProfileId: candidate.profileTwoId,
      tx,
    });
    await runFailureInjector(failureInjector, "after_common_lock");
    const [membership] = await findActiveProfileMembershipInTransaction(tx, profileId, userId);
    if (
      !conversation ||
      !membership ||
      (conversation.profileOneId !== profileId && conversation.profileTwoId !== profileId)
    ) {
      return {
        ok: false as const,
        code: "conversation_not_found" as const,
        message: "Conversation not found",
      };
    }

    const otherProfileId = getOtherProfileId(conversation, profileId);
    if (!(await areProfilesMatchedInTransaction(tx, profileId, otherProfileId))) {
      return {
        ok: false as const,
        code: "conversation_not_matched" as const,
        message: "Conversation is not currently matched",
      };
    }

    const [target] = await tx
      .select({ id: chatMessage.id })
      .from(chatMessage)
      .where(
        and(
          eq(chatMessage.id, messageId),
          eq(chatMessage.conversationId, conversationId),
          isNull(chatMessage.deletedAt),
        ),
      )
      .limit(1);
    if (!target) {
      return {
        ok: false as const,
        code: "message_not_found" as const,
        message: "Message not found",
      };
    }

    const changedRows = reacted
      ? await tx
          .insert(chatMessageReaction)
          .values({
            messageId,
            profileId,
            emoji: normalizedEmoji,
          })
          .onConflictDoNothing({
            target: [
              chatMessageReaction.messageId,
              chatMessageReaction.profileId,
              chatMessageReaction.emoji,
            ],
          })
          .returning({ messageId: chatMessageReaction.messageId })
      : await tx
          .delete(chatMessageReaction)
          .where(
            and(
              eq(chatMessageReaction.messageId, messageId),
              eq(chatMessageReaction.profileId, profileId),
              eq(chatMessageReaction.emoji, normalizedEmoji),
            ),
          )
          .returning({ messageId: chatMessageReaction.messageId });
    const updatedMessage = await getMessageWithReactions(messageId, profileId, tx);
    if (!updatedMessage) throw new Error("Reaction message disappeared while locked");
    const changed = changedRows.length > 0;

    if (changed) {
      await appendDurableEventsInTransaction({
        causalId: createDurableEventCausalId(),
        events: [
          {
            scope: { kind: "chat-conversation", id: conversationId },
            eventType: "chat.reaction.state",
            eventVersion: CHAT_EVENT_VERSION,
            payload: {
              conversationId,
              messageId,
              reactionCounts: updatedMessage.reactionCounts,
              actorProfileId: profileId,
              emoji: normalizedEmoji,
              reacted,
            },
            retentionSeconds: policy.eventRetentionSeconds,
          },
        ],
        tx,
      });
    }

    return {
      ok: true as const,
      changed,
      message: updatedMessage,
    };
  });

  if (!mutation.ok) return mutation;
  if (mutation.changed) {
    chatSockets.sendToConversationSubscribers(conversationId, {
      type: "reaction",
      conversationId,
      messageId,
      reactionCounts: mutation.message.reactionCounts as ChatMessageReactionCount[],
      profileId,
      emoji: normalizedEmoji,
      reacted,
    });
  }

  return {
    ok: true,
    data: mutation.message,
  };
};
