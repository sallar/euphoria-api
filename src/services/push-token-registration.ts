import type { PushToken } from "@/models/notification";

export type PushTokenRegistrationInput = {
  userId: string;
  provider?: PushToken["provider"];
  apnsEnvironment?: NonNullable<PushToken["apnsEnvironment"]>;
  token: string;
  platform: PushToken["platform"];
  deviceId?: string;
};

export type NormalizedPushTokenRegistration = {
  userId: string;
  provider: PushToken["provider"];
  apnsEnvironment: PushToken["apnsEnvironment"];
  token: string;
  platform: PushToken["platform"];
  deviceId: string | null;
};

export interface PushTokenRegistrationTransaction {
  lockApnsInstallation(
    environment: NonNullable<PushToken["apnsEnvironment"]>,
    deviceId: string,
  ): Promise<void>;
  disableRotatedApnsTokens(input: NormalizedPushTokenRegistration, now: Date): Promise<void>;
  upsertPushToken(input: NormalizedPushTokenRegistration, now: Date): Promise<PushToken>;
}

export interface PushTokenRegistrationRepository {
  transaction<T>(
    callback: (transaction: PushTokenRegistrationTransaction) => Promise<T>,
  ): Promise<T>;
}

export class PushTokenRegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PushTokenRegistrationError";
  }
}

export const normalizePushTokenRegistration = (
  input: PushTokenRegistrationInput,
): NormalizedPushTokenRegistration => {
  const provider = input.provider ?? "expo";

  if (provider === "expo") {
    if (input.apnsEnvironment !== undefined) {
      throw new PushTokenRegistrationError("APNs environment is only valid for APNs tokens");
    }

    return {
      ...input,
      provider,
      apnsEnvironment: null,
      deviceId: input.deviceId ?? null,
    };
  }

  if (input.platform !== "ios") {
    throw new PushTokenRegistrationError("APNs tokens require the iOS platform");
  }
  if (!input.apnsEnvironment) {
    throw new PushTokenRegistrationError("APNs environment is required");
  }

  const deviceId = input.deviceId?.trim();
  if (!deviceId) {
    throw new PushTokenRegistrationError("APNs registrations require a device installation ID");
  }
  if (!/^([0-9a-fA-F]{2})+$/.test(input.token)) {
    throw new PushTokenRegistrationError("APNs device token must be hex encoded");
  }

  return {
    ...input,
    provider,
    apnsEnvironment: input.apnsEnvironment,
    token: input.token.toLowerCase(),
    deviceId,
  };
};

export const registerPushTokenWithRepository = async (
  repository: PushTokenRegistrationRepository,
  input: PushTokenRegistrationInput,
) => {
  const registration = normalizePushTokenRegistration(input);
  const now = new Date();

  return repository.transaction(async (transaction) => {
    if (registration.provider === "apns") {
      await transaction.lockApnsInstallation(registration.apnsEnvironment!, registration.deviceId!);
      await transaction.disableRotatedApnsTokens(registration, now);
    }

    return transaction.upsertPushToken(registration, now);
  });
};
