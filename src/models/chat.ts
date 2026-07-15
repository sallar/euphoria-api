import Elysia, { t } from "elysia";

import { chatMessageTypeSchema, profileTypeSchema } from "./enums";

const uuid = t.String({ format: "uuid" });
const messageText = t.String({ minLength: 1, maxLength: 4000 });
const reactionEmoji = t.String({ minLength: 1, maxLength: 64 });

const ChatProfileSummary = t.Object({
  id: uuid,
  name: t.String(),
  profileType: profileTypeSchema,
});

const ChatMessageAttachment = t.Object({
  type: t.Literal("image"),
  url: t.String(),
  mimeType: t.Optional(t.String()),
  width: t.Optional(t.Integer({ minimum: 1 })),
  height: t.Optional(t.Integer({ minimum: 1 })),
});

const ChatMessageReactionCount = t.Object({
  emoji: reactionEmoji,
  count: t.Integer({ minimum: 0 }),
});

const ChatConversationLastMessage = t.Object({
  id: uuid,
  senderProfileId: t.Nullable(uuid),
  messageType: chatMessageTypeSchema,
  content: t.Nullable(t.String()),
  createdAt: t.Date(),
});

const ChatConversationReadState = t.Object({
  lastReadMessageId: t.Nullable(uuid),
  lastReadAt: t.Nullable(t.Date()),
  unreadCount: t.Integer({ minimum: 0 }),
  firstUnreadMessageId: t.Nullable(uuid),
  firstUnreadMessageCreatedAt: t.Nullable(t.Date()),
});

const ChatMessage = t.Object({
  id: uuid,
  conversationId: uuid,
  senderProfileId: t.Nullable(uuid),
  messageType: chatMessageTypeSchema,
  content: t.Nullable(t.String()),
  attachments: t.Array(ChatMessageAttachment),
  replyToMessageId: t.Nullable(uuid),
  editedAt: t.Nullable(t.Date()),
  deletedAt: t.Nullable(t.Date()),
  createdAt: t.Date(),
  updatedAt: t.Date(),
  reactionCounts: t.Array(ChatMessageReactionCount),
  viewerReactions: t.Array(reactionEmoji),
});

const ChatConversation = t.Object({
  id: uuid,
  profileOneId: uuid,
  profileTwoId: uuid,
  matchedProfileId: uuid,
  matchedProfile: ChatProfileSummary,
  isMatched: t.Boolean(),
  lastMessageAt: t.Nullable(t.Date()),
  lastMessage: t.Optional(ChatConversationLastMessage),
  readState: ChatConversationReadState,
  createdAt: t.Date(),
  updatedAt: t.Date(),
});

const ChatConversationListResponse = t.Object({
  data: t.Array(ChatConversation),
  cursor: t.Nullable(t.String({ format: "date-time" })),
});

const ChatMessageListResponse = t.Object({
  data: t.Array(ChatMessage),
  cursor: t.Nullable(t.String({ format: "date-time" })),
});

const ChatMessageInsert = t.Object({
  text: messageText,
  replyToMessageId: t.Optional(uuid),
});

const ChatMessageReactionInput = t.Object({
  emoji: reactionEmoji,
});

const ChatConversationReadUpdate = t.Object({
  messageId: t.Optional(uuid),
});

const ChatSocketMessage = t.Union([
  t.Object({
    type: t.Literal("ping"),
  }),
  t.Object({
    type: t.Literal("subscribe_conversation"),
    conversationId: uuid,
  }),
  t.Object({
    type: t.Literal("unsubscribe_conversation"),
    conversationId: uuid,
  }),
  t.Object({
    type: t.Literal("send_message"),
    conversationId: uuid,
    text: messageText,
    replyToMessageId: t.Optional(uuid),
    clientMessageId: t.Optional(t.String({ minLength: 1, maxLength: 120 })),
  }),
  t.Object({
    type: t.Literal("typing"),
    conversationId: uuid,
    isTyping: t.Boolean(),
  }),
  t.Object({
    type: t.Literal("mark_read"),
    conversationId: uuid,
    messageId: t.Optional(uuid),
  }),
  t.Object({
    type: t.Literal("add_reaction"),
    conversationId: uuid,
    messageId: uuid,
    emoji: reactionEmoji,
  }),
  t.Object({
    type: t.Literal("remove_reaction"),
    conversationId: uuid,
    messageId: uuid,
    emoji: reactionEmoji,
  }),
]);

export type ChatConversation = typeof ChatConversation.static;
export type ChatConversationLastMessage = typeof ChatConversationLastMessage.static;
export type ChatConversationReadState = typeof ChatConversationReadState.static;
export type ChatMessage = typeof ChatMessage.static;
export type ChatMessageAttachment = typeof ChatMessageAttachment.static;
export type ChatMessageReactionCount = typeof ChatMessageReactionCount.static;
export type ChatProfileSummary = typeof ChatProfileSummary.static;
export type ChatSocketMessage = typeof ChatSocketMessage.static;

export type ChatSocketEvent =
  | {
      type: "connected";
      profileId: string;
    }
  | {
      type: "conversation_subscribed";
      conversation: ChatConversation;
    }
  | {
      type: "conversation_unsubscribed";
      conversationId: string;
    }
  | {
      type: "conversation_upsert";
      conversation: ChatConversation;
    }
  | {
      type: "conversation_read";
      conversationId: string;
      profileId: string;
      readState: ChatConversationReadState;
    }
  | {
      type: "message";
      conversationId: string;
      message: ChatMessage;
      clientMessageId?: string;
    }
  | {
      type: "reaction";
      conversationId: string;
      messageId: string;
      reactionCounts: ChatMessageReactionCount[];
      profileId: string;
      emoji: string;
      reacted: boolean;
    }
  | {
      type: "typing";
      conversationId: string;
      profileId: string;
      isTyping: boolean;
    }
  | {
      type: "presence_snapshot";
      profiles: {
        profileId: string;
        online: boolean;
      }[];
    }
  | {
      type: "presence_changed";
      profileId: string;
      online: boolean;
    }
  | {
      type: "error";
      code: string;
      message: string;
      clientMessageId?: string;
      conversationId?: string;
    }
  | {
      type: "pong";
    };

export const chatModel = new Elysia({ name: "chat-model" }).model({
  ChatConversation,
  ChatConversationLastMessage,
  ChatConversationReadState,
  ChatConversationReadUpdate,
  ChatConversationListResponse,
  ChatMessage,
  ChatMessageAttachment,
  ChatMessageInsert,
  ChatMessageListResponse,
  ChatMessageReactionCount,
  ChatMessageReactionInput,
  ChatProfileSummary,
  ChatSocketMessage,
});
