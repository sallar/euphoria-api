import type { SQL } from "drizzle-orm";

import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";

import type {
  ChatConversation,
  ChatConversationReadState,
  ChatMessage,
  ChatMessageReactionCount,
  ChatProfileSummary,
} from "@/models/chat";

import { user } from "@/db/auth-schema";
import {
  chatConversation,
  chatConversationReadState,
  chatMessage,
  chatMessageReaction,
} from "@/db/chat-schema";
import {
  profile,
  profileMatch,
  profileReaction,
  profileReactionValues,
  profileUser,
} from "@/db/profile-schema";
import { decodeCursor, encodeCursor } from "@/lib/cursor";
import { db } from "@/lib/db";
import { findActiveProfileMembership } from "@/lib/profile-queries";

import { chatSockets } from "./chat-sockets";
import { createNotification } from "./notification-service";

type ProfileReaction = (typeof profileReactionValues)[number];
type ChatServiceErrorCode =
  | "conversation_not_found"
  | "empty_message"
  | "message_not_found"
  | "not_matched"
  | "profile_not_found"
  | "reply_not_found";

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
  editedAt: chatMessage.editedAt,
  deletedAt: chatMessage.deletedAt,
  createdAt: chatMessage.createdAt,
  updatedAt: chatMessage.updatedAt,
};

type ChatMessageRow = Pick<typeof chatMessage.$inferSelect, keyof typeof messageFields>;
type ConversationRow = Pick<typeof chatConversation.$inferSelect, keyof typeof conversationFields>;

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

