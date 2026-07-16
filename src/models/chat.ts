import Elysia, { t } from "elysia";

import { chatMessageTypeSchema, profileTypeSchema } from "./enums";
import {
  REALTIME_PROTOCOL_VERSION,
  realtimeSchemas,
  type RealtimeSchemaVariant,
  realtimeUnion,
} from "./realtime";

const uuid = t.String({ format: "uuid" });
const messageText = t.String({ minLength: 1, maxLength: 4000 });
const reactionEmoji = t.String({ minLength: 1, maxLength: 64 });
const clientMessageId = t.String({
  minLength: 1,
  maxLength: 120,
  description:
    "Ephemeral request correlation value. It is not an idempotency key and must not be blindly replayed after reconnecting.",
});

export const ChatProfileSummary = t.Object({
  id: uuid,
  name: t.String(),
  profileType: profileTypeSchema,
});

export const ChatMessageAttachment = t.Object({
  type: t.Literal("image"),
  url: t.String(),
  mimeType: t.Optional(t.String()),
  width: t.Optional(t.Integer({ minimum: 1 })),
  height: t.Optional(t.Integer({ minimum: 1 })),
});

export const ChatMessageReactionCount = t.Object({
  emoji: reactionEmoji,
  count: t.Integer({ minimum: 0 }),
});

export const ChatConversationLastMessage = t.Object({
  id: uuid,
  senderProfileId: t.Nullable(uuid),
  messageType: chatMessageTypeSchema,
  content: t.Nullable(t.String()),
  createdAt: t.Date(),
});

export const ChatConversationReadState = t.Object({
  lastReadMessageId: t.Nullable(uuid),
  lastReadAt: t.Nullable(t.Date()),
  unreadCount: t.Integer({ minimum: 0 }),
  firstUnreadMessageId: t.Nullable(uuid),
  firstUnreadMessageCreatedAt: t.Nullable(t.Date()),
});

