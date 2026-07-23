import Elysia, { t } from "elysia";

import {
  CHAT_MESSAGE_SEND_COMMAND_NAME,
  CHAT_MESSAGE_SEND_COMMAND_VERSION,
  readTransactionalChatPolicy,
} from "@/config/transactional-chat-policy";
import { chatModel } from "@/models/chat";
import { commonModel } from "@/models/common";
import { OpaqueCursor } from "@/models/cursor";
import { REALTIME_PROTOCOL_VERSION } from "@/models/realtime";
import { auth } from "@/plugins/auth";
import {
  broadcastChatPresenceChanged,
  getChatConversation,
  getChatPresenceSnapshot,
  getChatUnreadCount,
  isCanonicalMessageIdempotencyKey,
  listChatConversations,
  listChatMessages,
  markChatConversationRead,
  sendTextMessage,
  setMessageReaction,
} from "@/services/chat-service";
import { chatSockets } from "@/services/chat-sockets";

type ChatErrorCode =
  | "conversation_not_found"
  | "conversation_not_matched"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "invalid_message"
  | "invalid_reaction"
  | "invalid_reply_target"
  | "message_not_found"
  | "profile_not_found";

const uuidParam = t.String({ format: "uuid" });

const chatErrorStatus = (code: ChatErrorCode) => {
  if (
    code === "conversation_not_matched" ||
    code === "idempotency_conflict" ||
    code === "idempotency_in_progress"
  )
    return 409;
  if (code === "invalid_message" || code === "invalid_reaction" || code === "invalid_reply_target")
    return 422;
  return 404;
};

const messageIdempotencyKeyError = (value: string | undefined) => {
  if (!value) {
    return {
      code: "idempotency_key_required" as const,
      message: "Idempotency-Key is required",
    };
  }
  if (!isCanonicalMessageIdempotencyKey(value)) {
    return {
      code: "invalid_idempotency_key" as const,
      message: "Idempotency-Key must be a canonical lowercase RFC 4122 UUID",
    };
  }
  return null;
};

