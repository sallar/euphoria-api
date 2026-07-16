import type { Notification, PushToken } from "@/models/notification";

export type PushDeliveryTarget = {
  deliveryId: string;
  pushTokenId: string;
  provider: PushToken["provider"];
  apnsEnvironment: PushToken["apnsEnvironment"];
  token: string;
};

export type PushProviderMetadata = Record<string, string | number | null>;

export type PushDeliveryReference = Pick<PushDeliveryTarget, "deliveryId" | "pushTokenId">;

export type PushDeliveryAttempt = {
  target: PushDeliveryReference;
  outcome: "accepted" | "failed" | "retryable";
  disableToken: boolean;
  error: string | null;
  retryAt: Date | null;
  metadata: PushProviderMetadata;
};

export interface PushNotificationProvider {
  send(
    notification: Notification,
    deliveries: PushDeliveryTarget[],
  ): Promise<PushDeliveryAttempt[]>;
}

export type PushProviderRegistry = Record<PushToken["provider"], PushNotificationProvider>;
