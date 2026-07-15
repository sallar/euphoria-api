import Elysia, { t } from "elysia";

import { commonModel } from "@/models/common";
import { notificationModel, PushToken } from "@/models/notification";
import { auth } from "@/plugins/auth";
import {
  archiveNotification,
  disablePushToken,
  getUnreadNotificationCount,
  listNotifications,
  listPushTokens,
  markAllNotificationsRead,
  markNotificationRead,
  registerPushToken,
} from "@/services/notification-service";
import { notificationSockets } from "@/services/notification-sockets";
import { sendRandomTestNotification } from "@/services/test-notification-service";

export const notificationRoutes = new Elysia({
  prefix: "/api/notifications",
  tags: ["Notifications"],
})
  .use(auth)
  .use(notificationModel)
  .use(commonModel)
  .get(
    "/test/:userId",
    async ({ params, status, user }) => {
      if (params.userId !== user.id)
        return status(403, {
          code: "forbidden",
          message: "Test notifications can only be sent to the authenticated user",
        });

      const result = await sendRandomTestNotification(params.userId);
      if (!result) return status(404, { message: "User not found" });

      return status(201, result.notification);
    },
    {
      auth: true,
      params: t.Object({
        userId: t.String({ minLength: 1 }),
      }),
      response: {
        201: "Notification",
        403: "ApiErrorResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "sendTestNotification",
        security: [{ bearerAuth: [] }],
        summary: "Send a test notification to the authenticated user",
      },
    },
  )
  .get(
    "/",
    async ({ query, user }) =>
      listNotifications({
        cursor: query.cursor,
        limit: query.limit,
        unreadOnly: query.unreadOnly,
        userId: user.id,
      }),
    {
      auth: true,
      query: t.Object({
        cursor: t.Optional(t.String({ format: "date-time" })),
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, multipleOf: 1 })),
        unreadOnly: t.Optional(t.BooleanString()),
      }),
      response: {
        200: "NotificationListResponse",
      },
      detail: {
        operationId: "listNotifications",
        security: [{ bearerAuth: [] }],
      },
    },
  )
  .get(
    "/unread-count",
    async ({ user }) => ({
      count: await getUnreadNotificationCount(user.id),
    }),
    {
      auth: true,
      response: {
        200: "NotificationUnreadCount",
      },
      detail: {
        operationId: "getNotificationUnreadCount",
        security: [{ bearerAuth: [] }],
      },
    },
  )
  .patch(
    "/read-all",
    async ({ user }) => ({
      count: await markAllNotificationsRead(user.id),
    }),
    {
      auth: true,
      response: {
        200: "NotificationReadAllResponse",
      },
      detail: {
        operationId: "markAllNotificationsRead",
        security: [{ bearerAuth: [] }],
      },
    },
  )
  .patch(
    "/:id/read",
    async ({ params, status, user }) => {
      const notification = await markNotificationRead(user.id, params.id);
      if (!notification) return status(404, { message: "Notification not found" });

      return notification;
    },
    {
      auth: true,
      params: t.Object({ id: t.String({ format: "uuid" }) }),
      response: {
        200: "Notification",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "markNotificationRead",
        security: [{ bearerAuth: [] }],
      },
    },
  )
  .delete(
    "/:id",
    async ({ params, status, user }) => {
      const archived = await archiveNotification(user.id, params.id);
      if (!archived) return status(404, { message: "Notification not found" });

      return { message: "Notification dismissed" };
    },
    {
      auth: true,
      params: t.Object({ id: t.String({ format: "uuid" }) }),
      response: {
        200: "MessageResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "dismissNotification",
        security: [{ bearerAuth: [] }],
      },
    },
  )
  .get("/push-tokens", async ({ user }) => listPushTokens(user.id), {
    auth: true,
    response: {
      200: t.Array(PushToken),
    },
    detail: {
      operationId: "listPushTokens",
      security: [{ bearerAuth: [] }],
    },
  })
  .post(
    "/push-tokens",
    async ({ body, status, user }) => {
      const token = await registerPushToken({
        userId: user.id,
        token: body.token,
        platform: body.platform,
        deviceId: body.deviceId,
      });

      return status(201, token);
    },
    {
      auth: true,
      parse: "json",
      body: "PushTokenInsert",
      response: {
        201: "PushToken",
      },
      detail: {
        operationId: "registerPushToken",
        security: [{ bearerAuth: [] }],
      },
    },
  )
  .delete(
    "/push-tokens/:id",
    async ({ params, status, user }) => {
      const disabled = await disablePushToken(user.id, params.id);
      if (!disabled) return status(404, { message: "Push token not found" });

      return { message: "Push token disabled" };
    },
    {
      auth: true,
      params: t.Object({ id: t.String({ format: "uuid" }) }),
      response: {
        200: "MessageResponse",
        404: "ApiErrorResponse",
      },
      detail: {
        operationId: "disablePushToken",
        security: [{ bearerAuth: [] }],
      },
    },
  )
  .ws("/ws", {
    auth: true,
    body: "NotificationSocketMessage",
    async open(ws) {
      notificationSockets.add(ws.data.user.id, ws);
      ws.send({
        type: "connected",
        unreadCount: await getUnreadNotificationCount(ws.data.user.id),
      });
    },
    async message(ws, message) {
      if (message.type === "ping") {
        ws.send({ type: "pong" });
        return;
      }

      if (message.type === "mark_read") {
        const notification = await markNotificationRead(ws.data.user.id, message.notificationId);
        ws.send({
          type: "notification_read",
          notification,
        });
        return;
      }

      const count = await markAllNotificationsRead(ws.data.user.id);
      ws.send({
        type: "notifications_read",
        count,
      });
    },
    close(ws) {
      notificationSockets.remove(ws.data.user.id, ws.id);
    },
  });
