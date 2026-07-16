import Elysia, { t } from "elysia";

import { chatModel } from "@/models/chat";
import { commonModel } from "@/models/common";
import { REALTIME_PROTOCOL_VERSION } from "@/models/realtime";
import { auth } from "@/plugins/auth";
import {
  broadcastChatPresenceChanged,
  getChatConversation,
  getChatPresenceSnapshot,
  listChatConversations,
  listChatMessages,
  markChatConversationRead,
  sendTextMessage,
  setMessageReaction,
} from "@/services/chat-service";
import { chatSockets } from "@/services/chat-sockets";

type ChatErrorCode =
  | "conversation_not_found"
  | "empty_message"
  | "message_not_found"
  | "not_matched"
  | "profile_not_found"
  | "reply_not_found";

const uuidParam = t.String({ format: "uuid" });

const chatErrorStatus = (code: ChatErrorCode) => {
  if (code === "not_matched") return 403;
  if (code === "empty_message" || code === "reply_not_found") return 400;
  return 404;
};

export const chatRoutes = new Elysia({ prefix: "/api/chat", tags: ["Chat"] })
  .use(auth)
  .use(chatModel)
  .use(commonModel)
  .get(
    "/profiles/:profileId/conversations",
    async ({ params, query, status, user }) => {
      const result = await listChatConversations({
        profileId: params.profileId,
        userId: user.id,
        cursor: query.cursor,
        limit: query.limit,
      });

      if (!result.ok) return status(404, { message: result.message });

      return result.data;
    },
    {
      auth: true,
      params: t.Object({
        profileId: uuidParam,
      }),
      query: t.Object({
        cursor: t.Optional(t.String({ format: "date-time" })),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, multipleOf: 1 })),
      }),
      response: {
        200: "ChatConversationListResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "listChatConversations",
        security: [{ bearerAuth: [] }],
      },
    },
  )
  .get(
    "/profiles/:profileId/conversations/:conversationId",
    async ({ params, status, user }) => {
      const result = await getChatConversation({
        profileId: params.profileId,
        conversationId: params.conversationId,
        userId: user.id,
      });

      if (!result.ok) return status(404, { message: result.message });

      return result.data;
    },
    {
      auth: true,
      params: t.Object({
        profileId: uuidParam,
        conversationId: uuidParam,
      }),
      response: {
        200: "ChatConversation",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "getChatConversation",
        security: [{ bearerAuth: [] }],
      },
    },
  )
  .get(
    "/profiles/:profileId/conversations/:conversationId/messages",
    async ({ params, query, status, user }) => {
      const result = await listChatMessages({
        profileId: params.profileId,
        conversationId: params.conversationId,
        userId: user.id,
        cursor: query.cursor,
        limit: query.limit,
      });

      if (!result.ok) return status(404, { message: result.message });

      return result.data;
    },
    {
      auth: true,
      params: t.Object({
        profileId: uuidParam,
        conversationId: uuidParam,
      }),
      query: t.Object({
        cursor: t.Optional(t.String({ format: "date-time" })),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, multipleOf: 1 })),
      }),
      response: {
        200: "ChatMessageListResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "listChatMessages",
        security: [{ bearerAuth: [] }],
      },
    },
  )
  .post(
    "/profiles/:profileId/conversations/:conversationId/read",
    async ({ body, params, status, user }) => {
      const result = await markChatConversationRead({
        profileId: params.profileId,
        conversationId: params.conversationId,
        userId: user.id,
        messageId: body.messageId,
      });

      if (!result.ok) return status(chatErrorStatus(result.code), { message: result.message });

      return result.data;
    },
    {
      auth: true,
      parse: "json",
      params: t.Object({
        profileId: uuidParam,
        conversationId: uuidParam,
      }),
      body: "ChatConversationReadUpdate",
      response: {
        200: "ChatConversation",
        400: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "markChatConversationRead",
        security: [{ bearerAuth: [] }],
      },
    },
  )
  .post(
    "/profiles/:profileId/conversations/:conversationId/messages",
    async ({ body, params, status, user }) => {
      const result = await sendTextMessage({
        profileId: params.profileId,
        conversationId: params.conversationId,
        userId: user.id,
        text: body.text,
        replyToMessageId: body.replyToMessageId,
      });

      if (!result.ok) return status(chatErrorStatus(result.code), { message: result.message });

      return status(201, result.data);
    },
    {
      auth: true,
      parse: "json",
      params: t.Object({
        profileId: uuidParam,
        conversationId: uuidParam,
      }),
      body: "ChatMessageInsert",
      response: {
        201: "ChatMessage",
        400: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "sendChatMessage",
        security: [{ bearerAuth: [] }],
      },
    },
  )
  .put(
    "/profiles/:profileId/conversations/:conversationId/messages/:messageId/reactions",
    async ({ body, params, status, user }) => {
      const result = await setMessageReaction({
        profileId: params.profileId,
        conversationId: params.conversationId,
        messageId: params.messageId,
        userId: user.id,
        emoji: body.emoji,
        reacted: true,
      });

      if (!result.ok) return status(chatErrorStatus(result.code), { message: result.message });

      return result.data;
    },
    {
      auth: true,
      parse: "json",
      params: t.Object({
        profileId: uuidParam,
        conversationId: uuidParam,
        messageId: uuidParam,
      }),
      body: "ChatMessageReactionInput",
      response: {
        200: "ChatMessage",
        400: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "addChatMessageReaction",
        security: [{ bearerAuth: [] }],
      },
    },
  )
  .delete(
    "/profiles/:profileId/conversations/:conversationId/messages/:messageId/reactions",
    async ({ body, params, status, user }) => {
      const result = await setMessageReaction({
        profileId: params.profileId,
        conversationId: params.conversationId,
        messageId: params.messageId,
        userId: user.id,
        emoji: body.emoji,
        reacted: false,
      });

      if (!result.ok) return status(chatErrorStatus(result.code), { message: result.message });

      return result.data;
    },
    {
      auth: true,
      parse: "json",
      params: t.Object({
        profileId: uuidParam,
        conversationId: uuidParam,
        messageId: uuidParam,
      }),
      body: "ChatMessageReactionInput",
      response: {
        200: "ChatMessage",
        400: "ApiErrorResponse",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "removeChatMessageReaction",
        security: [{ bearerAuth: [] }],
      },
    },
  )
  .ws("/profiles/:profileId/ws", {
    auth: true,
    params: t.Object({
      profileId: uuidParam,
    }),
    body: "ChatClientCommand",
    async open(ws) {
      const { profileId } = ws.data.params;
      const result = await getChatPresenceSnapshot({
        profileId,
        userId: ws.data.user.id,
      });

      if (!result.ok) {
        ws.send({
          type: "error",
          code: result.code,
          message: result.message,
        });
        ws.close(1008, result.message);
        return;
      }

      const { wasFirstProfileSocket } = chatSockets.add({
        id: ws.id,
        userId: ws.data.user.id,
        profileId,
        send: (event) => ws.send(event),
      });

      ws.send({
        type: "connected",
        profileId,
        protocolVersion: REALTIME_PROTOCOL_VERSION,
      });
      ws.send({
        type: "presence_snapshot",
        profiles: result.data,
      });

      if (wasFirstProfileSocket) await broadcastChatPresenceChanged(profileId, true);
    },
    async message(ws, message) {
      const { profileId } = ws.data.params;

      if (message.type === "ping") {
        ws.send({ type: "pong" });
        return;
      }

      if (message.type === "subscribe_conversation") {
        const result = await getChatConversation({
          profileId,
          conversationId: message.conversationId,
          userId: ws.data.user.id,
        });

        if (!result.ok) {
          ws.send({
            type: "error",
            code: result.code,
            message: result.message,
            conversationId: message.conversationId,
          });
          return;
        }

        chatSockets.subscribe(ws.id, message.conversationId);
        ws.send({
          type: "conversation_subscribed",
          conversation: result.data,
        });
        ws.send({
          type: "presence_snapshot",
          profiles: [
            {
              profileId: result.data.matchedProfileId,
              online: chatSockets.isProfileOnline(result.data.matchedProfileId),
            },
          ],
        });
        return;
      }

      if (message.type === "unsubscribe_conversation") {
        chatSockets.unsubscribe(ws.id, message.conversationId);
        ws.send({
          type: "conversation_unsubscribed",
          conversationId: message.conversationId,
        });
        return;
      }

      if (message.type === "typing") {
        if (!chatSockets.isSocketSubscribed(ws.id, message.conversationId)) {
          ws.send({
            type: "error",
            code: "not_subscribed",
            message: "Subscribe to the conversation before sending typing events",
            conversationId: message.conversationId,
          });
          return;
        }

        chatSockets.sendToConversationSubscribers(
          message.conversationId,
          {
            type: "typing",
            conversationId: message.conversationId,
            profileId,
            isTyping: message.isTyping,
          },
          { excludeSocketId: ws.id },
        );
        return;
      }

      if (message.type === "send_message") {
        const result = await sendTextMessage({
          profileId,
          conversationId: message.conversationId,
          userId: ws.data.user.id,
          text: message.text,
          replyToMessageId: message.replyToMessageId,
          clientMessageId: message.clientMessageId,
        });

        if (!result.ok) {
          ws.send({
            type: "error",
            code: result.code,
            message: result.message,
            clientMessageId: message.clientMessageId,
            conversationId: message.conversationId,
          });
          return;
        }

        if (!chatSockets.isSocketSubscribed(ws.id, message.conversationId)) {
          ws.send({
            type: "message",
            conversationId: message.conversationId,
            message: result.data,
            clientMessageId: message.clientMessageId,
          });
        }

        return;
      }

      if (message.type === "mark_read") {
        const result = await markChatConversationRead({
          profileId,
          conversationId: message.conversationId,
          userId: ws.data.user.id,
          messageId: message.messageId,
        });

        if (!result.ok) {
          ws.send({
            type: "error",
            code: result.code,
            message: result.message,
            conversationId: message.conversationId,
          });
          return;
        }

        return;
      }

      const result = await setMessageReaction({
        profileId,
        conversationId: message.conversationId,
        messageId: message.messageId,
        userId: ws.data.user.id,
        emoji: message.emoji,
        reacted: message.type === "add_reaction",
      });

      if (!result.ok) {
        ws.send({
          type: "error",
          code: result.code,
          message: result.message,
          conversationId: message.conversationId,
        });
      }
    },
    async close(ws) {
      const result = chatSockets.remove(ws.id);
      if (result?.wasLastProfileSocket) {
        await broadcastChatPresenceChanged(result.profileId, false);
      }
    },
  });