export const chatRoutes = new Elysia({ prefix: "/api/chat", tags: ["Chat"] })
  .use(auth)
  .use(chatModel)
  .use(commonModel)
  .get(
    "/profiles/:profileId/unread-count",
    async ({ params, status, user }) => {
      const result = await getChatUnreadCount({
        profileId: params.profileId,
        userId: user.id,
      });
      if (!result.ok) return status(404, { code: result.code, message: result.message });
      return result.data;
    },
    {
      auth: true,
      params: t.Object({
        profileId: uuidParam,
      }),
      response: {
        200: "ChatUnreadCount",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "getChatUnreadCount",
        security: [{ bearerAuth: [] }],
      },
    },
  )
  .get(
    "/profiles/:profileId/conversations",
    async ({ params, query, status, user }) => {
      const result = await listChatConversations({
        profileId: params.profileId,
        userId: user.id,
        cursor: query.cursor,
        limit: query.limit,
      });

      if (!result.ok) return status(404, { code: result.code, message: result.message });

      return result.data;
    },
    {
      auth: true,
      params: t.Object({
        profileId: uuidParam,
      }),
      query: t.Object({
        cursor: t.Optional(OpaqueCursor),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, multipleOf: 1 })),
      }),
      response: {
        200: "ChatConversationListResponse",
        400: "ApiErrorResponse",
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

      if (!result.ok) return status(404, { code: result.code, message: result.message });

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

      if (!result.ok) return status(404, { code: result.code, message: result.message });

      return result.data;
    },
    {
      auth: true,
      params: t.Object({
        profileId: uuidParam,
        conversationId: uuidParam,
      }),
      query: t.Object({
        cursor: t.Optional(OpaqueCursor),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, multipleOf: 1 })),
      }),
      response: {
        200: "ChatMessageListResponse",
        400: "ApiErrorResponse",
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
        policy: readTransactionalChatPolicy(),
      });

      if (!result.ok) return status(404, { code: result.code, message: result.message });

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
    async ({ body, headers, params, set, status, user }) => {
      const idempotencyKey = headers["idempotency-key"];
      const keyError = messageIdempotencyKeyError(idempotencyKey);
      if (keyError) return status(400, keyError);

      const result = await sendTextMessage({
        profileId: params.profileId,
        conversationId: params.conversationId,
        userId: user.id,
        text: body.text,
        replyToMessageId: body.replyToMessageId,
        idempotencyKey: idempotencyKey!,
        policy: readTransactionalChatPolicy(),
      });

      if (!result.ok) {
        if (result.replayed !== undefined)
          set.headers["Idempotency-Replayed"] = String(result.replayed);
        if (result.code === "idempotency_in_progress") set.headers["Retry-After"] = "1";
        return status(result.httpStatus, { code: result.code, message: result.message });
      }

      set.headers["Idempotency-Replayed"] = String(result.replayed);
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
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
        422: "ApiErrorResponse",
      },
      detail: {
        operationId: "sendChatMessage",
        security: [{ bearerAuth: [] }],
        parameters: [
          {
            in: "header",
            name: "Idempotency-Key",
            required: true,
            description: "Canonical lowercase RFC 4122 UUID scoped to chat.message.send.",
            schema: {
              type: "string",
              format: "uuid",
              pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            },
          },
        ],
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
        policy: readTransactionalChatPolicy(),
      });

      if (!result.ok)
        return status(chatErrorStatus(result.code), {
          code: result.code,
          message: result.message,
        });

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
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
        422: "ApiErrorResponse",
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
        policy: readTransactionalChatPolicy(),
      });

      if (!result.ok)
        return status(chatErrorStatus(result.code), {
          code: result.code,
          message: result.message,
        });

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
        404: "ApiErrorResponse",
        409: "ApiErrorResponse",
        422: "ApiErrorResponse",
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
    parse(_ws, message) {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "send_message" &&
        !("idempotencyKey" in message)
      ) {
        return {
          ...message,
          idempotencyKey: "",
        } as never;
      }
      return message as never;
    },
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
        const keyError = messageIdempotencyKeyError(message.idempotencyKey);
        if (keyError) {
          ws.send({
            type: "error",
            code: keyError.code,
            message: keyError.message,
            ...(message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : {}),
            clientMessageId: message.clientMessageId,
            conversationId: message.conversationId,
          });
          return;
        }

        const result = await sendTextMessage({
          profileId,
          conversationId: message.conversationId,
          userId: ws.data.user.id,
          text: message.text,
          replyToMessageId: message.replyToMessageId,
          idempotencyKey: message.idempotencyKey,
          policy: readTransactionalChatPolicy(),
        });

        if (!result.ok) {
          if (result.terminalCommandResult) {
            ws.send({
              type: "send_message_result",
              command: CHAT_MESSAGE_SEND_COMMAND_NAME,
              commandVersion: CHAT_MESSAGE_SEND_COMMAND_VERSION,
              idempotencyKey: message.idempotencyKey,
              clientMessageId: message.clientMessageId,
              replayed: result.replayed ?? false,
              result: {
                status: "rejected",
                error: {
                  code: result.code,
                  message: result.message,
                },
              },
            });
            return;
          }

          ws.send({
            type: "error",
            code: result.code,
            message: result.message,
            idempotencyKey: message.idempotencyKey,
            clientMessageId: message.clientMessageId,
            conversationId: message.conversationId,
          });
          return;
        }

        ws.send({
          type: "send_message_result",
          command: CHAT_MESSAGE_SEND_COMMAND_NAME,
          commandVersion: CHAT_MESSAGE_SEND_COMMAND_VERSION,
          idempotencyKey: message.idempotencyKey,
          clientMessageId: message.clientMessageId,
          replayed: result.replayed,
          result: {
            status: "succeeded",
            message: result.data,
          },
        });

        return;
      }

      if (message.type === "mark_read") {
        const result = await markChatConversationRead({
          profileId,
          conversationId: message.conversationId,
          userId: ws.data.user.id,
          messageId: message.messageId,
          policy: readTransactionalChatPolicy(),
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
        policy: readTransactionalChatPolicy(),
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
