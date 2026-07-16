import type { ExpoPushMessage, ExpoPushTicket } from "expo-server-sdk";

import { Value } from "@sinclair/typebox/value";
import { describe, expect, spyOn, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";

import type { Notification, PushToken } from "@/models/notification";
import type {
  NormalizedPushTokenRegistration,
  PushTokenRegistrationRepository,
} from "@/services/push-token-registration";
import type {
  ApnsHttpRequest,
  ApnsHttpResponse,
  ApnsHttpTransport,
} from "@/services/push/apns-provider";
import type {
  PushDeliveryAttempt,
  PushDeliveryTarget,
  PushNotificationProvider,
  PushProviderRegistry,
} from "@/services/push/types";

import { parameterRedactingDatabaseLogger } from "@/lib/db";
import { PushTokenInsert } from "@/models/notification";
import {
  normalizePushTokenRegistration,
  PushTokenRegistrationError,
  registerPushTokenWithRepository,
} from "@/services/push-token-registration";
import {
  APNS_PAYLOAD_LIMIT_BYTES,
  ApnsJwtProvider,
  ApnsProviderClient,
  buildApnsPayload,
  classifyApnsResponse,
} from "@/services/push/apns-provider";
import { dispatchPushNotifications } from "@/services/push/dispatcher";
import { ExpoPushProvider } from "@/services/push/expo-provider";

const notification: Notification = {
  id: "00000000-0000-4000-8000-000000000011",
  createdAt: new Date("2026-07-16T12:00:00.000Z"),
  updatedAt: new Date("2026-07-16T12:00:00.000Z"),
  type: "message",
  title: "New message",
  body: "Open the conversation",
  data: { conversationId: "00000000-0000-4000-8000-000000000012" },
  readAt: null,
  archivedAt: null,
  actorProfileId: null,
  relatedProfileId: null,
};

const target = (
  provider: PushToken["provider"] = "apns",
  apnsEnvironment: PushToken["apnsEnvironment"] = "development",
): PushDeliveryTarget => ({
  deliveryId: `00000000-0000-4000-8000-${provider === "apns" ? "000000000021" : "000000000022"}`,
  pushTokenId: `00000000-0000-4000-8000-${provider === "apns" ? "000000000031" : "000000000032"}`,
  provider,
  apnsEnvironment,
  token: provider === "apns" ? "aabbccdd" : "ExponentPushToken[test-token]",
});

type StoredPushToken = PushToken & { userId: string; token: string };

class MemoryPushTokenRepository implements PushTokenRegistrationRepository {
  readonly rows: StoredPushToken[] = [];
  private id = 1;

  transaction<T>(callback: Parameters<PushTokenRegistrationRepository["transaction"]>[0]) {
    return callback({
      lockApnsInstallation: async () => {},
      disableRotatedApnsTokens: async (input, now) => {
        for (const row of this.rows) {
          if (
            row.provider === "apns" &&
            row.apnsEnvironment === input.apnsEnvironment &&
            row.deviceId === input.deviceId &&
            row.token !== input.token &&
            row.enabled
          ) {
            row.enabled = false;
            row.disabledAt = now;
            row.updatedAt = now;
          }
        }
      },
      upsertPushToken: async (input, now) => this.upsert(input, now),
    }) as Promise<T>;
  }

  private upsert(input: NormalizedPushTokenRegistration, now: Date): PushToken {
    let row = this.rows.find(
      (candidate) => candidate.provider === input.provider && candidate.token === input.token,
    );
    if (row) {
      Object.assign(row, {
        ...input,
        enabled: true,
        disabledAt: null,
        lastRegisteredAt: now,
        updatedAt: now,
      });
    } else {
      row = {
        id: `00000000-0000-4000-8000-${String(this.id++).padStart(12, "0")}`,
        ...input,
        enabled: true,
        lastRegisteredAt: now,
        disabledAt: null,
        createdAt: now,
        updatedAt: now,
      };
      this.rows.push(row);
    }

    const { token: _token, userId: _userId, ...registered } = row;
    return registered;
  }
}

describe("push token registration", () => {
  test("defaults legacy registrations to Expo", async () => {
    const repository = new MemoryPushTokenRepository();
    const registered = await registerPushTokenWithRepository(repository, {
      userId: "legacy-user",
      token: "ExponentPushToken[legacy]",
      platform: "ios",
    });

    expect(registered.provider).toBe("expo");
    expect(registered.apnsEnvironment).toBeNull();
    expect(registered.deviceId).toBeNull();
    expect(repository.rows[0]?.token).toBe("ExponentPushToken[legacy]");
  });

  test.each(["development", "production"] as const)(
    "registers and normalizes valid APNs %s tokens",
    async (apnsEnvironment) => {
      const repository = new MemoryPushTokenRepository();
      const registered = await registerPushTokenWithRepository(repository, {
        userId: "native-user",
        provider: "apns",
        apnsEnvironment,
        token: "AABBCCDDEEFF",
        platform: "ios",
        deviceId: " installation-1 ",
      });

      expect(registered).toMatchObject({
        provider: "apns",
        apnsEnvironment,
        platform: "ios",
        deviceId: "installation-1",
        enabled: true,
      });
      expect(repository.rows[0]?.token).toBe("aabbccddeeff");
    },
  );

  test.each([
    ["non-iOS platform", { platform: "android" }],
    ["missing environment", { apnsEnvironment: undefined }],
    ["missing installation", { deviceId: undefined }],
    ["blank installation", { deviceId: "   " }],
    ["non-hex token", { token: "not-a-device-token" }],
    ["odd-length token", { token: "abc" }],
  ])("rejects APNs registration with %s", (_case, override) => {
    expect(() =>
      normalizePushTokenRegistration({
        userId: "native-user",
        provider: "apns",
        apnsEnvironment: "development",
        token: "aabbccdd",
        platform: "ios",
        deviceId: "installation-1",
        ...override,
      } as Parameters<typeof normalizePushTokenRegistration>[0]),
    ).toThrow(PushTokenRegistrationError);
  });

  test("publishes matching runtime validation for Expo and APNs", () => {
    expect(
      Value.Check(PushTokenInsert, {
        token: "ExponentPushToken[legacy]",
        platform: "android",
      }),
    ).toBeTrue();
    expect(
      Value.Check(PushTokenInsert, {
        provider: "apns",
        apnsEnvironment: "production",
        token: "aabbccdd",
        platform: "ios",
        deviceId: "installation-1",
      }),
    ).toBeTrue();
    expect(
      Value.Check(PushTokenInsert, {
        provider: "apns",
        token: "aabbccdd",
        platform: "ios",
        deviceId: "installation-1",
      }),
    ).toBeFalse();
  });

  test("rotates an installation token and safely reassigns it to the authenticated user", async () => {
    const repository = new MemoryPushTokenRepository();
    const base = {
      provider: "apns" as const,
      apnsEnvironment: "production" as const,
      platform: "ios" as const,
      deviceId: "installation-1",
    };

    await registerPushTokenWithRepository(repository, {
      ...base,
      userId: "old-user",
      token: "aabb",
    });
    await registerPushTokenWithRepository(repository, {
      ...base,
      userId: "new-user",
      token: "ccdd",
    });

    expect(repository.rows).toHaveLength(2);
    expect(repository.rows.find(({ token }) => token === "aabb")).toMatchObject({
      userId: "old-user",
      enabled: false,
    });
    expect(repository.rows.find(({ token }) => token === "ccdd")).toMatchObject({
      userId: "new-user",
      enabled: true,
    });

    await registerPushTokenWithRepository(repository, {
      ...base,
      userId: "current-user",
      token: "ccdd",
    });
    expect(repository.rows.find(({ token }) => token === "ccdd")).toMatchObject({
      userId: "current-user",
      enabled: true,
    });
    expect(repository.rows.filter(({ enabled }) => enabled)).toHaveLength(1);
  });
});

class CapturingProvider implements PushNotificationProvider {
  deliveries: PushDeliveryTarget[] = [];

  async send(_notification: Notification, deliveries: PushDeliveryTarget[]) {
    this.deliveries.push(...deliveries);
    return deliveries.map(
      (delivery): PushDeliveryAttempt => ({
        target: {
          deliveryId: delivery.deliveryId,
          pushTokenId: delivery.pushTokenId,
        },
        outcome: "accepted",
        disableToken: false,
        error: null,
        retryAt: null,
        metadata: {},
      }),
    );
  }
}

describe("push provider dispatch", () => {
  test("fans a notification out across mixed Expo and APNs registrations", async () => {
    const expo = new CapturingProvider();
    const apns = new CapturingProvider();
    const providers: PushProviderRegistry = { expo, apns };
    const attempts = await dispatchPushNotifications(
      notification,
      [target("expo", null), target("apns", "production")],
      providers,
    );

    expect(expo.deliveries.map(({ provider }) => provider)).toEqual(["expo"]);
    expect(
      apns.deliveries.map(({ provider, apnsEnvironment }) => ({
        provider,
        apnsEnvironment,
      })),
    ).toEqual([{ provider: "apns", apnsEnvironment: "production" }]);
    expect(attempts).toHaveLength(2);
  });

  test("preserves Expo validation, chunk tickets, and DeviceNotRegistered disabling safely", async () => {
    let sentMessages: ExpoPushMessage[] = [];
    const provider = new ExpoPushProvider({
      chunkPushNotifications: (messages) => [messages],
      sendPushNotificationsAsync: async (messages) => {
        sentMessages = messages;
        return [
          {
            status: "error",
            message: `unsafe ${messages[0]?.to} ${notification.body}`,
            details: { error: "DeviceNotRegistered" },
          },
        ] satisfies ExpoPushTicket[];
      },
    });

    const [invalid, unregistered] = await provider.send(notification, [
      { ...target("expo", null), token: "invalid" },
      target("expo", null),
    ]);

    expect(sentMessages).toHaveLength(1);
    expect(invalid).toMatchObject({
      outcome: "failed",
      disableToken: true,
      error: "Invalid Expo push token format",
    });
    expect(unregistered).toMatchObject({
      outcome: "failed",
      disableToken: true,
      error: "Expo push ticket error: DeviceNotRegistered",
    });
    expect(unregistered?.error).not.toContain(notification.body);
    expect(unregistered?.error).not.toContain(target("expo", null).token);
  });
});

class CapturingTransport implements ApnsHttpTransport {
  readonly requests: ApnsHttpRequest[] = [];

  constructor(
    private readonly response: ApnsHttpResponse = {
      status: 200,
      headers: { "apns-id": "00000000-0000-4000-8000-000000000041" },
      body: "",
    },
  ) {}

  async request(request: ApnsHttpRequest) {
    this.requests.push(request);
    return this.response;
  }
}

describe("APNs provider protocol", () => {
  test("uses the environment host, device path, required headers, and alert routing payload", async () => {
    const transport = new CapturingTransport();
    const provider = new ApnsProviderClient({
      configuration: {
        teamId: "TEAMID",
        keyId: "KEYID",
        privateKey: "not-used-by-the-injected-token-provider",
        topic: "io.martiancode.Pluriel",
      },
      authorizationTokenProvider: { getToken: () => "header.claims.signature" },
      transport,
      createApnsId: () => "00000000-0000-4000-8000-000000000042",
    });

    await provider.send(notification, [
      target("apns", "development"),
      target("apns", "production"),
    ]);

    expect(transport.requests.map(({ host }) => host)).toEqual([
      "api.sandbox.push.apple.com",
      "api.push.apple.com",
    ]);
    for (const request of transport.requests) {
      expect(request.path).toBe("/3/device/aabbccdd");
      expect(request.headers).toEqual({
        authorization: "bearer header.claims.signature",
        "apns-topic": "io.martiancode.Pluriel",
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-id": "00000000-0000-4000-8000-000000000042",
      });
      expect(JSON.parse(request.body)).toEqual({
        aps: {
          alert: { title: notification.title, body: notification.body },
          sound: "default",
        },
        route: {
          notificationId: notification.id,
          type: notification.type,
          data: notification.data,
        },
      });
    }
  });

  test("generates a correct cached ES256 provider JWT", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    let now = new Date("2026-07-16T12:00:00.000Z");
    const jwtProvider = new ApnsJwtProvider(
      {
        teamId: "TEAMID1234",
        keyId: "KEYID12345",
        privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        topic: "io.martiancode.Pluriel",
      },
      () => now,
    );

    const first = jwtProvider.getToken();
    expect(jwtProvider.getToken()).toBe(first);
    const [header, claims, signature] = first.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "KEYID12345",
    });
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({
      iss: "TEAMID1234",
      iat: Math.floor(now.getTime() / 1000),
    });
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${claims}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature!, "base64url"),
      ),
    ).toBeTrue();

    now = new Date(now.getTime() + 51 * 60 * 1000);
    expect(jwtProvider.getToken()).not.toBe(first);
  });

  test("keeps payloads within APNs limits and falls back when custom data is too large", () => {
    const payload = buildApnsPayload({
      ...notification,
      body: "body".repeat(2_000),
      data: { oversized: "private-custom-payload".repeat(1_000) },
    });
    const parsed = JSON.parse(payload);

    expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(APNS_PAYLOAD_LIMIT_BYTES);
    expect(parsed.route).toEqual({
      notificationId: notification.id,
      type: notification.type,
      data: {},
      dataTruncated: true,
    });
  });
});