export const ChatMessage = t.Object({
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

export const ChatConversation = t.Object({
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

export const ChatPresence = t.Object({
  profileId: uuid,
  online: t.Boolean(),
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

export const ChatPingCommand = t.Object(
  {
    type: t.Literal("ping"),
  },
  { description: "Application-level heartbeat request." },
);

export const ChatSubscribeConversationCommand = t.Object(
  {
    type: t.Literal("subscribe_conversation"),
    conversationId: uuid,
  },
  { description: "Subscribes this socket to conversation-scoped events." },
);

export const ChatUnsubscribeConversationCommand = t.Object(
  {
    type: t.Literal("unsubscribe_conversation"),
    conversationId: uuid,
  },
  { description: "Stops conversation-scoped events for this socket." },
);

export const ChatSendMessageCommand = t.Object(
  {
    type: t.Literal("send_message"),
    conversationId: uuid,
    text: messageText,
    replyToMessageId: t.Optional(uuid),
    clientMessageId: t.Optional(clientMessageId),
  },
  { description: "Creates a text message in a conversation." },
);

export const ChatTypingCommand = t.Object(
  {
    type: t.Literal("typing"),
    conversationId: uuid,
    isTyping: t.Boolean(),
  },
  { description: "Updates ephemeral typing presence for a subscribed conversation." },
);

export const ChatMarkReadCommand = t.Object(
  {
    type: t.Literal("mark_read"),
    conversationId: uuid,
    messageId: t.Optional(uuid),
  },
  { description: "Advances the active profile's read state." },
);

export const ChatAddReactionCommand = t.Object(
  {
    type: t.Literal("add_reaction"),
    conversationId: uuid,
    messageId: uuid,
    emoji: reactionEmoji,
  },
  { description: "Adds the active profile's emoji reaction to a message." },
);

export const ChatRemoveReactionCommand = t.Object(
  {
    type: t.Literal("remove_reaction"),
    conversationId: uuid,
    messageId: uuid,
    emoji: reactionEmoji,
  },
  { description: "Removes the active profile's emoji reaction from a message." },
);

export const ChatConnectedEvent = t.Object(
  {
    type: t.Literal("connected"),
    profileId: uuid,
    protocolVersion: t.Literal(REALTIME_PROTOCOL_VERSION, {
      description:
        "Realtime wire protocol version. Clients must stop processing an unsupported version.",
    }),
  },
  { description: "Confirms the authenticated profile socket and protocol version." },
);

export const ChatConversationSubscribedEvent = t.Object(
  {
    type: t.Literal("conversation_subscribed"),
    conversation: ChatConversation,
  },
  { description: "Confirms a conversation subscription with its current REST-equivalent state." },
);

export const ChatConversationUnsubscribedEvent = t.Object(
  {
    type: t.Literal("conversation_unsubscribed"),
    conversationId: uuid,
  },
  { description: "Confirms that conversation-scoped delivery stopped." },
);

export const ChatConversationUpsertEvent = t.Object(
  {
    type: t.Literal("conversation_upsert"),
    conversation: ChatConversation,
  },
  { description: "Provides the latest canonical conversation state." },
);

export const ChatConversationReadEvent = t.Object(
  {
    type: t.Literal("conversation_read"),
    conversationId: uuid,
    profileId: uuid,
    readState: ChatConversationReadState,
  },
  { description: "Reports a participant's current conversation read state." },
);

export const ChatMessageEvent = t.Object(
  {
    type: t.Literal("message"),
    conversationId: uuid,
    message: ChatMessage,
    clientMessageId: t.Optional(clientMessageId),
  },
  { description: "Delivers a newly created canonical chat message." },
);

export const ChatReactionEvent = t.Object(
  {
    type: t.Literal("reaction"),
    conversationId: uuid,
    messageId: uuid,
    reactionCounts: t.Array(ChatMessageReactionCount),
    profileId: uuid,
    emoji: reactionEmoji,
    reacted: t.Boolean(),
  },
  { description: "Reports the canonical reaction totals after a profile reaction change." },
);

export const ChatTypingEvent = t.Object(
  {
    type: t.Literal("typing"),
    conversationId: uuid,
    profileId: uuid,
    isTyping: t.Boolean(),
  },
  { description: "Reports ephemeral typing state from another subscribed participant." },
);

export const ChatPresenceSnapshotEvent = t.Object(
  {
    type: t.Literal("presence_snapshot"),
    profiles: t.Array(ChatPresence),
  },
  { description: "Reports the current online state for relevant peer profiles." },
);

export const ChatPresenceChangedEvent = t.Object(
  {
    type: t.Literal("presence_changed"),
    profileId: uuid,
    online: t.Boolean(),
  },
  { description: "Reports an online-state change for a peer profile." },
);

export const ChatErrorEvent = t.Object(
  {
    type: t.Literal("error"),
    code: t.String(),
    message: t.String(),
    clientMessageId: t.Optional(clientMessageId),
    conversationId: t.Optional(uuid),
  },
  { description: "Reports a recoverable command error without closing the socket." },
);

export const ChatPongEvent = t.Object(
  {
    type: t.Literal("pong"),
  },
  { description: "Acknowledges an application-level heartbeat request." },
);

const exampleIds = {
  profile: "00000000-0000-4000-8000-000000000001",
  peerProfile: "00000000-0000-4000-8000-000000000002",
  conversation: "00000000-0000-4000-8000-000000000003",
  message: "00000000-0000-4000-8000-000000000004",
  reply: "00000000-0000-4000-8000-000000000005",
} as const;
const exampleTimestamp = "2026-07-16T12:00:00.000Z";
const exampleReadState = {
  lastReadMessageId: exampleIds.message,
  lastReadAt: exampleTimestamp,
  unreadCount: 0,
  firstUnreadMessageId: null,
  firstUnreadMessageCreatedAt: null,
};
const exampleMessage = {
  id: exampleIds.message,
  conversationId: exampleIds.conversation,
  senderProfileId: exampleIds.profile,
  messageType: "text",
  content: "See you tonight!",
  attachments: [],
  replyToMessageId: null,
  editedAt: null,
  deletedAt: null,
  createdAt: exampleTimestamp,
  updatedAt: exampleTimestamp,
  reactionCounts: [{ emoji: "❤️", count: 1 }],
  viewerReactions: ["❤️"],
};
const exampleConversation = {
  id: exampleIds.conversation,
  profileOneId: exampleIds.profile,
  profileTwoId: exampleIds.peerProfile,
  matchedProfileId: exampleIds.peerProfile,
  matchedProfile: {
    id: exampleIds.peerProfile,
    name: "Alex",
    profileType: "solo",
  },
  isMatched: true,
  lastMessageAt: exampleTimestamp,
  lastMessage: {
    id: exampleIds.message,
    senderProfileId: exampleIds.profile,
    messageType: "text",
    content: "See you tonight!",
    createdAt: exampleTimestamp,
  },
  readState: exampleReadState,
  createdAt: exampleTimestamp,
  updatedAt: exampleTimestamp,
};

export const chatClientCommandRegistry = [
  {
    name: "ChatPingCommand",
    wireType: "ping",
    schema: ChatPingCommand,
    summary: "Ping the chat socket",
    description: "The mobile client sends an application-level heartbeat request.",
    example: { type: "ping" },
  },
  {
    name: "ChatSubscribeConversationCommand",
    wireType: "subscribe_conversation",
    schema: ChatSubscribeConversationCommand,
    summary: "Subscribe to a conversation",
    description: "Begin receiving conversation-scoped events on this socket.",
    example: { type: "subscribe_conversation", conversationId: exampleIds.conversation },
  },
  {
    name: "ChatUnsubscribeConversationCommand",
    wireType: "unsubscribe_conversation",
    schema: ChatUnsubscribeConversationCommand,
    summary: "Unsubscribe from a conversation",
    description: "Stop receiving conversation-scoped events on this socket.",
    example: { type: "unsubscribe_conversation", conversationId: exampleIds.conversation },
  },
  {
    name: "ChatSendMessageCommand",
    wireType: "send_message",
    schema: ChatSendMessageCommand,
    summary: "Send a chat message",
    description:
      "Create a message. clientMessageId correlates the response only and is not an idempotency key.",
    example: {
      type: "send_message",
      conversationId: exampleIds.conversation,
      text: "See you tonight!",
      replyToMessageId: exampleIds.reply,
      clientMessageId: "mobile-message-42",
    },
    correlationId: true,
  },
  {
    name: "ChatTypingCommand",
    wireType: "typing",
    schema: ChatTypingCommand,
    summary: "Update typing state",
    description: "Send ephemeral typing state for a subscribed conversation.",
    example: { type: "typing", conversationId: exampleIds.conversation, isTyping: true },
  },
  {
    name: "ChatMarkReadCommand",
    wireType: "mark_read",
    schema: ChatMarkReadCommand,
    summary: "Mark a conversation read",
    description: "Advance the active profile's read state, optionally through a specific message.",
    example: {
      type: "mark_read",
      conversationId: exampleIds.conversation,
      messageId: exampleIds.message,
    },
  },
  {
    name: "ChatAddReactionCommand",
    wireType: "add_reaction",
    schema: ChatAddReactionCommand,
    summary: "Add a message reaction",
    description: "Add the active profile's emoji reaction to a message.",
    example: {
      type: "add_reaction",
      conversationId: exampleIds.conversation,
      messageId: exampleIds.message,
      emoji: "❤️",
    },
  },
  {
    name: "ChatRemoveReactionCommand",
    wireType: "remove_reaction",
    schema: ChatRemoveReactionCommand,
    summary: "Remove a message reaction",
    description: "Remove the active profile's emoji reaction from a message.",
    example: {
      type: "remove_reaction",
      conversationId: exampleIds.conversation,
      messageId: exampleIds.message,
      emoji: "❤️",
    },
  },
] as const satisfies readonly RealtimeSchemaVariant[];

export const chatServerEventRegistry = [
  {
    name: "ChatConnectedEvent",
    wireType: "connected",
    schema: ChatConnectedEvent,
    summary: "Chat socket connected",
    description: "Confirms the active profile and announces the realtime protocol version.",
    example: {
      type: "connected",
      profileId: exampleIds.profile,
      protocolVersion: REALTIME_PROTOCOL_VERSION,
    },
  },
  {
    name: "ChatConversationSubscribedEvent",
    wireType: "conversation_subscribed",
    schema: ChatConversationSubscribedEvent,
    summary: "Conversation subscription confirmed",
    description: "Confirms a conversation subscription with current conversation state.",
    example: { type: "conversation_subscribed", conversation: exampleConversation },
  },
  {
    name: "ChatConversationUnsubscribedEvent",
    wireType: "conversation_unsubscribed",
    schema: ChatConversationUnsubscribedEvent,
    summary: "Conversation unsubscription confirmed",
    description: "Confirms that conversation-scoped delivery stopped.",
    example: { type: "conversation_unsubscribed", conversationId: exampleIds.conversation },
  },
  {
    name: "ChatConversationUpsertEvent",
    wireType: "conversation_upsert",
    schema: ChatConversationUpsertEvent,
    summary: "Conversation state changed",
    description: "Carries the latest canonical conversation state.",
    example: { type: "conversation_upsert", conversation: exampleConversation },
  },
  {
    name: "ChatConversationReadEvent",
    wireType: "conversation_read",
    schema: ChatConversationReadEvent,
    summary: "Conversation read state changed",
    description: "Reports a participant's canonical conversation read state.",
    example: {
      type: "conversation_read",
      conversationId: exampleIds.conversation,
      profileId: exampleIds.profile,
      readState: exampleReadState,
    },
  },
  {
    name: "ChatMessageEvent",
    wireType: "message",
    schema: ChatMessageEvent,
    summary: "Chat message created",
    description: "Carries the new canonical message and optional command correlation value.",
    example: {
      type: "message",
      conversationId: exampleIds.conversation,
      message: exampleMessage,
      clientMessageId: "mobile-message-42",
    },
    correlationId: true,
  },
  {
    name: "ChatReactionEvent",
    wireType: "reaction",
    schema: ChatReactionEvent,
    summary: "Message reaction changed",
    description: "Carries the updated aggregate reaction counts and actor state.",
    example: {
      type: "reaction",
      conversationId: exampleIds.conversation,
      messageId: exampleIds.message,
      reactionCounts: [{ emoji: "❤️", count: 1 }],
      profileId: exampleIds.profile,
      emoji: "❤️",
      reacted: true,
    },
  },
  {
    name: "ChatTypingEvent",
    wireType: "typing",
    schema: ChatTypingEvent,
    summary: "Participant typing state changed",
    description: "Carries ephemeral typing state for another subscribed participant.",
    example: {
      type: "typing",
      conversationId: exampleIds.conversation,
      profileId: exampleIds.peerProfile,
      isTyping: true,
    },
  },
  {
    name: "ChatPresenceSnapshotEvent",
    wireType: "presence_snapshot",
    schema: ChatPresenceSnapshotEvent,
    summary: "Presence snapshot available",
    description: "Carries current online state for relevant peer profiles.",
    example: {
      type: "presence_snapshot",
      profiles: [{ profileId: exampleIds.peerProfile, online: true }],
    },
  },
  {
    name: "ChatPresenceChangedEvent",
    wireType: "presence_changed",
    schema: ChatPresenceChangedEvent,
    summary: "Profile presence changed",
    description: "Reports a peer profile's latest online state.",
    example: { type: "presence_changed", profileId: exampleIds.peerProfile, online: true },
  },
  {
    name: "ChatErrorEvent",
    wireType: "error",
    schema: ChatErrorEvent,
    summary: "Chat command failed",
    description: "Reports a recoverable command error and any available correlation context.",
    example: {
      type: "error",
      code: "reply_not_found",
      message: "Reply target message not found",
      clientMessageId: "mobile-message-42",
      conversationId: exampleIds.conversation,
    },
    correlationId: true,
  },
  {
    name: "ChatPongEvent",
    wireType: "pong",
    schema: ChatPongEvent,
    summary: "Chat heartbeat acknowledged",
    description: "Acknowledges a chat ping command.",
    example: { type: "pong" },
  },
] as const satisfies readonly RealtimeSchemaVariant[];

export const ChatClientCommand = realtimeUnion(chatClientCommandRegistry);
export const ChatServerEvent = realtimeUnion(chatServerEventRegistry);

export type ChatClientCommand = typeof ChatClientCommand.static;
export type ChatServerEvent = typeof ChatServerEvent.static;
export type ChatConversation = typeof ChatConversation.static;
export type ChatConversationLastMessage = typeof ChatConversationLastMessage.static;
export type ChatConversationReadState = typeof ChatConversationReadState.static;
export type ChatMessage = typeof ChatMessage.static;
export type ChatMessageAttachment = typeof ChatMessageAttachment.static;
export type ChatMessageReactionCount = typeof ChatMessageReactionCount.static;
export type ChatPresence = typeof ChatPresence.static;
export type ChatProfileSummary = typeof ChatProfileSummary.static;

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
  ChatPresence,
  ChatProfileSummary,
  ...realtimeSchemas(chatClientCommandRegistry, chatServerEventRegistry),
  ChatClientCommand,
  ChatServerEvent,
});
