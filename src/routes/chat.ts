import Elysia, { t } from "elysia";

import { chatModel } from "@/models/chat";
import { commonModel } from "@/models/common";
import { auth } from "@/plugins/auth";
import {
  getChatConversation,
  listChatConversations,
  listChatMessages,
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
        404: "MessageResponse",
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
        404: "MessageResponse",
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
        404: "MessageResponse",
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
      params: t.Object({
        profileId: uuidParam,
        conversationId: uuidParam,
      }),
      body: "ChatMessageInsert",
      response: {
        201: "ChatMessage",
        400: "MessageResponse",
        403: "MessageResponse",
        404: "MessageResponse",
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
      params: t.Object({
        profileId: uuidParam,
        conversationId: uuidParam,
        messageId: uuidParam,
      }),
      body: "ChatMessageReactionInput",
      response: {
        200: "ChatMessage",
        400: "MessageResponse",
        403: "MessageResponse",
        404: "MessageResponse",
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
      params: t.Object({
        profileId: uuidParam,
        conversationId: uuidParam,
        messageId: uuidParam,
      }),
      body: "ChatMessageReactionInput",
      response: {
        200: "ChatMessage",
        400: "MessageResponse",
        403: "MessageResponse",
        404: "MessageResponse",
      },
    },
  )
  .ws("/profiles/:profileId/conversations/:conversationId/ws", {
    auth: true,
    params: t.Object({
      profileId: uuidParam,
      conversationId: uuidParam,
    }),
    body: "ChatSocketMessage",
    async open(ws) {
      const { conversationId, profileId } = ws.data.params;
      const result = await getChatConversation({
        profileId,
        conversationId,
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

      chatSockets.add(conversationId, {
        id: ws.id,
        userId: ws.data.user.id,
        profileId,
        send: (event) => ws.send(event),
      });

      ws.send({
        type: "connected",
        conversation: result.data,
      });

      chatSockets.sendToConversation(
        conversationId,
        {
          type: "presence",
          profileId,
          online: true,
        },
        { excludeSocketId: ws.id },
      );
    },
    async message(ws, message) {
      const { conversationId, profileId } = ws.data.params;

      if (message.type === "ping") {
        ws.send({ type: "pong" });
        return;
      }

      if (message.type === "typing") {
        chatSockets.sendToConversation(
          conversationId,
          {
            type: "typing",
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
          conversationId,
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
          });
        }

        return;
      }

      const result = await setMessageReaction({
        profileId,
        conversationId,
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
        });
      }
    },
    close(ws) {
      const { conversationId, profileId } = ws.data.params;
      chatSockets.remove(conversationId, ws.id);

      if (!chatSockets.isProfileInConversation(conversationId, profileId)) {
        chatSockets.sendToConversation(conversationId, {
          type: "presence",
          profileId,
          online: false,
        });
      }
    },
  });
