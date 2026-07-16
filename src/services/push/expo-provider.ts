import type { ExpoPushMessage, ExpoPushTicket } from "expo-server-sdk";

import { Expo } from "expo-server-sdk";

import type { Notification } from "@/models/notification";

import type { PushDeliveryAttempt, PushDeliveryTarget, PushNotificationProvider } from "./types";

type ExpoClient = Pick<Expo, "chunkPushNotifications" | "sendPushNotificationsAsync">;

let expoClient: Expo | undefined;

const getExpoClient = () => {
  const accessToken = process.env.EXPO_ACCESS_TOKEN?.trim();
  expoClient ??= new Expo(accessToken ? { accessToken } : undefined);
  return expoClient;
};

const failure = (
  target: PushDeliveryTarget,
  error: string,
  disableToken: boolean,
  metadata: PushDeliveryAttempt["metadata"] = {},
): PushDeliveryAttempt => ({
  target: { deliveryId: target.deliveryId, pushTokenId: target.pushTokenId },
  outcome: "failed",
  disableToken,
  error,
  retryAt: null,
  metadata,
});

const applyExpoPushTicket = (
  target: PushDeliveryTarget,
  ticket: ExpoPushTicket | undefined,
): PushDeliveryAttempt => {
  if (!ticket) {
    return failure(target, "Expo did not return a push ticket for this notification", false);
  }

  if (ticket.status === "ok") {
    return {
      target: { deliveryId: target.deliveryId, pushTokenId: target.pushTokenId },
      outcome: "accepted",
      disableToken: false,
      error: null,
      retryAt: null,
      metadata: { ticketStatus: "ok", ticketId: ticket.id },
    };
  }

  const errorCode = ticket.details?.error;
  return failure(
    target,
    errorCode ? `Expo push ticket error: ${errorCode}` : "Expo returned a push ticket error",
    errorCode === "DeviceNotRegistered",
    {
      ticketStatus: "error",
      errorCode: errorCode ?? null,
    },
  );
};

const toExpoPushMessage = (
  notification: Notification,
  target: PushDeliveryTarget,
): ExpoPushMessage => ({
  to: target.token,
  title: notification.title,
  body: notification.body,
  sound: "default",
  data: notification,
});

export class ExpoPushProvider implements PushNotificationProvider {
  constructor(private readonly client: ExpoClient = getExpoClient()) {}

  async send(notification: Notification, deliveries: PushDeliveryTarget[]) {
    const attempts: PushDeliveryAttempt[] = [];
    const deliverableMessages: { target: PushDeliveryTarget; message: ExpoPushMessage }[] = [];

    for (const target of deliveries) {
      if (!Expo.isExpoPushToken(target.token)) {
        attempts.push(failure(target, "Invalid Expo push token format", true));
        continue;
      }

      deliverableMessages.push({
        target,
        message: toExpoPushMessage(notification, target),
      });
    }

    let chunkStart = 0;
    const messages = deliverableMessages.map(({ message }) => message);
    for (const chunk of this.client.chunkPushNotifications(messages)) {
      const chunkTargets = deliverableMessages
        .slice(chunkStart, chunkStart + chunk.length)
        .map(({ target }) => target);
      chunkStart += chunk.length;

      try {
        const tickets = await this.client.sendPushNotificationsAsync(chunk);
        attempts.push(
          ...chunkTargets.map((target, index) => applyExpoPushTicket(target, tickets[index])),
        );
      } catch {
        // Provider exceptions can contain tokens or payloads. Keep logs and stored errors generic.
        console.error("Expo push notification chunk failed");
        attempts.push(
          ...chunkTargets.map((target) =>
            failure(target, "Expo push notification request failed", false),
          ),
        );
      }
    }

    return attempts;
  }
}
