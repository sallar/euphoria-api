import type { Notification, PushToken } from "@/models/notification";

import type { PushDeliveryAttempt, PushDeliveryTarget, PushProviderRegistry } from "./types";

export const dispatchPushNotifications = async (
  notification: Notification,
  deliveries: PushDeliveryTarget[],
  providers: PushProviderRegistry,
): Promise<PushDeliveryAttempt[]> => {
  const grouped = new Map<PushToken["provider"], PushDeliveryTarget[]>();

  for (const delivery of deliveries) {
    const providerDeliveries = grouped.get(delivery.provider) ?? [];
    providerDeliveries.push(delivery);
    grouped.set(delivery.provider, providerDeliveries);
  }

  const attempts = await Promise.all(
    [...grouped.entries()].map(([provider, providerDeliveries]) =>
      providers[provider].send(notification, providerDeliveries),
    ),
  );

  return attempts.flat();
};