const toConversation = (row: RawConversationRow): ChatConversation => ({
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
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const toMessage = (
  row: ChatMessageRow,
  reactionCounts: ChatMessageReactionCount[] = [],
  viewerReactions: string[] = [],
): ChatMessage => ({
  ...row,
  attachments: row.attachments ?? [],
  reactionCounts,
  viewerReactions,
});

type ReadPosition = {
  id: string | null;
  createdAt: Date;
};

const compareReadPositions = (a: ReadPosition, b: ReadPosition) => {
  const timeDelta = a.createdAt.getTime() - b.createdAt.getTime();
  if (timeDelta !== 0) return timeDelta;
  if (a.id && b.id) return a.id.localeCompare(b.id);
  if (a.id && !b.id) return 1;
  if (!a.id && b.id) return -1;
  return 0;
};

const getExistingReadPosition = (
  row:
    | {
        lastReadMessageId: string | null;
        lastReadAt: Date;
        readMessageCreatedAt: Date | null;
      }
    | undefined,
) => {
  if (!row) return null;

  if (row.lastReadMessageId && row.readMessageCreatedAt) {
    return {
      id: row.lastReadMessageId,
      createdAt: row.readMessageCreatedAt,
    };
  }

  return {
    id: null,
    createdAt: row.lastReadAt,
  };
};

const loadReactionSummaries = async (messageIds: string[], viewerProfileId: string) => {
  const reactionCountsByMessageId = new Map<string, ChatMessageReactionCount[]>();
  const viewerReactionsByMessageId = new Map<string, string[]>();

  if (!messageIds.length) {
    return {
      reactionCountsByMessageId,
      viewerReactionsByMessageId,
    };
  }

  const counts = await db
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

  const viewerReactions = await db
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

const getMessageWithReactions = async (messageId: string, viewerProfileId: string) => {
  const [row] = await db
    .select(messageFields)
    .from(chatMessage)
    .where(eq(chatMessage.id, messageId))
    .limit(1);

  if (!row) return null;

  const { reactionCountsByMessageId, viewerReactionsByMessageId } = await loadReactionSummaries(
    [messageId],
    viewerProfileId,
  );

  return toMessage(
    row,
    reactionCountsByMessageId.get(messageId),
    viewerReactionsByMessageId.get(messageId),
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
  profileId,
}: {
  conversationId: string;
  profileId: string;
}) => {
  const rows = (await db.execute(sql`
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
    left join ${chatMessage} read_message
      on read_message.id = read_state.last_read_message_id
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
          or (
            read_state.last_read_message_id is not null
            and read_message.id is not null
            and (
              unread_message.created_at > read_message.created_at
              or (
                unread_message.created_at = read_message.created_at
                and unread_message.id > read_message.id
              )
            )
          )
          or (
            (
              read_state.last_read_message_id is null
              or read_message.id is null
            )
            and unread_message.created_at > read_state.last_read_at
          )
        )
    ) unread_state on true
  `)) as RawConversationRow[];

  const row = rows[0];
  return row ? toConversation(row) : null;
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

  await syncConversationsForProfileMatches(profileId);

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

const areProfilesMatched = async (profileId: string, targetProfileId: string) => {
  const [result] = await db
    .select({
      count: sql<number>`count(*)::int`,
    })
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

const notifyAbsentRecipientUsers = async ({
  conversation,
  message,
  recipientProfileId,
  senderProfileId,
  senderUserId,
}: {
  conversation: ConversationRow;
  message: ChatMessage;
  recipientProfileId: string;
  senderProfileId: string;
  senderUserId: string;
}) => {
  const activeUserIds = chatSockets.getActiveUserIdsForConversationSubscribers(conversation.id);
  const [senderProfile] = await db
    .select({
      name: profile.name,
    })
    .from(profile)
    .where(eq(profile.id, senderProfileId))
    .limit(1);

  const recipients = await db
    .select({
      userId: user.id,
    })
    .from(profileUser)
    .innerJoin(user, eq(profileUser.userId, user.id))
    .where(eq(profileUser.profileId, recipientProfileId));

  const senderName = senderProfile?.name ?? "Someone";
  const content = message.content ?? "Sent a message";
  const preview = content.length > 120 ? `${content.slice(0, 117)}...` : content;

  for (const recipient of recipients) {
    if (recipient.userId === senderUserId || activeUserIds.has(recipient.userId)) continue;

    await createNotification({
      recipientUserId: recipient.userId,
      type: "message",
      title: `New message from ${senderName}`,
      body: preview,
      actorProfileId: senderProfileId,
      relatedProfileId: recipientProfileId,
      data: {
        conversationId: conversation.id,
        messageId: message.id,
        senderProfileId,
        recipientProfileId,
        messageType: message.messageType,
      },
      channels: ["push"],
    });
  }
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

export const syncConversationsForProfileMatches = async (profileId: string) => {
  await db.execute(sql`
    insert into ${chatConversation} (
      profile_one_id,
      profile_two_id,
      created_at,
      updated_at
    )
    select
      least(${profileMatch.profileId}, ${profileMatch.matchedProfileId}),
      greatest(${profileMatch.profileId}, ${profileMatch.matchedProfileId}),
      min(${profileMatch.matchedAt}),
      now()
    from ${profileMatch}
    where ${profileMatch.profileId} = ${profileId}
    group by 1, 2
    on conflict (profile_one_id, profile_two_id) do nothing
  `);
};

export const setProfileReactionAndSyncConversation = async ({
  profileId,
  reaction,
  targetProfileId,
}: {
  profileId: string;
  reaction: ProfileReaction;
  targetProfileId: string;
}) => {
  const pair = getProfilePair(profileId, targetProfileId);
  const pairLockKey = `chat_conversation:${pair.profileOneId}:${pair.profileTwoId}`;

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${pairLockKey}))`);

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
          updatedAt: new Date(),
        },
      });

    if (reaction !== "like") {
      return {
        shouldNotifyMatch: false,
        reaction,
        matched: false,
        conversationId: null,
      };
    }

    const [matchCount] = await tx
      .select({
        count: sql<number>`count(*)::int`,
      })
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

    if (Number(matchCount?.count ?? 0) !== 2) {
      return {
        shouldNotifyMatch: false,
        reaction,
        matched: false,
        conversationId: null,
      };
    }

    const [createdConversation] = await tx
      .insert(chatConversation)
      .values(pair)
      .onConflictDoNothing({
        target: [chatConversation.profileOneId, chatConversation.profileTwoId],
      })
      .returning({
        id: chatConversation.id,
      });

    if (createdConversation) {
      return {
        shouldNotifyMatch: !alreadyLiked,
        reaction,
        matched: true,
        conversationId: createdConversation.id,
      };
    }

    const [existingConversation] = await tx
      .select({
        id: chatConversation.id,
      })
      .from(chatConversation)
      .where(
        and(
          eq(chatConversation.profileOneId, pair.profileOneId),
          eq(chatConversation.profileTwoId, pair.profileTwoId),
        ),
      )
      .limit(1);

    return {
      shouldNotifyMatch: !alreadyLiked,
      reaction,
      matched: true,
      conversationId: existingConversation?.id ?? null,
    };
  });

  if (result.matched && result.conversationId) {
    await broadcastConversationUpsert(result.conversationId);

    if (result.shouldNotifyMatch) {
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

  await syncConversationsForProfileMatches(profileId);

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
    left join ${chatMessage} read_message
      on read_message.id = read_state.last_read_message_id
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
          or (
            read_state.last_read_message_id is not null
            and read_message.id is not null
            and (
              unread_message.created_at > read_message.created_at
              or (
                unread_message.created_at = read_message.created_at
                and unread_message.id > read_message.id
              )
            )
          )
          or (
            (
              read_state.last_read_message_id is null
              or read_message.id is null
            )
            and unread_message.created_at > read_state.last_read_at
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

  const data = rows.slice(0, pageSize).map(toConversation);
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
  const data = dataRows.map((row) =>
    toMessage(row, reactionCountsByMessageId.get(row.id), viewerReactionsByMessageId.get(row.id)),
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
  profileId,
  userId,
}: {
  conversationId: string;
  messageId?: string;
  profileId: string;
  userId: string;
}): Promise<ChatServiceResult<ChatConversation>> => {
  const access = await getConversationAccess({ conversationId, profileId, userId });
  if (!access.ok) return access;

  const now = new Date();
  const updateResult = await db.transaction(async (tx) => {
    const [targetMessage] = messageId
      ? await tx
          .select({
            id: chatMessage.id,
            createdAt: chatMessage.createdAt,
          })
          .from(chatMessage)
          .where(and(eq(chatMessage.id, messageId), eq(chatMessage.conversationId, conversationId)))
          .limit(1)
      : await tx
          .select({
            id: chatMessage.id,
            createdAt: chatMessage.createdAt,
          })
          .from(chatMessage)
          .where(eq(chatMessage.conversationId, conversationId))
          .orderBy(desc(chatMessage.createdAt), desc(chatMessage.id))
          .limit(1);

    if (messageId && !targetMessage) {
      return {
        ok: false as const,
      };
    }

    if (!targetMessage) {
      return {
        ok: true as const,
      };
    }

    const [existingState] = await tx
      .select({
        lastReadMessageId: chatConversationReadState.lastReadMessageId,
        lastReadAt: chatConversationReadState.lastReadAt,
        readMessageCreatedAt: chatMessage.createdAt,
      })
      .from(chatConversationReadState)
      .leftJoin(chatMessage, eq(chatConversationReadState.lastReadMessageId, chatMessage.id))
      .where(
        and(
          eq(chatConversationReadState.conversationId, conversationId),
          eq(chatConversationReadState.profileId, profileId),
        ),
      )
      .limit(1);

    const targetPosition = {
      id: targetMessage.id,
      createdAt: targetMessage.createdAt,
    };
    const existingPosition = getExistingReadPosition(existingState);

    if (!existingPosition || compareReadPositions(targetPosition, existingPosition) > 0) {
      await tx
        .insert(chatConversationReadState)
        .values({
          conversationId,
          profileId,
          lastReadMessageId: targetMessage.id,
          lastReadAt: now,
        })
        .onConflictDoUpdate({
          target: [chatConversationReadState.conversationId, chatConversationReadState.profileId],
          set: {
            lastReadMessageId: targetMessage.id,
            lastReadAt: now,
            updatedAt: now,
          },
        });
    }

    return {
      ok: true as const,
    };
  });

  if (!updateResult.ok) {
    return {
      ok: false,
      code: "message_not_found",
      message: "Read target message not found",
    };
  }

  const conversation = await loadChatConversationForProfile({ conversationId, profileId });
  if (!conversation) {
    return {
      ok: false,
      code: "conversation_not_found",
      message: "Conversation not found",
    };
  }

  chatSockets.sendToProfile(profileId, {
    type: "conversation_upsert",
    conversation,
  });
  chatSockets.sendToConversationSubscribers(conversationId, {
    type: "conversation_read",
    conversationId,
    profileId,
    readState: conversation.readState as ChatConversationReadState,
  });

  return {
    ok: true,
    data: conversation,
  };
};

export const sendTextMessage = async ({
  clientMessageId,
  conversationId,
  profileId,
  replyToMessageId,
  text,
  userId,
}: {
  clientMessageId?: string;
  conversationId: string;
  profileId: string;
  replyToMessageId?: string;
  text: string;
  userId: string;
}): Promise<ChatServiceResult<ChatMessage>> => {
  const content = text.trim();
  if (!content) {
    return {
      ok: false,
      code: "empty_message",
      message: "Message text cannot be empty",
    };
  }

  const access = await getConversationAccess({ conversationId, profileId, userId });
  if (!access.ok) return access;

  const matched = await areProfilesMatched(profileId, access.data.otherProfileId);
  if (!matched) {
    return {
      ok: false,
      code: "not_matched",
      message: "Messages can only be sent while profiles are matched",
    };
  }

  const row = await db.transaction(async (tx) => {
    if (replyToMessageId) {
      const [reply] = await tx
        .select({
          id: chatMessage.id,
        })
        .from(chatMessage)
        .where(
          and(eq(chatMessage.id, replyToMessageId), eq(chatMessage.conversationId, conversationId)),
        )
        .limit(1);

      if (!reply) return null;
    }

    const [created] = await tx
      .insert(chatMessage)
      .values({
        conversationId,
        senderProfileId: profileId,
        messageType: "text",
        content,
        replyToMessageId: replyToMessageId ?? null,
      })
      .returning(messageFields);

    await tx
      .update(chatConversation)
      .set({
        lastMessageAt: created.createdAt,
        updatedAt: new Date(),
      })
      .where(eq(chatConversation.id, conversationId));

    const readAt = new Date();
    await tx
      .insert(chatConversationReadState)
      .values({
        conversationId,
        profileId,
        lastReadMessageId: created.id,
        lastReadAt: readAt,
      })
      .onConflictDoUpdate({
        target: [chatConversationReadState.conversationId, chatConversationReadState.profileId],
        set: {
          lastReadMessageId: created.id,
          lastReadAt: readAt,
          updatedAt: readAt,
        },
      });

    return created;
  });

  if (!row) {
    return {
      ok: false,
      code: "reply_not_found",
      message: "Reply target message not found",
    };
  }

  const message = toMessage(row);

  chatSockets.sendToConversationSubscribers(conversationId, {
    type: "message",
    conversationId,
    message,
    clientMessageId,
  });
  await broadcastConversationUpsert(conversationId);

  try {
    await notifyAbsentRecipientUsers({
      conversation: access.data.conversation,
      message,
      recipientProfileId: access.data.otherProfileId,
      senderProfileId: profileId,
      senderUserId: userId,
    });
  } catch (error) {
    console.error("Failed to create chat message notifications:", error);
  }

  return {
    ok: true,
    data: message,
  };
};

export const setMessageReaction = async ({
  conversationId,
  emoji,
  messageId,
  profileId,
  reacted,
  userId,
}: {
  conversationId: string;
  emoji: string;
  messageId: string;
  profileId: string;
  reacted: boolean;
  userId: string;
}): Promise<ChatServiceResult<ChatMessage>> => {
  const normalizedEmoji = emoji.trim();
  if (!normalizedEmoji) {
    return {
      ok: false,
      code: "empty_message",
      message: "Reaction cannot be empty",
    };
  }

  const access = await getConversationAccess({ conversationId, profileId, userId });
  if (!access.ok) return access;

  const matched = await areProfilesMatched(profileId, access.data.otherProfileId);
  if (!matched) {
    return {
      ok: false,
      code: "not_matched",
      message: "Message reactions can only be changed while profiles are matched",
    };
  }

  const [message] = await db
    .select({
      id: chatMessage.id,
    })
    .from(chatMessage)
    .where(and(eq(chatMessage.id, messageId), eq(chatMessage.conversationId, conversationId)))
    .limit(1);

  if (!message) {
    return {
      ok: false,
      code: "message_not_found",
      message: "Message not found",
    };
  }

  if (reacted) {
    await db
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
      });
  } else {
    await db
      .delete(chatMessageReaction)
      .where(
        and(
          eq(chatMessageReaction.messageId, messageId),
          eq(chatMessageReaction.profileId, profileId),
          eq(chatMessageReaction.emoji, normalizedEmoji),
        ),
      );
  }

  const updatedMessage = await getMessageWithReactions(messageId, profileId);
  if (!updatedMessage) {
    return {
      ok: false,
      code: "message_not_found",
      message: "Message not found",
    };
  }

  chatSockets.sendToConversationSubscribers(conversationId, {
    type: "reaction",
    conversationId,
    messageId,
    reactionCounts: updatedMessage.reactionCounts as ChatMessageReactionCount[],
    profileId,
    emoji: normalizedEmoji,
    reacted,
  });

  return {
    ok: true,
    data: updatedMessage,
  };
};