describe("APNs response semantics", () => {
  const response = (
    status: number,
    reason?: string,
    headers: ApnsHttpResponse["headers"] = {},
  ): ApnsHttpResponse => ({
    status,
    headers: { "apns-id": "00000000-0000-4000-8000-000000000051", ...headers },
    body: reason ? JSON.stringify({ reason, timestamp: 1_721_131_200_000 }) : "",
  });

  test("classifies accepted, permanent-token, authentication, throttling, and server responses", () => {
    const now = new Date("2026-07-16T12:00:00.000Z");
    const accepted = classifyApnsResponse(target(), response(200), now);
    const permanent = classifyApnsResponse(target(), response(410, "Unregistered"), now);
    const authentication = classifyApnsResponse(
      target(),
      response(403, "InvalidProviderToken"),
      now,
    );
    const throttled = classifyApnsResponse(
      target(),
      response(429, "TooManyRequests", { "retry-after": "120" }),
      now,
    );
    const unavailable = classifyApnsResponse(target(), response(503, "Shutdown"), now);

    expect(accepted).toMatchObject({ outcome: "accepted", disableToken: false, error: null });
    expect(permanent).toMatchObject({ outcome: "failed", disableToken: true });
    expect(authentication).toMatchObject({ outcome: "failed", disableToken: false });
    expect(throttled).toMatchObject({ outcome: "retryable", disableToken: false });
    expect(throttled.retryAt).toEqual(new Date(now.getTime() + 120_000));
    expect(unavailable).toMatchObject({ outcome: "retryable", disableToken: false });
    expect(permanent.metadata).toMatchObject({
      httpStatus: 410,
      reason: "Unregistered",
      timestamp: 1_721_131_200_000,
    });
  });

  test("never puts transport secrets, tokens, bodies, or custom payloads in logs or error text", async () => {
    const secret = "super-secret-private-key-material";
    const deviceToken = "deadbeef";
    const privatePayload = "private-notification-body-and-custom-data";
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    const provider = new ApnsProviderClient({
      configuration: {
        teamId: "TEAMID",
        keyId: "KEYID",
        privateKey: secret,
        topic: "io.martiancode.Pluriel",
      },
      authorizationTokenProvider: { getToken: () => "private.bearer.jwt" },
      transport: {
        request: () => Promise.reject(new Error(`${secret} ${deviceToken} ${privatePayload}`)),
      },
    });

    try {
      const [result] = await provider.send(
        { ...notification, body: privatePayload, data: { privatePayload } },
        [{ ...target(), token: deviceToken }],
      );
      const storedText = `${result?.error} ${JSON.stringify(result?.metadata)}`;
      const providerResult = JSON.stringify(result);

      expect(storedText).toBe('APNs transport request failed {"classification":"transport"}');
      expect(storedText).not.toContain(secret);
      expect(storedText).not.toContain(deviceToken);
      expect(storedText).not.toContain(privatePayload);
      expect(providerResult).not.toContain(deviceToken);
      expect(providerResult).not.toContain(privatePayload);
      expect(providerResult).not.toContain("private.bearer.jwt");
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  test("sanitizes unrecognized APNs response content", () => {
    const sensitiveBody = "private-notification-body";
    const result = classifyApnsResponse(target(), {
      status: 400,
      headers: {},
      body: JSON.stringify({ reason: sensitiveBody, payload: sensitiveBody }),
    });

    expect(result.error).toBe("APNs rejected the notification (400)");
    expect(JSON.stringify(result.metadata)).not.toContain(sensitiveBody);
  });

  test("redacts all database query parameters from development logs", () => {
    const consoleLog = spyOn(console, "log").mockImplementation(() => {});

    try {
      parameterRedactingDatabaseLogger.logQuery("insert into notification values ($1, $2)", [
        "device-token",
        { body: "private-body", data: "private-data" },
      ]);

      expect(consoleLog).toHaveBeenCalledWith("Query: insert into notification values ($1, $2)");
      expect(JSON.stringify(consoleLog.mock.calls)).not.toContain("device-token");
      expect(JSON.stringify(consoleLog.mock.calls)).not.toContain("private-body");
      expect(JSON.stringify(consoleLog.mock.calls)).not.toContain("private-data");
    } finally {
      consoleLog.mockRestore();
    }
  });
});
